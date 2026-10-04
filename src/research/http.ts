// HTTP for research sources: timeouts, a per-host spacing, and readable text from HTML.

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
  const r = await get(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
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

export async function fetchPage(url: string, maxChars = 20_000): Promise<{ url: string; title: string; text: string }> {
  const r = await get(url, { timeoutMs: 30_000, headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' } });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  if (r.type.includes('json') || r.type.includes('text/plain') || r.type.includes('csv')) {
    return { url, title: url, text: r.text.slice(0, maxChars) };
  }
  const { title, text } = htmlToText(r.text);
  return { url, title, text: text.slice(0, maxChars) };
}
