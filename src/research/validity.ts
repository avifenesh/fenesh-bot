// What counts as a valid source: a public http(s) page on a real site, with a title and a snippet, once
// per URL. Spam mirrors (random hostnames, throwaway TLDs), search-result pages and bare IPs do not.
// The research floor (src/pipeline.ts) counts only valid sources, at most a few per domain.

import type { Evidence } from './sources.ts';

// TLDs that in practice carry mostly spam mirrors and scraped copies.
const THROWAWAY_TLDS = new Set(['online', 'xyz', 'top', 'click', 'site', 'buzz', 'icu', 'cfd', 'sbs', 'rest', 'monster', 'quest', 'lol', 'cyou', 'bond', 'autos', 'beauty', 'hair', 'mom', 'skin', 'makeup', 'boats', 'homes', 'yachts', 'zip', 'mov', 'loan', 'win', 'bid', 'gq', 'cf', 'tk', 'ml', 'ga']);
export const PER_DOMAIN_CAP = 3;

export function sourceHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function randomLabel(l: string): boolean {
  if (l.length < 14 || !/^[a-z0-9]+$/.test(l)) return false;
  const digits = (l.match(/\d/g) ?? []).length;
  const letters = l.replace(/\d/g, '');
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  return digits >= 2 && vowels / Math.max(1, letters.length) < 0.34;
}

export function validUrl(url: string | undefined): boolean {
  const host = sourceHost(url);
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return false;
  const labels = host.split('.');
  if (THROWAWAY_TLDS.has(labels[labels.length - 1])) return false;
  // Machine-generated labels such as kbbacdp7bgof4cuc4fadi: long, letters and digits only, several
  // digits, few vowels. Real names (news24online, site1-bridge) keep hyphens or a normal vowel share.
  if (labels.slice(0, -1).some(randomLabel)) return false;
  const u = new URL(url!);
  if (/\/search\b|[?&](q|query|search)=/.test(u.pathname + u.search) && /google|bing|duckduckgo|yahoo|yandex|baidu|startpage|brave/.test(host)) return false;
  return true;
}

export function validSource(e: Evidence): boolean {
  return validUrl(e.url) && (e.title ?? '').trim().length >= 8 && (e.snippet ?? '').trim().length >= 40;
}

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/.test(k)) u.searchParams.delete(k);
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

// Distinct valid sources, at most PER_DOMAIN_CAP per domain, so ten results are not ten pages of one site.
export function countedSources(urls: string[]): string[] {
  const seen = new Set<string>();
  const perDomain = new Map<string, number>();
  const out: string[] = [];
  for (const url of urls) {
    if (!validUrl(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const host = sourceHost(url)!;
    const n = perDomain.get(host) ?? 0;
    if (n >= PER_DOMAIN_CAP) continue;
    perDomain.set(host, n + 1);
    out.push(url);
  }
  return out;
}

// Source URLs a brief cites.
export function citedUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>)\]"'`]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}
