// The standings report the bot sends after new resolutions: counts, peer score, leaderboard rank,
// accuracy against baselines and the best members, from the archive and the Metaculus API.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-standings-'));

afterEach(() => vi.unstubAllGlobals());

describe('standings report', () => {
  it('summarizes resolved forecasts, peer score and leaderboard rank', async () => {
    const store = await import('../src/store.ts');
    const q = (id: number, type: string, extra: any = {}) => ({ postId: 100 + id, questionId: id, type, title: `q${id}`, tournaments: ['minibench'], closeTime: '2026-10-01T00:00:00Z', options: [], ...extra });
    const fs = (m: string, f: any) => ({ model: m, slot: m, ok: true, costUsd: 0, ...f });
    const scaling = { rangeMin: 0, rangeMax: 100, zeroPoint: null, openLower: false, openUpper: false, cdfSize: 201, grid: null };
    const cdf = Array.from({ length: 201 }, (_, i) => i / 200);
    const runs = [
      { q: q(1, 'binary'), payload: { probability_yes: 0.8 }, fs: [fs('opus-5.5', { pYes: 0.9 }), fs('gpt-6.1-sol', { pYes: 0.7 })], res: 'yes', peer: 12.5 },
      { q: q(2, 'binary'), payload: { probability_yes: 0.2 }, fs: [fs('opus-5.5', { pYes: 0.1 }), fs('gpt-6.1-sol', { pYes: 0.3 })], res: 'no', peer: 4.1 },
      { q: q(3, 'numeric', { scaling }), payload: { continuous_cdf: cdf }, fs: [], res: '50', peer: null },
      { q: q(5, 'numeric', { scaling: { ...scaling, openUpper: true } }), payload: { continuous_cdf: cdf.map((v, i) => (i === 200 ? 0.95 : v * 0.95)) }, fs: [], res: 'above_upper_bound', peer: null },
      { q: q(4, 'binary'), payload: { probability_yes: 0.5 }, fs: [], res: null, peer: null }, // not resolved yet
    ];
    for (const r of runs) {
      const id = store.startRun(r.q as any);
      store.finishRun(id, 'submitted', { plan: {}, evidence: [], brief: '', round1: r.fs, forecasts: r.fs, payload: r.payload, headline: '', comment: '', costUsd: 1, disagreement: 0 } as any);
    }
    const { db } = await import('../src/evaluate.ts');
    const d = db();
    for (const r of runs) if (r.res) d.prepare('INSERT INTO outcomes (question_id, resolution, peer_score) VALUES (?, ?, ?)').run(r.q.questionId, r.res, r.peer);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/posts/105/')) return json({ projects: { tournament: [{ id: 33121, slug: 'fall-futureeval-2026', name: 'Fall FutureEval', type: 'tournament' }], default_project: { id: 33121, slug: 'fall-futureeval-2026', name: 'Fall FutureEval', type: 'tournament' }, category: [{ id: 5, type: 'category' }] } });
      if (url.includes('/posts/')) return json({ projects: { question_series: [{ id: 33129, slug: 'minibench', name: 'MiniBench', type: 'question_series' }], default_project: { id: 33129, slug: 'minibench', name: 'MiniBench', type: 'question_series' } } });
      if (url.includes('/leaderboards/project/33121/')) return json([{ is_primary_leaderboard: true, entries: [] }]);
      if (url.includes('/leaderboards/project/33129/')) return json([{ is_primary_leaderboard: true, entries: [
        { user: { username: 'top-bot' }, rank: 1, score: 40 }, { user: { username: 'fenesh-bot', id: 309777 }, rank: 2, score: 16.6 }, { user: { username: 'x' }, rank: 3, score: 1 },
      ] }]);
      return new Response('{}', { status: 404 });
    }));
    const { standingsReport } = await import('../src/standings.ts');
    const text = await standingsReport(3);
    expect(text).toContain('3 new resolutions; 4 of 5 submitted forecasts resolved.');
    expect(text).toContain('Fall FutureEval: leaderboard not published yet');
    expect(text).toContain('Peer score: mean +8.3 over 2 questions (sum +16.6).');
    expect(text).toContain('MiniBench: rank 2 of 3, score 16.60');
    // Brier (0.04 + 0.04) / 2 = 0.04; log (ln .8 + ln .8) / 2 = -0.22
    expect(text).toMatch(/Yes\/no \(2\): Brier 0\.04 vs base rate 0\.\d\d and coin 0\.25; log -0\.22 vs/);
    // An above-range resolution scores the tail mass: the bot put 5% there, the uniform baseline 0.1%
    // (open bound, standardized), so the bot beats the baseline on that question.
    const m = text.match(/Numeric, discrete, date \(2\): log score (-?[\d.]+) vs uniform (-?[\d.]+)\./);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(Number(m![2]));
    expect(text).toMatch(/Best members \(mean log score, round 1\): opus-5\.5 -0\.11, gpt-6\.1-sol -0\.36\./);
  });
});
