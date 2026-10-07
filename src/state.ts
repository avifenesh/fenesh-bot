// Small key -> number state that survives restarts (alert quiet periods, source cooldowns), kept as
// JSON in the data directory. The service restarts on every deploy; without this, a cooldown or an
// "alert once" would start over each time.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';

let cache: Record<string, number> | null = null;
const file = () => `${config.dataDir}/state.json`;

function load(): Record<string, number> {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(file(), 'utf8')); } catch { cache = {}; }
  return cache!;
}

export function getState(key: string): number | undefined {
  return load()[key];
}

export function setState(key: string, value: number | undefined): void {
  const s = load();
  if (value === undefined) delete s[key]; else s[key] = value;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(`${file()}.tmp`, JSON.stringify(s));
    renameSync(`${file()}.tmp`, file());
  } catch { /* the in-memory value still applies */ }
}
