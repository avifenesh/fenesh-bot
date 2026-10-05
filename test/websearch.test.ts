// Web search through the harness-websearch CLI protocol: a stand-in binary for the contract, and the
// real binary when one is built locally (avifenesh/tools).
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harnessSearch } from '../src/research/sources.ts';

describe('harness web search', () => {
  it('sends one JSON-RPC request with the keyless engine chain and maps results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fenesh-ws-'));
    const bin = join(dir, 'fake-cli');
    // Echo the request back inside the result so the test can check what was sent.
    writeFileSync(bin, `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const req = JSON.parse(s);
  process.stdout.write(JSON.stringify({ id: req.id, result: { kind: 'ok', meta: { engine: 'parallel', count: 2 }, results: [
    { title: 'A', url: 'https://a.example/1', snippet: JSON.stringify(req.params), age: '2026-10-02' },
    { title: 'B', url: 'https://b.example/2', snippet: 'b', age: '3 days ago' },
  ] } }) + '\\n');
});
`);
    chmodSync(bin, 0o755);
    const out = await harnessSearch('kennedy center', 5, bin);
    expect(out.map((e) => [e.source, e.title, e.published])).toEqual([['web', 'A', '2026-10-02'], ['web', 'B', undefined]]);
    const sent = JSON.parse(out[0].snippet);
    expect(sent.params).toEqual({ query: 'kennedy center', count: 5 });
    expect(sent.session.engine_order[0]).toBe('exa');
    expect(sent.session.unsafe_allow_search_without_hook).toBe(true);
  });

  it('surfaces a CLI error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fenesh-ws-'));
    const bin = join(dir, 'fail-cli');
    writeFileSync(bin, '#!/bin/sh\necho \'{"id":1,"result":{"kind":"error","message":"no engine answered"}}\'\n');
    chmodSync(bin, 0o755);
    await expect(harnessSearch('x', 5, bin)).rejects.toThrow(/no engine answered/);
  });

  const real = join(homedir(), 'projects/tools/target/release/harness-websearch-cli');
  it.skipIf(!existsSync(real))('real CLI returns dated results', async () => {
    const out = await harnessSearch('Metaculus forecasting tournament', 5, real);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].url).toMatch(/^https?:\/\//);
  }, 60_000);
});
