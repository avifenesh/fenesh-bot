// Numeric, discrete and date questions: from declared percentiles to the CDF Metaculus accepts.
//
// The value <-> location mapping and the CDF standardization follow forecasting-tools
// (MIT, Copyright (c) 2024 CodexVeritas), ported to TypeScript. See NOTICE.

import type { Scaling } from './metaculus.ts';

export interface Pct { p: number; v: number } // P(X <= v) = p

// Value -> location in [0, 1] of the question range (can fall outside when beyond the bounds).
export function toLocation(s: Scaling, v: number): number {
  const { rangeMin: lo, rangeMax: hi, zeroPoint: z } = s;
  if (z == null) return (v - lo) / (hi - lo);
  const ratio = (hi - z) / (lo - z);
  const x = v === z ? v + 1e-10 : v;
  return (Math.log((x - lo) * (ratio - 1) + (hi - lo)) - Math.log(hi - lo)) / Math.log(ratio);
}

export function fromLocation(s: Scaling, x: number): number {
  const { rangeMin: lo, rangeMax: hi, zeroPoint: z } = s;
  if (z == null) return lo + (hi - lo) * x;
  const ratio = (hi - z) / (lo - z);
  return lo + ((hi - lo) * (ratio ** x - 1)) / (ratio - 1);
}

// Fritsch-Carlson monotone cubic interpolation (PCHIP) through (xs, ys), xs strictly increasing.
export function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = new Array<number>(n).fill(0);
  if (n === 2) { m[0] = m[1] = d[0]; }
  else {
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    const end = (h0: number, h1: number, d0: number, d1: number) => {
      let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(v) !== Math.sign(d0)) v = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > Math.abs(3 * d0)) v = 3 * d0;
      return v;
    };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3] ?? h[n - 2], d[n - 2], d[n - 3] ?? d[n - 2]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// Clean declared percentiles: sort, drop duplicates, force strictly increasing in both axes.
export function cleanPercentiles(pcts: Pct[]): Pct[] {
  const s = pcts
    .filter((q) => Number.isFinite(q.p) && Number.isFinite(q.v) && q.p > 0 && q.p < 1)
    .sort((a, b) => a.p - b.p);
  const out: Pct[] = [];
  for (const q of s) {
    const prev = out[out.length - 1];
    if (prev && (q.p <= prev.p || q.v <= prev.v)) continue;
    out.push(q);
  }
  if (out.length < 2) throw new Error('need at least two usable percentiles');
  return out;
}

// Raw CDF on the question grid: cdf[i] = P(X <= value at location i/(n-1)).
export function rawCdf(s: Scaling, pcts: Pct[]): number[] {
  const clean = cleanPercentiles(pcts);
  const xs = clean.map((q) => toLocation(s, q.v));
  const ys = clean.map((q) => q.p);
  // Tails: decay linearly in location space at the outer segment slopes, clamped to [0, 1].
  const f = pchip(xs, ys);
  const n = s.cdfSize;
  const cdf: number[] = [];
  for (let i = 0; i < n; i++) {
    cdf.push(Math.min(1, Math.max(0, f(i / (n - 1)))));
  }
  for (let i = 1; i < n; i++) cdf[i] = Math.max(cdf[i], cdf[i - 1]); // monotone
  return cdf;
}

// Stretch a CDF around its median by `factor` in location space (factor > 1 widens).
export function widen(cdf: number[], factor: number): number[] {
  if (factor === 1) return cdf;
  const n = cdf.length;
  const loc = (i: number) => i / (n - 1);
  let mi = cdf.findIndex((v) => v >= 0.5);
  if (mi < 0) mi = n - 1;
  const med = loc(mi);
  const at = (x: number) => {
    const pos = Math.min(n - 1, Math.max(0, x * (n - 1)));
    const i = Math.floor(pos), t = pos - i;
    if (x < 0) return Math.max(0, cdf[0] + (cdf[1] - cdf[0]) * x * (n - 1));
    if (x > 1) return Math.min(1, cdf[n - 1] + (cdf[n - 1] - cdf[n - 2]) * (x - 1) * (n - 1));
    return i >= n - 1 ? cdf[n - 1] : cdf[i] * (1 - t) + cdf[i + 1] * t;
  };
  const out = cdf.map((_, i) => at(med + (loc(i) - med) / factor));
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1]);
  return out;
}

