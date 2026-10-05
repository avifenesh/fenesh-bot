// Archive of every run: inputs, each component's forecast, what was submitted, and cost.
// Kept so forecasts can be scored per component once questions resolve.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import type { Question } from './metaculus.ts';
import type { RunResult } from './pipeline.ts';

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(`${config.dataDir}/fenesh.db`);
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      tournaments TEXT NOT NULL,
      close_time TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,          -- running | submitted | dry_run | failed
      error TEXT,
      headline TEXT,
      payload TEXT,                  -- what was (or would have been) submitted
      cost_usd REAL,
      disagreement REAL,
      question TEXT NOT NULL,        -- full normalized question
      plan TEXT, evidence TEXT, brief TEXT, addendum TEXT, comment TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_q ON runs(question_id);
    CREATE TABLE IF NOT EXISTS components (
      run_id INTEGER NOT NULL,
      round INTEGER NOT NULL,        -- 0 = logged priors, 1 = first pass, 2 = after the supervisor addendum, 9 = shadow
      model TEXT NOT NULL,
      ok INTEGER NOT NULL,
      forecast TEXT,                 -- pYes / probs / pcts
      summary TEXT,
      cost_usd REAL,
      error TEXT,
      reasoning TEXT
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      question_id INTEGER PRIMARY KEY,
      resolution TEXT,
      resolved_at TEXT,
      fetched_at TEXT
    );
  `);
  for (const ddl of ['ALTER TABLE components ADD COLUMN reasoning TEXT', 'ALTER TABLE runs ADD COLUMN comment_error TEXT', 'ALTER TABLE components ADD COLUMN slot TEXT']) {
    try { db.exec(ddl); } catch { /* column exists */ }
  }
  return db;
}

export function startRun(q: Question): number {
  const r = open().prepare(`INSERT INTO runs (question_id, post_id, type, title, tournaments, close_time, started_at, status, question)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(q.questionId, q.postId, q.type, q.title, q.tournaments.join(','), q.closeTime, new Date().toISOString(), JSON.stringify(q));
  return Number(r.lastInsertRowid);
}

export function finishRun(id: number, status: string, r?: RunResult, error?: string, spentUsd?: number): void {
  const d = open();
  d.prepare(`UPDATE runs SET finished_at = ?, status = ?, error = ?, headline = ?, payload = ?, cost_usd = ?, disagreement = ?,
    plan = ?, evidence = ?, brief = ?, addendum = ?, comment = ? WHERE id = ?`).run(
    new Date().toISOString(), status, error ?? null, r?.headline ?? null, r ? JSON.stringify(r.payload) : null,
    r?.costUsd ?? spentUsd ?? null, r?.disagreement ?? null, r ? JSON.stringify(r.plan) : null, r ? JSON.stringify(r.evidence) : null,
    r?.brief ?? null, r?.addendum ?? null, r?.comment ?? null, id);
  if (!r) return;
  const ins = d.prepare('INSERT INTO components (run_id, round, model, ok, forecast, summary, cost_usd, error, reasoning, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // `model` answered; `slot` is the ensemble member it answered for (they differ when a fallback did).
  const put = (round: number, fs: RunResult['forecasts']) => {
    for (const f of fs) ins.run(id, round, f.model, f.ok ? 1 : 0, JSON.stringify({ pYes: f.pYes, probs: f.probs, pcts: f.pcts }), f.summary ?? null, f.costUsd, f.error ?? null, f.reasoning ?? null, f.slot ?? f.model);
  };
  // Round 0: components that are logged for evaluation but may not be in the aggregate.
  if (r.market) ins.run(id, 0, 'market', 1, JSON.stringify({ pYes: r.market.quote.probability }), `${r.market.quote.venue}: ${r.market.quote.question} (confidence ${r.market.confidence}, weight ${r.marketWeight})`, 0, null, null, 'market');
  put(1, r.round1);
  if (r.addendum) put(2, r.forecasts);
  if (r.shadow?.length) put(9, r.shadow); // shadow models: scored, never submitted
}

// True if this question already got a submitted forecast from us.
export function submitted(questionId: number): boolean {
  const row = open().prepare(`SELECT 1 FROM runs WHERE question_id = ? AND status = 'submitted' LIMIT 1`).get(questionId);
  return !!row;
}

export function spentSince(iso: string): number {
  const row = open().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE started_at >= ?`).get(iso) as { s: number };
  return row.s;
}

export function recent(limit = 20): any[] {
  return open().prepare(`SELECT id, question_id, type, status, headline, cost_usd, started_at, finished_at, substr(title, 1, 80) AS title FROM runs ORDER BY id DESC LIMIT ?`).all(limit);
}

// A run for this question started recently and has not finished: another job is working on it.
export function inFlight(questionId: number, maxAgeMin = 45): boolean {
  const since = new Date(Date.now() - maxAgeMin * 60_000).toISOString();
  return !!open().prepare(`SELECT 1 FROM runs WHERE question_id = ? AND status = 'running' AND started_at >= ? LIMIT 1`).get(questionId, since);
}

export function commentFailed(id: number, error: string): void {
  open().prepare('UPDATE runs SET comment_error = ? WHERE id = ?').run(error, id);
}

// At worker start nothing can be running yet: runs left in 'running' were cut off by a crash or restart.
export function markInterrupted(): number {
  const r = open().prepare(`UPDATE runs SET status = 'failed', error = 'interrupted (worker restarted)', finished_at = ? WHERE status = 'running'`).run(new Date().toISOString());
  return Number(r.changes);
}
