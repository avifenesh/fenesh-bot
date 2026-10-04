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
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      question_id INTEGER PRIMARY KEY,
      resolution TEXT,
      resolved_at TEXT,
      fetched_at TEXT
    );
  `);
  return db;
}

export function startRun(q: Question): number {
  const r = open().prepare(`INSERT INTO runs (question_id, post_id, type, title, tournaments, close_time, started_at, status, question)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(q.questionId, q.postId, q.type, q.title, q.tournaments.join(','), q.closeTime, new Date().toISOString(), JSON.stringify(q));
  return Number(r.lastInsertRowid);
}

export function finishRun(id: number, status: string, r?: RunResult, error?: string): void {
  const d = open();
  d.prepare(`UPDATE runs SET finished_at = ?, status = ?, error = ?, headline = ?, payload = ?, cost_usd = ?, disagreement = ?,
    plan = ?, evidence = ?, brief = ?, addendum = ?, comment = ? WHERE id = ?`).run(
    new Date().toISOString(), status, error ?? null, r?.headline ?? null, r ? JSON.stringify(r.payload) : null,
    r?.costUsd ?? null, r?.disagreement ?? null, r ? JSON.stringify(r.plan) : null, r ? JSON.stringify(r.evidence) : null,
    r?.brief ?? null, r?.addendum ?? null, r?.comment ?? null, id);
  if (!r) return;
  const ins = d.prepare('INSERT INTO components (run_id, round, model, ok, forecast, summary, cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const put = (round: number, fs: RunResult['forecasts']) => {
    for (const f of fs) ins.run(id, round, f.model, f.ok ? 1 : 0, JSON.stringify({ pYes: f.pYes, probs: f.probs, pcts: f.pcts }), f.summary ?? null, f.costUsd, f.error ?? null);
  };
  // Round 0: components that are logged for evaluation but may not be in the aggregate.
  if (r.market) ins.run(id, 0, 'market', 1, JSON.stringify({ pYes: r.market.quote.probability }), `${r.market.quote.venue}: ${r.market.quote.question} (confidence ${r.market.confidence}, weight ${r.marketWeight})`, 0, null);
  if (r.gut) ins.run(id, 0, 'system1-gut', 1, JSON.stringify(r.gut), null, 0, null);
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
