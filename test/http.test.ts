// Page fetches refuse non-public destinations.
import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '../src/research/http.ts';

describe('page fetch guard', () => {
  for (const u of ['http://127.0.0.1:6379/', 'http://localhost/', 'http://10.0.0.8/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'file:///etc/passwd', 'http://192.168.1.1/', 'https://example.com:6379/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://100.100.1.1/']) {
    it(`blocks ${u}`, async () => { await expect(assertPublicUrl(u)).rejects.toThrow(/blocked/); });
  }
  it('unwraps mapped addresses', async () => {
    const { privateIp } = await import('../src/research/http.ts');
    expect(privateIp('::ffff:a9fe:a9fe')).toBe(true);
    expect(privateIp('::ffff:8.8.8.8')).toBe(false);
    expect(privateIp('2606:4700::6810:84e5')).toBe(false);
  });
  it('allows a public host', async () => {
    expect((await assertPublicUrl('https://en.wikipedia.org/wiki/Main_Page')).hostname).toBe('en.wikipedia.org');
  });
});
