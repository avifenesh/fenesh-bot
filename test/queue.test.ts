// Queue integration: real Valkey on a free port, Metaculus and the pipeline stubbed.
// Checks that polling is idempotent, safety jobs are scheduled, and a question job submits once.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); });
});

let valkey: ChildProcess;
let dir: string;
const submittedIds: number[] = [];
const close = new Date(Date.now() + 3 * 3600_000).toISOString();

const fakeQuestion = (id: number) => ({
  postId: id, questionId: id, type: 'binary', title: `q${id}`, description: '', resolutionCriteria: '', finePrint: '',
  unit: '', options: [], openTime: new Date().toISOString(), closeTime: close, resolveTime: close, scaling: null,
  weight: 1, tournaments: ['fall-futureeval-2026'], alreadyForecast: false, url: '',
});

vi.mock('../src/metaculus.ts', () => ({
  openQuestions: async () => [fakeQuestion(1), fakeQuestion(2)],
  getPost: async (id: number) => [fakeQuestion(id)],
}));
vi.mock('../src/cli.ts', () => ({
  forecastAndSubmit: async (q: any) => { submittedIds.push(q.questionId); return `ok ${q.questionId}`; },
}));

beforeAll(async () => {
  const port = await freePort();
  dir = mkdtempSync(join(tmpdir(), 'fenesh-test-'));
  process.env.VALKEY_PORT = String(port);
  process.env.FENESH_DATA_DIR = dir;
  process.env.FENESH_MINIBENCH = '0';
  valkey = spawn('valkey-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await new Promise<void>((res, rej) => { const s = connect(port, '127.0.0.1', () => { s.end(); res(); }); s.on('error', rej); }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

afterAll(() => {
  valkey?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('queue', () => {
  it('enqueues each open question once and runs it', async () => {
    const { Queue, Worker } = await import('glide-mq');
    const q = await import('../src/queue.ts');
    expect(await q.pollOnce()).toBe('poll: 2 open, 2 new');
    expect(await q.pollOnce()).toBe('poll: 2 open, 0 new'); // same job ids: no duplicates

    const connection = { addresses: [{ host: '127.0.0.1', port: Number(process.env.VALKEY_PORT) }] };
    const queue = new Queue('fenesh-question', { connection });
    // One forecast job and one delayed safety job per question.
    for (const id of [1, 2]) {
      expect(await queue.getJob(`q-${id}`)).toBeTruthy();
      expect(await (await queue.getJob(`s-${id}`))?.getState()).toBe('delayed');
    }

    const done: string[] = [];
    const worker = new Worker('fenesh-question', async (job: any) => {
      const r = await q.processQuestion(job);
      done.push(String(job.id));
      return r;
    }, { connection, concurrency: 2 });
    for (let i = 0; i < 100 && done.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    await worker.close();
    await queue.close();
    expect(done.sort()).toEqual(['q-1', 'q-2']);
    expect(submittedIds.sort()).toEqual([1, 2]);
  }, 30_000);
});
