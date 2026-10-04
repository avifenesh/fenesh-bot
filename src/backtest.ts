// Backtests: run the full pipeline on resolved past questions "as of" the moment bots forecast them,
// with every research source bounded to that moment, then score against the real resolution.
//
// Leakage rules:
// - only questions that opened after the latest training cutoff of the models in the run;
// - research sources return only what existed at the as-of moment (see src/asof.ts users);
// - base rates come from questions that resolved before the backtest window.
// Nothing is submitted. Runs are archived with status 'backtest' and scored by `report --backtest`.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runAsOf } from './asof.ts';
import { config, model } from './config.ts';
import { log } from './log.ts';
import { questionsFromPost, type Question } from './metaculus.ts';
import { Budget, runQuestion } from './pipeline.ts';
import { finishRun, startRun } from './store.ts';

export interface BacktestItem { question: Question; resolution: string; asOf: string; source: string }

// Census file: [{ record, embed_post }] as written by the question-census scripts.
export function loadCensus(path: string): BacktestItem[] {
  const rows: any[] = JSON.parse(readFileSync(path, 'utf8'));
  const out: BacktestItem[] = [];
  for (const r of rows) {
    const post = r.embed_post;
    if (!post || r.record?.practice) continue;
    for (const q of questionsFromPost({ ...post, question: post.question ? { ...post.question, status: 'open' } : undefined, group_of_questions: post.group_of_questions })) {
      const raw = post.question?.id === q.questionId ? post.question : post.group_of_questions?.questions?.find((x: any) => x.id === q.questionId);
      const res = raw?.resolution;
      if (res == null || res === '' || res === 'annulled' || res === 'ambiguous') continue;
      // Bots forecast during the open window; take a moment 20 minutes after opening.
      const asOf = new Date(Date.parse(q.openTime) + 20 * 60_000).toISOString();
      out.push({ question: { ...q, alreadyForecast: false, tournaments: [r.record?.tournament_key ?? 'census'] }, resolution: String(res), asOf, source: r.record?.tournament_key ?? '' });
    }
  }
  return out;
}

export interface BacktestOptions {
  models: string[];
  from?: string; // only questions opening on or after this date
  n?: number;
  types?: string[];
  concurrency?: number;
  supervisor?: boolean;
  seed?: number;
}

// Deterministic shuffle so a sample is reproducible and spread across rounds and topics.
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function selectItems(items: BacktestItem[], o: BacktestOptions): BacktestItem[] {
  const cutoff = o.models.map((m) => model(m).cutoff).sort().pop()!;
  // One week of margin past the latest training cutoff.
  const earliest = new Date(Date.parse(cutoff) + 8 * 86_400_000).toISOString();
  const from = o.from && o.from > earliest ? o.from : earliest;
  const pool = items.filter((it) => it.question.openTime >= from && (!o.types || o.types.includes(it.question.type)));
  log.info('backtest pool', { candidates: items.length, eligible: pool.length, from, latestCutoff: cutoff });
  return shuffle(pool, o.seed ?? 7).slice(0, o.n ?? 20);
}

export async function runBacktest(items: BacktestItem[], o: BacktestOptions): Promise<{ done: number; failed: number; costUsd: number }> {
  const db = new DatabaseSync(`${config.dataDir}/fenesh.db`);
  db.exec('PRAGMA busy_timeout = 15000');
  let done = 0, failed = 0, costUsd = 0, next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      const id = startRun(it.question);
      const budget = new Budget(config.maxCostPerQuestion);
      try {
        const r = await runAsOf(it.asOf, () => runQuestion(it.question, { forecasters: o.models, supervisor: o.supervisor ?? true }, budget));
        finishRun(id, 'backtest', r);
        db.prepare('INSERT OR REPLACE INTO outcomes (question_id, resolution, resolved_at, fetched_at) VALUES (?, ?, ?, ?)')
          .run(it.question.questionId, it.resolution, it.question.resolveTime, new Date().toISOString());
        done++; costUsd += r.costUsd;
        log.info('backtest done', { q: it.question.questionId, asOf: it.asOf, headline: r.headline, resolution: it.resolution, usd: +r.costUsd.toFixed(3) });
      } catch (e: any) {
        finishRun(id, 'backtest_failed', undefined, e.message, budget.spent);
        failed++; costUsd += budget.spent;
        log.warn('backtest failed', { q: it.question.questionId, err: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 3) }, worker));
  return { done, failed, costUsd };
}
