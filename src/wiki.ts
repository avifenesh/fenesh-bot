// A small knowledge base the bot maintains itself, in markdown under <data>/wiki:
//   digest/YYYY-MM-DD.md   one page per day: world news from Wikipedia Current Events, condensed
//   entities/<slug>.md     dated facts about people, organizations, places and indicators,
//                          taken from research briefs ("- 2026-10-02: fact (source) [q12345]")
//   outcomes.md            questions we forecast, what we said, how they resolved
// Every line carries a date so lookups can be cut off at a past date (backtests).

import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { call, lastJson, type ToolSpec } from './llm.ts';
import { log } from './log.ts';
import type { Question } from './metaculus.ts';
import { currentEventsDay } from './research/sources.ts';
import { asOfMs } from './asof.ts';

const root = () => `${config.dataDir}/wiki`;
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function ensure(): void {
  for (const d of ['', '/digest', '/entities']) mkdirSync(`${root()}${d}`, { recursive: true });
}

// Condense one day of Current Events into a digest page. Skips days already written.
export async function writeDigest(day: Date): Promise<string | null> {
  ensure();
  const date = day.toISOString().slice(0, 10);
  const file = `${root()}/digest/${date}.md`;
  if (existsSync(file)) return file;
  const lines = await currentEventsDay(day);
  if (lines.length < 5) return null;
  const r = await call(config.fastModel, `Condense these news items from ${date} into a digest grouped by topic (conflicts, politics and elections, economy and markets, science and technology, disasters and health, other). Keep every number, name and date that matters; drop nothing that could decide a forecasting question. Bullets only, no commentary.

${lines.map((l) => l.slice(12)).join('\n').slice(0, 60_000)}`, { label: 'wiki-digest', effort: 'low', maxTokens: 8000 });
  writeFileSync(file, `# World digest ${date}\n\nSource: Wikipedia Current Events portal for ${date}.\n\n${r.text.trim()}\n`);
  log.info('wiki digest', { date, items: lines.length });
  return file;
}

// Keep the last week of digests written. Called on a schedule.
export async function refreshDigests(days = 7): Promise<number> {
  let n = 0;
  for (let i = 1; i <= days; i++) {
    try { if (await writeDigest(new Date(Date.now() - i * 86_400_000))) n++; }
    catch (e: any) { log.warn('wiki digest failed', { err: e.message }); }
  }
  return n;
}

// Pull dated facts out of a research brief and file them under entity pages.
export async function recordFacts(q: Question, brief: string): Promise<number> {
  ensure();
  try {
    const r = await call(config.fastModel, `Extract the dated, checkable facts from this research brief. Only facts stated with a date (or clearly as of a date) and a source; no opinions, no forecasts.

${brief.slice(0, 30_000)}

Return only JSON: {"facts": [{"entity": "<the person, organization, place, product or indicator the fact is about>", "date": "YYYY-MM-DD", "fact": "<one sentence>", "source": "<url or source name>"}]} with at most 20 facts.`, { label: 'wiki-facts', effort: 'low', maxTokens: 6000 });
    const facts: any[] = lastJson(r.text).facts ?? [];
    let n = 0;
    for (const f of facts) {
      if (!f?.entity || !/^\d{4}-\d{2}-\d{2}$/.test(String(f.date)) || !f.fact) continue;
      const file = `${root()}/entities/${slug(f.entity)}.md`;
      const line = `- ${f.date}: ${String(f.fact).trim()}${f.source ? ` (${f.source})` : ''} [q${q.questionId}]`;
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : `# ${f.entity}\n\n`;
      if (existing.includes(String(f.fact).trim().slice(0, 80))) continue;
      writeFileSync(file, existing.endsWith('\n') ? existing + line + '\n' : `${existing}\n${line}\n`);
      n++;
    }
    appendFileSync(`${root()}/log.md`, `${new Date().toISOString().slice(0, 10)} facts +${n} from q${q.questionId}\n`);
    return n;
  } catch (e: any) {
    log.warn('wiki facts failed', { q: q.questionId, err: e.message });
    return 0;
  }
}

// Rewrite outcomes.md from the archive: what we forecast and how it resolved.
export function writeOutcomes(): void {
  ensure();
  const db = new DatabaseSync(`${config.dataDir}/fenesh.db`);
  db.exec('PRAGMA busy_timeout = 15000');
  try {
    const rows = db.prepare(`SELECT r.question_id, r.title, r.close_time, r.headline, o.resolution, o.resolved_at FROM runs r
      JOIN outcomes o ON o.question_id = r.question_id WHERE r.status = 'submitted' ORDER BY o.resolved_at DESC`).all() as any[];
    const body = rows.map((x) => `- ${String(x.resolved_at ?? '').slice(0, 10)} q${x.question_id} ${x.title}: we said ${x.headline}; resolved ${x.resolution}`).join('\n');
    writeFileSync(`${root()}/outcomes.md`, `# Resolved questions we forecast\n\n${body}\n`);
  } catch { /* no outcomes yet */ }
}

// Look up entity pages and recent digest lines that mention any of the keywords, cut off at asOf.
export function lookup(keywords: string, asOf?: string, maxChars = 12_000): string {
  ensure();
  const kws = keywords.toLowerCase().split(/[\s,]+/).filter((k) => k.length > 2);
  if (!kws.length) return 'no keywords';
  const cutoff = asOf ?? '9999-12-31';
  const keep = (line: string) => { const d = line.match(/^- (\d{4}-\d{2}-\d{2})/)?.[1]; return !d || d <= cutoff; };
  const out: string[] = [];
  for (const f of readdirSync(`${root()}/entities`)) {
    if (!kws.some((k) => f.includes(slug(k)))) continue;
    const lines = readFileSync(`${root()}/entities/${f}`, 'utf8').split('\n').filter(keep);
    out.push(lines.slice(0, 1).concat(lines.slice(-40)).join('\n'));
  }
  const digests = readdirSync(`${root()}/digest`).filter((f) => f.slice(0, 10) <= cutoff).sort().slice(-10);
  for (const f of digests) {
    const hits = readFileSync(`${root()}/digest/${f}`, 'utf8').split('\n').filter((l) => kws.some((k) => l.toLowerCase().includes(k)));
    if (hits.length) out.push(`## ${f.slice(0, 10)}\n${hits.slice(0, 15).join('\n')}`);
  }
  return out.join('\n\n').slice(0, maxChars) || 'nothing on file';
}

export function wikiTool(): ToolSpec {
  return {
    name: 'wiki',
    description: "The team's own notes: dated facts about entities collected from earlier research, and daily world digests. Search by keywords (names, places, indicators).",
    parameters: { type: 'object', properties: { keywords: { type: 'string' } }, required: ['keywords'] },
    run: async ({ keywords }) => { const a = asOfMs(); return lookup(String(keywords), a == null ? undefined : new Date(a - 86_400_000).toISOString().slice(0, 10)); },
  };
}
