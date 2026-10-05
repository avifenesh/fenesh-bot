// Model calls through Amazon Bedrock with a bearer key.
// Claude goes through the Converse API; OpenAI models go through the OpenAI-compatible Responses API,
// on Mantle (plain openai.* ids) or on bedrock-runtime (global.openai.* profiles).

import { AsyncLocalStorage } from 'node:async_hooks';
import { config, model, type ModelSpec } from './config.ts';
import { log } from './log.ts';

export interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUsd: number } // input includes cached tokens

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
  // Model tried when this one keeps failing. Defaults to the model's own fallback (config.ts); null
  // disables it.
  fallback?: string | null;
}

export interface CallResult { text: string; usage: Usage; model: string; toolCalls: number }

const UsageSink: Array<(model: string, label: string, u: Usage) => void> = [];
export function onUsage(fn: (model: string, label: string, u: Usage) => void): void { UsageSink.push(fn); }

// Cost of one request. `uncached` excludes cache reads and writes. OpenAI models bill a request with
// more than 272K input tokens at the long-context rates (2x input and cache, 1.5x output).
export function requestCost(spec: ModelSpec, uncached: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const p = spec.price;
  const long = p.longContext && uncached + cacheRead + cacheWrite > 272_000;
  const inX = long ? 2 : 1, outX = long ? 1.5 : 1;
  return (inX * (uncached * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) + outX * output * p.output) / 1e6;
}

// Reasoning effort never goes below medium (owner, 2026-10-05).
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function effortFor(requested: string): string {
  return EFFORTS.indexOf(requested) < EFFORTS.indexOf('medium') ? 'medium' : requested;
}

// Run deadline: every model call inside withDeadline() (fallbacks included) stops at it, so a run can
// never outlive the window in which the queue treats its question as in flight (src/store.ts inFlight).
const deadlineStore = new AsyncLocalStorage<number>();
export const RUN_DEADLINE_MS = 40 * 60_000;
export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return deadlineStore.run(Date.now() + ms, fn);
}
function timeLeft(): number { const d = deadlineStore.getStore(); return d == null ? Infinity : d - Date.now(); }

async function post(url: string, body: unknown, timeoutMs: number): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Every request (each retry, each tool round) gets only the time the run has left.
    const left = timeLeft();
    if (left < 1_000) throw new Error('run deadline passed');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, left));
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
      if (e?.name === 'AbortError') throw new Error(timeLeft() < 1_000 ? 'run deadline passed' : `bedrock request timed out after ${Math.round(timeoutMs / 1000)} s`);
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
  let input = 0, output = 0, toolCalls = 0, cacheRead = 0, cacheWrite = 0, usd = 0;
  for (let round = 0; ; round++) {
    // Always cached: a cache point at the end of the conversation so far. A repeated prompt (both
    // forecast rounds, a revision) and every tool round read that prefix at the cache rate. One point
    // at a time; Bedrock allows four. Prompts under the model's minimum are simply not cached.
    for (const m of messages) m.content = m.content.filter((c: any) => !c.cachePoint);
    messages[messages.length - 1].content.push({ cachePoint: { type: 'default' } });
    const body: any = {
      messages,
      inferenceConfig: { maxTokens: o.maxTokens ?? spec.maxTokens },
      additionalModelRequestFields: converseExtra(spec, effortFor(o.effort ?? spec.effort)),
    };
    if (o.system) body.system = [{ text: o.system }];
    if (toolConfig) body.toolConfig = toolConfig;
    const d = await post(url, body, o.timeoutMs ?? 15 * 60_000);
    const u = { in: d.usage?.inputTokens ?? 0, out: d.usage?.outputTokens ?? 0, read: d.usage?.cacheReadInputTokens ?? 0, write: d.usage?.cacheWriteInputTokens ?? 0 };
    input += u.in; output += u.out; cacheRead += u.read; cacheWrite += u.write;
    usd += requestCost(spec, u.in, u.out, u.read, u.write);
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
    return { text, usage: { input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite, costUsd: usd }, model: spec.key, toolCalls };
  }
}

// ---- Mantle Responses (OpenAI models) ----

