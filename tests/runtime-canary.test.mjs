import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { certifyCanary } from '../lib/runtime/canary.mjs';
import { evaluateResponse as evaluateRuntimeResponse } from '../lib/runtime/orchestrator.mjs';
import { qualifyModel } from '../lib/runtime/qualification.mjs';
import { commitEvaluation } from '../lib/runtime/transaction.mjs';
import { record } from '../lib/runtime/util.mjs';
import { makeResponse, makeTask, NOW } from './runtime-fixtures.mjs';

function evaluateResponse(task, response, providerSnapshot = null) {
  return evaluateRuntimeResponse(task, response, providerSnapshot, { now: NOW });
}

const PROVIDER = {
  provider: 'candidate',
  model_vendor: 'test',
  model_family: 'candidate-family',
  model_snapshot: 'candidate-snapshot',
  capability_class: 'CONSEQUENTIAL',
  execution_surface: 'test-cli',
  resource_pool: 'test-pool',
};

function bundle() {
  const metrics = {
    provider_id: PROVIDER.provider,
    model_snapshot: PROVIDER.model_snapshot,
    task_class: 'job_evaluation',
    capability_class: 'CONSEQUENTIAL',
    evaluation_set_version: 'combined-v1',
    representative_set: true,
    sample_count: 50,
    recommendation_agreement_successes: 50,
    recommendation_agreement: 1,
    hard_gate_errors: 0,
    authorization_errors: 0,
    consequential_unknown_rate: 0,
    schema_success: 1,
    evidence_accuracy: 1,
    repair_rate: 0,
    latency_ms: 1,
    token_use: 10,
    failure_rate: 0,
  };
  return record('QualificationEvidenceBundleV1', {
    provider_id: PROVIDER.provider,
    model_snapshot: PROVIDER.model_snapshot,
    task_class: 'job_evaluation',
    component_digests: { recommendation: 'a'.repeat(64), hard_gates: 'b'.repeat(64) },
    coverage: {
      representative_recommendations: true,
      deterministic_hard_gates: true,
      same_model_snapshot: true,
      unresolved_blockers: [],
    },
    metrics,
    qualification: qualifyModel({
      ...metrics,
      shadow_passed: true,
      canary_passed: false,
      lifecycle_state: 'shadow',
    }),
  });
}

async function canaryReceipts(target, hosts = ['writer-a', 'writer-a', 'writer-a']) {
  const receipts = [];
  for (let index = 0; index < hosts.length; index++) {
    const task = makeTask({ task_id: `canary-${index}`, idempotency_key: `canary-key-${index}` });
    const value = evaluateResponse(task, makeResponse(), PROVIDER);
    receipts.push(await commitEvaluation({
      target,
      ...value,
      hooks: { lock: { hostId: hosts[index], writerId: `writer-${index}` } },
    }));
  }
  return receipts;
}

test('canary certification verifies receipt chains and a single writer host', async () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-canary-'));
  mkdirSync(target, { recursive: true });
  const receipts = await canaryReceipts(target);
  assert.equal(receipts.every(item => item.writer_identity.host_id === 'writer-a'), true);
  const certification = certifyCanary({ qualificationBundle: bundle(), receipts, target });
  assert.equal(certification.passed, true);
  assert.equal(certification.qualification.checks.canary_passed, true);
  assert.equal(certification.qualification.lifecycle_state, 'canary');
  assert.equal(certification.qualification.qualified, true);
});

test('canary certification rejects cross-host and duplicate receipt sets', async () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-canary-hosts-'));
  mkdirSync(target, { recursive: true });
  const receipts = await canaryReceipts(target, ['writer-a', 'writer-b', 'writer-a']);
  const crossHost = certifyCanary({ qualificationBundle: bundle(), receipts, target });
  assert.equal(crossHost.passed, false);
  assert.equal(crossHost.checks.single_writer_host, false);
  assert.equal(crossHost.qualification.lifecycle_state, 'shadow');
  const duplicate = certifyCanary({ qualificationBundle: bundle(), receipts: [receipts[0], receipts[0], receipts[0]], target });
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.checks.unique_transactions, false);
  assert.equal(duplicate.checks.unique_tasks, false);
});
