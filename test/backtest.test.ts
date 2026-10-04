// Backtest rules: the as-of moment reaches prompts and sources, and selection respects training cutoffs.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-bt-'));

const post = (id: number, open: string, resolution: string | null) => ({
  record: { tournament_key: 'mbtest', practice: false },
  embed_post: {
    id, title: `q${id}`, open_time: open, scheduled_close_time: open, scheduled_resolve_time: open,
    question: { id: id + 1000, type: 'binary', title: `q${id}`, open_time: open, scheduled_close_time: open, scheduled_resolve_time: open, resolution, options: null, scaling: {} },
  },
});

describe('backtest', () => {
  it('runs under the as-of date', async () => {
    const { runAsOf, liveOnly } = await import('../src/asof.ts');
    const { today } = await import('../src/prompts.ts');
    expect(await runAsOf('2026-08-01T10:00:00Z', async () => today())).toBe('2026-08-01');
    await expect(runAsOf('2026-08-01T10:00:00Z', async () => liveOnly('web search'))).rejects.toThrow(/not available in a backtest/);
    expect(() => liveOnly('web search')).not.toThrow();
  });

  it('selects only resolved questions opened after the latest model cutoff', async () => {
    const file = join(process.env.FENESH_DATA_DIR!, 'census.json');
    writeFileSync(file, JSON.stringify([
      post(1, '2026-06-01T00:00:00Z', 'yes'), // before the Claude cutoff
      post(2, '2026-07-20T00:00:00Z', 'no'),
      post(3, '2026-08-20T00:00:00Z', 'yes'),
      post(4, '2026-09-20T00:00:00Z', null), // unresolved
      post(5, '2026-09-25T00:00:00Z', 'annulled'),
      { record: { tournament_key: 'mbtest', practice: false }, embed_post: { id: 6, title: 'group', open_time: '2026-08-02T00:00:00Z',
        group_of_questions: { questions: [
          { id: 1601, type: 'binary', label: 'A', status: 'resolved', open_time: '2026-08-02T00:00:00Z', scheduled_close_time: '2026-08-02T00:00:00Z', scheduled_resolve_time: '2026-08-02T00:00:00Z', resolution: 'no', scaling: {} },
          { id: 1602, type: 'binary', label: 'B', status: 'resolved', open_time: '2026-08-02T00:00:00Z', scheduled_close_time: '2026-08-02T00:00:00Z', scheduled_resolve_time: '2026-08-02T00:00:00Z', resolution: 'yes', scaling: {} },
        ] } } },
    ]));
    const { loadCensus, selectItems } = await import('../src/backtest.ts');
    const items = loadCensus(file);
    expect(items.map((i) => i.question.questionId).sort()).toEqual([1001, 1002, 1003, 1601, 1602]);
    expect(items.find((i) => i.question.questionId === 1602)!.resolution).toBe('yes');
    expect(items.find((i) => i.question.questionId === 1002)!.asOf).toBe('2026-07-20T00:20:00.000Z');
    const claude = selectItems(items, { models: ['opus-5.5', 'gpt-6-sol'], n: 10 });
    expect(claude.map((i) => i.question.questionId).sort()).toEqual([1002, 1003, 1601, 1602]);
    const withGrok = selectItems(items, { models: ['opus-5.5', 'grok-4.7'], n: 10 });
    expect(withGrok).toEqual([]);
  });
});
