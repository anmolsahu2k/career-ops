import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeResponse } from './runtime-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'career-ops.mjs');

function writeConfig(path, writerHost = hostname()) {
  writeFileSync(path, [
    'runtime_version: 1',
    'api_billing: false',
    'subscription_overage: false',
    `writer_host: ${writerHost}`,
    'providers: {}',
    '',
  ].join('\n'));
}

test('provider-free CLI prepares, validates, previews, and explicitly commits only to an isolated root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-cli-'));
  const target = join(dir, 'target');
  const seedPath = join(dir, 'seed.json');
  const taskPath = join(dir, 'nested-output', 'task.json');
  const responsePath = join(dir, 'response.json');
  const configPath = join(dir, 'runtime.yml');
  writeConfig(configPath);
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
  const receipt = JSON.parse(execFileSync(process.execPath, [cli, 'commit', '--task', taskPath, '--response', responsePath, '--target', target, '--config', configPath, '--apply'], { cwd: root, encoding: 'utf8' }));
  assert.equal(receipt.schema, 'CommitReceiptV1');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), true);
});

test('batch entrypoint delegates to provider-free runtime batch validation and explicit commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-batch-cli-'));
  const target = join(dir, 'target');
  const seedPath = join(dir, 'seed.json');
  const taskPath = join(dir, 'task.json');
  const responsePath = join(dir, 'response.json');
  const manifestPath = join(dir, 'batch.json');
  const configPath = join(dir, 'runtime.yml');
  writeConfig(configPath);
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
  const previewCommand = process.platform === 'win32' ? process.execPath : 'bash';
  const previewArgs = process.platform === 'win32'
    ? [cli, 'batch', '--manifest', manifestPath, '--target', target]
    : [wrapper, '--manifest', manifestPath, '--target', target];
  const preview = JSON.parse(execFileSync(previewCommand, previewArgs, {
    cwd: root, encoding: 'utf8', env: { ...process.env, CAREER_OPS_RUNTIME: 'v1' },
  }));
  assert.equal(preview.schema, 'RuntimeBatchPreviewV1');
  assert.equal(preview.results[0].status, 'VALIDATED');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
  const committed = JSON.parse(execFileSync(process.execPath, [
    cli, 'batch', '--manifest', manifestPath, '--target', target, '--config', configPath, '--apply',
  ], { cwd: root, encoding: 'utf8' }));
  assert.equal(committed.schema, 'RuntimeBatchResultV1');
  assert.equal(committed.results[0].status, 'COMMITTED');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), true);
});

test('commit preview remains read-only while apply rejects the wrong writer host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-writer-cli-'));
  const target = join(dir, 'target');
  const seedPath = join(dir, 'seed.json');
  const taskPath = join(dir, 'task.json');
  const responsePath = join(dir, 'response.json');
  const configPath = join(dir, 'runtime.yml');
  writeConfig(configPath, 'definitely-not-this-host');
  writeFileSync(seedPath, JSON.stringify({
    company: 'Writer Guard', role: 'Software Engineer', url: 'https://jobs.example.com/writer', resume: 'SDE', source: 'greenhouse',
    evidence: [{
      id: 'EV-1', source_type: 'greenhouse', uri: 'https://jobs.example.com/writer', content: 'Writer guard evidence',
      liveness_state: 'YES', structured_fields: {
        citizenship_restricted: 'NO', geography_eligible: 'YES', sponsorship_compatible: 'YES', required_evidence_complete: 'YES',
      },
    }],
  }));
  execFileSync(process.execPath, [cli, 'prepare', '--input', seedPath, '--out', taskPath], { cwd: root });
  writeFileSync(responsePath, JSON.stringify(makeResponse()));

  const preview = spawnSync(process.execPath, [
    cli, 'commit', '--task', taskPath, '--response', responsePath, '--target', target,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).apply_required, true);

  const applied = spawnSync(process.execPath, [
    cli, 'commit', '--task', taskPath, '--response', responsePath, '--target', target,
    '--config', configPath, '--apply',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(applied.status, 1);
  assert.equal(JSON.parse(applied.stderr).error, 'WRITER_HOST_MISMATCH');
  assert.equal(existsSync(join(target, 'data', 'applications.md')), false);
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
