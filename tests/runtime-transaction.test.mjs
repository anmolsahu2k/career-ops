import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateResponse as evaluateRuntimeResponse } from '../lib/runtime/orchestrator.mjs';
import { acquireWriterLock, commitEvaluation, persistencePaths, recoverTransactions, TransactionError, verifyCommitReceipt } from '../lib/runtime/transaction.mjs';
import { canonicalJson, record } from '../lib/runtime/util.mjs';
import { makeResponse, makeTask, NOW } from './runtime-fixtures.mjs';

function evaluateResponse(task, response, providerSnapshot = null) {
  return evaluateRuntimeResponse(task, response, providerSnapshot, { now: NOW });
}

function tempTarget() {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-runtime-'));
  mkdirSync(join(target, 'data'), { recursive: true });
  mkdirSync(join(target, 'reports'), { recursive: true });
  return target;
}

function expireJournals(target) {
  const journalDir = join(target, '.career-ops-runtime', 'transactions');
  for (const name of readdirSync(journalDir)) {
    const path = join(journalDir, name);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.heartbeat_at = '2000-01-01T00:00:00.000Z';
    writeFileSync(path, `${canonicalJson(journal)}\n`);
  }
}

function recoverDeadWriter(target) {
  return recoverTransactions({
    target,
    now: Date.parse('2100-01-01T00:00:00.000Z'),
    journalProcessProbe: () => ({ alive: false, process_start_identity: null }),
  });
}

test('transaction commits full A-G report, nine-column tracker, receipt, and permanent reservation idempotently', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask(), makeResponse());
  const receipt = await commitEvaluation({ target, ...value });
  assert.equal(receipt.schema, 'CommitReceiptV1');
  assert.equal(verifyCommitReceipt({
    receipt, target, task: value.task, normalized: value.normalized,
    decision: value.decision, rawResponse: value.rawResult.response,
  }), true);
  const reportPath = join(target, receipt.artifact_manifest.find(item => item.name === 'report').final_path);
  const report = readFileSync(reportPath, 'utf8');
  for (const block of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) assert.match(report, new RegExp(`^## Block ${block},`, 'm'));
  assert.match(report, /^\*\*URL:\*\* https:\/\//m);
  const tracker = readFileSync(join(target, 'data', 'applications.md'), 'utf8');
  const row = tracker.split('\n').find(line => /^\|\s*1\s*\|/.test(line));
  assert.equal(row.split('|').length, 11);
  const reservations = readdirSync(join(target, 'reports')).filter(name => name.endsWith('-RESERVED.md'));
  assert.equal(reservations.length, 1);
  assert.equal(JSON.parse(readFileSync(join(target, 'reports', reservations[0]), 'utf8')).permanent, true);

  const repeated = await commitEvaluation({ target, ...value });
  assert.equal(repeated.transaction_id, receipt.transaction_id);
  const reevaluated = evaluateResponse(value.task, makeResponse());
  const repeatedAfterReevaluation = await commitEvaluation({ target, ...reevaluated });
  assert.equal(repeatedAfterReevaluation.transaction_id, receipt.transaction_id);
  const reparsedTask = makeTask({ task_id: 'task-reprepared', idempotency_key: value.task.idempotency_key });
  const reparsed = evaluateResponse(reparsedTask, makeResponse());
  const repeatedAfterPrepare = await commitEvaluation({ target, ...reparsed });
  assert.equal(repeatedAfterPrepare.transaction_id, receipt.transaction_id);
  assert.equal((readFileSync(join(target, 'data', 'applications.md'), 'utf8').match(/^\|\s*1\s*\|/gm) || []).length, 1);

  const secondTask = makeTask({ task_id: 'task-second', idempotency_key: 'key-second' });
  await commitEvaluation({ target, ...evaluateResponse(secondTask, makeResponse()) });
  assert.equal(verifyCommitReceipt({ receipt, target, task: value.task }), true);
});

test('receipt verification detects artifact and receipt tampering', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask({ task_id: 'task-tamper', idempotency_key: 'key-tamper' }), makeResponse());
  const receipt = await commitEvaluation({ target, ...value });
  const changedReceipt = { ...receipt, committed_at: '2000-01-01T00:00:00.000Z' };
  assert.equal(verifyCommitReceipt({ receipt: changedReceipt, target }), false);
  const reportItem = receipt.artifact_manifest.find(item => item.name === 'report');
  writeFileSync(join(target, reportItem.final_path), 'tampered\n');
  assert.equal(verifyCommitReceipt({ receipt, target }), false);
  await assert.rejects(commitEvaluation({ target, ...value }), error => error.code === 'RECEIPT_INVALID');
});

