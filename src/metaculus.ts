// Metaculus API client: list open questions, post forecasts and comments.

import { config } from './config.ts';
import { log } from './log.ts';

export type QType = 'binary' | 'numeric' | 'discrete' | 'date' | 'multiple_choice';

export interface Scaling {
  rangeMin: number;
  rangeMax: number;
  zeroPoint: number | null;
  openLower: boolean;
  openUpper: boolean;
  cdfSize: number; // inbound_outcome_count + 1
  discrete?: boolean; // one bucket per outcome (missing on questions archived before the flag)
  grid: unknown[] | null; // continuous_range as the API sends it (numbers, or ISO dates for date questions)
}

export interface Question {
  postId: number;
  questionId: number;
  type: QType;
  title: string;
  groupTitle?: string; // parent post title when this is a sub-question of a group
  label?: string;
  description: string;
  resolutionCriteria: string;
  finePrint: string;
  unit: string;
  options: string[];
  openTime: string;
  closeTime: string; // forecasts are scored at close
  resolveTime: string;
  scaling: Scaling | null;
  weight: number;
  tournaments: string[];
  alreadyForecast: boolean;
  url: string;
}

// Every Metaculus request goes through api(): requests are spaced (FENESH_METACULUS_GAP_MS, default 1 s,
// one queue for the whole process), a 429 honors Retry-After (or backs off exponentially with jitter)
// and pauses every caller until then. A caller that cannot wait long (the outcome sync) gets a
// MetaculusRateLimited error and stops its batch; the next cycle resumes it.
export class MetaculusRateLimited extends Error {
  retryAfterMs: number;
  constructor(path: string, retryAfterMs: number) {
    super(`metaculus 429 ${path}: rate limited, retry after ${Math.ceil(retryAfterMs / 1000)} s`);
    this.retryAfterMs = retryAfterMs;
  }
}

let nextSlot = 0;
let pausedUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry-After is either delay seconds or an HTTP date.
export function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

async function slot(): Promise<void> {
  const gap = Number(process.env.FENESH_METACULUS_GAP_MS ?? 1000);
  const now = Date.now();
  const at = Math.max(now, nextSlot, pausedUntil);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
  // A 429 seen while this request was queued pushes it back too.
  if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
}

export interface ApiOptions {
  attempts?: number; // total tries on 429 / 5xx (default 5)
  maxWaitMs?: number; // longest single back-off this caller accepts before giving up (default 5 min)
}

