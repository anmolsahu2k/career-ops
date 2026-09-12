import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isCanonicalStatus, loadStateContract } from '../lib/states.mjs';

test('canonical tracker statuses are loaded from states.yml without a duplicate verifier list', () => {
  const contract = loadStateContract(new URL('../templates/states.yml', import.meta.url));
  for (const status of ['Evaluated', 'Rejected-at-eval', 'Purged', 'Discarded', 'SKIP']) {
    assert.equal(isCanonicalStatus(status, contract), true, status);
  }
  assert.equal(isCanonicalStatus('rejected_at_eval', contract), true);
  assert.equal(isCanonicalStatus('not-a-status', contract), false);
});

test('states.yml rejects aliases that map to multiple canonical states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-states-'));
  const path = join(dir, 'states.yml');
  writeFileSync(path, [
    'states:',
    '  - id: one',
    '    label: One',
    '    aliases: [shared]',
    '  - id: two',
    '    label: Two',
    '    aliases: [shared]',
  ].join('\n'));
  assert.throws(() => loadStateContract(path), /maps to multiple states/);
});
