// The research floor: web gather tops up with extra queries until it has 10 valid sources, and spam
// never comes back from web search.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { citedUrls, countedSources, validUrl } from '../src/research/validity.ts';

const dir = mkdtempSync(join(tmpdir(), 'fenesh-floor-'));
const calls = join(dir, 'calls.log');
const bin = join(dir, 'fake-cli');
// Per query: three valid results on distinct domains plus one spam mirror.
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const q = JSON.parse(s).params.params.query;
  fs.appendFileSync(${JSON.stringify(calls)}, q + '\\n');
  const slug = q.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const results = [1, 2, 3].map((i) => ({ title: 'Report ' + slug + ' ' + i, url: 'https://site' + i + '-' + slug + '.example.com/a', snippet: 'A real article body with enough text to count as a snippet. '.repeat(2), age: '2026-10-01' }));
  results.push({ title: 'Mirror of everything', url: 'https://kbbacdp7bgof4cuc4fadi.kfy001.online/x', snippet: 'copied text copied text copied text copied text', age: '2026-10-01' });
  process.stdout.write(JSON.stringify({ id: 1, result: { kind: 'ok', results } }) + '\\n');
});
`);
chmodSync(bin, 0o755);
process.env.FENESH_WEBSEARCH_BIN = bin;

describe('research floor', () => {
  it('tops up to 10 valid web sources and drops spam', async () => {
    const { SOURCES } = await import('../src/research/sources.ts');
    const web = SOURCES.find((s) => s.name === 'web')!;
    const q: any = { questionId: 1, title: 'Will the bridge reopen before November 2026?', resolutionCriteria: 'Resolves Yes if the bridge reopens to traffic. Other text.', groupTitle: undefined };
    const items = await web.gather(q, { queries: ['bridge repair status', 'bridge reopening date'], wikiTitles: [], marketQueries: [], series: [] });
    expect(items.some((e) => e.url?.includes('kfy001.online'))).toBe(false);
    expect(countedSources(items.map((e) => e.url!)).length).toBeGreaterThanOrEqual(10);
    const queries = readFileSync(calls, 'utf8').trim().split('\n');
    // Two planned queries give 6 valid sources; the top-up adds queries until the floor is met.
    expect(queries.slice(0, 2).sort()).toEqual(['bridge reopening date', 'bridge repair status']);
    expect(queries.length).toBe(4);
    expect(queries[2]).toBe(q.title);
  });

  it('judges sources', () => {
    expect(validUrl('https://www.reuters.com/world/some-story-2026-10-02/')).toBe(true);
    expect(validUrl('https://kbbacdp7bgof4cuc4fadi.kfy001.online/futureeval')).toBe(false);
    expect(validUrl('https://kbbacdp7bgof4cuc4fadi.example.com/futureeval')).toBe(false);
    expect(validUrl('https://news24online.com/a')).toBe(true);
    expect(validUrl('https://site1-bridge-repair-status.example.com/a')).toBe(true);
    expect(validUrl('https://news.example.xyz/a')).toBe(false);
    expect(validUrl('https://www.google.com/search?q=bridge')).toBe(false);
    expect(validUrl('http://10.0.0.1/a')).toBe(false);
    expect(validUrl('ftp://example.com/a')).toBe(false);
    const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4', 'https://www.a.com/1?utm_source=x', 'https://b.org/1'];
    expect(countedSources(urls)).toEqual(['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.org/1']);
    expect(citedUrls('See https://a.com/x. Also (https://b.org/y), and <https://c.net/z>')).toEqual(['https://a.com/x', 'https://b.org/y', 'https://c.net/z']);
  });
});
