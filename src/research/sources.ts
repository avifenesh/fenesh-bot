// Research sources. Each source turns a research plan into evidence items and can expose tools
// to the agentic research pass. New sources plug in by adding to SOURCES.

import type { Question } from '../metaculus.ts';
import type { ToolSpec } from '../llm.ts';
import { log } from '../log.ts';
import { fetchPage, get, getJson, htmlToText } from './http.ts';

export interface Evidence {
  source: string;
  title: string;
  url?: string;
  published?: string; // ISO date when known
  snippet: string;
}

export interface SeriesRef { kind: 'fred' | 'crypto' | 'stock'; id: string }

export interface ResearchPlan {
  queries: string[]; // web/news queries
  wikiTitles: string[];
  marketQueries: string[];
  series: SeriesRef[];
}

export interface ResearchSource {
  name: string;
  gather(q: Question, plan: ResearchPlan): Promise<Evidence[]>;
  tools(): ToolSpec[];
}

// Sources that answer 429 are skipped for a while instead of being hit on every call.
const coolUntil = new Map<string, number>();
function cooling(name: string): void {
  if ((coolUntil.get(name) ?? 0) > Date.now()) throw new Error(`${name} rate-limited, cooling down`);
}
function cool(name: string, minutes = 10): void { coolUntil.set(name, Date.now() + minutes * 60_000); }

// ---------- GDELT news (keyless; one request per 5 s) ----------

async function gdeltSearch(query: string, days = 30, max = 15): Promise<Evidence[]> {
  const u = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  u.search = new URLSearchParams({ query: `${query} sourcelang:english`, mode: 'artlist', maxrecords: String(max), format: 'json', timespan: `${days}d`, sort: 'datedesc' }).toString();
  cooling('gdelt');
  const r = await get(u.toString(), { timeoutMs: 30_000 });
  if (r.status === 429 || /limit requests/i.test(r.text.slice(0, 200))) { cool('gdelt'); throw new Error('gdelt rate-limited'); }
  if (!r.text.startsWith('{')) return []; // GDELT answers plain-text errors for bad queries
  const d = JSON.parse(r.text);
  return (d.articles ?? []).map((a: any) => ({
    source: 'gdelt', title: a.title, url: a.url,
    published: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : undefined,
    snippet: `${a.domain ?? ''}`,
  }));
}

const gdelt: ResearchSource = {
  name: 'gdelt',
  async gather(_q, plan) {
    const out: Evidence[] = [];
    for (const query of plan.queries.slice(0, 3)) {
      try { out.push(...(await gdeltSearch(query))); } catch (e: any) { log.warn('gdelt', { err: e.message }); }
    }
    return out;
  },
  tools: () => [{
    name: 'news_search',
    description: 'Search recent English-language news articles (GDELT). Returns titles, URLs and dates; use fetch_page to read one.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, days: { type: 'integer', description: 'look-back window, 1-90' } }, required: ['query'] },
    run: async ({ query, days }) => fmt(await gdeltSearch(query, Math.min(90, Math.max(1, days ?? 30)))),
  }],
};

// ---------- Exa web search through its hosted MCP endpoint ----------

async function exaSearch(query: string, n = 8): Promise<Evidence[]> {
  cooling('exa');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (process.env.EXA_API_KEY) headers['x-api-key'] = process.env.EXA_API_KEY;
  const r = await get('https://mcp.exa.ai/mcp', {
    method: 'POST', headers, timeoutMs: 30_000,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: n } } }),
  });
  if (r.status === 429) { cool('exa'); throw new Error('exa HTTP 429'); }
  if (r.status >= 400) throw new Error(`exa HTTP ${r.status}`);
  let msg: any;
  if (r.type.includes('event-stream')) {
    for (const line of r.text.split('\n')) if (line.startsWith('data: ')) { try { msg = JSON.parse(line.slice(6)); } catch { /* skip */ } }
  } else msg = JSON.parse(r.text);
  if (msg?.error) throw new Error(`exa: ${msg.error.message}`);
  const text: string = (msg?.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
  const out: Evidence[] = [];
  for (const rec of text.split(/\n(?=Title: )/)) {
    const title = rec.match(/^Title: (.*)$/m)?.[1]?.trim();
    const url = rec.match(/^URL: (.*)$/m)?.[1]?.trim();
    if (!title || !url) continue;
    const pub = rec.match(/^Published: (.*)$/m)?.[1]?.trim();
    const body = rec.split(/^(?:Highlights|Text|Summary):\s*$/m)[1] ?? '';
    out.push({ source: 'exa', title, url, published: pub && pub !== 'N/A' ? pub.slice(0, 10) : undefined, snippet: body.replace(/\n---[\s\S]*$/, '').trim().slice(0, 1500) });
  }
  return out;
}

