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

let lastRequest = 0;
async function api(path: string, init: RequestInit = {}): Promise<any> {
  // Stay well under any rate limit: at most one request per 600 ms.
  const wait = lastRequest + 600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${config.metaculusBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${config.metaculusToken}`,
        'Accept-Language': 'en',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
      continue;
    }
    throw new Error(`metaculus ${res.status} ${path}: ${text.slice(0, 400)}`);
  }
  throw new Error(`metaculus: gave up on ${path}`);
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
