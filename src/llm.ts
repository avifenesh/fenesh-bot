// Model calls through Amazon Bedrock with a bearer key.
// Claude goes through the Converse API; OpenAI models go through the OpenAI-compatible Responses API,
// on Mantle (plain openai.* ids) or on bedrock-runtime (global.openai.* profiles).

import { config, model, type ModelSpec } from './config.ts';
import { log } from './log.ts';

export interface Usage { input: number; output: number; costUsd: number }

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
  run: (args: any) => Promise<string>;
}

export interface CallOptions {
  system?: string;
  maxTokens?: number;
  effort?: string;
  tools?: ToolSpec[];
  maxToolRounds?: number;
  timeoutMs?: number;
  label?: string; // what the call is for, logged with usage
  fallback?: string; // model to try once if this one keeps failing
}

export interface CallResult { text: string; usage: Usage; model: string; toolCalls: number }

const UsageSink: Array<(model: string, label: string, u: Usage) => void> = [];
export function onUsage(fn: (model: string, label: string, u: Usage) => void): void { UsageSink.push(fn); }

function cost(spec: ModelSpec, input: number, output: number): number {
  return (input * spec.price.input + output * spec.price.output) / 1e6;
}

async function post(url: string, body: unknown, timeoutMs: number): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.bedrockToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`bedrock ${res.status}: ${text.slice(0, 500)}`);
      if (!retryable) throw lastErr;
    } catch (e: any) {
      lastErr = e;
      if (e?.message?.startsWith('bedrock 4') && !e.message.startsWith('bedrock 429')) throw e;
      // A request that hung until its timeout is not repeated here; call() retries once, then falls back.
      if (e?.name === 'AbortError') throw new Error(`bedrock request timed out after ${Math.round(timeoutMs / 1000)} s`);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt + Math.random() * 1000));
  }
  throw lastErr;
}

// Sent back for tool calls made after the round budget is spent, so the model writes its answer
// instead of returning nothing.
const BUDGET_SPENT = 'Not run: the tool budget for this task is used up. Write your final answer now from what you already have, without calling tools.';

function safeParse(s: string | undefined): any {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

async function runTool(o: CallOptions, name: string, args: any): Promise<string> {
  const tool = o.tools?.find((t) => t.name === name);
  if (!tool) return `unknown tool ${name}`;
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      tool.run(args),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('tool timed out after 90 s')), 90_000)),
    ]);
    log.info('tool', { label: o.label, tool: name, ms: Date.now() - t0, chars: out.length });
    return out;
  } catch (e: any) {
    log.info('tool', { label: o.label, tool: name, ms: Date.now() - t0, err: e?.message ?? String(e) });
    return `tool error: ${e?.message ?? e}`;
  }
}

// ---- Converse (Claude) ----

function converseExtra(spec: ModelSpec, effort: string): Record<string, unknown> {
  if (spec.id.includes('anthropic')) return { thinking: { type: 'adaptive' }, output_config: { effort } };
  return {};
}

async function callConverse(spec: ModelSpec, prompt: string, o: CallOptions): Promise<CallResult> {
  const url = `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(spec.id)}/converse`;
  const messages: any[] = [{ role: 'user', content: [{ text: prompt }] }];
  const toolConfig = o.tools?.length
    ? { tools: o.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) }
    : undefined;
  let input = 0, output = 0, toolCalls = 0;
  for (let round = 0; ; round++) {
    const body: any = {
      messages,
      inferenceConfig: { maxTokens: o.maxTokens ?? spec.maxTokens },
      additionalModelRequestFields: converseExtra(spec, o.effort ?? spec.effort),
    };
    if (o.system) body.system = [{ text: o.system }];
    if (toolConfig) body.toolConfig = toolConfig;
    const d = await post(url, body, o.timeoutMs ?? 15 * 60_000);
    input += d.usage?.inputTokens ?? 0;
    output += d.usage?.outputTokens ?? 0;
    const content: any[] = d.output?.message?.content ?? [];
    const uses = content.filter((c) => c.toolUse);
    const maxRounds = o.maxToolRounds ?? 12;
    if (d.stopReason === 'tool_use' && uses.length && round <= maxRounds) {
      messages.push({ role: 'assistant', content });
      const spent = round === maxRounds;
      const results = await Promise.all(uses.map(async (c) => {
        if (spent) return { toolResult: { toolUseId: c.toolUse.toolUseId, content: [{ text: BUDGET_SPENT }] } };
        toolCalls++;
        const out = await runTool(o, c.toolUse.name, c.toolUse.input ?? {});
        return { toolResult: { toolUseId: c.toolUse.toolUseId, content: [{ text: out.slice(0, 60_000) }] } };
      }));
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = content.filter((c) => typeof c.text === 'string').map((c) => c.text).join('\n');
    return { text, usage: { input, output, costUsd: cost(spec, input, output) }, model: spec.key, toolCalls };
  }
}

