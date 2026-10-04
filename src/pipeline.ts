// One question, end to end: plan, gather, research brief, forecasters, aggregation,
// disagreement check, comment. Submission is the caller's job.

import { config } from './config.ts';
import { call, lastJson, type ToolSpec } from './llm.ts';
import { log } from './log.ts';
import type { ForecastPayload, Question } from './metaculus.ts';
import { checkCdf, medianCdf, quantilesOf, rawCdf, standardize, widen, type Pct } from './numeric.ts';
import { forecastPrompt, planPrompt, researchPrompt, supervisorPrompt } from './prompts.ts';
import { SOURCES, type Evidence, type ResearchPlan } from './research/sources.ts';
import { classify, gut, matchMarket, type MarketMatch } from './system1.ts';
import { wikiTool } from './wiki.ts';

export interface ForecasterOutput {
  model: string;
  ok: boolean;
  error?: string;
  costUsd: number;
  summary?: string;
  pYes?: number;
  probs?: Record<string, number>;
  pcts?: Pct[];
  reasoning?: string;
}

export interface RunResult {
  plan: ResearchPlan;
  evidence: Evidence[];
  brief: string;
  round1: ForecasterOutput[];
  addendum?: string;
  forecasts: ForecasterOutput[];
  payload: ForecastPayload;
  headline: string; // human summary of the final forecast
  market: MarketMatch | null; // exact-match market, if one was found
  marketWeight: number; // weight the market got in the binary aggregate
  gut?: { pYes?: number; probs?: Record<string, number> }; // fast forecast with no research, logged only
  baseRate?: string;
  shadow: ForecasterOutput[]; // extra models on the same brief, archived and scored, never submitted
  comment: string;
  costUsd: number;
  disagreement: number;
}

class Budget {
  spent = 0;
  cap: number;
  constructor(cap: number) { this.cap = cap; }
  add(usd: number) { this.spent += usd; }
  left() { return this.cap - this.spent; }
}

function researchTools(): ToolSpec[] {
  return [...SOURCES.flatMap((s) => s.tools()), wikiTool()];
}

async function makePlan(q: Question, b: Budget): Promise<ResearchPlan> {
  const fallback: ResearchPlan = { queries: [q.title], wikiTitles: [], marketQueries: [q.title.slice(0, 80)], series: [] };
  try {
    const r = await call(config.fastModel, planPrompt(q), { label: 'plan', maxTokens: 4000 });
    b.add(r.usage.costUsd);
    const j = lastJson(r.text);
    return {
      queries: (j.queries ?? []).filter((s: unknown) => typeof s === 'string').slice(0, 6),
      wikiTitles: (j.wiki_titles ?? []).filter((s: unknown) => typeof s === 'string').slice(0, 3),
      marketQueries: (j.market_queries ?? []).filter((s: unknown) => typeof s === 'string').slice(0, 3),
      series: (j.series ?? []).filter((s: any) => s && ['fred', 'crypto', 'stock'].includes(s.kind) && typeof s.id === 'string').slice(0, 3),
    };
  } catch (e: any) {
    log.warn('plan failed, using fallback', { q: q.questionId, err: e.message });
    return fallback;
  }
}

