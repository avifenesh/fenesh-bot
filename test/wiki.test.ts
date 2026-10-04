// Wiki lookups respect the as-of cutoff and match entity pages and digests by keyword.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-wiki-'));

describe('wiki lookup', () => {
  it('filters by keyword and date', async () => {
    const root = `${process.env.FENESH_DATA_DIR}/wiki`;
    mkdirSync(`${root}/entities`, { recursive: true });
    mkdirSync(`${root}/digest`, { recursive: true });
    writeFileSync(`${root}/entities/federal-reserve.md`, '# Federal Reserve\n\n- 2026-09-01: Held rates at 3.75-4.00% (fed.gov) [q1]\n- 2026-10-02: Cut rates by 25 bp (fed.gov) [q2]\n');
    writeFileSync(`${root}/digest/2026-09-30.md`, '# World digest 2026-09-30\n\n- Federal Reserve chair spoke on inflation\n- Unrelated item\n');
    const { lookup } = await import('../src/wiki.ts');
    const all = lookup('federal reserve');
    expect(all).toContain('Cut rates by 25 bp');
    expect(all).toContain('chair spoke');
    const before = lookup('federal reserve', '2026-09-15');
    expect(before).toContain('Held rates');
    expect(before).not.toContain('Cut rates');
    expect(before).not.toContain('chair spoke');
    expect(lookup('zzz nothing')).toBe('nothing on file');
  });
});
