// HTTP for research sources: timeouts, a per-host spacing, and readable text from HTML.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { config } from '../config.ts';

const nextSlot = new Map<string, number>();
const spacingMs: Record<string, number> = {
  'api.gdeltproject.org': 5_200, // GDELT asks for at most one request per 5 s
  'mcp.exa.ai': 1_200,
  'en.wikipedia.org': 1_000, // Wikimedia rate-limits anonymous API traffic hard
  'api.coingecko.com': 2_500,
};

async function throttle(host: string): Promise<void> {
  const gap = spacingMs[host] ?? 250;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gap);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export async function get(url: string, opts: { timeoutMs?: number; headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<{ status: number; text: string; type: string }> {
  const u = new URL(url);
  await throttle(u.hostname);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    body: opts.body,
    headers: { 'user-agent': config.userAgent, accept: '*/*', ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    redirect: 'follow',
  });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, text, type };
}

export async function getJson(url: string, opts: Parameters<typeof get>[1] = {}): Promise<any> {
  let r = await get(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  // Back off on 429 a few times before giving up (Wikimedia and Polymarket throttle bursts).
  for (let attempt = 0; r.status === 429 && attempt < 3; attempt++) {
    await new Promise((res) => setTimeout(res, 4_000 * 2 ** attempt));
    r = await get(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  }
  if (r.status >= 400) throw new Error(`${r.status} ${url}: ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text);
}

// Main readable text of an HTML page; falls back to all visible text.
export function htmlToText(html: string): { title: string; text: string } {
  // linkedom needs a root element; some pages and fragments come without one.
  const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
  const { document } = parseHTML(doc);
  for (const el of document.querySelectorAll('script,style,noscript,svg')) el.remove();
  let title = document.title ?? '';
  let text = '';
  try {
    const art = new Readability(document as any).parse();
    if (art?.textContent && art.textContent.trim().length > 400) {
      title = art.title || title;
      text = art.textContent;
    }
  } catch { /* fall through */ }
  if (!text) text = document.body?.textContent ?? '';
  return { title: title.trim(), text: text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim() };
}

// Reading a single page the way a person's browser would; many news sites refuse non-browser agents.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// The research model chooses URLs, and fetched pages can try to steer it, so page fetches only go
// to public addresses: no loopback, private, link-local, CGNAT, multicast or metadata ranges, checked
// on every redirect. IPv4-mapped and NAT64 IPv6 forms are unwrapped first, in dotted or hex notation.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) blocked.addSubnet(net, bits, 'ipv6');

function embeddedIpv4(v6: string): string | null {
  // ::ffff:a.b.c.d, ::ffff:hhhh:hhhh, ::a.b.c.d, 64:ff9b::hhhh:hhhh (NAT64)
  const m = v6.toLowerCase().match(/^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return blocked.check(ip, 'ipv4');
  if (isIP(ip) !== 6) return true; // not an address we understand: refuse
  const v4 = embeddedIpv4(ip);
  if (v4) return blocked.check(v4, 'ipv4');
  return blocked.check(ip, 'ipv6');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`blocked scheme ${u.protocol}`);
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error(`blocked port ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(privateIp)) throw new Error(`blocked non-public address for ${host}`);
  return u;
}

export async function fetchPage(url: string, maxChars = 20_000): Promise<{ url: string; title: string; text: string }> {
  const headers = { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
  let current = (await assertPublicUrl(url)).toString();
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    await throttle(new URL(current).hostname);
    res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get('location');
    if (!loc) break;
    current = (await assertPublicUrl(new URL(loc, current).toString())).toString();
  }
  if (!res) throw new Error('no response');
  const r = { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  if (r.type.includes('json') || r.type.includes('text/plain') || r.type.includes('csv')) {
    return { url, title: url, text: r.text.slice(0, maxChars) };
  }
  const { title, text } = htmlToText(r.text);
  return { url, title, text: text.slice(0, maxChars) };
}
