// Standings report, sent to the owner (src/alert.ts) after an outcome sync that found new resolutions:
// how many forecasts resolved, peer score, leaderboard rank where Metaculus publishes one, accuracy
// against simple baselines, and the best ensemble members.

import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { db, fetchPostJson, logScore, report } from './evaluate.ts';
import { log } from './log.ts';
import type { Question } from './metaculus.ts';
import { standardize } from './numeric.ts';

const RATES = JSON.parse(readFileSync(new URL('./base-rates.json', import.meta.url), 'utf8'));
const BASE_RATE = RATES.overall.yes / RATES.overall.n; // share of past tournament yes/no questions that resolved Yes

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const signed = (x: number) => (x >= 0 ? `+${x.toFixed(1)}` : x.toFixed(1));

// Our row on a project's leaderboard, if Metaculus has published entries yet.
async function leaderboardLine(projectId: number, name: string): Promise<string> {
  try {
    const res = await fetch(`${config.metaculusBase}/leaderboards/project/${projectId}/`, {
      headers: { Authorization: `Token ${config.metaculusToken}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `${name}: leaderboard unavailable (HTTP ${res.status})`;
    const body = await res.json();
    const boards: any[] = Array.isArray(body) ? body : [body];
    const board = boards.find((b) => b?.is_primary_leaderboard) ?? boards[0];
    const entries: any[] = board?.entries ?? [];
    if (!entries.length) return `${name}: leaderboard not published yet`;
    const i = entries.findIndex((e) => e?.user?.username === 'fenesh-bot' || e?.user?.id === 309777);
    if (i < 0) return `${name}: not on the leaderboard yet (${entries.length} entrants)`;
    const e = entries[i];
    return `${name}: rank ${e.rank ?? i + 1} of ${entries.length}, score ${f2(Number(e.score))}`;
  } catch (e: any) {
    return `${name}: leaderboard check failed (${e.message})`;
  }
}

export async function standingsReport(newlyResolved: number): Promise<string> {
  const d = db();
  const total = (d.prepare(`SELECT COUNT(DISTINCT question_id) AS n FROM runs WHERE status = 'submitted'`).get() as any).n;
  const rows = d.prepare(`SELECT r.question, r.payload, r.post_id, o.resolution, o.peer_score FROM runs r
    JOIN outcomes o ON o.question_id = r.question_id
    WHERE r.status = 'submitted' AND o.resolution NOT IN ('annulled', 'ambiguous')`).all() as any[];
  const lines = [`Standings: ${newlyResolved} new resolution${newlyResolved === 1 ? '' : 's'}; ${rows.length} of ${total} submitted forecasts resolved.`];

  const peers = rows.map((r) => r.peer_score).filter((x): x is number => typeof x === 'number');
  lines.push(peers.length ? `Peer score: mean ${signed(mean(peers))} over ${peers.length} questions (sum ${signed(peers.reduce((a, b) => a + b, 0))}).` : 'Peer score: not computed by Metaculus yet.');

  // One leaderboard line per project the resolved questions belong to: tournaments list themselves under
  // `tournament`, MiniBench under `question_series` and `default_project` (as in src/metaculus.ts).
  const projects = new Map<number, { name: string }>();
  const seenPosts = new Set<number>();
  for (const r of rows.slice(-20)) {
    if (projects.size >= 4 || seenPosts.size >= 5) break;
    if (seenPosts.has(r.post_id)) continue;
    seenPosts.add(r.post_id);
    try {
      const pr = (await fetchPostJson(r.post_id)).projects ?? {};
      for (const p of [...(pr.tournament ?? []), ...(pr.question_series ?? []), pr.default_project]) {
        if (p?.id && p.type !== 'site_main' && p.type !== 'category' && !projects.has(p.id)) projects.set(p.id, { name: p.name ?? p.slug ?? String(p.id) });
      }
    } catch { /* leaderboard lines are best effort */ }
  }
  for (const [id, p] of projects) lines.push(await leaderboardLine(id, p.name));

  const binary = rows.filter((r) => JSON.parse(r.question).type === 'binary' && JSON.parse(r.payload ?? 'null')?.probability_yes != null);
  if (binary.length) {
    const ys = binary.map((r) => (r.resolution === 'yes' ? 1 : 0));
    const ps = binary.map((r) => JSON.parse(r.payload).probability_yes as number);
    const brier = (p: (i: number) => number) => mean(ys.map((y, i) => (p(i) - y) ** 2));
    const ll = (p: (i: number) => number) => mean(ys.map((y, i) => Math.log(y ? p(i) : 1 - p(i))));
    lines.push(`Yes/no (${binary.length}): Brier ${f2(brier((i) => ps[i]))} vs base rate ${f2(brier(() => BASE_RATE))} and coin ${f2(brier(() => 0.5))}; log ${f2(ll((i) => ps[i]))} vs ${f2(ll(() => BASE_RATE))} and ${f2(ll(() => 0.5))}.`);
  }
  for (const [label, types] of [['Numeric, discrete, date', ['numeric', 'discrete', 'date']], ['Multiple choice', ['multiple_choice']]] as const) {
    const rs = rows.filter((r) => (types as readonly string[]).includes(JSON.parse(r.question).type));
    if (!rs.length) continue;
    const scores = rs.map((r) => {
      const q: Question = JSON.parse(r.question);
      const p = JSON.parse(r.payload ?? 'null');
      const sub = p?.probability_yes_per_category ? { probs: p.probability_yes_per_category } : { cdf: p?.continuous_cdf };
      return logScore(q, sub, r.resolution);
    }).filter((x): x is number => x != null);
    // The uniform baseline is scored the same way, so out-of-range resolutions count its tail mass.
    const uniform = rs.map((r) => {
      const q: Question = JSON.parse(r.question);
      if (q.type === 'multiple_choice') return logScore(q, { probs: Object.fromEntries(q.options.map((o) => [o, 1 / q.options.length])) }, r.resolution);
      if (!q.scaling) return null;
      const n = q.scaling.cdfSize;
      return logScore(q, { cdf: standardize(q.scaling, Array.from({ length: n }, (_, i) => i / (n - 1))) }, r.resolution);
    }).filter((x): x is number => x != null);
    const baseline = `uniform ${f2(mean(uniform))}`;
    lines.push(`${label} (${rs.length}): log score ${f2(mean(scores))} vs ${baseline}.`);
  }

  const members = report(['submitted']).rows.filter((x) => / r1$/.test(x.component) && x.n >= Math.max(1, Math.floor(rows.length / 2)));
  if (members.length) lines.push(`Best members (mean log score, round 1): ${members.slice(0, 4).map((m) => `${m.component.replace(/ r1$/, '')} ${f2(m.meanLog)}`).join(', ')}.`);
  log.info('standings', { resolved: rows.length, total });
  return lines.join('\n');
}