const exa: ResearchSource = {
  name: 'exa',
  async gather(_q, plan) {
    const res = await Promise.allSettled(plan.queries.slice(0, 5).map((q) => exaSearch(q, 6)));
    return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  },
  tools: () => [{
    name: 'web_search',
    description: 'General web search. Returns titles, URLs, dates and relevant passages.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => fmt(await exaSearch(query, 8), true),
  }],
};

// ---------- Wikipedia ----------

async function wikiExtract(title: string, chars = 6000): Promise<Evidence | null> {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', prop: 'extracts|info', explaintext: '1', redirects: '1', titles: title, format: 'json', inprop: 'url' }).toString();
  const d = await getJson(u.toString());
  const page: any = Object.values(d.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  return { source: 'wikipedia', title: page.title, url: page.fullurl, published: page.touched?.slice(0, 10), snippet: String(page.extract ?? '').slice(0, chars) };
}

async function wikiSearch(query: string): Promise<string[]> {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '5', format: 'json' }).toString();
  const d = await getJson(u.toString());
  return (d.query?.search ?? []).map((s: any) => s.title);
}

const wikipedia: ResearchSource = {
  name: 'wikipedia',
  async gather(_q, plan) {
    const titles = plan.wikiTitles.slice(0, 3);
    const res = await Promise.allSettled(titles.map((t) => wikiExtract(t, 4000)));
    return res.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
  },
  tools: () => [{
    name: 'wikipedia',
    description: 'Read a Wikipedia article (plain text). If the exact title is unknown, pass a search phrase; the best match is returned.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: async ({ title }) => {
      let e = await wikiExtract(title, 12000);
      if (!e) { const hit = (await wikiSearch(title))[0]; if (hit) e = await wikiExtract(hit, 12000); }
      return e ? `${e.title} (${e.url}, last edited ${e.published})\n\n${e.snippet}` : 'no article found';
    },
  }],
};

// ---------- Prediction markets: Polymarket and Manifold ----------

export interface MarketQuote {
  venue: 'polymarket' | 'manifold';
  question: string;
  outcome: string; // e.g. "Yes"
  probability: number;
  volumeUsd?: number;
  closeTime?: string;
  url: string;
}

export async function polymarketSearch(query: string): Promise<MarketQuote[]> {
  const u = new URL('https://gamma-api.polymarket.com/public-search');
  u.search = new URLSearchParams({ q: query, limit_per_type: '6', events_status: 'active' }).toString();
  const d = await getJson(u.toString());
  const out: MarketQuote[] = [];
  for (const e of d.events ?? []) {
    for (const m of e.markets ?? []) {
      if (m.closed || !m.outcomePrices) continue;
      const outcomes: string[] = JSON.parse(m.outcomes ?? '[]');
      const prices: number[] = JSON.parse(m.outcomePrices ?? '[]').map(Number);
      const i = outcomes.indexOf('Yes');
      if (i < 0) continue;
      out.push({ venue: 'polymarket', question: m.question, outcome: 'Yes', probability: prices[i], volumeUsd: Number(m.volumeNum ?? m.volume ?? 0), closeTime: m.endDate, url: `https://polymarket.com/event/${e.slug}` });
    }
  }
  return out;
}

export async function manifoldSearch(query: string): Promise<MarketQuote[]> {
  const u = new URL('https://api.manifold.markets/v0/search-markets');
  u.search = new URLSearchParams({ term: query, limit: '6', filter: 'open' }).toString();
  const d = await getJson(u.toString());
  return (d as any[])
    .filter((m) => m.outcomeType === 'BINARY' && typeof m.probability === 'number')
    .map((m) => ({ venue: 'manifold' as const, question: m.question, outcome: 'Yes', probability: m.probability, volumeUsd: m.volume, closeTime: m.closeTime ? new Date(m.closeTime).toISOString() : undefined, url: m.url }));
}