export async function api(path: string, init: RequestInit = {}, o: ApiOptions = {}): Promise<any> {
  const attempts = o.attempts ?? 5, maxWait = o.maxWaitMs ?? 5 * 60_000;
  const base = Number(process.env.FENESH_METACULUS_BACKOFF_MS ?? 5000);
  for (let attempt = 0; ; attempt++) {
    await slot();
    const res = await fetch(`${config.metaculusBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${config.metaculusToken}`,
        'Accept-Language': 'en',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status !== 429 && res.status < 500) throw new Error(`metaculus ${res.status} ${path}: ${text.slice(0, 400)}`);
    // Exponential back-off with jitter (half fixed, half random), unless the server says how long to wait.
    const backoff = Math.min(120_000, base * 2 ** attempt);
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoff / 2 + Math.random() * backoff / 2;
    if (res.status === 429) {
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      log.warn('metaculus rate limit', { path, attempt, waitMs: Math.round(wait) });
      if (attempt + 1 >= attempts || wait > maxWait) throw new MetaculusRateLimited(path, wait);
    } else if (attempt + 1 >= attempts) {
      throw new Error(`metaculus ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status !== 429) await sleep(Math.min(wait, maxWait));
  }
}

function scalingOf(q: any): Scaling | null {
  const s = q.scaling;
  if (!s || s.range_min == null || s.range_max == null) return null;
  return {
    rangeMin: s.range_min,
    rangeMax: s.range_max,
    zeroPoint: s.zero_point ?? null,
    openLower: !!(s.open_lower_bound ?? q.open_lower_bound),
    openUpper: !!(s.open_upper_bound ?? q.open_upper_bound),
    cdfSize: (s.inbound_outcome_count ?? 200) + 1,
    discrete: q.type === 'discrete',
    grid: Array.isArray(s.continuous_range) ? s.continuous_range : null,
  };
}

function normalize(post: any, q: any, group?: any): Question {
  return {
    postId: post.id,
    questionId: q.id,
    type: q.type,
    title: group ? `${post.title} (${q.label ?? q.title})` : (q.title ?? post.title),
    groupTitle: group ? post.title : undefined,
    label: q.label || undefined,
    description: q.description || group?.description || '',
    resolutionCriteria: q.resolution_criteria || group?.resolution_criteria || '',
    finePrint: q.fine_print || group?.fine_print || '',
    unit: q.unit ?? '',
    options: q.options ?? [],
    openTime: q.open_time ?? post.open_time,
    closeTime: q.scheduled_close_time ?? post.scheduled_close_time,
    resolveTime: q.scheduled_resolve_time ?? post.scheduled_resolve_time,
    scaling: scalingOf(q),
    weight: q.question_weight ?? 1,
    // Tournaments list themselves under `tournament`; MiniBench under `question_series` and `default_project`.
    tournaments: [...new Set([...(post.projects?.tournament ?? []), ...(post.projects?.question_series ?? []), post.projects?.default_project]
      .filter((t: any) => t && t.type !== 'site_main').map((t: any) => t.slug ?? String(t.id)))],
    alreadyForecast: !!q.my_forecasts?.latest,
    url: `https://www.metaculus.com/questions/${post.id}/`,
  };
}

export function questionsFromPost(post: any): Question[] {
  if (post.question) return [normalize(post, post.question)];
  if (post.group_of_questions) {
    return post.group_of_questions.questions
      .filter((q: any) => q.status === 'open' || !q.status)
      .map((q: any) => normalize(post, q, post.group_of_questions));
  }
  return []; // notebooks and conditionals are skipped
}

export async function openQuestions(tournament: string | number): Promise<Question[]> {
  const out: Question[] = [];
  for (let offset = 0; ; offset += 100) {
    const params = new URLSearchParams({
      tournaments: String(tournament), statuses: 'open', limit: '100', offset: String(offset),
      order_by: '-published_time', with_cp: 'false',
    });
    const d = await api(`/posts/?${params}`);
    const results: any[] = d.results ?? [];
    for (const p of results) out.push(...questionsFromPost(p));
    // The API returns a `next` link even on the last page, so stop on a short page.
    if (results.length < 100 || !d.next) break;
  }
  return out;
}

// Several posts in one request (the feed's `ids` filter). The feed leaves out `my_forecasts`, so peer
// scores still need the single-post endpoint.
export async function postsByIds(ids: number[], o: ApiOptions = {}): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const params = new URLSearchParams({ limit: String(chunk.length), with_cp: 'false' });
    for (const id of chunk) params.append('ids', String(id));
    const d = await api(`/posts/?${params}`, {}, o);
    out.push(...(d?.results ?? []));
  }
  return out;
}

export async function getPost(postId: number): Promise<Question[]> {
  return questionsFromPost(await api(`/posts/${postId}/`));
}

// MiniBench runs as a new tournament every two weeks. Find the ones with open questions.
export async function activeMiniBench(): Promise<number[]> {
  try {
    const d = await api(`/projects/tournaments/`);
    const list: any[] = Array.isArray(d) ? d : (d.results ?? []);
    const now = Date.now();
    return list
      .filter((t) => /minibench/i.test(`${t.name} ${t.slug}`) && t.slug !== 'minibench')
      .filter((t) => !t.close_date || Date.parse(t.close_date) > now - 86_400_000)
      .map((t) => t.id);
  } catch (e: any) {
    log.warn('minibench discovery failed', { err: e.message });
    return [];
  }
}

export async function me(): Promise<{ id: number; username: string }> {
  const d = await api('/users/me/');
  return { id: d.id, username: d.username };
}

export type ForecastPayload =
  | { probability_yes: number }
  | { continuous_cdf: number[] }
  | { probability_yes_per_category: Record<string, number> };

export async function postForecast(questionId: number, payload: ForecastPayload): Promise<void> {
  if (config.dryRun) { log.info('dry-run forecast', { questionId, payload }); return; }
  await api('/questions/forecast/', {
    method: 'POST',
    body: JSON.stringify([{ question: questionId, source: 'api', ...payload }]),
  });
}

export async function postComment(postId: number, text: string): Promise<void> {
  if (config.dryRun) { log.info('dry-run comment', { postId, chars: text.length }); return; }
  await api('/comments/create/', {
    method: 'POST',
    body: JSON.stringify({ on_post: postId, text, is_private: true, included_forecast: true }),
  });
}
