// Page fetches refuse non-public destinations.
import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '../src/research/http.ts';

describe('page fetch guard', () => {
  for (const u of ['http://127.0.0.1:6379/', 'http://localhost/', 'http://10.0.0.8/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'file:///etc/passwd', 'http://192.168.1.1/', 'https://example.com:6379/']) {
    it(`blocks ${u}`, async () => { await expect(assertPublicUrl(u)).rejects.toThrow(/blocked/); });
  }
  it('allows a public host', async () => {
    expect((await assertPublicUrl('https://en.wikipedia.org/wiki/Main_Page')).hostname).toBe('en.wikipedia.org');
  });
});
