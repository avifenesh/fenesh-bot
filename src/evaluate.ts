// Learning loop: fetch resolutions for questions we forecast, then score every component.
// Scores are log scores (natural log of the probability given to what happened); higher is better.
// Metaculus peer scores need the other bots' forecasts, so we also store our own peer score when the
// API reports it.

import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { log } from './log.ts';
import { medianCdf as medianOf, rawCdf, standardize, widen as widenCdf, type Pct } from './numeric.ts';
import type { Question } from './metaculus.ts';

function db(): DatabaseSync {
  const d = new DatabaseSync(`${config.dataDir}/fenesh.db`);
  d.exec('PRAGMA busy_timeout = 15000');
  d.exec(`CREATE TABLE IF NOT EXISTS outcomes (question_id INTEGER PRIMARY KEY, resolution TEXT, resolved_at TEXT, fetched_at TEXT);`);
  try { d.exec(`ALTER TABLE outcomes ADD COLUMN peer_score REAL`); } catch { /* exists */ }
  return d;
}

async function fetchPostJson(postId: number): Promise<any> {
  const res = await fetch(`${config.metaculusBase}/posts/${postId}/`, {
    headers: { Authorization: `Token ${config.metaculusToken}`, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`metaculus ${res.status}`);
  return res.json();
}

// Pull resolutions for every forecast question that has closed and is not yet resolved in our table.
export async function syncOutcomes(): Promise<number> {
  const d = db();
  const rows = d.prepare(`SELECT DISTINCT r.question_id, r.post_id FROM runs r
    LEFT JOIN outcomes o ON o.question_id = r.question_id
    WHERE r.status IN ('submitted','dry_run') AND (o.resolution IS NULL) AND r.close_time < ?`).all(new Date().toISOString()) as any[];
  let n = 0;
  for (const r of rows) {
    try {
      const post = await fetchPostJson(r.post_id);
      const qs: any[] = post.question ? [post.question] : (post.group_of_questions?.questions ?? []);
      const q = qs.find((x) => x.id === r.question_id);
      if (!q || q.resolution == null || q.resolution === '') continue;
      const peer = q.my_forecasts?.score_data?.peer_score ?? q.my_forecasts?.score_data?.spot_peer_score ?? null;
      d.prepare(`INSERT OR REPLACE INTO outcomes (question_id, resolution, resolved_at, fetched_at, peer_score) VALUES (?, ?, ?, ?, ?)`)
        .run(r.question_id, String(q.resolution), q.actual_resolve_time ?? null, new Date().toISOString(), peer);
      n++;
      await new Promise((res) => setTimeout(res, 700));
    } catch (e: any) {
      log.warn('outcome sync', { q: r.question_id, err: e.message });
    }
  }
  log.info('outcomes synced', { checked: rows.length, resolved: n });
  return n;
}

const FLOOR = 1e-4;

// Log score of one forecast against a resolution. Returns null for annulled/ambiguous questions.
export function logScore(q: Question, forecast: { pYes?: number; probs?: Record<string, number>; pcts?: Pct[]; cdf?: number[] }, resolution: string): number | null {
  if (resolution === 'annulled' || resolution === 'ambiguous') return null;
  if (q.type === 'binary') {
    if (forecast.pYes == null) return null;
    const p = resolution === 'yes' ? forecast.pYes : 1 - forecast.pYes;
    return Math.log(Math.max(FLOOR, p));
  }
  if (q.type === 'multiple_choice') {
    if (!forecast.probs) return null;
    const tot = Object.values(forecast.probs).reduce((a, b) => a + b, 0) || 1;
    return Math.log(Math.max(FLOOR, (forecast.probs[resolution] ?? 0) / tot));
  }
  const s = q.scaling;
  if (!s) return null;
  const cdf = forecast.cdf ?? (forecast.pcts ? standardize(s, rawCdf(s, forecast.pcts)) : null);
  if (!cdf) return null;
  const n = cdf.length;
  if (resolution === 'below_lower_bound') return Math.log(Math.max(FLOOR, cdf[0]));
  if (resolution === 'above_upper_bound') return Math.log(Math.max(FLOOR, 1 - cdf[n - 1]));
  const v = q.type === 'date' ? Date.parse(resolution) / 1000 : Number(resolution);
  if (!Number.isFinite(v)) return null;
  const { rangeMin: lo, rangeMax: hi, zeroPoint: z } = s;
  const loc = z == null ? (v - lo) / (hi - lo)
    : (Math.log((v - lo) * ((hi - z) / (lo - z) - 1) + (hi - lo)) - Math.log(hi - lo)) / Math.log((hi - z) / (lo - z));
  const i = Math.min(n - 2, Math.max(0, Math.floor(loc * (n - 1))));
  // Probability mass of the bucket holding the outcome, scaled to a density per bucket.
  return Math.log(Math.max(FLOOR, cdf[i + 1] - cdf[i]) * (n - 1));
}

export interface ScoreRow { component: string; n: number; meanLog: number }

// Mean log score per component (each model per round, and what we submitted).
export function report(statuses = ['submitted', 'dry_run']): { rows: ScoreRow[]; resolved: number; peerMean: number | null } {
  const d = db();
  const runs = d.prepare(`SELECT r.id, r.question, r.payload, o.resolution, o.peer_score FROM runs r
    JOIN outcomes o ON o.question_id = r.question_id WHERE r.status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as any[];
  const acc = new Map<string, number[]>();
  const add = (k: string, v: number | null) => { if (v == null) return; (acc.get(k) ?? acc.set(k, []).get(k)!).push(v); };
  const peers: number[] = [];
  for (const r of runs) {
    const q: Question = JSON.parse(r.question);
    const payload = JSON.parse(r.payload ?? 'null');
    if (payload) {
      const sub = payload.probability_yes != null ? { pYes: payload.probability_yes }
        : payload.probability_yes_per_category ? { probs: payload.probability_yes_per_category }
        : { cdf: payload.continuous_cdf };
      add('submitted', logScore(q, sub, r.resolution));
    }
    if (r.peer_score != null) peers.push(r.peer_score);
    const comps = d.prepare(`SELECT round, model, forecast FROM components WHERE run_id = ? AND ok = 1`).all(r.id) as any[];
    for (const c of comps) add(`${c.model} r${c.round}`, logScore(q, JSON.parse(c.forecast), r.resolution));
  }
  const rows = [...acc.entries()].map(([component, v]) => ({ component, n: v.length, meanLog: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.meanLog - a.meanLog);
  return { rows, resolved: runs.length, peerMean: peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : null };
}

// ---- Aggregation replay: score alternative aggregation settings on the archived components ----
// No model calls: every variant is recomputed from what each model said on resolved questions.

const lg = (p: number) => Math.log(p / (1 - p));
const ilg = (x: number) => 1 / (1 + Math.exp(-x));
const clip = (p: number, c: number) => Math.min(1 - c, Math.max(c, p));
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const k = s.length; return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

type BinaryVariant = (ps: number[], market: number | null) => number;

export const BINARY_VARIANTS: Record<string, BinaryVariant> = {
  'median clip.02 (live)': (ps) => clip(med(ps), 0.02),
  'median clip.01': (ps) => clip(med(ps), 0.01),
  'median clip.05': (ps) => clip(med(ps), 0.05),
  'mean clip.02': (ps) => clip(mean(ps), 0.02),
  'logodds-mean clip.02': (ps) => clip(ilg(mean(ps.map((p) => lg(clip(p, 0.001))))), 0.02),
  'logodds-mean x1.3 clip.02': (ps) => clip(ilg(1.3 * mean(ps.map((p) => lg(clip(p, 0.001))))), 0.02),
  'median + market w.25': (ps, m) => clip(m == null ? med(ps) : ilg(0.75 * lg(clip(med(ps), 0.001)) + 0.25 * lg(clip(m, 0.001))), 0.02),
  'median + market w.5': (ps, m) => clip(m == null ? med(ps) : ilg(0.5 * lg(clip(med(ps), 0.001)) + 0.5 * lg(clip(m, 0.001))), 0.02),
  'median + market w.75': (ps, m) => clip(m == null ? med(ps) : ilg(0.25 * lg(clip(med(ps), 0.001)) + 0.75 * lg(clip(m, 0.001))), 0.02),
};

export function replay(statuses = ['submitted', 'dry_run']): { component: string; n: number; meanLog: number }[] {
  const d = db();
  const runs = d.prepare(`SELECT r.id, r.question, o.resolution FROM runs r JOIN outcomes o ON o.question_id = r.question_id
    WHERE r.status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as any[];
  const acc = new Map<string, number[]>();
  const add = (k: string, v: number | null) => { if (v == null) return; (acc.get(k) ?? acc.set(k, []).get(k)!).push(v); };
  for (const r of runs) {
    const q: Question = JSON.parse(r.question);
    const comps = d.prepare(`SELECT round, model, forecast FROM components WHERE run_id = ? AND ok = 1`).all(r.id) as any[];
    const finalRound = Math.max(1, ...comps.filter((c) => c.round < 9).map((c) => c.round));
    const members = comps.filter((c) => c.round === finalRound).map((c) => JSON.parse(c.forecast));
    const market = comps.find((c) => c.model === 'market');
    const gutC = comps.find((c) => c.model === 'system1-gut');
    if (!members.length) continue;
    if (q.type === 'binary') {
      const ps = members.map((m) => m.pYes).filter((p: unknown) => typeof p === 'number');
      if (!ps.length) continue;
      const mk = market ? JSON.parse(market.forecast).pYes : null;
      for (const [name, f] of Object.entries(BINARY_VARIANTS)) add(name, logScore(q, { pYes: f(ps, mk) }, r.resolution));
      if (gutC) add('median + system1 member', logScore(q, { pYes: clip(med([...ps, JSON.parse(gutC.forecast).pYes]), 0.02) }, r.resolution));
    } else if (q.type === 'multiple_choice') {
      const opts = q.options;
      const norm = (pr: Record<string, number>) => { const t = opts.reduce((a, o) => a + (pr[o] ?? 0), 0) || 1; return Object.fromEntries(opts.map((o) => [o, (pr[o] ?? 0) / t])); };
      const ms = members.map((m) => norm(m.probs ?? {}));
      add('mc mean (live)', logScore(q, { probs: Object.fromEntries(opts.map((o) => [o, Math.max(0.005, mean(ms.map((m) => m[o])))])) }, r.resolution));
      add('mc median', logScore(q, { probs: Object.fromEntries(opts.map((o) => [o, Math.max(0.005, med(ms.map((m) => m[o])))])) }, r.resolution));
    } else if (q.scaling) {
      const cdfs = members.filter((m) => m.pcts?.length).map((m) => rawCdf(q.scaling!, m.pcts));
      if (!cdfs.length) continue;
      for (const w of [1, 1.15, 1.3, 1.5]) {
        add(`numeric median widen ${w}${w === 1.15 ? ' (live)' : ''}`, logScore(q, { cdf: standardize(q.scaling, widenCdf(medianOf(cdfs), w)) }, r.resolution));
      }
      add('numeric mean widen 1.15', logScore(q, { cdf: standardize(q.scaling, widenCdf(cdfs[0].map((_, i) => mean(cdfs.map((c) => c[i]))), 1.15)) }, r.resolution));
    }
  }
  return [...acc.entries()].map(([component, v]) => ({ component, n: v.length, meanLog: mean(v) })).sort((a, b) => a.component.localeCompare(b.component));
}
