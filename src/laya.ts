// System 1 vote: LAYA through the local laya-serve sidecar (POST /v1/systemone).
//
// LAYA is a non-generative decision model: it reads a state and typed questions and returns
// probabilities in one forward pass, with no reasoning. Its model card sets how it is asked here:
// - the base checkpoints are near chance zero-shot and ship over-confident, so every probability
//   goes through a calibration fitted on resolved tournament questions (src/laya-calibration.json,
//   written by sidecar/calibrate.py). With no signal the fit is flat and LAYA votes the base rate;
//   a refit or a fine-tuned checkpoint moves it without code changes;
// - accuracy holds up to about 4,000 tokens of text, so the state is trimmed to config.laya.maxLen;
// - yes/no is asked as `noul`, the form that scored best on the census (sidecar/census_eval.py);
//   multiple choice is asked in both option orders and averaged to cancel position bias.

import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { log } from './log.ts';
import type { Question } from './metaculus.ts';
import { fromLocation, type Pct } from './numeric.ts';
import { today } from './prompts.ts';

interface Calibration {
  fitted: string;
  binary: { a: number; b: number }; // logit p' = a logit p + b
  threshold: { a: number; b: number; c: number }; // logit p' = a logit p + b + c logit x, x = range location
  choice: { t: number; mix: number }; // p' = (1 - mix) * normalize(p ^ (1 / t)) + mix / k
}

const CAL = JSON.parse(readFileSync(new URL('./laya-calibration.json', import.meta.url), 'utf8')) as Calibration;

// Range locations asked as "at most v" thresholds for numeric, discrete and date questions.
export const THRESHOLD_LOCATIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => { const c = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(c / (1 - c)); };

export function calibrateBinary(p: number, c = CAL): number {
  return sigmoid(c.binary.a * logit(p) + c.binary.b);
}

export function calibrateThreshold(p: number, x: number, c = CAL): number {
  return sigmoid(c.threshold.a * logit(p) + c.threshold.b + c.threshold.c * logit(x));
}

export function calibrateChoice(ps: number[], c = CAL): number[] {
  const powed = ps.map((p) => Math.max(p, 1e-6) ** (1 / c.choice.t));
  const tot = powed.reduce((a, b) => a + b, 0);
  return powed.map((p) => (1 - c.choice.mix) * (p / tot) + c.choice.mix / ps.length);
}

interface LayaAnswer { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }

async function systemOne(state: Record<string, string>, questions: Record<string, unknown>): Promise<Record<string, LayaAnswer>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  try {
    const res = await fetch(`${config.laya.url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.laya.key ? { Authorization: `Bearer ${config.laya.key}` } : {}) },
      body: JSON.stringify({ state, questions, model: config.laya.model, max_len: config.laya.maxLen }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`laya ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).answers;
  } finally {
    clearTimeout(timer);
  }
}

// Roughly 3.5 characters per token for English; the option prompt has its own 256-token head budget.
function stateBudgetChars(): number {
  return Math.max(2000, (config.laya.maxLen - 256) * 3.5);
}

// The same fields the calibration was fitted on (sidecar/census_eval.py), plus the brief and priors
// when there are any. The brief fills what is left of the budget.
export function layaState(q: Question, brief?: string, priors?: string): Record<string, string> {
  const s: Record<string, string> = {
    question: q.groupTitle ? `${q.groupTitle}: ${q.title}` : q.title,
    today: today(),
    forecast_closes: q.closeTime.slice(0, 10),
    resolves: q.resolveTime.slice(0, 10),
    resolution_criteria: q.resolutionCriteria.slice(0, 1500),
    fine_print: q.finePrint.slice(0, 800),
    background: q.description.slice(0, 2500),
  };
  if (q.type === 'multiple_choice') s.options = q.options.join(' | ');
  if (priors) s.priors = priors.slice(0, 1500);
  if (brief) {
    const used = Object.values(s).reduce((a, v) => a + v.length + 20, 0);
    s.research_brief = brief.slice(0, Math.max(0, stateBudgetChars() - used));
  }
  return s;
}

