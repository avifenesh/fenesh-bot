// Outcome sync against a stand-in Metaculus: resolutions come from the feed in bulk, requests are
// spaced, a 429 honors Retry-After, and a rate limit that persists stops the batch (no burst of
// retries), which the next cycle resumes. On 2026-10-06 the old sync sent 176 requests in about a
// second and saved nothing.
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
const hits: { t: number; path: string }[] = [];
let limited = new Set<number>(); // post ids whose detail answers 429
const resolved = new Map<number, string>(); // question id -> resolution

const post = (id: number, withMine: boolean) => ({
  id, title: `p${id}`,
  question: { id: id - 1000, type: 'binary', resolution: resolved.get(id - 1000) ?? null, actual_resolve_time: resolved.has(id - 1000) ? '2026-10-06T00:00:00Z' : null,
    ...(withMine ? { my_forecasts: { score_data: { peer_score: id - 1000 + 0.5 } } } : {}) },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    hits.push({ t: Date.now(), path: u.pathname + u.search });
    const json = (code: number, b: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/api/posts/') return json(200, { results: u.searchParams.getAll('ids').map((x) => post(Number(x), false)) });
    const m = u.pathname.match(/^\/api\/posts\/(\d+)\/$/);
    if (m && limited.has(Number(m[1]))) return json(429, { detail: 'throttled' }, { 'retry-after': '1' });
    if (m) return json(200, post(Number(m[1]), true));
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.METACULUS_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-sync-'));
  process.env.FENESH_METACULUS_GAP_MS = '150';
  process.env.FENESH_METACULUS_BACKOFF_MS = '100';
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe('outcome sync', () => {
  it('fetches in bulk, paces requests, stops on a persistent 429 and resumes next cycle', async () => {
    const store = await import('../src/store.ts');
    for (let i = 1; i <= 30; i++) {
      const id = store.startRun({ postId: 1000 + i, questionId: i, type: 'binary', title: `q${i}`, tournaments: ['t'], closeTime: '2026-10-05T00:00:00Z', options: [] } as any);
      store.finishRun(id, 'submitted', { plan: {}, evidence: [], brief: '', round1: [], forecasts: [], payload: { probability_yes: 0.5 }, headline: '', comment: '', costUsd: 0, disagreement: 0 } as any);
    }
    for (const q of [1, 2, 3]) resolved.set(q, 'yes');
    resolved.set(4, 'annulled');
    limited = new Set([1002]);
    const { syncOutcomes, db } = await import('../src/evaluate.ts');

    const n1 = await syncOutcomes();
    // Two feed pages (25 + 5 posts), the peer score of q1, then q2 answers 429 twice (Retry-After 1 s)
    // and the batch stops: nothing is asked about q3 or q4.
    expect(hits.map((h) => h.path.replace(/\?.*/, ''))).toEqual(['/api/posts/', '/api/posts/', '/api/posts/1001/', '/api/posts/1002/', '/api/posts/1002/']);
    expect(new URL(`http://x${hits[0].path}`).searchParams.getAll('ids')).toHaveLength(25);
    for (let i = 1; i < hits.length; i++) expect(hits[i].t - hits[i - 1].t).toBeGreaterThanOrEqual(120); // 150 ms gap, less timer slack
    expect(hits[4].t - hits[3].t).toBeGreaterThanOrEqual(950); // Retry-After honored
    expect(n1).toBe(1);
    expect(db().prepare('SELECT question_id, resolution, peer_score FROM outcomes').all()).toEqual([{ question_id: 1, resolution: 'yes', peer_score: 1.5 }]);

    // Next cycle: the limit is gone. q1 is done; q2, q3 get their peer scores, q4 (annulled) needs none.
    limited = new Set();
    hits.length = 0;
    const n2 = await syncOutcomes();
    expect(n2).toBe(3);
    expect(hits.map((h) => h.path.replace(/\?.*/, ''))).toEqual(['/api/posts/', '/api/posts/', '/api/posts/1002/', '/api/posts/1003/']);
    const rows = db().prepare('SELECT question_id, resolution, peer_score FROM outcomes ORDER BY question_id').all();
    expect(rows).toEqual([
      { question_id: 1, resolution: 'yes', peer_score: 1.5 },
      { question_id: 2, resolution: 'yes', peer_score: 2.5 },
      { question_id: 3, resolution: 'yes', peer_score: 3.5 },
      { question_id: 4, resolution: 'annulled', peer_score: null },
    ]);
  }, 30_000);
});

describe('retry-after', () => {
  it('reads seconds and HTTP dates', async () => {
    const { retryAfterMs } = await import('../src/metaculus.ts');
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
