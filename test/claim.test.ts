// One forecast per question: only one run can hold the right to submit; a failed post gives it back.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.FENESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'fenesh-claim-'));

describe('submission claim', () => {
  it('is exclusive and released on failure', async () => {
    const { claimSubmission, releaseSubmission } = await import('../src/store.ts');
    expect(claimSubmission(7, 1)).toBe(true);
    expect(claimSubmission(7, 2)).toBe(false); // the safety run loses
    releaseSubmission(7, 2); // a loser cannot release the winner's claim
    expect(claimSubmission(7, 3)).toBe(false);
    releaseSubmission(7, 1); // the winner's post failed
    expect(claimSubmission(7, 3)).toBe(true);
  });
});
