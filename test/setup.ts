// Every test file starts with its own empty data directory, so archives, cooldowns and alert quiet
// periods (src/state.ts) never leak between files or runs. Files that need a known path set their own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-test-'));
