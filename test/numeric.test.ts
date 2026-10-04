import { describe, expect, it } from 'vitest';
import { rawCdf, standardize, checkCdf, medianCdf, widen, quantilesOf, toLocation, fromLocation } from '../src/numeric.ts';
import type { Scaling } from '../src/metaculus.ts';

const base = { grid: null } as const;
const shapes: Record<string, Scaling> = {
  openBoth: { ...base, rangeMin: -35, rangeMax: 0, zeroPoint: null, openLower: true, openUpper: true, cdfSize: 201 },
  discrete: { ...base, rangeMin: 0.095, rangeMax: 0.805, zeroPoint: null, openLower: true, openUpper: true, cdfSize: 72 },
  smallDiscrete: { ...base, rangeMin: -0.5, rangeMax: 15.5, zeroPoint: null, openLower: false, openUpper: false, cdfSize: 17 },
  date: { ...base, rangeMin: 1653782400, rangeMax: 1811462400, zeroPoint: null, openLower: false, openUpper: true, cdfSize: 201 },
  log: { ...base, rangeMin: 1, rangeMax: 1e6, zeroPoint: 0, openLower: false, openUpper: true, cdfSize: 201 },
};

function pctsFor(s: Scaling, center: number, spread: number) {
  const ps = [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
  // Normal-ish in location space, mapped back to values.
  const z = (p: number) => Math.sqrt(2) * erfinv(2 * p - 1);
  return ps.map((p) => ({ p, v: fromLocation(s, center + spread * z(p)) }));
}
function erfinv(x: number) {
  const a = 0.147, l = Math.log(1 - x * x), t = 2 / (Math.PI * a) + l / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - l / a) - t);
}

describe('numeric CDF', () => {
  for (const [name, s] of Object.entries(shapes)) {
    it(`builds a valid CDF for ${name}`, () => {
      const cdfs = [0.4, 0.5, 0.6].map((c) => rawCdf(s, pctsFor(s, c, 0.12)));
      const agg = standardize(s, widen(medianCdf(cdfs), 1.2));
      checkCdf(s, agg);
      const q = quantilesOf(s, agg);
      expect(toLocation(s, q.p50)).toBeGreaterThan(0.35);
      expect(toLocation(s, q.p50)).toBeLessThan(0.65);
      expect(q.p10).toBeLessThan(q.p50);
      expect(q.p50).toBeLessThan(q.p90);
    });
  }
  it('survives a spike and out-of-range percentiles', () => {
    const s = shapes.openBoth;
    const cdf = standardize(s, rawCdf(s, [{ p: 0.05, v: -20 }, { p: 0.5, v: -19.99 }, { p: 0.95, v: 50 }]));
    checkCdf(s, cdf);
  });
  it('round-trips log-scale locations', () => {
    const s = shapes.log;
    for (const v of [1, 10, 1000, 999999]) expect(fromLocation(s, toLocation(s, v))).toBeCloseTo(v, 4);
  });
});