test('commit revalidates normalization, policy, and presentation before allocating a number', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask({ task_id: 'task-chain', idempotency_key: 'key-chain' }), makeResponse());
  const changedDecision = { ...value.decision, authorized_writes: [] };
  await assert.rejects(commitEvaluation({ target, ...value, decision: changedDecision }), error => error.code === 'POLICY_DECISION_MISMATCH');
  const changedNormalized = { ...value.normalized, decision_inputs: { ...value.normalized.decision_inputs, score: 1 } };
  await assert.rejects(commitEvaluation({ target, ...value, normalized: changedNormalized }), error => error.code === 'NORMALIZED_RESULT_MISMATCH');
  const poisonedRaw = {
    ...value.rawResult,
    response: makeResponse({ presentation: { A: '<script>unsafe</script>' } }),
  };
  const poisonedNormalized = (await import('../lib/runtime/normalize.mjs')).normalizeEvaluation(value.task, poisonedRaw);
  const poisonedDecision = (await import('../lib/runtime/policy-engine.mjs')).decide(value.task, poisonedNormalized);
  await assert.rejects(commitEvaluation({
    target, task: value.task, rawResult: poisonedRaw,
    normalized: poisonedNormalized, decision: poisonedDecision, presentation: poisonedNormalized.presentation_content,
  }), error => error.code === 'PRESENTATION_UNSAFE');
  assert.equal(readdirSync(join(target, 'reports')).filter(name => name.endsWith('-RESERVED.md')).length, 0);
});

test('commit rechecks symlink crossings immediately before artifact rename', async () => {
  const target = tempTarget();
  const outside = mkdtempSync(join(tmpdir(), 'career-ops-outside-'));
  const value = evaluateResponse(makeTask({ task_id: 'task-symlink', idempotency_key: 'key-symlink' }), makeResponse());
  await assert.rejects(commitEvaluation({
    target, ...value,
    hooks: {
      afterState(state) {
        if (state === 'STAGED') symlinkSync(outside, join(target, 'reports', 'example-systems'));
      },
    },
  }), error => error.code === 'SYMLINK_CROSSING');
  assert.equal(readdirSync(outside).length, 0);
});

test('fresh, live-stale, and different-host writer locks cannot be stolen', async () => {
  const target = tempTarget();
  const paths = persistencePaths(target);
  const first = await acquireWriterLock(paths, { hostId: 'host-a', writerId: 'one', processId: 101, processStartIdentity: 'start-one', processProbe: () => ({ alive: true, process_start_identity: 'start-one' }) });
  await assert.rejects(
    acquireWriterLock(paths, { hostId: 'host-a', writerId: 'two', processProbe: () => ({ alive: true, process_start_identity: 'start-one' }) }),
    error => error instanceof TransactionError && error.code === 'WRITER_BUSY',
  );
  const lock = JSON.parse(readFileSync(paths.lockFile, 'utf8'));
  lock.heartbeat_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(paths.lockFile, `${canonicalJson(lock)}\n`);
  await assert.rejects(
    acquireWriterLock(paths, { hostId: 'host-a', writerId: 'two', processProbe: () => ({ alive: true, process_start_identity: 'start-one' }) }),
    error => error instanceof TransactionError && error.code === 'WRITER_UNRESPONSIVE',
  );
  await assert.rejects(
    acquireWriterLock(paths, { hostId: 'host-b', writerId: 'three', processProbe: () => ({ alive: false, process_start_identity: null }) }),
    error => error instanceof TransactionError && error.code === 'DIFFERENT_HOST_LOCK',
  );
  await first.release();
});

test('expired lock with PID reuse can be recovered without stealing a live identity', async () => {
  const target = tempTarget();
  const paths = persistencePaths(target);
  mkdirSync(paths.runtimeDir, { recursive: true });
  mkdirSync(paths.lockArchiveDir, { recursive: true });
  const stale = record('WriterLeaseV1', {
    transaction_id: null, writer_id: 'old', process_id: 44, process_start_identity: 'old-start', host_id: 'host-a',
    started_at: '2000-01-01T00:00:00.000Z', heartbeat_at: '2000-01-01T00:00:00.000Z', lock_generation: 'old-generation', journal_state: 'IDLE',
  });
  writeFileSync(paths.lockFile, `${canonicalJson(stale)}\n`);
  const lock = await acquireWriterLock(paths, {
    hostId: 'host-a', writerId: 'new', processId: 45, processStartIdentity: 'new-start',
    processProbe: () => ({ alive: true, process_start_identity: 'reused-pid-start' }),
  });
  assert.equal(lock.owner.writer_id, 'new');
  assert.ok(readdirSync(paths.lockArchiveDir).some(name => name.includes('old-generation')));
  await lock.release();
});

