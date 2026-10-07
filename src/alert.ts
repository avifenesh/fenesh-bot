// Owner alerts. Every alert is logged as {"msg":"alert"}; deploy/alert-relay.sh on the rig reads those
// lines from the journal and sends them to the owner's phone through Hermes. FENESH_ALERT_WEBHOOK is an
// optional extra channel: a plain-text POST, with FENESH_ALERT_TOKEN as a bearer token when set.

import { log } from './log.ts';
import { getState, setState } from './state.ts';

// `key` rate-limits repeats of the same condition (default once per 6 hours). The quiet period is kept
// across restarts (src/state.ts), and a repeat inside it is logged as "alert suppressed", which the relay
// does not forward. A failed webhook delivery clears it so the next occurrence tries again.
// kind 'report' (standings) logs at info level; the relay forwards both kinds.
export async function alert(text: string, opts: { key?: string; everyMs?: number; kind?: 'problem' | 'report' } = {}): Promise<void> {
  const stateKey = opts.key ? `alert:${opts.key}` : '';
  if (opts.key) {
    if (Date.now() - (getState(stateKey) ?? 0) < (opts.everyMs ?? 6 * 3600_000)) {
      log.warn('alert suppressed', { key: opts.key, text: text.slice(0, 200) });
      return;
    }
    setState(stateKey, Date.now());
  }
  if (opts.kind === 'report') log.info('alert', { text, kind: 'report' });
  else log.error('alert', { text });
  const url = process.env.FENESH_ALERT_WEBHOOK;
  if (!url) return;
  const failed = () => { if (opts.key) setState(stateKey, undefined); };
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

// The condition behind `key` is over: the next occurrence alerts again.
export function clearAlert(key: string): void {
  if (getState(`alert:${key}`) !== undefined) setState(`alert:${key}`, undefined);
}
