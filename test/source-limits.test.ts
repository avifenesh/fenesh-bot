// Sources that refuse: AskNews with an empty wallet (402) is switched off for hours and the owner is told
// once, across restarts; GDELT's repeated 429s back off longer each time; the web search CLI's zero-hit
// answer is a result, not a failure, and a query no engine can match is retried loosened.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let server: Server;
let askStatus = 402;
let askHits = 0;
const dir = mkdtempSync(join(tmpdir(), 'fenesh-limits-'));

beforeAll(async () => {
  server = createServer((_req, res) => {
    askHits++;
    if (askStatus === 200) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ as_dicts: [] })); return; }
    res.writeHead(askStatus); res.end('{"detail":"Insufficient credits"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.FENESH_ASKNEWS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ASKNEWS_API_KEY = 'test';
  process.env.FENESH_DATA_DIR = dir;
  // The CLI answers "empty" to anything with a URL path or quotes, like the live engines did.
  const bin = join(dir, 'ws-cli');
  writeFileSync(bin, `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const req = JSON.parse(s); const q = req.params.params.query;
  require('fs').appendFileSync(${JSON.stringify(join(dir, 'queries.txt'))}, q + '\\n');
  const empty = /site\\.|\\/|"/.test(q);
  process.stdout.write(JSON.stringify({ id: req.id, result: empty
    ? { kind: 'empty', meta: { backend_host: '', count: 0, engine: 'exa', query: q } }
    : { kind: 'ok', meta: { engine: 'exa', count: 1 }, results: [{ title: 'Bo Nix game log 2026 season', url: 'https://www.espn.com/nfl/player/gamelog/_/id/4426338/bo-nix', snippet: 'Passing yards, touchdowns and interceptions by game for the 2026 season.' }] } }) + '\\n');
});
`);
  chmodSync(bin, 0o755);
  process.env.FENESH_WEBSEARCH_BIN = bin;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
afterEach(() => vi.unstubAllGlobals());

const logLines = () => {
  const lines: any[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { lines.push(JSON.parse(String(s))); return true; });
  return { lines, restore: () => spy.mockRestore() };
};

describe('asknews empty wallet', () => {
  it('backs off for hours and alerts once, across a restart', async () => {
    const plan = { queries: ['a', 'b'], wikiTitles: [], marketQueries: [], series: [] };
    const cap = logLines();
    const { SOURCES } = await import('../src/research/sources.ts');
    await SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, plan);
    await SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, plan); // skipped: cooling down
    cap.restore();
    expect(askHits).toBe(2); // the two concurrent searches of the first gather
    expect(cap.lines.filter((l) => l.msg === 'alert')).toHaveLength(1);
    expect(cap.lines.find((l) => l.msg === 'alert').text).toMatch(/AskNews wallet is empty/);

    // A restart: the cooldown and the quiet period come back from the data directory.
    vi.resetModules();
    const cap2 = logLines();
    const again = await import('../src/research/sources.ts');
    await again.SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, plan);
    const { getState, setState } = await import('../src/state.ts');
    expect(askHits).toBe(2);
    // The cooldown ends, the wallet is still empty: one probe, no second alert.
    setState('cool:asknews', 0);
    await again.SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, { ...plan, queries: ['c'] });
    cap2.restore();
    expect(askHits).toBe(3);
    expect(cap2.lines.filter((l) => l.msg === 'alert')).toHaveLength(0);
    expect(cap2.lines.filter((l) => l.msg === 'alert suppressed')).toHaveLength(1);
    expect(getState('cool:asknews')! - Date.now()).toBeGreaterThan(5 * 3600_000);
    // Topped up: the next success clears the alert, so a later empty wallet is reported again.
    setState('cool:asknews', 0);
    askStatus = 200;
    await again.SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, { ...plan, queries: ['d'] });
    expect(getState('alert:asknews-402')).toBeUndefined();
  });
});

describe('gdelt refusals', () => {
  it('backs off longer on each 429 and resets after a success', async () => {
    let calls = 0;
    let status = 429;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return status === 429 ? new Response('Please limit requests to one every 5 seconds', { status: 429 }) : new Response(JSON.stringify({ articles: [] }), { status: 200 }); }));
    const { SOURCES } = await import('../src/research/sources.ts');
    const { getState, setState } = await import('../src/state.ts');
    const news = SOURCES.find((s) => s.name === 'gdelt')!.tools()[0];
    await expect(news.run({ query: 'x' })).rejects.toThrow(/skipped for 10 min/);
    await expect(news.run({ query: 'x' })).rejects.toThrow(/cooling down/);
    expect(calls).toBe(1);
    setState('cool:gdelt', 0);
    await expect(news.run({ query: 'x' })).rejects.toThrow(/skipped for 20 min/);
    setState('cool:gdelt', 0);
    status = 200;
    await news.run({ query: 'x' });
    expect(getState('strikes:gdelt')).toBeUndefined();
    expect(calls).toBe(3);
  }, 30_000);
});

describe('web search', () => {
  it('treats zero hits as an answer and retries a too-narrow query loosened, without Exa', async () => {
    const exa = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', exa);
    const { SOURCES, loosenQuery } = await import('../src/research/sources.ts');
    const web = SOURCES.find((s) => s.name === 'web')!.tools()[0];
    const out = await web.run({ query: 'site.espn.com/nfl/player/gamelog/4426338 "2026" "819"' });
    expect(out).toMatch(/Bo Nix game log/);
    expect(exa).not.toHaveBeenCalled();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'queries.txt'), 'utf8').trim().split('\n')).toEqual([
      'site.espn.com/nfl/player/gamelog/4426338 "2026" "819"', 'site:espn.com 2026 819',
    ]);
    expect(loosenQuery('"site:elpais.com/espana/madrid" "acampada"')).toBe('site:elpais.com acampada');
    expect(loosenQuery('Supreme Court of India judges')).toBe('Supreme Court of India judges');
  });
});