export async function marketSearch(query: string): Promise<MarketQuote[]> {
  const res = await Promise.allSettled([polymarketSearch(query), manifoldSearch(query)]);
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

function quoteLine(m: MarketQuote): string {
  const vol = m.volumeUsd ? `, volume $${Math.round(m.volumeUsd).toLocaleString('en-US')}` : '';
  return `[${m.venue}] ${m.question}: ${(m.probability * 100).toFixed(1)}% ${m.outcome}${vol}, closes ${m.closeTime?.slice(0, 10) ?? '?'} (${m.url})`;
}

const markets: ResearchSource = {
  name: 'markets',
  async gather(_q, plan) {
    const res = await Promise.allSettled(plan.marketQueries.slice(0, 3).map(marketSearch));
    const seen = new Set<string>();
    return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .filter((m) => !seen.has(m.question) && seen.add(m.question))
      .map((m) => ({ source: 'markets', title: m.question, url: m.url, snippet: quoteLine(m) }));
  },
  tools: () => [{
    name: 'market_search',
    description: 'Search open prediction markets (Polymarket, Manifold) for current crowd probabilities on related events.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => (await marketSearch(query)).map(quoteLine).join('\n') || 'no open markets found',
  }],
};

// ---------- Resolution source: pages linked from the criteria ----------

export function linksIn(text: string): string[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.add(m[0].replace(/[.,;]+$/, ''));
  return [...urls];
}

const resolution: ResearchSource = {
  name: 'resolution',
  async gather(q) {
    const urls = linksIn(`${q.resolutionCriteria}\n${q.finePrint}`).slice(0, 4);
    const res = await Promise.allSettled(urls.map((u) => fetchPage(u, 8000)));
    return res.flatMap((r, i) => (r.status === 'fulfilled'
      ? [{ source: 'resolution', title: r.value.title || urls[i], url: urls[i], snippet: r.value.text }]
      : []));
  },
  tools: () => [{
    name: 'fetch_page',
    description: 'Fetch a web page or data file and return its readable text (first 20k characters).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => { const p = await fetchPage(url, 20_000); return `${p.title}\n${p.url}\n\n${p.text}`; },
  }],
};

// ---------- Data series: FRED, CoinGecko, Yahoo Finance ----------

export interface Series { ref: SeriesRef; points: Array<[string, number]> } // [ISO date, value]

export async function fetchSeries(ref: SeriesRef, days = 400): Promise<Series> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  if (ref.kind === 'fred') {
    const r = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(ref.id)}&cosd=${since}`);
    if (r.status >= 400) throw new Error(`FRED ${r.status}`);
    const points = r.text.trim().split('\n').slice(1).map((l) => l.split(','))
      .filter(([, v]) => v && v !== '.').map(([d, v]) => [d, Number(v)] as [string, number]);
    return { ref, points };
  }
  if (ref.kind === 'crypto') {
    const d = await getJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(ref.id)}/market_chart?vs_currency=usd&days=${Math.min(days, 365)}&interval=daily`);
    return { ref, points: (d.prices ?? []).map(([t, v]: [number, number]) => [new Date(t).toISOString().slice(0, 10), v]) };
  }
  const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ref.id)}?range=2y&interval=1d`);
  const res = d.chart?.result?.[0];
  if (!res) throw new Error('yahoo: no data');
  const closes: number[] = res.indicators?.quote?.[0]?.close ?? [];
  const points = (res.timestamp ?? []).map((t: number, i: number) => [new Date(t * 1000).toISOString().slice(0, 10), closes[i]] as [string, number])
    .filter(([, v]: [string, number]) => Number.isFinite(v));
  return { ref, points: points.filter(([d]: [string, number]) => d >= since) };
}

// Summary statistics the forecasters can use without doing arithmetic themselves.
export function describeSeries(s: Series): string {
  const pts = s.points;
  if (pts.length < 2) return `${s.ref.kind}:${s.ref.id}: not enough data`;
  const last = pts[pts.length - 1];
  const vals = pts.map(([, v]) => v);
  const at = (back: number) => pts[Math.max(0, pts.length - 1 - back)][1];
  // Daily log returns for a random-walk spread estimate (only meaningful for positive series).
  const rets: number[] = [];
  for (let i = 1; i < vals.length; i++) if (vals[i] > 0 && vals[i - 1] > 0) rets.push(Math.log(vals[i] / vals[i - 1]));
  const sd = rets.length > 5 ? Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) : NaN;
  const recent = pts.slice(-12).map(([d, v]) => `${d}: ${v}`).join('; ');
  return [
    `${s.ref.kind}:${s.ref.id} latest ${last[1]} on ${last[0]} (${pts.length} points since ${pts[0][0]})`,
    `change vs 5 obs ago ${(last[1] - at(5)).toPrecision(4)}, vs 20 obs ago ${(last[1] - at(20)).toPrecision(4)}`,
    `range over window: min ${Math.min(...vals)} max ${Math.max(...vals)}`,
    Number.isFinite(sd) ? `per-observation log-return sd ${sd.toPrecision(3)} (random walk: sd over k steps ~ ${sd.toPrecision(3)} x sqrt(k))` : '',
    `recent: ${recent}`,
  ].filter(Boolean).join('\n');
}

const series: ResearchSource = {
  name: 'series',
  async gather(_q, plan) {
    const res = await Promise.allSettled(plan.series.slice(0, 4).map((r) => fetchSeries(r)));
    return res.flatMap((r) => (r.status === 'fulfilled'
      ? [{ source: 'series', title: `${r.value.ref.kind}:${r.value.ref.id}`, snippet: describeSeries(r.value) }]
      : []));
  },
  tools: () => [{
    name: 'data_series',
    description: 'Fetch a daily time series with summary statistics. kind=fred (FRED series id, e.g. UNRATE, CPIAUCSL, DFF), crypto (CoinGecko coin id, e.g. bitcoin), stock (Yahoo ticker, e.g. ^GSPC, AAPL, CL=F).',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['fred', 'crypto', 'stock'] }, id: { type: 'string' }, days: { type: 'integer' } }, required: ['kind', 'id'] },
    run: async ({ kind, id, days }) => describeSeries(await fetchSeries({ kind, id }, Math.min(1500, days ?? 400))),
  }],
};

// ---------- Wikipedia Current Events: dated daily summaries of world news ----------

const dayCache = new Map<string, { at: number; lines: string[] }>();

function portalTitle(d: Date): string {
  const m = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `Portal:Current_events/${d.getUTCFullYear()}_${m}_${d.getUTCDate()}`;
}

export async function currentEventsDay(d: Date): Promise<string[]> {
  const title = portalTitle(d);
  const hit = dayCache.get(title);
  const isToday = d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  // Past days are final; today's page is refreshed every 2 hours.
  if (hit && (!isToday || Date.now() - hit.at < 2 * 3600_000)) return hit.lines;
  const r = await get(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`, { timeoutMs: 20_000 });
  if (r.status === 404) { dayCache.set(title, { at: Date.now(), lines: [] }); return []; }
  if (r.status >= 400) throw new Error(`current events ${r.status}`);
  const { text } = htmlToText(r.text);
  const date = d.toISOString().slice(0, 10);
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 40).map((l) => `${date}: ${l}`);
  dayCache.set(title, { at: Date.now(), lines });
  return lines;
}