async function gather(q: Question, plan: ResearchPlan): Promise<Evidence[]> {
  const res = await Promise.allSettled(SOURCES.map((s) => Promise.race([
    s.gather(q, plan),
    new Promise<Evidence[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 120_000)),
  ])));
  const seen = new Set<string>();
  const out: Evidence[] = [];
  res.forEach((r, i) => {
    if (r.status === 'rejected') { log.warn('source failed', { source: SOURCES[i].name, err: String(r.reason?.message ?? r.reason) }); return; }
    for (const e of r.value) {
      const key = e.url ?? `${e.source}:${e.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  });
  return out;
}

function digest(items: Evidence[], maxChars = 30_000): string {
  let s = '';
  for (const e of items) {
    const line = `- [${e.source}] ${e.title}${e.published ? ` (${e.published})` : ''}${e.url ? ` <${e.url}>` : ''}\n  ${e.snippet.slice(0, e.source === 'resolution' || e.source === 'series' || e.source === 'wikipedia' ? 2500 : 500).replace(/\n+/g, '\n  ')}\n`;
    if (s.length + line.length > maxChars) break;
    s += line;
  }
  return s || '(nothing found automatically)';
}

async function writeBrief(q: Question, items: Evidence[], b: Budget): Promise<string> {
  try {
    const r = await call(config.researchModel, researchPrompt(q, digest(items)), {
      label: 'research', effort: 'medium', tools: researchTools(), maxToolRounds: 14, maxTokens: 24000,
    });
    b.add(r.usage.costUsd);
    if (r.text.trim().length > 200) return r.text.trim();
    throw new Error('empty brief');
  } catch (e: any) {
    log.warn('research failed, forecasting from the raw digest', { q: q.questionId, err: e.message });
    return `(The analyst step failed; raw search results follow.)\n${digest(items)}`;
  }
}

function parseForecast(q: Question, j: any): Pick<ForecasterOutput, 'pYes' | 'probs' | 'pcts' | 'summary'> {
  const summary = typeof j.summary === 'string' ? j.summary : undefined;
  if (q.type === 'binary') {
    const y = Number(j.p_yes), n = Number(j.p_no);
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
    if (!ok(y) && !ok(n)) throw new Error('no usable p_yes/p_no');
    const pYes = ok(y) && ok(n) ? (y + (1 - n)) / 2 : ok(y) ? y : 1 - n;
    return { pYes, summary };
  }
  if (q.type === 'multiple_choice') {
    const raw: Record<string, number> = j.probabilities ?? {};
    const norm = (s: string) => s.trim().toLowerCase();
    const probs: Record<string, number> = {};
    for (const o of q.options) {
      const k = Object.keys(raw).find((x) => norm(x) === norm(o));
      const v = k ? Number(raw[k]) : NaN;
      probs[o] = Number.isFinite(v) && v >= 0 ? v : NaN;
    }
    if (Object.values(probs).filter(Number.isFinite).length < q.options.length - 1) throw new Error('missing option probabilities');
    for (const o of q.options) if (!Number.isFinite(probs[o])) probs[o] = 0.01;
    return { probs, summary };
  }
  const pc = j.percentiles ?? {};
  const pcts: Pct[] = Object.entries(pc).map(([k, v]) => {
    const p = Number(k) / 100;
    const val = q.type === 'date' ? Date.parse(String(v)) / 1000 : Number(v);
    return { p, v: val };
  }).filter((x) => Number.isFinite(x.p) && Number.isFinite(x.v));
  if (pcts.length < 5) throw new Error('too few percentiles');
  if (q.scaling) rawCdf(q.scaling, pcts); // throws on percentiles that cannot form a CDF
  return { pcts, summary };
}

async function forecastOne(q: Question, modelKey: string, brief: string, extra: string, b: Budget): Promise<ForecasterOutput> {
  let costUsd = 0;
  try {
    const r = await call(modelKey, forecastPrompt(q, brief, extra), { label: 'forecast' });
    costUsd += r.usage.costUsd;
    let parsed;
    try { parsed = parseForecast(q, lastJson(r.text)); }
    catch {
      // Let the fast model pull the answer out of the reasoning.
      const fix = await call(config.fastModel, `Extract the final forecast from this text as the JSON object it was asked to end with. Return only the JSON.\n\n${r.text.slice(-12000)}`, { label: 'repair', maxTokens: 3000 });
      costUsd += fix.usage.costUsd;
      parsed = parseForecast(q, lastJson(fix.text));
    }
    b.add(costUsd);
    return { model: modelKey, ok: true, costUsd, reasoning: r.text.slice(0, 20_000), ...parsed };
  } catch (e: any) {
    b.add(costUsd);
    log.warn('forecaster failed', { q: q.questionId, model: modelKey, err: e.message });
    return { model: modelKey, ok: false, error: e.message, costUsd };
  }
}

const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number, lo: number) => Math.min(1 - lo, Math.max(lo, p));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length;
  return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2;
}

// Disagreement on a 0..1-ish scale per type, used to decide whether the supervisor runs.
function disagreement(q: Question, fs: ForecasterOutput[]): number {
  const ok = fs.filter((f) => f.ok);
  if (ok.length < 2) return 0;
  if (q.type === 'binary') {
    const l = ok.map((f) => logit(clamp(f.pYes!, 0.01)));
    return (Math.max(...l) - Math.min(...l)) / 2; // 0.8 ~ 0.2 vs 0.5
  }
  if (q.type === 'multiple_choice') {
    return Math.max(...q.options.map((o) => {
      const v = ok.map((f) => f.probs![o]);
      return Math.max(...v) - Math.min(...v);
    })) * 2;
  }
  const s = q.scaling!;
  const meds = ok.map((f) => {
    const c = rawCdf(s, f.pcts!);
    const i = c.findIndex((v) => v >= 0.5);
    return (i < 0 ? c.length - 1 : i) / (c.length - 1);
  });
  return (Math.max(...meds) - Math.min(...meds)) * 3;
}

// Weight for an exact-match market in the binary aggregate (log-odds blend). Liquid real-money
// markets get more; play-money markets less. Zero when the match is not confident.
export function marketWeight(m: MarketMatch | null): number {
  if (!m || m.confidence < 0.7) return 0;
  const w = Number(process.env.FENESH_MARKET_WEIGHT ?? 0.5);
  if (m.quote.venue === 'polymarket') return (m.quote.volumeUsd ?? 0) >= 10_000 ? w : 0;
  return (m.quote.volumeUsd ?? 0) >= 2_000 ? w / 2 : 0;
}

export function aggregate(q: Question, fs: ForecasterOutput[], market: MarketMatch | null = null): { payload: ForecastPayload; headline: string; marketWeight: number } {
  const ok = fs.filter((f) => f.ok);
  if (!ok.length) throw new Error('no forecaster produced a usable forecast');
  if (q.type === 'binary') {
    const models = clamp(median(ok.map((f) => f.pYes!)), 0.001);
    const w = marketWeight(market);
    const blended = w ? 1 / (1 + Math.exp(-((1 - w) * logit(models) + w * logit(clamp(market!.quote.probability, 0.001))))) : models;
    const p = clamp(blended, config.binaryClip);
    const head = `${(p * 100).toFixed(1)}% Yes${w ? ` (models ${(models * 100).toFixed(1)}%, market ${(market!.quote.probability * 100).toFixed(1)}% at weight ${w})` : ''}`;
    return { payload: { probability_yes: Math.round(p * 1000) / 1000 }, headline: head, marketWeight: w };
  }
  if (q.type === 'multiple_choice') {
    const mean: Record<string, number> = {};
    for (const o of q.options) mean[o] = Math.max(0.005, ok.reduce((a, f) => a + f.probs![o] / (Object.values(f.probs!).reduce((x, y) => x + y, 0) || 1), 0) / ok.length);
    const tot = Object.values(mean).reduce((a, b) => a + b, 0);
    for (const o of q.options) mean[o] = Math.round((mean[o] / tot) * 1e6) / 1e6;
    // Make the rounded values add to exactly 1.
    const last = q.options[q.options.length - 1];
    mean[last] = Math.round((1 - q.options.slice(0, -1).reduce((a, o) => a + mean[o], 0)) * 1e6) / 1e6;
    const head = q.options.map((o) => `${o} ${(mean[o] * 100).toFixed(0)}%`).join(', ');
    return { payload: { probability_yes_per_category: mean }, headline: head, marketWeight: 0 };
  }
  const s = q.scaling!;
  const cdfs = ok.map((f) => rawCdf(s, f.pcts!));
  const cdf = standardize(s, widen(medianCdf(cdfs), Number(process.env.FENESH_NUMERIC_WIDEN ?? 1.15)));
  checkCdf(s, cdf);
  const qs = quantilesOf(s, cdf);
  const show = (v: number) => (q.type === 'date' ? new Date(v * 1000).toISOString().slice(0, 10) : v.toPrecision(4));
  return { payload: { continuous_cdf: cdf }, headline: `median ${show(qs.p50)} (80% interval ${show(qs.p10)} to ${show(qs.p90)})${q.unit ? ` ${q.unit}` : ''}`, marketWeight: 0 };
}

function describe(q: Question, f: ForecasterOutput): string {
  if (!f.ok) return `${f.model}: failed (${f.error})`;
  if (q.type === 'binary') return `${f.model}: ${(f.pYes! * 100).toFixed(1)}%`;
  if (q.type === 'multiple_choice') return `${f.model}: ${q.options.map((o) => `${o} ${(f.probs![o] * 100).toFixed(0)}%`).join(', ')}`;
  const p = (x: number) => f.pcts!.find((c) => Math.abs(c.p - x) < 1e-9)?.v;
  const show = (v?: number) => (v == null ? '?' : q.type === 'date' ? new Date(v * 1000).toISOString().slice(0, 10) : v.toPrecision(4));
  return `${f.model}: p10 ${show(p(0.1))}, p50 ${show(p(0.5))}, p90 ${show(p(0.9))}`;
}

function buildComment(q: Question, r: Omit<RunResult, 'comment'>): string {
  const parts = [
    `Forecast: ${r.headline}`,
    '',
    `Aggregation: ${q.type === 'binary' ? `median of model probabilities, kept within ${config.binaryClip * 100}-${100 - config.binaryClip * 100}%` : q.type === 'multiple_choice' ? 'mean of model probabilities per option' : `pointwise median of model CDFs, widened ${Math.round((Number(process.env.FENESH_NUMERIC_WIDEN ?? 1.15) - 1) * 100)}% around the median`}.`,
    '',
    ...(r.market ? [`Matching market: ${r.market.quote.question} on ${r.market.quote.venue} at ${(r.market.quote.probability * 100).toFixed(1)}% (${r.market.quote.url}), weight ${r.marketWeight}.`, ''] : []),
    'Model forecasts:',
    ...r.forecasts.map((f) => `- ${describe(q, f)}${f.summary ? `. ${f.summary}` : ''}`),
  ];
  if (r.addendum) parts.push('', `The models disagreed (spread ${r.disagreement.toFixed(2)}), so a supervisor checked the crux and the models forecast again. First-round forecasts: ${r.round1.map((f) => describe(q, f)).join('; ')}.`);
  parts.push('', 'Research brief (excerpt):', r.brief.slice(0, 6000));
  return parts.join('\n').slice(0, 9500);
}

export async function runQuestion(q: Question, opts: { forecasters?: string[]; supervisor?: boolean } = {}): Promise<RunResult> {
  const b = new Budget(config.maxCostPerQuestion);
  const plan = await makePlan(q, b);
  const [evidence, cls, market] = await Promise.all([gather(q, plan), classify(q), matchMarket(q, plan.marketQueries)]);
  log.info('gathered', { q: q.questionId, items: evidence.length, market: market ? `${market.quote.venue} ${market.quote.probability} c=${market.confidence}` : null, bySource: Object.fromEntries(SOURCES.map((s) => [s.name, evidence.filter((e) => e.source === s.name).length])) });
  const [brief, g] = await Promise.all([writeBrief(q, evidence, b), gut(q, cls.baseRateText)]);
  b.add(g.costUsd);

  const priors = [
    cls.baseRateText,
    market ? `A prediction market appears to ask this same question: "${market.quote.question}" on ${market.quote.venue}, currently ${(market.quote.probability * 100).toFixed(1)}% Yes${market.quote.volumeUsd ? `, volume about ${Math.round(market.quote.volumeUsd)} ${market.quote.venue === 'polymarket' ? 'USD' : 'mana'}` : ''} (${market.quote.url}). Check that it truly matches before leaning on it.` : '',
  ].filter(Boolean).join('\n');
  const priorsBlock = priors ? `Priors:\n${priors}` : '';

  const models = opts.forecasters ?? config.forecasters;
  const shadowModels = (process.env.FENESH_SHADOW_MODELS ?? '').split(',').map((x) => x.trim()).filter((x) => x && !models.includes(x));
  const [round1, shadow] = await Promise.all([
    Promise.all(models.map((m) => forecastOne(q, m, brief, priorsBlock, b))),
    Promise.all(shadowModels.map((m) => forecastOne(q, m, brief, priorsBlock, b))),
  ]);
  let forecasts = round1;
  const dis = disagreement(q, round1);
  let addendum: string | undefined;
  const threshold = Number(process.env.FENESH_DISAGREEMENT ?? 0.8);
  if ((opts.supervisor ?? true) && dis >= threshold && b.left() > b.cap * 0.35) {
    log.info('supervisor', { q: q.questionId, disagreement: +dis.toFixed(2) });
    try {
      const sv = await call('opus-5.5', supervisorPrompt(q, brief, round1.filter((f) => f.ok).map((f) => `### ${describe(q, f)}\n${(f.reasoning ?? '').slice(-4000)}`).join('\n\n')), {
        label: 'supervisor', tools: researchTools(), maxToolRounds: 10, maxTokens: 20000,
      });
      b.add(sv.usage.costUsd);
      addendum = sv.text.trim();
      const round2 = await Promise.all(models.map((m) => forecastOne(q, m, brief, `${priorsBlock}\n\nAddendum from the supervisor, who checked the points the team disagreed on:\n${addendum}`, b)));
      if (round2.filter((f) => f.ok).length >= Math.min(3, models.length)) forecasts = round2;
    } catch (e: any) {
      log.warn('supervisor failed', { q: q.questionId, err: e.message });
    }
  }
  if (forecasts.filter((f) => f.ok).length < Math.min(2, models.length)) throw new Error('fewer than two forecasters succeeded');
  const { payload, headline, marketWeight: mw } = aggregate(q, forecasts, market);
  const base = { plan, evidence, brief, round1, addendum, forecasts, payload, headline, costUsd: b.spent, disagreement: dis,
    market, marketWeight: mw, gut: g.pYes != null || g.probs ? { pYes: g.pYes, probs: g.probs } : undefined, baseRate: cls.baseRateText, shadow };
  return { ...base, comment: buildComment(q, base) };
}
