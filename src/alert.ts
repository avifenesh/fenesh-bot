// Owner alerts. Every alert is logged as {"msg":"alert"}; deploy/alert-relay.sh on the rig reads those
// lines from the journal and sends them to the owner's phone through Hermes. FENESH_ALERT_WEBHOOK is an
// optional extra channel: a plain-text POST, with FENESH_ALERT_TOKEN as a bearer token when set.

import { log } from './log.ts';

const lastSent = new Map<string, number>();

// `key` rate-limits repeats of the same condition (default once per 6 hours). Only a delivered alert
// starts the quiet period; a failed delivery clears it so the next occurrence tries again.
// kind 'report' (standings) logs at info level; the relay forwards both kinds.
export async function alert(text: string, opts: { key?: string; everyMs?: number; kind?: 'problem' | 'report' } = {}): Promise<void> {
  if (opts.kind === 'report') log.info('alert', { text, kind: 'report' });
  else log.error('alert', { text });
  if (opts.key) {
    if (Date.now() - (lastSent.get(opts.key) ?? 0) < (opts.everyMs ?? 6 * 3600_000)) return;
    lastSent.set(opts.key, Date.now());
  }
  const url = process.env.FENESH_ALERT_WEBHOOK;
  if (!url) return;
  const failed = () => { if (opts.key) lastSent.delete(opts.key); };
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', Title: 'fenesh-bot', Tags: 'crystal_ball' };
  if (process.env.FENESH_ALERT_TOKEN) headers.Authorization = `Bearer ${process.env.FENESH_ALERT_TOKEN}`;
  try {
    const res = await fetch(url, { method: 'POST', body: text, headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { failed(); log.warn('alert webhook refused', { status: res.status }); }
  } catch (e: any) {
    failed();
    log.warn('alert webhook failed', { err: e.message });
  }
}
