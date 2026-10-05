// Runtime configuration. Everything secret comes from the environment; nothing here is a secret.

import './net.ts';

export type Transport = 'converse' | 'mantle-openai' | 'runtime-openai';

export interface Price {
  input: number;
  output: number;
  cacheRead: number; // cached prompt tokens read
  cacheWrite: number; // prompt tokens written to the cache
  // OpenAI models: a request with more than 272K input tokens bills input and cache at 2x and output
  // at 1.5x for the whole request.
  longContext?: boolean;
}

export interface ModelSpec {
  key: string; // short name used in logs and the archive
  id: string; // Bedrock model or inference-profile id
  transport: Transport;
  // Default reasoning effort, for the model's main job (forecasting). Never below medium (src/llm.ts).
  effort: string;
  maxTokens: number;
  // Last date the model may know about (training cutoff, from the providers' docs). Backtests only
  // use questions that open after the latest cutoff of the models in the run, fallbacks included.
  cutoff: string;
  // Tried when this model keeps failing. Every model has one; a forecaster's fallback is never another
  // ensemble member, so one model cannot vote twice.
  fallback: string;
  // USD per million tokens (reasoning bills as output). From the AWS price list and model cards,
  // 2026-10-05: global profiles at the base rate, Mantle in-region ids at +10%.
  price: Price;
}

const env = process.env;

export const MODELS: Record<string, ModelSpec> = {
  'gpt-6-astra': {
    key: 'gpt-6-astra', id: 'openai.gpt-6-astra', transport: 'mantle-openai', effort: 'xhigh', fallback: 'gpt-6-sol',
    cutoff: '2026-04-30', maxTokens: 32000, price: { input: 11, output: 55, cacheRead: 1.1, cacheWrite: 13.75, longContext: true },
  },
  // Exception to the plain openai.* id rule (owner, 2026-10-04): GPT-6.1 Sol runs as the global
  // inference profile on bedrock-runtime. The bare id is refused there ("on-demand throughput isn't
  // supported"). Astra keeps its plain id on Mantle.
  'gpt-6.1-sol': {
    key: 'gpt-6.1-sol', id: 'global.openai.gpt-6.1-sol', transport: 'runtime-openai', effort: 'xhigh', fallback: 'gpt-6-sol',
    cutoff: '2026-04-30', maxTokens: 32000, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, longContext: true },
  },
  'opus-5.5': {
    key: 'opus-5.5', id: 'global.anthropic.claude-opus-5-5', transport: 'converse', effort: 'high', fallback: 'sonnet-5.5',
    cutoff: '2026-06-30', maxTokens: 32000, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  'fable-5.1': {
    key: 'fable-5.1', id: 'global.anthropic.claude-fable-5-1', transport: 'converse', effort: 'high', fallback: 'sonnet-5.5',
    cutoff: '2026-06-30', maxTokens: 32000, price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
  // Fallback-only models: not in the ensemble.
  'gpt-6-sol': {
    key: 'gpt-6-sol', id: 'global.openai.gpt-6-sol', transport: 'runtime-openai', effort: 'xhigh', fallback: 'sonnet-5.5',
    cutoff: '2026-04-20', maxTokens: 32000, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, longContext: true },
  },
  'sonnet-5.5': {
    key: 'sonnet-5.5', id: 'global.anthropic.claude-sonnet-5-5', transport: 'converse', effort: 'high', fallback: 'gpt-6-sol',
    cutoff: '2026-06-30', maxTokens: 32000, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
};

function list(name: string, fallback: string): string[] {
  return (env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  metaculusBase: env.METACULUS_API_BASE ?? 'https://www.metaculus.com/api',
  metaculusToken: env.METACULUS_TOKEN ?? '',
  bedrockToken: env.AWS_BEARER_TOKEN_BEDROCK ?? '',
  bedrockRegion: env.BEDROCK_REGION ?? 'us-east-1',
  valkey: { host: env.VALKEY_HOST ?? '127.0.0.1', port: Number(env.VALKEY_PORT ?? 6379) },
  dataDir: env.FENESH_DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
  // Tournaments polled for open questions. The current MiniBench round is polled by its slug, 'minibench'.
  tournaments: list('FENESH_TOURNAMENTS', 'fall-futureeval-2026'),
  discoverMiniBench: (env.FENESH_MINIBENCH ?? '1') === '1',
  forecasters: list('FENESH_FORECASTERS', 'gpt-6-astra,gpt-6.1-sol,opus-5.5,fable-5.1'),
  // Plan, base-rate classification, market matching, JSON repair and wiki notes.
  fastModel: env.FENESH_FAST_MODEL ?? 'gpt-6.1-sol',
  fastEffort: env.FENESH_FAST_EFFORT ?? 'medium',
  // The analyst checks sources and writes the brief the forecasts rest on.
  researchEffort: env.FENESH_RESEARCH_EFFORT ?? 'high',
  researchModel: env.FENESH_RESEARCH_MODEL ?? 'gpt-6.1-sol',
  // Submit nothing; log what would be submitted.
  dryRun: (env.FENESH_DRY_RUN ?? '0') === '1',
  // Hard cap on model spend per question, USD.
  maxCostPerQuestion: Number(env.FENESH_MAX_COST_PER_QUESTION ?? 4),
  // Binary probabilities are kept inside [clip, 1 - clip].
  binaryClip: Number(env.FENESH_BINARY_CLIP ?? 0.02),
  pollEveryMs: Number(env.FENESH_POLL_EVERY_MS ?? 10 * 60_000),
  questionConcurrency: Number(env.FENESH_QUESTION_CONCURRENCY ?? 6),
  userAgent: env.FENESH_USER_AGENT ?? 'fenesh-bot/0.1 (Metaculus forecasting bot; contact via metaculus.com/accounts/profile/309777)',
};

// The fallback chain of a model, without repeats: e.g. gpt-6.1-sol -> gpt-6-sol -> sonnet-5.5.
export function fallbackChain(key: string): string[] {
  const out: string[] = [];
  for (let k = MODELS[key]?.fallback; k && k !== key && !out.includes(k); k = MODELS[k]?.fallback) out.push(k);
  return out;
}

export function model(key: string): ModelSpec {
  const m = MODELS[key];
  if (!m) throw new Error(`unknown model ${key}`);
  return m;
}
