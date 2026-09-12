import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateScanResults,
  guessResume,
  loadScanResults,
  parseScanResultsTsv,
  writeScanResultsTsv,
} from '../lib/runtime/evaluate-scan.mjs';
import { makeResponse } from './runtime-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'career-ops.mjs');

function stubConfig() {
  return {
    runtime_version: 1,
    api_billing: false,
    writer_host: hostname(),
    resource_pools: {
      'test-pool': {
        schema: 'ResourcePoolV1',
        schema_version: 1,
        quota_state: 'AVAILABLE',
        remaining_ratio: 1,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        minimum_reserve_ratio: 0,
        emergency_reserve_ratio: 0,
      },
    },
    providers: {
      'test-provider': {
        type: 'command',
        enabled: true,
        command: ['node', '-e', 'process.stdout.write("{}")'],
        model_vendor: 'local',
        model_family: 'test',
        model_snapshot: 'test-1',
        execution_surface: 'test',
        resource_pool: 'test-pool',
        capability_class: 'CONSEQUENTIAL',
        capabilities: ['structured_output', 'evidence_citations'],
        risk_ceiling: 'CONSEQUENTIAL',
        qualification: {
          qualified: true,
          lifecycle_state: 'production',
          confidence_interval_95: { lower: 0.99, upper: 1 },
        },
        observation: {
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          available: true,
          latency_ms: 1,
        },
      },
    },
  };
}

test('parseScanResultsTsv loads canonical handoff rows', () => {
  const rows = parseScanResultsTsv([
    'url\tcompany\ttitle\tlocation\tsource',
    'https://jobs.example.com/1\tAcme\tSoftware Engineer\tRemote\tgreenhouse-api',
    'not-a-url\tBad\tRow\t\tmanual',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].source, 'greenhouse-api');
});

test('guessResume picks MLE for ML titles', () => {
  assert.equal(guessResume('Machine Learning Engineer'), 'MLE');
  assert.equal(guessResume('Software Engineer'), 'SDE');
});

test('evaluateScanResults dry-run plans without writing the tracker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, [{
    url: 'https://jobs.example.com/live',
    company: 'Example',
    title: 'Software Engineer',
    location: 'Remote',
    source: 'manual',
  }, {
    url: 'https://jobs.example.com/dead',
    company: 'Example',
    title: 'Backend Engineer',
    location: 'NYC',
    source: 'manual',
  }]);

  const result = await evaluateScanResults({
    target: dir,
    files: [file],
    apply: false,
    skipLiveness: true,
  });

  assert.equal(result.schema, 'EvaluateScanResultV1');
  assert.equal(result.status, 'PLAN');
  assert.equal(result.candidate_count, 2);
  assert.equal(result.queue.length, 2);
  assert.equal(existsSync(join(dir, 'data', 'applications.md')), false);
  assert.equal(loadScanResults([file]).length, 2);
});

test('evaluateScanResults apply commits through an injected provider and clears triage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-apply-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, [{
    url: 'https://jobs.example.com/apply-me',
    company: 'Example Co',
    title: 'Software Engineer',
    location: 'Remote',
    source: 'manual',
  }]);

  const longJd = `${'Requirements: build APIs with Node.js and ship reliable services. '.repeat(12)}Apply now.`;
  const providerHandle = {
    async complete(request) {
      return {
        schema: 'RawProviderResultV1',
        schema_version: 1,
        task_id: request.task.task_id,
        provider_snapshot: {
          provider: 'test-provider',
          model_snapshot: 'test-1',
          capability_class: 'CONSEQUENTIAL',
          execution_surface: 'test',
        },
        response: JSON.stringify(makeResponse()),
        usage: {},
        latency_ms: 1,
        attempts: 1,
        capability_degradation: false,
      };
    },
  };

  const result = await evaluateScanResults({
    target: dir,
    config: stubConfig(),
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'manual',
      content: longJd,
      title: 'Software Engineer',
      liveness_state: 'YES',
      method: 'test',
    }),
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.results, null, 2));
  assert.equal(result.committed, 1, JSON.stringify(result.results, null, 2));
  assert.equal(result.results[0].status, 'COMMITTED', JSON.stringify(result.results[0], null, 2));
  assert.match(readFileSync(join(dir, 'data', 'applications.md'), 'utf8'), /Example Co/);
  assert.equal(existsSync(file), false);
});

test('career-ops evaluate help lists the command and dry-runs against an isolated file', () => {
  const help = execFileSync(process.execPath, [cli, 'help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /evaluate/);

  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-cli-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeFileSync(file, [
    'url\tcompany\ttitle\tlocation\tsource',
    'https://jobs.example.com/cli\tCLI Co\tSoftware Engineer\tRemote\tmanual',
    '',
  ].join('\n'));

  const output = JSON.parse(execFileSync(process.execPath, [
    cli, 'evaluate',
    '--target', dir,
    '--file', file,
    '--skip-liveness',
    '--max', '1',
  ], { cwd: root, encoding: 'utf8' }));

  assert.equal(output.schema, 'EvaluateScanResultV1');
  assert.equal(output.status, 'PLAN');
  assert.equal(output.candidate_count, 1);
  assert.equal(output.queue[0].company, 'CLI Co');
});