// ---- Mantle Responses (OpenAI models) ----

async function callResponses(spec: ModelSpec, prompt: string, o: CallOptions): Promise<CallResult> {
  const url = spec.transport === 'runtime-openai'
    ? `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com/openai/v1/responses`
    : `https://bedrock-mantle.${config.bedrockRegion}.api.aws/openai/v1/responses`;
  const tools = o.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  let inputItems: any[] = [{ role: 'user', content: prompt }];
  let input = 0, output = 0, toolCalls = 0;
  for (let round = 0; ; round++) {
    const body: any = {
      model: spec.id,
      input: inputItems,
      reasoning: { effort: o.effort ?? spec.effort },
      max_output_tokens: o.maxTokens ?? spec.maxTokens,
      store: false,
    };
    if (o.system) body.instructions = o.system;
    if (tools?.length) body.tools = tools;
    const maxRounds = o.maxToolRounds ?? 12;
    if (tools?.length && round > maxRounds) body.tool_choice = 'none';
    const d = await post(url, body, o.timeoutMs ?? 15 * 60_000);
    input += d.usage?.input_tokens ?? 0;
    output += d.usage?.output_tokens ?? 0;
    const items: any[] = d.output ?? [];
    // A 200 can still carry a failed or cut-off response; surface it instead of returning nothing.
    if (d.status === 'failed') throw new Error(`${spec.key} response failed: ${JSON.stringify(d.error ?? {}).slice(0, 300)}`);
    if (d.status === 'incomplete' && !items.some((i) => i.type === 'message' || i.type === 'function_call')) {
      throw new Error(`${spec.key} response incomplete: ${JSON.stringify(d.incomplete_details ?? {}).slice(0, 200)}`);
    }
    const calls = items.filter((i) => i.type === 'function_call');
    if (calls.length && round <= maxRounds) {
      // Stateless: send back everything the model produced plus our tool outputs.
      inputItems = [...inputItems, ...items];
      for (const c of calls) {
        if (round === maxRounds) { inputItems.push({ type: 'function_call_output', call_id: c.call_id, output: BUDGET_SPENT }); continue; }
        toolCalls++;
        const out = await runTool(o, c.name, safeParse(c.arguments));
        inputItems.push({ type: 'function_call_output', call_id: c.call_id, output: out.slice(0, 60_000) });
      }
      continue;
    }
    const text = items
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content ?? [])
      .map((c: any) => c.text ?? '')
      .join('\n');
    return { text, usage: { input, output, costUsd: cost(spec, input, output) }, model: spec.key, toolCalls };
  }
}

const clientError = (e: any) => /^bedrock 4\d\d/.test(e?.message ?? '') && !/^bedrock 429/.test(e.message);

// One retry for a failed or empty reply, then the fallback model if one is given. Provider-side
// hiccups (503s, 200s with no output) come in bursts; a request the provider refuses (4xx) is not retried.
export async function call(modelKey: string, prompt: string, o: CallOptions = {}): Promise<CallResult> {
  const spec = model(modelKey);
  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const r = spec.transport === 'converse' ? await callConverse(spec, prompt, o) : await callResponses(spec, prompt, o);
      log.info('llm', { model: spec.key, label: o.label, ms: Date.now() - t0, in: r.usage.input, out: r.usage.output, usd: +r.usage.costUsd.toFixed(4), tools: r.toolCalls });
      for (const fn of UsageSink) fn(spec.key, o.label ?? '', r.usage);
      if (!r.text.trim() && r.usage.output === 0) throw new Error(`${spec.key} returned an empty reply`);
      return r;
    } catch (e: any) {
      lastErr = e;
      log.warn('llm call failed', { model: spec.key, label: o.label, attempt, ms: Date.now() - t0, err: String(e?.message ?? e).slice(0, 300) });
      if (clientError(e)) break;
    }
  }
  if (o.fallback && o.fallback !== modelKey) {
    log.warn('llm fallback', { from: spec.key, to: o.fallback, label: o.label });
    return call(o.fallback, prompt, { ...o, fallback: undefined });
  }
  throw lastErr;
}

// The fast steps (plan, classification, market match, repair, wiki) run on one model at low effort.
export function fast(prompt: string, o: CallOptions = {}): Promise<CallResult> {
  return call(config.fastModel, prompt, { effort: config.fastEffort, fallback: config.fallbackModel, timeoutMs: 120_000, ...o });
}

// Pull the last JSON object out of a model reply (models are told to end with one).
export function lastJson(text: string): any {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [];
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* try next */ }
  }
  // Fall back to the last balanced {...} block.
  let depth = 0, end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') { if (depth === 0) end = i; depth++; }
    else if (ch === '{') { depth--; if (depth === 0 && end >= 0) { try { return JSON.parse(text.slice(i, end + 1)); } catch { end = -1; } } }
  }
  throw new Error('no JSON object in reply');
}
