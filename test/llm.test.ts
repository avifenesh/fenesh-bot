// Provider hiccups: a 200 that carries a failed or empty response is retried once, then the fallback
// model answers; a refused request (4xx) is not retried.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../src/config.ts';
import { call, effortFor, requestCost } from '../src/llm.ts';
import { dedupeAnswers } from '../src/pipeline.ts';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const solText = (text: string) => ok({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const opusText = (text: string) => ok({ output: { message: { content: [{ text }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });

afterEach(() => vi.unstubAllGlobals());

describe('model calls', () => {
  it('retries a failed 200 once', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ status: 'failed', error: { code: 'server_error' }, output: [] }))
      .mockResolvedValueOnce(solText('answer'));
    vi.stubGlobal('fetch', fetch);
    const r = await call('gpt-6.1-sol', 'q', { label: 't' });
    expect(r.text).toBe('answer');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back after two empty replies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ status: 'completed', output: [] }))
      .mockResolvedValueOnce(ok({ status: 'completed', output: [] }))
      .mockResolvedValueOnce(opusText('from opus'));
    vi.stubGlobal('fetch', fetch);
    const r = await call('gpt-6.1-sol', 'q', { label: 't', fallback: 'opus-5.5' });
    expect(r.text).toBe('from opus');
    expect(r.model).toBe('opus-5.5');
    expect(String(fetch.mock.calls[2][0])).toContain('/converse');
  });

  it('moves on from a hung request to the fallback', async () => {
    const hang = (_u: string, init: any) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const fetch = vi.fn().mockImplementationOnce(hang).mockImplementationOnce(hang).mockResolvedValueOnce(opusText('from opus'));
    vi.stubGlobal('fetch', fetch);
    const t0 = Date.now();
    const r = await call('gpt-6.1-sol', 'q', { label: 't', fallback: 'opus-5.5', timeoutMs: 200 });
    expect(r.text).toBe('from opus');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  // The two failed calls above (empty replies, then hangs) tripped the breaker for Sol.
  it('skips a model that keeps failing and goes straight to the fallback', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(opusText('from opus'));
    vi.stubGlobal('fetch', fetch);
    const r = await call('gpt-6.1-sol', 'q', { label: 't', fallback: 'opus-5.5' });
    expect(r.model).toBe('opus-5.5');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/converse');
    await expect(call('gpt-6.1-sol', 'q', { label: 't', fallback: null })).rejects.toThrow(/skipped after repeated failures/);
  });

  it('does not retry a refused request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"message":"bad input"}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(call('gpt-6-astra', 'q', { label: 't', fallback: null })).rejects.toThrow(/bedrock 400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('every model has a fallback, and a failing one falls through its own chain', async () => {
    for (const [key, m] of Object.entries(MODELS)) expect(MODELS[m.fallback], key).toBeDefined();
    // Fable fails twice -> Sonnet 5.5 (its fallback) answers.
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(opusText('from sonnet'));
    vi.stubGlobal('fetch', fetch);
    const r = await call('fable-5.1', 'q', { label: 't' });
    expect(r.model).toBe('sonnet-5.5');
    expect(String(fetch.mock.calls.at(-1)![0])).toContain('claude-sonnet-5-5');
  }, 60_000);

  it('never asks for less than medium effort, and always asks for the cache', async () => {
    expect(effortFor('low')).toBe('medium');
    expect(effortFor('minimal')).toBe('medium');
    expect(effortFor('high')).toBe('high');
    const fetch = vi.fn().mockResolvedValueOnce(solText('a')).mockResolvedValueOnce(opusText('b'));
    vi.stubGlobal('fetch', fetch);
    await call('gpt-6-astra', 'q', { label: 'cls', effort: 'low' });
    await call('opus-5.5', 'q', { label: 'cls', effort: 'low' });
    const sol = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sol.reasoning.effort).toBe('medium');
    expect(sol.prompt_cache_key).toBe('fenesh:cls');
    const opus = JSON.parse(fetch.mock.calls[1][1].body);
    expect(opus.additionalModelRequestFields.output_config.effort).toBe('medium');
    expect(opus.messages[0].content.at(-1)).toEqual({ cachePoint: { type: 'default' } });
  });

  it('prices cached tokens and long context', async () => {
    const sol = MODELS['gpt-6.1-sol'];
    // 10K uncached, 90K cached, 1K output: (10K*2 + 90K*0.2 + 1K*10) / 1e6
    expect(requestCost(sol, 10_000, 1_000, 90_000, 0)).toBeCloseTo((20_000 + 18_000 + 10_000) / 1e6, 9);
    // Over 272K input: input and cache at 2x, output at 1.5x.
    expect(requestCost(sol, 300_000, 1_000)).toBeCloseTo((2 * 300_000 * 2 + 1.5 * 1_000 * 10) / 1e6, 9);
    // Claude has no long-context tier.
    expect(requestCost(MODELS['opus-5.5'], 300_000, 0)).toBeCloseTo(300_000 * 4 / 1e6, 9);
    const fetch = vi.fn().mockResolvedValueOnce(ok({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }], usage: { input_tokens: 100_000, output_tokens: 1_000, input_tokens_details: { cached_tokens: 90_000, cache_write_tokens: 0 } } }));
    vi.stubGlobal('fetch', fetch);
    const r = await call('gpt-6.1-sol', 'q', { label: 't' });
    expect(r.usage.costUsd).toBeCloseTo(0.048, 9);
    expect(r.usage.cacheRead).toBe(90_000);
  });

  it('keeps one answer per model when two members fell back to the same one', () => {
    const f = (model: string, slot: string, pYes: number) => ({ model, slot, ok: true, costUsd: 0, pYes });
    const out = dedupeAnswers([f('gpt-6-sol', 'gpt-6-astra', 0.3), f('gpt-6-sol', 'gpt-6.1-sol', 0.4), f('opus-5.5', 'opus-5.5', 0.5)]);
    expect(out.map((x) => x.ok)).toEqual([true, false, true]);
  });
});
