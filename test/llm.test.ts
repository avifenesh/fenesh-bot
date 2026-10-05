// Provider hiccups: a 200 that carries a failed or empty response is retried once, then the fallback
// model answers; a refused request (4xx) is not retried.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/llm.ts';

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

  it('does not retry a refused request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"message":"bad input"}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(call('gpt-6.1-sol', 'q', { label: 't' })).rejects.toThrow(/bedrock 400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
