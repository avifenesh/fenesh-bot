// AskNews must not hold up a question: a search that gets no answer times out, and two failures in a
// row skip AskNews entirely for a while.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let hits = 0;

beforeAll(async () => {
  // Accepts the request and never answers.
  server = createServer(() => { hits++; });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.FENESH_ASKNEWS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ASKNEWS_API_KEY = 'test';
  process.env.FENESH_ASKNEWS_TIMEOUT_MS = '300';
});

afterAll(() => { server.closeAllConnections(); server.close(); });

describe('asknews', () => {
  it('times out, then skips after two failures', async () => {
    const { SOURCES } = await import('../src/research/sources.ts');
    const tool = SOURCES.find((s) => s.name === 'asknews')!.tools()[0];
    const t0 = Date.now();
    await expect(tool.run({ query: 'a' })).rejects.toThrow(/no answer in 0.3 s/);
    await expect(tool.run({ query: 'b' })).rejects.toThrow(/no answer in 0.3 s/);
    expect(hits).toBe(2);
    // Skipped without a request.
    await expect(tool.run({ query: 'c' })).rejects.toThrow(/cooling down/);
    expect(hits).toBe(2);
    // The gather step treats a skipped source as no evidence.
    const items = await SOURCES.find((s) => s.name === 'asknews')!.gather({} as any, { queries: ['x', 'y'], wikiTitles: [], marketQueries: [], series: [] });
    expect(items).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
