// fenesh-bot command line.
//   run <post-id> [--dry-run]   forecast one question now (sub-questions of a group included)
//   worker                      start the queue workers and the poll scheduler (the service)
//   poll                        enqueue open questions once
//   status                      recent runs and spend
//   report [--no-sync]          fetch resolutions and score every model and the submitted forecast

import { config } from './config.ts';
import { log } from './log.ts';
import { getPost, me, postComment, postForecast, type Question } from './metaculus.ts';
import { runQuestion } from './pipeline.ts';
import { finishRun, recent, spentSince, startRun, submitted } from './store.ts';

export async function forecastAndSubmit(q: Question, opts: { forecasters?: string[]; supervisor?: boolean } = {}): Promise<string> {
  const id = startRun(q);
  try {
    const r = await runQuestion(q, opts);
    await postForecast(q.questionId, r.payload);
    await postComment(q.postId, r.comment);
    const status = config.dryRun ? 'dry_run' : 'submitted';
    finishRun(id, status, r);
    const { recordFacts } = await import('./wiki.ts');
    await recordFacts(q, r.brief);
    log.info('done', { q: q.questionId, status, headline: r.headline, usd: +r.costUsd.toFixed(3) });
    return `${q.title}\n  -> ${r.headline} ($${r.costUsd.toFixed(2)}, ${status})`;
  } catch (e: any) {
    finishRun(id, 'failed', undefined, e.message);
    throw e;
  }
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
  } else if (cmd === 'report') {
    const { syncOutcomes, report } = await import('./evaluate.ts');
    if (!args.includes('--no-sync')) await syncOutcomes();
    const r = report();
    console.log(`resolved questions: ${r.resolved}${r.peerMean != null ? `, mean Metaculus peer score ${r.peerMean.toFixed(2)}` : ''}`);
    console.table(r.rows.map((x) => ({ component: x.component, n: x.n, meanLogScore: +x.meanLog.toFixed(4) })));
    const { replay } = await import('./evaluate.ts');
    console.log('aggregation variants replayed on the same questions:');
    console.table(replay().map((x) => ({ variant: x.component, n: x.n, meanLogScore: +x.meanLog.toFixed(4) })));
  } else if (cmd === 'status') {
    console.log(await me());
    console.table(recent(25));
    const day = new Date(Date.now() - 86_400_000).toISOString();
    console.log(`spend last 24h: $${spentSince(day).toFixed(2)}`);
  } else {
    console.log('usage: cli.ts run <post-id> [--dry-run] | worker | poll | status | report [--no-sync]');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log.error('fatal', { err: e.message, stack: e.stack }); process.exit(1); });
}
