// tests/status-resolve.test.mjs — which Status survives a re-evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, APPLY_TIER } from '../lib/status-resolve.mjs';

test('the Palantir regression: Discarded releases when a re-score crosses into apply-tier', () => {
  // Row #110 -> #3290, 2.3 -> 4.2, stayed Discarded and vanished from the queue.
  const r = resolveStatus('Discarded', 'Evaluated', 2.3, 4.2);
  assert.equal(r.status, 'Evaluated');
  assert.equal(r.changed, true);
});

test('Evaluated releases to Discarded when a re-score drops out of apply-tier', () => {
  const r = resolveStatus('Evaluated', 'Discarded', 4.5, 2.0);
  assert.equal(r.status, 'Discarded');
  assert.equal(r.changed, true);
});

test('a re-score inside the same tier keeps the existing status', () => {
  assert.equal(resolveStatus('Discarded', 'Evaluated', 3.0, 3.8).status, 'Discarded');
  assert.equal(resolveStatus('Discarded', 'Evaluated', 3.0, 3.8).changed, false);
  assert.equal(resolveStatus('Evaluated', 'Discarded', 4.5, 4.1).status, 'Evaluated');
});

test('real-world statuses are never overwritten by a re-eval', () => {
  for (const s of ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']) {
    // Even a dramatic downgrade must not erase the fact that this happened.
    const r = resolveStatus(s, 'Discarded', 4.6, 1.0);
    assert.equal(r.status, s, `${s} must survive`);
    assert.equal(r.changed, false);
  }
});

test('an upgrade also cannot overwrite a real-world status', () => {
  const r = resolveStatus('Applied', 'Evaluated', 2.0, 4.9);
  assert.equal(r.status, 'Applied');
  assert.equal(r.changed, false);
});

test('exactly at the apply-tier boundary counts as apply-tier', () => {
  assert.equal(resolveStatus('Discarded', 'Evaluated', 3.9, APPLY_TIER).changed, true);
  // 4.0 -> 4.4 stays inside the tier, so no release.
  assert.equal(resolveStatus('Discarded', 'Evaluated', APPLY_TIER, 4.4).changed, false);
});

test('unparseable or missing scores never trigger a release', () => {
  assert.equal(resolveStatus('Discarded', 'Evaluated', NaN, 4.2).changed, false);
  assert.equal(resolveStatus('Discarded', 'Evaluated', 2.0, NaN).changed, false);
  assert.equal(resolveStatus('Discarded', 'Evaluated', undefined, 4.2).changed, false);
});

test('no-op when the new status matches, and when there is no new status', () => {
  assert.equal(resolveStatus('Discarded', 'Discarded', 2.0, 4.2).changed, false);
  assert.equal(resolveStatus('Discarded', '', 2.0, 4.2).status, 'Discarded');
  assert.equal(resolveStatus('Discarded', undefined, 2.0, 4.2).changed, false);
});

test('every verdict carries a reason for the merge log', () => {
  for (const args of [['Discarded', 'Evaluated', 2.3, 4.2], ['Applied', 'Discarded', 4.6, 1.0], ['Evaluated', 'Discarded', 3.1, 3.2]]) {
    assert.ok(resolveStatus(...args).reason.length > 0);
  }
});