const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function fmt(v: number, q: Question): string {
  if (q.type === 'date') return new Date(v * 1000).toISOString().slice(0, 10);
  return Math.abs(v) >= 100 ? String(Math.round(v)) : v.toPrecision(4);
}

export interface LayaForecast { pYes?: number; probs?: Record<string, number>; pcts?: Pct[]; raw: unknown; summary: string }

// One System 1 forecast. Without a brief this is the no-research gut read the calibration was fitted on.
export async function layaForecast(q: Question, brief?: string, priors?: string): Promise<LayaForecast> {
  const state = layaState(q, brief, priors);
  const t0 = Date.now();
  let out: LayaForecast;
  if (q.type === 'binary') {
    const a = await systemOne(state, { yes: { type: 'noul', instructions: 'Will this forecasting question resolve Yes?' } });
    const raw = Number(a.yes?.noul);
    if (!Number.isFinite(raw)) throw new Error('laya returned no noul answer');
    const pYes = calibrateBinary(raw);
    out = { pYes, raw: { noul: raw }, summary: `LAYA ${(raw * 100).toFixed(1)}% raw, ${(pYes * 100).toFixed(1)}% calibrated` };
  } else if (q.type === 'multiple_choice') {
    const k = q.options.length;
    if (k > KEYS.length) throw new Error(`too many options for laya (${k})`);
    const ask = (order: string[]) => ({ type: 'choice', instructions: 'Which option will this forecasting question resolve to?', criteria: Object.fromEntries(order.map((o, i) => [KEYS[i], o])) });
    const rev = [...q.options].reverse();
    const a = await systemOne(state, { fwd: ask(q.options), rev: ask(rev) });
    const fwd = q.options.map((_, i) => Number(a.fwd?.probabilities?.[KEYS[i]]));
    const bwd = q.options.map((_, i) => Number(a.rev?.probabilities?.[KEYS[k - 1 - i]]));
    if (![...fwd, ...bwd].every(Number.isFinite)) throw new Error('laya returned incomplete choice probabilities');
    const cal = calibrateChoice(fwd.map((p, i) => (p + bwd[i]) / 2));
    out = { probs: Object.fromEntries(q.options.map((o, i) => [o, cal[i]])), raw: { fwd, rev: bwd }, summary: 'LAYA choice, both option orders averaged, calibrated' };
  } else {
    const s = q.scaling;
    if (!s) throw new Error('numeric question without scaling');
    const unit = q.unit ? ` ${q.unit}` : '';
    const values = THRESHOLD_LOCATIONS.map((x) => fromLocation(s, x));
    const qs = Object.fromEntries(values.map((v, i) => [`t${i}`, { type: 'noul', instructions: `Will the value this question resolves to be ${q.type === 'date' ? 'on or before' : 'at most'} ${fmt(v, q)}${q.type === 'date' ? '' : unit}?` }]));
    const a = await systemOne(state, qs);
    const raw = values.map((_, i) => Number(a[`t${i}`]?.noul));
    if (!raw.every(Number.isFinite)) throw new Error('laya returned incomplete threshold answers');
    // Calibrate, then force a strictly increasing CDF through the thresholds.
    const ps: number[] = [];
    THRESHOLD_LOCATIONS.forEach((x, i) => {
      const p = Math.min(0.99, Math.max(0.01, calibrateThreshold(raw[i], x)));
      ps.push(i && p <= ps[i - 1] + 0.005 ? Math.min(0.995, ps[i - 1] + 0.005) : p);
    });
    out = { pcts: values.map((v, i) => ({ p: ps[i], v })), raw: { thresholds: raw }, summary: 'LAYA thresholds at range locations 0.1 to 0.9, calibrated' };
  }
  log.info('laya', { q: q.questionId, type: q.type, ms: Date.now() - t0, brief: !!brief, raw: out.raw });
  return out;
}

export async function layaHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${config.laya.url}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
