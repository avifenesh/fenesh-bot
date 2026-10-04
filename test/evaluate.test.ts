// Archive -> outcomes -> per-component scores, on a temporary database.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-eval-'));

const q = (id: number, type: string, extra: any = {}) => ({
  postId: id, questionId: id, type, title: `q${id}`, description: '', resolutionCriteria: '', finePrint: '', unit: '',
  options: extra.options ?? [], openTime: '', closeTime: '2026-01-01T00:00:00Z', resolveTime: '', scaling: extra.scaling ?? null,
  weight: 1, tournaments: ['t'], alreadyForecast: false, url: '',
});

describe('evaluation', () => {
  it('scores submitted forecasts and each model against resolutions', async () => {
    const store = await import('../src/store.ts');
    const { report } = await import('../src/evaluate.ts');
    const fs = (m: string, f: any) => ({ model: m, ok: true, costUsd: 0, ...f });
    const runs = [
      { q: q(1, 'binary'), payload: { probability_yes: 0.8 }, fs: [fs('a', { pYes: 0.9 }), fs('b', { pYes: 0.6 })], res: 'yes' },
      { q: q(2, 'binary'), payload: { probability_yes: 0.3 }, fs: [fs('a', { pYes: 0.1 }), fs('b', { pYes: 0.5 }), fs('gpt-oss-120b', { pYes: 0.9 })], res: 'no' },
      { q: q(3, 'multiple_choice', { options: ['x', 'y'] }), payload: { probability_yes_per_category: { x: 0.7, y: 0.3 } },
        fs: [fs('a', { probs: { x: 0.8, y: 0.2 } }), fs('b', { probs: { x: 0.5, y: 0.5 } })], res: 'x' },
    ];
    for (const r of runs) {
      const id = store.startRun(r.q as any);
      store.finishRun(id, 'submitted', { plan: {}, evidence: [], brief: '', round1: r.fs, forecasts: r.fs, payload: r.payload, headline: '', comment: '', costUsd: 1, disagreement: 0 } as any);
    }
    const d = new DatabaseSync(`${process.env.FENESH_DATA_DIR}/fenesh.db`);
    for (const r of runs) d.prepare('INSERT INTO outcomes (question_id, resolution) VALUES (?, ?)').run(r.q.questionId, r.res);
    const rep = report();
    expect(rep.resolved).toBe(3);
    const by = Object.fromEntries(rep.rows.map((x) => [x.component, x]));
    expect(by['a r1'].n).toBe(3);
    expect(by['a r1'].meanLog).toBeCloseTo((Math.log(0.9) + Math.log(0.9) + Math.log(0.8)) / 3, 6);
    expect(by.submitted.meanLog).toBeCloseTo((Math.log(0.8) + Math.log(0.7) + Math.log(0.7)) / 3, 6);
    expect(by['a r1'].meanLog).toBeGreaterThan(by['b r1'].meanLog);

    const { replay } = await import('../src/evaluate.ts');
    const v = Object.fromEntries(replay().map((x) => [x.component, x]));
    expect(v['median clip.02 (live)'].n).toBe(2);
    // median of {0.9, 0.6} = 0.75 on a Yes, median of {0.1, 0.5, 0.9} = 0.5 on a No
    expect(v['median clip.02 (live)'].meanLog).toBeCloseTo((Math.log(0.75) + Math.log(0.5)) / 2, 6);
    expect(v['mc mean (live)'].n).toBe(1);
    // Only question 2 had the open model: with it the median is 0.5, without it 0.3.
    expect(v['median without open model'].n).toBe(1);
    expect(v['median without open model'].meanLog).toBeCloseTo(Math.log(0.7), 6);
  });
});
