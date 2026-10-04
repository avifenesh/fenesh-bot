// The LAYA client against a stand-in laya-serve: request shape, auth, and that every question type
// comes back as a forecast the aggregator and Metaculus accept.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { calibrateBinary, layaForecast } from '../src/laya.ts';
import type { Question, Scaling } from '../src/metaculus.ts';
import { checkCdf, rawCdf, standardize } from '../src/numeric.ts';

const seen: any[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end('{}'); return; }
      const b = JSON.parse(body);
      seen.push(b);
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries<any>(b.questions)) {
        if (q.type === 'noul') answers[k] = { type: 'noul', noul: 0.9 };
        else {
          const keys = Object.keys(q.criteria);
          answers[k] = { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((x, i) => [x, i === 0 ? 0.7 : 0.3 / (keys.length - 1)])) };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.laya.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.laya.key = 'test-key';
});

afterAll(() => { server.close(); });

const base: Question = {
  postId: 1, questionId: 2, type: 'binary', title: 'Will it happen?', description: 'Background.', resolutionCriteria: 'Yes if it happens.',
  finePrint: '', unit: '', options: [], openTime: '2026-10-01T00:00:00Z', closeTime: '2026-10-02T00:00:00Z', resolveTime: '2026-12-01T00:00:00Z',
  scaling: null, weight: 1, tournaments: [], alreadyForecast: false, url: '',
};

describe('laya client', () => {
  it('binary: one noul ask, calibrated, brief inside the token budget', async () => {
    const f = await layaForecast(base, 'x'.repeat(100_000), 'Priors: 30% of such questions resolved Yes.');
    const req = seen.at(-1);
    expect(req.model).toBe(config.laya.model);
    expect(req.max_len).toBe(config.laya.maxLen);
    expect(Object.values<any>(req.questions).map((q) => q.type)).toEqual(['noul']);
    expect(JSON.stringify(req.state).length).toBeLessThan((config.laya.maxLen - 256) * 3.5 + 500);
    expect(f.pYes).toBeCloseTo(calibrateBinary(0.9), 9);
  });

  it('multiple choice: both option orders, position bias cancels', async () => {
    const q = { ...base, type: 'multiple_choice' as const, options: ['Red', 'Green', 'Blue'] };
    const f = await layaForecast(q);
    const sum = Object.values(f.probs!).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    // The stand-in always favours the first key, so after averaging both orders the first and
    // last options tie.
    expect(f.probs!.Red).toBeCloseTo(f.probs!.Blue, 9);
  });

  it('numeric: thresholds make a CDF Metaculus accepts', async () => {
    const s: Scaling = { rangeMin: 10, rangeMax: 1000, zeroPoint: 0, openLower: true, openUpper: true, cdfSize: 201, grid: null };
    const q = { ...base, type: 'numeric' as const, scaling: s, unit: 'units' };
    const f = await layaForecast(q, 'brief');
    expect(f.pcts!.length).toBe(5);
    expect(Object.values<any>(seen.at(-1).questions)[0].instructions).toMatch(/at most [\d.]+ units\?$/);
    const cdf = standardize(s, rawCdf(s, f.pcts!));
    expect(() => checkCdf(s, cdf)).not.toThrow();
  });

  it('refuses without the key', async () => {
    config.laya.key = 'wrong';
    await expect(layaForecast(base)).rejects.toThrow(/laya 401/);
    config.laya.key = 'test-key';
  });
});