// Pointwise median of several CDFs on the same grid.
export function medianCdf(cdfs: number[][]): number[] {
  const n = cdfs[0].length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const col = cdfs.map((c) => c[i]).sort((a, b) => a - b);
    const k = col.length;
    out.push(k % 2 ? col[(k - 1) / 2] : (col[k / 2 - 1] + col[k / 2]) / 2);
  }
  return out;
}

// Metaculus constraints: no mass beyond closed bounds, a minimum mass beyond open bounds,
// a minimum step everywhere, and a cap on any single bucket.
export function standardize(s: Scaling, input: number[]): number[] {
  const cdf = input.slice();
  const n = cdf.length;
  const lower = s.openLower ? 0 : cdf[0];
  const upper = s.openUpper ? 1 : cdf[n - 1];
  const mass = Math.max(upper - lower, 1e-9);
  for (let i = 0; i < n; i++) {
    const loc = i / (n - 1);
    const F = (cdf[i] - lower) / mass;
    if (s.openLower && s.openUpper) cdf[i] = 0.988 * F + 0.01 * loc + 0.001;
    else if (s.openLower) cdf[i] = 0.989 * F + 0.01 * loc + 0.001;
    else if (s.openUpper) cdf[i] = 0.989 * F + 0.01 * loc;
    else cdf[i] = 0.99 * F + 0.01 * loc;
  }
  // Cap the probability of any inner bucket.
  const pmf = [cdf[0], ...cdf.slice(1).map((v, i) => v - cdf[i]), 1 - cdf[n - 1]];
  const cap = 0.2 * (200 / (n - 1)) * 0.95;
  const capped = (scale: number) => [pmf[0], ...pmf.slice(1, -1).map((v) => Math.min(cap, scale * v)), pmf[pmf.length - 1]];
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let lo = 1, hi = 1;
  while (sum(capped(hi)) < 1) hi *= 1.2;
  let scale = 1;
  for (let k = 0; k < 100; k++) {
    scale = (lo + hi) / 2;
    const sm = sum(capped(scale));
    if (sm < 1) lo = scale; else hi = scale;
    if (sm === 1 || hi - lo < 2e-5) break;
  }
  const out = capped(scale);
  const inner = sum(out.slice(1, -1));
  const want = cdf[n - 1] - cdf[0];
  for (let i = 1; i < out.length - 1; i++) out[i] *= want / inner;
  const res: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += out[i]; res.push(Math.round(acc * 1e10) / 1e10); }
  return res;
}

// Validate what we are about to submit; throws on anything Metaculus would reject.
export function checkCdf(s: Scaling, cdf: number[]): void {
  if (cdf.length !== s.cdfSize) throw new Error(`cdf length ${cdf.length} != ${s.cdfSize}`);
  for (let i = 0; i < cdf.length; i++) {
    if (!(cdf[i] >= 0 && cdf[i] <= 1)) throw new Error(`cdf[${i}] out of range`);
    if (i && cdf[i] - cdf[i - 1] < 5e-5 - 1e-12) throw new Error(`cdf step too small at ${i}`);
  }
  if (!s.openLower && cdf[0] !== 0) throw new Error('closed lower bound needs cdf[0] = 0');
  if (!s.openUpper && Math.abs(cdf[cdf.length - 1] - 1) > 1e-9) throw new Error('closed upper bound needs cdf[-1] = 1');
}

// Percentile summary of a standardized CDF, for comments and logs.
export function quantilesOf(s: Scaling, cdf: number[], ps = [0.1, 0.5, 0.9]): Record<string, number> {
  const n = cdf.length;
  const out: Record<string, number> = {};
  for (const p of ps) {
    let i = cdf.findIndex((v) => v >= p);
    if (i < 0) i = n - 1;
    const x = i === 0 ? 0 : (i - 1 + (p - cdf[i - 1]) / Math.max(cdf[i] - cdf[i - 1], 1e-12)) / (n - 1);
    out[`p${Math.round(p * 100)}`] = fromLocation(s, x);
  }
  return out;
}
