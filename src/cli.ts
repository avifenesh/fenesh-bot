// fenesh-bot command line.
//   run <post-id> [--dry-run]   forecast one question now (sub-questions of a group included)
//   worker                      start the queue workers and the poll scheduler (the service)
//   poll                        enqueue open questions once
//   status                      recent runs and spend
//   report [--no-sync] [--backtest]  fetch resolutions and score every model and the submitted forecast
//   backtest <census.json> [--models a,b] [--from YYYY-MM-DD] [--n 20] [--types binary,numeric] [--concurrency 3] [--no-supervisor]

import { RUN_DEADLINE_MS, withDeadline } from './llm.ts';
import { config } from './config.ts';
import { log } from './log.ts';
import { getPost, me, postComment, postForecast, type Question } from './metaculus.ts';
import { Budget, runQuestion } from './pipeline.ts';
import { claimSubmission, commentFailed, finishRun, recent, releaseSubmission, spentSince, startRun, submitted } from './store.ts';

export async function forecastAndSubmit(q: Question, opts: { forecasters?: string[]; supervisor?: boolean } = {}): Promise<string> {
  const id = startRun(q);
  const budget = new Budget(config.maxCostPerQuestion);
  let r;
  try {
    r = await withDeadline(RUN_DEADLINE_MS, () => runQuestion(q, opts, budget));
    // One forecast per question: another run (the safety job) may be submitting it too. The claim is
    // exclusive; a failed post gives it back.
    if (!config.dryRun && (submitted(q.questionId) || !claimSubmission(q.questionId, id))) {
      finishRun(id, 'superseded', r, 'another run submitted first');
      log.warn('superseded', { q: q.questionId, run: id });
      return `${q.title}\n  -> superseded: another run submitted first`;
    }
    try {
      await postForecast(q.questionId, r.payload);
    } catch (e) {
      if (!config.dryRun) releaseSubmission(q.questionId, id);
      throw e;
    }
  } catch (e: any) {
    // Record what the failed attempt spent so the daily budget sees it.
    finishRun(id, 'failed', r, e.message, budget.spent);
    throw e;
  }
  // The forecast is in: record it before anything else can fail, so a retry never resubmits.
  const status = config.dryRun ? 'dry_run' : 'submitted';
  finishRun(id, status, r);
  try {
    await postComment(q.postId, r.comment);
  } catch (e: any) {
    // Comments are required for prizes; keep the text and flag it for a manual repost.
    commentFailed(id, e.message);
    log.error('comment failed', { q: q.questionId, run: id, err: e.message });
  }
  const { recordFacts } = await import('./wiki.ts');
  await recordFacts(q, r.brief);
  log.info('done', { q: q.questionId, status, headline: r.headline, usd: +r.costUsd.toFixed(3) });
  return `${q.title}\n  -> ${r.headline} ($${r.costUsd.toFixed(2)}, ${status})`;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (args.includes('--dry-run')) config.dryRun = true;
  if (cmd === 'run') {
    const postId = Number(args[0]);
    const qs = await getPost(postId);
    for (const q of qs) {
      if (!config.dryRun && (q.alreadyForecast || submitted(q.questionId))) { console.log(`skip ${q.questionId}: already forecast`); continue; }
      console.log(await forecastAndSubmit(q));
    }
  } else if (cmd === 'worker' || cmd === 'poll') {
    const { startWorker, pollOnce } = await import('./queue.ts');
    if (cmd === 'worker') await startWorker();
    else { console.log(await pollOnce()); process.exit(0); }
  } else if (cmd === 'backtest') {
    const { loadCensus, selectItems, runBacktest } = await import('./backtest.ts');
    const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
    const opts = {
      models: (flag('models') ?? config.forecasters.join(',')).split(','),
      from: flag('from'), n: Number(flag('n') ?? 20), types: flag('types')?.split(','),
      concurrency: Number(flag('concurrency') ?? 3), supervisor: !args.includes('--no-supervisor'), seed: Number(flag('seed') ?? 7),
    };
    const items = selectItems(loadCensus(args[0]), opts);
    console.log(`backtesting ${items.length} questions with ${opts.models.join(', ')}`);
    console.log(await runBacktest(items, opts));
  } else if (cmd === 'report') {
    const { syncOutcomes, report } = await import('./evaluate.ts');
    const backtest = args.includes('--backtest');
    if (!args.includes('--no-sync') && !backtest) await syncOutcomes();
    const statuses = backtest ? ['backtest'] : ['submitted', 'dry_run'];
    const r = report(statuses);
    console.log(`resolved questions: ${r.resolved}${r.peerMean != null ? `, mean Metaculus peer score ${r.peerMean.toFixed(2)}` : ''}`);
    console.table(r.rows.map((x) => ({ component: x.component, n: x.n, meanLogScore: +x.meanLog.toFixed(4) })));
    const { replay } = await import('./evaluate.ts');
    console.log('aggregation variants replayed on the same questions:');
    console.table(replay(statuses).map((x) => ({ variant: x.component, n: x.n, meanLogScore: +x.meanLog.toFixed(4) })));
  } else if (cmd === 'status') {
    console.log(await me());
    console.table(recent(25));
    const day = new Date(Date.now() - 86_400_000).toISOString();
    console.log(`spend last 24h: $${spentSince(day).toFixed(2)}`);
  } else {
    console.log('usage: cli.ts run <post-id> [--dry-run] | worker | poll | status | report [--no-sync] [--backtest] | backtest <census.json> [options]');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log.error('fatal', { err: e.message, stack: e.stack }); process.exit(1); });
}
