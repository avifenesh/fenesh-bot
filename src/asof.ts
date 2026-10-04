// Backtests run the pipeline "as of" a past moment: prompts say that date is today and every
// research source returns only what existed then. The moment travels with the async call chain,
// so concurrent backtest questions do not see each other's dates.

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<number>(); // epoch ms

export function asOfMs(): number | null { return store.getStore() ?? null; }

export function nowMs(): number { return store.getStore() ?? Date.now(); }

export function runAsOf<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`bad as-of date ${iso}`);
  return store.run(ms, fn);
}

// For sources that cannot be bounded to a past date.
export function liveOnly(name: string): void {
  if (store.getStore() != null) throw new Error(`${name} is not available in a backtest (no as-of data)`);
}
