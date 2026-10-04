// Runtime configuration. Everything secret comes from the environment; nothing here is a secret.

import './net.ts';

export type Transport = 'converse' | 'mantle-openai' | 'mantle-v1';

export interface ModelSpec {
  key: string; // short name used in logs and the archive
  id: string; // Bedrock model or inference-profile id
  transport: Transport;
  effort: string; // reasoning effort passed to the provider
  maxTokens: number;
  // Last date the model may know about (training cutoff, from the providers' docs). Backtests only
  // use questions that open after the latest cutoff of the models in the run.
  cutoff: string;
  // USD per million tokens (reasoning tokens bill as output). Bedrock prices checked 2026-10-04:
  // global profiles at base rate, Mantle OpenAI ids at the in-region rate (+10%).
  price: { input: number; output: number };
}

const env = process.env;

export const MODELS: Record<string, ModelSpec> = {
  'gpt-6-astra': {
    key: 'gpt-6-astra', id: 'openai.gpt-6-astra', transport: 'mantle-openai',
    effort: 'xhigh', cutoff: '2026-04-30', maxTokens: 32000, price: { input: 11, output: 55 },
  },
  'gpt-6.1-sol': {
    key: 'gpt-6.1-sol', id: 'openai.gpt-6.1-sol', transport: 'mantle-openai',
    effort: 'xhigh', cutoff: '2026-04-30', maxTokens: 32000, price: { input: 2.2, output: 11 },
  },
  'opus-5.5': {
    key: 'opus-5.5', id: 'global.anthropic.claude-opus-5-5', transport: 'converse',
    effort: 'high', cutoff: '2026-06-30', maxTokens: 32000, price: { input: 4, output: 20 },
  },
  'fable-5.1': {
    key: 'fable-5.1', id: 'global.anthropic.claude-fable-5-1', transport: 'converse',
    effort: 'high', cutoff: '2026-06-30', maxTokens: 32000, price: { input: 10, output: 50 },
  },
  // The open-weight model: a voting member of the ensemble, and the fast steps (query writing,
  // classification, market matching, parse repair).
  'gpt-oss-120b': {
    key: 'gpt-oss-120b', id: 'openai.gpt-oss-120b', transport: 'mantle-v1',
    effort: 'medium', cutoff: '2024-06-30', maxTokens: 16000, price: { input: 0.15, output: 0.6 },
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
  // Tournaments polled for open questions. MiniBench rounds are discovered at runtime.
  tournaments: list('FENESH_TOURNAMENTS', 'fall-futureeval-2026'),
  discoverMiniBench: (env.FENESH_MINIBENCH ?? '1') === '1',
  forecasters: list('FENESH_FORECASTERS', 'gpt-6-astra,gpt-6.1-sol,opus-5.5,fable-5.1,gpt-oss-120b'),
  fastModel: env.FENESH_FAST_MODEL ?? 'gpt-oss-120b',
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

export function model(key: string): ModelSpec {
  const m = MODELS[key];
  if (!m) throw new Error(`unknown model ${key}`);
  return m;
}