test('recovery validates journal identity before copying it into the writer lock', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask({ task_id: 'task-journal-integrity', idempotency_key: 'key-journal-integrity' }), makeResponse());
  await assert.rejects(commitEvaluation({
    target, ...value, hooks: { afterState(state) { if (state === 'STAGED') throw new Error('interrupt'); } },
  }), /interrupt/);
  const journalDir = join(target, '.career-ops-runtime', 'transactions');
  const journalPath = join(journalDir, readdirSync(journalDir)[0]);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.transaction_id = 'foreign-transaction';
  writeFileSync(journalPath, `${canonicalJson(journal)}\n`);
  const results = await recoverTransactions({ target });
  assert.equal(results[0].result, 'JOURNAL_INTEGRITY_FAILED');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
});

test('recovery refuses fresh journals and expired journals whose writer identity is still live', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask({ task_id: 'task-live-journal', idempotency_key: 'key-live-journal' }), makeResponse());
  await assert.rejects(commitEvaluation({
    target, ...value, hooks: { afterState(state) { if (state === 'STAGED') throw new Error('interrupt'); } },
  }), /interrupt/);
  const fresh = await recoverTransactions({ target });
  assert.equal(fresh[0].result, 'JOURNAL_LEASE_FRESH');
  expireJournals(target);
  const journalDir = join(target, '.career-ops-runtime', 'transactions');
  const journal = JSON.parse(readFileSync(join(journalDir, readdirSync(journalDir)[0]), 'utf8'));
  const live = await recoverTransactions({
    target,
    now: Date.parse('2100-01-01T00:00:00.000Z'),
    journalProcessProbe: () => ({
      alive: true,
      process_start_identity: journal.owner_identity.process_start_identity,
    }),
  });
  assert.equal(live[0].result, 'WRITER_UNRESPONSIVE');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
});

test('recovery never takes over a journal owned by another host', async () => {
  const target = tempTarget();
  const value = evaluateResponse(makeTask({ task_id: 'task-foreign-host', idempotency_key: 'key-foreign-host' }), makeResponse());
  await assert.rejects(commitEvaluation({
    target, ...value, hooks: { afterState(state) { if (state === 'STAGED') throw new Error('interrupt'); } },
  }), /interrupt/);
  expireJournals(target);
  const journalDir = join(target, '.career-ops-runtime', 'transactions');
  const journalPath = join(journalDir, readdirSync(journalDir)[0]);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.owner_identity.host_id = 'foreign-writer-host';
  writeFileSync(journalPath, `${canonicalJson(journal)}\n`);
  const results = await recoverDeadWriter(target);
  assert.equal(results[0].result, 'DIFFERENT_HOST_JOURNAL');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
});

for (const interruptedState of ['PREPARED', 'STAGED', 'DECISION_COMMITTED', 'REPORT_COMMITTED', 'TRACKER_COMMITTED', 'RECEIPT_COMMITTED']) {
  test(`recovery is deterministic after interruption at ${interruptedState}`, async () => {
    const target = tempTarget();
    const value = evaluateResponse(makeTask({ task_id: `task-${interruptedState}`, idempotency_key: `key-${interruptedState}` }), makeResponse());
    await assert.rejects(commitEvaluation({
      target, ...value,
      hooks: { afterState(state) { if (state === interruptedState) throw new Error(`interrupt-${state}`); } },
    }), new RegExp(`interrupt-${interruptedState}`));
    expireJournals(target);
    const results = await recoverDeadWriter(target);
    if (interruptedState === 'PREPARED') {
      assert.equal(results[0].result, 'ROLLED_BACK');
      assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
      assert.equal(readdirSync(join(target, 'reports')).filter(name => name.endsWith('-RESERVED.md')).length, 1, 'aborted number remains permanently reserved');
    } else {
      assert.equal(results[0].result, 'RECOVERED');
      assert.match(readFileSync(join(target, 'data', 'applications.md'), 'utf8'), /^\|\s*1\s*\|/m);
      assert.equal(readdirSync(join(target, '.career-ops-runtime', 'receipts')).length, 1);
      const receiptPath = join(target, '.career-ops-runtime', 'receipts', readdirSync(join(target, '.career-ops-runtime', 'receipts'))[0]);
      assert.equal(verifyCommitReceipt({ receipt: JSON.parse(readFileSync(receiptPath, 'utf8')), target }), true);
    }
  });
}
