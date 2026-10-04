// The service: glide-mq queues on Valkey.
//   fenesh-poll      scheduler every FENESH_POLL_EVERY_MS: find open questions, enqueue them
//   fenesh-question  one job per question (custom job id = idempotent), earliest close first;
//                    plus a delayed "safety" job per question that forecasts on the lean path
//                    25 min before close if nothing was submitted by then.

import { Queue, UnrecoverableError, Worker, type Job } from 'glide-mq';
import { config } from './config.ts';
import { log } from './log.ts';
import { getPost, openQuestions, type Question } from './metaculus.ts';
import { forecastAndSubmit } from './cli.ts';
import { inFlight, markInterrupted, spentSince, submitted } from './store.ts';
import { syncOutcomes } from './evaluate.ts';
import { refreshDigests, writeOutcomes } from './wiki.ts';

const connection = { addresses: [{ host: config.valkey.host, port: config.valkey.port }] };
const POLL = 'fenesh-poll';
const QUESTION = 'fenesh-question';
const EVALUATE = 'fenesh-evaluate';

const leanForecasters = (process.env.FENESH_LEAN_FORECASTERS ?? 'gpt-6-sol,opus-5.5,grok-4.7').split(',');
const dailyBudget = Number(process.env.FENESH_DAILY_BUDGET_USD ?? 60);
const safetyLeadMs = 25 * 60_000;

export async function alert(text: string): Promise<void> {
  log.error('alert', { text });
  const url = process.env.FENESH_ALERT_WEBHOOK;
  if (!url) return;
  try { await fetch(url, { method: 'POST', body: `fenesh-bot: ${text}`, signal: AbortSignal.timeout(10_000) }); }
  catch (e: any) { log.warn('alert webhook failed', { err: e.message }); }
}

interface QuestionJob { postId: number; questionId: number; closeTime: string; tournaments: string[]; lean?: boolean }

function tournamentsToPoll(): string[] {
  const t = [...config.tournaments];
  if (config.discoverMiniBench && !t.includes('minibench')) t.push('minibench');
  return t;
}

let questionQueue: Queue | null = null;
function qq(): Queue {
  questionQueue ??= new Queue(QUESTION, { connection });
  return questionQueue;
}

export async function pollOnce(): Promise<string> {
  const found: Question[] = [];
  for (const t of tournamentsToPoll()) {
    try { found.push(...(await openQuestions(t))); }
    catch (e: any) { log.warn('poll failed', { tournament: t, err: e.message }); }
  }
  let added = 0;
  const now = Date.now();
  for (const q of found) {
    if (q.alreadyForecast || submitted(q.questionId)) continue;
    const msToClose = Date.parse(q.closeTime) - now;
    if (msToClose <= 0) continue;
    const data: QuestionJob = { postId: q.postId, questionId: q.questionId, closeTime: q.closeTime, tournaments: q.tournaments };
    const priority = Math.min(2048, Math.max(1, Math.round(msToClose / 120_000))); // earlier close = higher priority
    const job = await qq().add('forecast', data, {
      jobId: `q-${q.questionId}`, priority, attempts: 3, backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 30 * 86_400, count: 5000 }, removeOnFail: false, lockDuration: 10 * 60_000,
    });
    if (job) {
      added++;
      if (msToClose > safetyLeadMs + 5 * 60_000) {
        await qq().add('safety', { ...data, lean: true }, {
          jobId: `s-${q.questionId}`, delay: msToClose - safetyLeadMs, priority: 1, attempts: 2,
          backoff: { type: 'fixed', delay: 60_000 }, removeOnComplete: { age: 30 * 86_400, count: 5000 }, removeOnFail: false, lockDuration: 10 * 60_000,
        });
      }
    }
  }
  const msg = `poll: ${found.length} open, ${added} new`;
  log.info('poll', { open: found.length, added });
  return msg;
}

export async function processQuestion(job: Job): Promise<unknown> {
  const d = job.data as QuestionJob;
  if (submitted(d.questionId)) return { skipped: 'already submitted' };
  if (inFlight(d.questionId)) return { skipped: 'another job is forecasting this question' };
  const q = (await getPost(d.postId)).find((x) => x.questionId === d.questionId);
  if (!q) return { skipped: 'question gone' };
  if (q.alreadyForecast) return { skipped: 'already forecast on Metaculus' };
  const msToClose = Date.parse(q.closeTime) - Date.now();
  if (msToClose <= 60_000) {
    await alert(`question ${q.questionId} closed before we forecast it: ${q.title}`);
    return { skipped: 'closed' };
  }
  const overBudget = spentSince(new Date(Date.now() - 86_400_000).toISOString()) > dailyBudget;
  const isMiniBench = q.tournaments.some((t) => /minibench/i.test(t));
  const lean = d.lean || job.name === 'safety' || isMiniBench || overBudget || msToClose < 20 * 60_000;
  if (overBudget) log.warn('daily budget exceeded, lean path', { budget: dailyBudget });
  try {
    const line = await forecastAndSubmit(q, lean ? { forecasters: leanForecasters, supervisor: false } : {});
    return { line, lean };
  } catch (e: any) {
    // Metaculus refusing the forecast (closed question, bad payload) will not change on retry.
    if (/^metaculus 4\d\d/.test(e.message ?? '') && !/^metaculus 429/.test(e.message)) throw new UnrecoverableError(e.message);
    throw e;
  }
}

export async function startWorker(): Promise<void> {
  const interrupted = markInterrupted();
  if (interrupted) log.warn('runs interrupted by the last restart', { count: interrupted });
  const poll = new Queue(POLL, { connection });
  await poll.upsertJobScheduler('poll-open-questions', { every: config.pollEveryMs }, { name: 'poll', data: {} });

  const pollWorker = new Worker(POLL, async () => pollOnce(), { connection, concurrency: 1 });
  const evaluate = new Queue(EVALUATE, { connection });
  await evaluate.upsertJobScheduler('sync-outcomes', { every: 6 * 3600_000 }, { name: 'sync', data: {} });
  await evaluate.upsertJobScheduler('wiki-digest', { every: 6 * 3600_000 }, { name: 'digest', data: {} });
  const evalWorker = new Worker(EVALUATE, async (job: Job) => {
    if (job.name === 'digest') return refreshDigests();
    const n = await syncOutcomes();
    writeOutcomes();
    return n;
  }, { connection, concurrency: 1, lockDuration: 30 * 60_000 });
  const questionWorker = new Worker(QUESTION, processQuestion, {
    connection, concurrency: config.questionConcurrency, lockDuration: 10 * 60_000, stalledInterval: 60_000,
  });
  questionWorker.on('failed', (job: Job | undefined, err: Error) => {
    const d = job?.data as QuestionJob | undefined;
    log.error('question job failed', { job: job?.id, q: d?.questionId, attempts: job?.attemptsMade, err: err.message });
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) void alert(`question ${d?.questionId} failed after ${job.attemptsMade} attempts: ${err.message}`);
  });
  pollWorker.on('failed', (_job: Job | undefined, err: Error) => log.error('poll failed', { err: err.message }));

  log.info('worker started', { tournaments: tournamentsToPoll(), forecasters: config.forecasters, lean: leanForecasters, dryRun: config.dryRun });
  await pollOnce();

  const stop = async () => {
    log.info('shutting down');
    await Promise.allSettled([pollWorker.close(), questionWorker.close(), evalWorker.close(), poll.close(), evaluate.close(), qq().close()]);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