async function callResponses(spec: ModelSpec, prompt: string, o: CallOptions): Promise<CallResult> {
  const url = spec.transport === 'runtime-openai'
    ? `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com/openai/v1/responses`
    : `https://bedrock-mantle.${config.bedrockRegion}.api.aws/openai/v1/responses`;
  const tools = o.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  let inputItems: any[] = [{ role: 'user', content: prompt }];
  let input = 0, output = 0, toolCalls = 0, cacheRead = 0, cacheWrite = 0, usd = 0;
  for (let round = 0; ; round++) {
    const body: any = {
      model: spec.id,
      input: inputItems,
      reasoning: { effort: effortFor(o.effort ?? spec.effort) },
      max_output_tokens: o.maxTokens ?? spec.maxTokens,
      store: false,
      // Always cached: these models cache any prefix of 1,024+ tokens; the key keeps requests of one
      // kind (and every round of a tool loop) on the same cache.
      prompt_cache_key: `fenesh:${o.label ?? 'call'}`,
    };
    if (o.system) body.instructions = o.system;
    if (tools?.length) body.tools = tools;
    const maxRounds = o.maxToolRounds ?? 12;
    if (tools?.length && round > maxRounds) body.tool_choice = 'none';
    const d = await post(url, body, o.timeoutMs ?? 15 * 60_000);
    // input_tokens includes the cached and cache-write tokens.
    const det = d.usage?.input_tokens_details ?? {};
    const u = { all: d.usage?.input_tokens ?? 0, out: d.usage?.output_tokens ?? 0, read: det.cached_tokens ?? 0, write: det.cache_write_tokens ?? 0 };
    input += u.all; output += u.out; cacheRead += u.read; cacheWrite += u.write;
    usd += requestCost(spec, Math.max(0, u.all - u.read - u.write), u.out, u.read, u.write);
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
    return { text, usage: { input, output, cacheRead, cacheWrite, costUsd: usd }, model: spec.key, toolCalls };
  }
}

const clientError = (e: any) => /^bedrock 4\d\d/.test(e?.message ?? '') && !/^bedrock 429/.test(e.message);

// Circuit breaker: a model that failed two calls in a row is skipped for 15 minutes, so an outage costs
// one detection window instead of a hung request on every step of every question.
const downUntil = new Map<string, number>();
const failuresInARow = new Map<string, number>();
export function modelDown(key: string): boolean { return (downUntil.get(key) ?? 0) > Date.now(); }
function markFailure(key: string): void {
  const n = (failuresInARow.get(key) ?? 0) + 1;
  failuresInARow.set(key, n);
  if (n >= 2) { downUntil.set(key, Date.now() + 15 * 60_000); failuresInARow.set(key, 0); log.warn('model skipped for 15 minutes after repeated failures', { model: key }); }
}

// One retry for a failed or empty reply, then the fallback model if one is given. Provider-side
// hiccups (503s, 200s with no output) come in bursts; a request the provider refuses (4xx) is not retried.
export async function call(modelKey: string, prompt: string, o: CallOptions = {}): Promise<CallResult> {
  const spec = model(modelKey);
  let lastErr: any;
  if (modelDown(modelKey)) lastErr = new Error(`${modelKey} is skipped after repeated failures`);
  else for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    if (timeLeft() < 1_000) { lastErr = new Error('run deadline passed'); break; }
    try {
      const r = spec.transport === 'converse' ? await callConverse(spec, prompt, o) : await callResponses(spec, prompt, o);
      log.info('llm', { model: spec.key, label: o.label, ms: Date.now() - t0, in: r.usage.input, cached: r.usage.cacheRead ?? 0, out: r.usage.output, usd: +r.usage.costUsd.toFixed(4), tools: r.toolCalls });
      for (const fn of UsageSink) fn(spec.key, o.label ?? '', r.usage);
      if (!r.text.trim() && r.usage.output === 0) throw new Error(`${spec.key} returned an empty reply`);
      failuresInARow.set(modelKey, 0);
      return r;
    } catch (e: any) {
      lastErr = e;
      log.warn('llm call failed', { model: spec.key, label: o.label, attempt, ms: Date.now() - t0, err: String(e?.message ?? e).slice(0, 300) });
      if (clientError(e) || /run deadline passed/.test(e?.message ?? '')) break;
      if (attempt === 1) markFailure(modelKey);
    }
  }
  const next = o.fallback === null ? undefined : (o.fallback ?? spec.fallback);
  const tried = [...((o as any)._tried ?? []), modelKey];
  if (next && !tried.includes(next) && timeLeft() >= 1_000) {
    log.warn('llm fallback', { from: spec.key, to: next, label: o.label });
    // The fallback's own fallback is next in line; a model already tried is never tried again.
    return call(next, prompt, { ...o, fallback: undefined, _tried: tried } as CallOptions);
  }
  throw lastErr;
}

// The fast steps (plan, classification, market match, repair, wiki) run on one model at low effort.
export function fast(prompt: string, o: CallOptions = {}): Promise<CallResult> {
  return call(config.fastModel, prompt, { effort: config.fastEffort, timeoutMs: 120_000, ...o });
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
