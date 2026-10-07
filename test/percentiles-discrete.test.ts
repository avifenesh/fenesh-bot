// Discrete questions: several percentiles on one outcome are a valid answer. On q46123 (2026-10-06) two
// forecasters put every percentile on 3 and were dropped as "need at least two usable percentiles";
// the replies below are theirs (replayed on the archived brief).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lastJson } from '../src/llm.ts';
import type { Question, Scaling } from '../src/metaculus.ts';
import { checkCdf, cleanPercentiles, rawCdf, standardize } from '../src/numeric.ts';
import { parseForecast } from '../src/pipeline.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/q46123-percentiles.json', import.meta.url), 'utf8'));
const q46123 = { ...fx.question, options: [] } as Question;
const P = [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];

describe('discrete percentiles', () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    it(`accepts ${model}'s q46123 answer with every percentile on 3`, () => {
      const f = parseForecast(q46123, lastJson(fx.replies[model]));
      expect(f.pcts!.every((x) => x.v === 3)).toBe(true);
      const s = q46123.scaling!;
      const cdf = standardize(s, rawCdf(s, f.pcts!));
      checkCdf(s, cdf);
      // Buckets 0, 1, 2, 3 sit between grid points -0.5, 0.5, 1.5, 2.5, 3.5: nearly all mass on 3.
      expect(cdf[4] - cdf[3]).toBeGreaterThan(0.9);
      expect(cdf[3]).toBeLessThan(0.05);
    });
  }

  it('keeps the probability each repeated outcome was given', () => {
    // q46125 (Bitcoin ETF inflow days, 0-2): what two models answered. By these percentiles
    // P(X <= 0) is 20-30% and P(X <= 1) 50-60%; dropping the repeats gave 15% and 45%.
    const s: Scaling = { rangeMin: -0.5, rangeMax: 2.5, zeroPoint: null, openLower: false, openUpper: false, cdfSize: 4, grid: null };
    const v = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2];
    const cdf = rawCdf(s, P.map((p, i) => ({ p, v: v[i] })));
    expect(cdf[1]).toBeGreaterThanOrEqual(0.2);
    expect(cdf[1]).toBeLessThan(0.3);
    expect(cdf[2]).toBeGreaterThanOrEqual(0.5);
    expect(cdf[2]).toBeLessThan(0.6);
    expect(cdf[3]).toBe(1);
    checkCdf(s, standardize(s, cdf));
  });

  it('leaves continuous questions as before: repeats are dropped', () => {
    const s: Scaling = { rangeMin: 0, rangeMax: 50_000, zeroPoint: null, openLower: false, openUpper: true, cdfSize: 201, grid: null, discrete: false };
    const v = [0, 0, 0, 0, 0, 400, 1000, 1700, 2800, 4700, 9200, 15500, 40000];
    const clean = cleanPercentiles(P.map((p, i) => ({ p, v: v[i] })), s);
    expect(clean.map((x) => x.v)).toEqual([0, 400, 1000, 1700, 2800, 4700, 9200, 15500, 40000]);
    expect(() => cleanPercentiles(P.map((p) => ({ p, v: 7 })), s)).toThrow(/two usable/);
  });
});
