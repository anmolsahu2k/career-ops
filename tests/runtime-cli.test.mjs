import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeResponse } from './runtime-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'career-ops.mjs');

test('provider-free CLI prepares, validates, previews, and explicitly commits only to an isolated root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-cli-'));
  const target = join(dir, 'target');
  const seedPath = join(dir, 'seed.json');
  const taskPath = join(dir, 'nested-output', 'task.json');
  const responsePath = join(dir, 'response.json');
  writeFileSync(seedPath, JSON.stringify({
    company: 'CLI Example', role: 'Software Engineer', url: 'https://jobs.example.com/cli', resume: 'SDE', source: 'greenhouse',
    evidence: [{
      id: 'EV-1', source_type: 'greenhouse', uri: 'https://jobs.example.com/cli', content: 'CLI evidence',
      liveness_state: 'YES', structured_fields: {
        citizenship_restricted: 'NO', geography_eligible: 'YES', sponsorship_compatible: 'YES', required_evidence_complete: 'YES',
      },
    }],
  }));
  execFileSync(process.execPath, [cli, 'prepare', '--input', seedPath, '--out', taskPath], { cwd: root });
  const bundle = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.equal(bundle.schema, 'PreparedTaskBundleV1');
  assert.equal(bundle.provider_request.evidence[0].content, 'CLI evidence');
  writeFileSync(responsePath, JSON.stringify(makeResponse()));
  const validated = JSON.parse(execFileSync(process.execPath, [cli, 'validate', '--task', taskPath, '--response', responsePath], { cwd: root, encoding: 'utf8' }));
  assert.equal(validated.decision.decision, 'APPLY');
  const preview = JSON.parse(execFileSync(process.execPath, [cli, 'commit', '--task', taskPath, '--response', responsePath, '--target', target], { cwd: root, encoding: 'utf8' }));
  assert.equal(preview.apply_required, true);
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
  const receipt = JSON.parse(execFileSync(process.execPath, [cli, 'commit', '--task', taskPath, '--response', responsePath, '--target', target, '--apply'], { cwd: root, encoding: 'utf8' }));
  assert.equal(receipt.schema, 'CommitReceiptV1');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), true);
});

test('legacy batch entrypoint delegates to provider-free runtime batch validation and explicit commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-batch-cli-'));
  const target = join(dir, 'target');
  const seedPath = join(dir, 'seed.json');
  const taskPath = join(dir, 'task.json');
  const responsePath = join(dir, 'response.json');
  const manifestPath = join(dir, 'batch.json');
  writeFileSync(seedPath, JSON.stringify({
    company: 'Batch Example', role: 'Software Engineer', url: 'https://jobs.example.com/batch', resume: 'SDE', source: 'greenhouse',
    evidence: [{
      id: 'EV-1', source_type: 'greenhouse', uri: 'https://jobs.example.com/batch', content: 'Batch evidence',
      liveness_state: 'YES', structured_fields: {
        citizenship_restricted: 'NO', geography_eligible: 'YES', sponsorship_compatible: 'YES', required_evidence_complete: 'YES',
      },
    }],
  }));
  execFileSync(process.execPath, [cli, 'prepare', '--input', seedPath, '--out', taskPath], { cwd: root });
  writeFileSync(responsePath, JSON.stringify(makeResponse()));
  writeFileSync(manifestPath, JSON.stringify({
    schema: 'RuntimeBatchManifestV1', schema_version: 1,
    entries: [{ id: 'batch-1', task: 'task.json', response: 'response.json' }],
  }));
  const wrapper = join(root, 'batch', 'batch-runner.sh');
  const preview = JSON.parse(execFileSync('bash', [wrapper, '--manifest', manifestPath, '--target', target], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CAREER_OPS_RUNTIME: 'v1' },
  }));
  assert.equal(preview.schema, 'RuntimeBatchPreviewV1');
  assert.equal(preview.results[0].status, 'VALIDATED');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
  const committed = JSON.parse(execFileSync(process.execPath, [
    cli, 'batch', '--manifest', manifestPath, '--target', target, '--apply',
  ], { cwd: root, encoding: 'utf8' }));
  assert.equal(committed.schema, 'RuntimeBatchResultV1');
  assert.equal(committed.results[0].status, 'COMMITTED');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), true);
});

test('legacy Gemini entrypoint delegates by default and retains an explicit legacy escape hatch', () => {
  const entrypoint = join(root, 'gemini-eval.mjs');
  const delegated = spawnSync(process.execPath, [entrypoint, '--help'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CAREER_OPS_RUNTIME: 'v1' },
  });
  assert.equal(delegated.status, 1);
  assert.match(delegated.stderr, /respond requires --task, --config, and --provider/);
  assert.doesNotMatch(delegated.stdout, /Gemini Evaluator/);

  const legacy = spawnSync(process.execPath, [entrypoint], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CAREER_OPS_RUNTIME: 'legacy', ALLOW_GEMINI_EVAL: '' },
  });
  assert.equal(legacy.status, 2);
  assert.match(legacy.stderr, /Legacy gemini-eval\.mjs is disabled/);
});