function keywordsOf(texts: string[]): string[] {
  const stop = new Set('will the a an of in on by to for and or with be is are was were before after than at from this that which what who when how many much more less between during under over end its their there as it not no any all into about per'.split(' '));
  const words = texts.join(' ').toLowerCase().match(/[a-z0-9][a-z0-9.'-]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !stop.has(w)))];
}

export async function currentEvents(terms: string[], days = 14, max = 40): Promise<Evidence[]> {
  const kws = keywordsOf(terms);
  const out: { score: number; line: string; date: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    let lines: string[] = [];
    try { lines = await currentEventsDay(d); } catch (e: any) { log.warn('current events', { err: e.message }); break; }
    for (const line of lines) {
      const low = line.toLowerCase();
      const score = kws.reduce((a, k) => a + (low.includes(k) ? 1 : 0), 0);
      if (score >= 2) out.push({ score, line, date: line.slice(0, 10) });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((o) => ({ source: 'current-events', title: o.line.slice(12, 160), published: o.date, snippet: o.line.slice(12) }));
}

const currentEventsSource: ResearchSource = {
  name: 'current-events',
  async gather(q, plan) { return currentEvents([q.title, ...plan.queries], 14); },
  tools: () => [{
    name: 'current_events',
    description: "Wikipedia's daily Current Events summaries of world news, filtered by keywords, newest first.",
    parameters: { type: 'object', properties: { keywords: { type: 'string', description: 'space-separated keywords' }, days: { type: 'integer', description: '1-60' } }, required: ['keywords'] },
    run: async ({ keywords, days }) => {
      const items = await currentEvents([String(keywords)], Math.min(60, Math.max(1, days ?? 21)), 60);
      return items.map((e) => `${e.published}: ${e.snippet}`).join('\n') || 'no matching entries';
    },
  }],
};

export const SOURCES: ResearchSource[] = [exa, gdelt, currentEventsSource, wikipedia, markets, resolution, series];

export function fmt(items: Evidence[], withSnippet = false): string {
  if (!items.length) return 'no results';
  return items.map((e, i) => `${i + 1}. ${e.title}${e.published ? ` (${e.published})` : ''}\n   ${e.url ?? ''}${withSnippet && e.snippet ? `\n   ${e.snippet.slice(0, 600).replace(/\n+/g, ' ')}` : ''}`).join('\n');
}
