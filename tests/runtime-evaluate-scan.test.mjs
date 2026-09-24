import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

test('evaluateScanResults can plan a single triage URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-url-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, [{
    url: 'https://jobs.example.com/keep',
    company: 'Example',
    title: 'Software Engineer',
    location: 'Remote',
    source: 'manual',
  }, {
    url: 'https://jobs.example.com/skip',
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
    urls: ['https://jobs.example.com/keep'],
  });

  assert.equal(result.status, 'PLAN');
  assert.equal(result.candidate_count, 1);
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].url, 'https://jobs.example.com/keep');
});

test('evaluateScanResults plan prunes geography and level rejects from triage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-prune-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, [{
    url: 'https://jobs.example.com/london',
    company: 'Wiz',
    title: 'Security Engineer',
    location: 'London, UK',
    source: 'manual',
  }, {
    url: 'https://jobs.example.com/senior',
    company: 'Acme',
    title: 'Sr. Software Engineer',
    location: 'Austin, TX',
    source: 'manual',
  }, {
    url: 'https://jobs.example.com/keep',
    company: 'Humana',
    title: 'Software Engineer',
    location: 'Louisville, KY',
    source: 'manual',
  }]);

  const result = await evaluateScanResults({
    target: dir,
    files: [file],
    apply: false,
    skipLiveness: true,
    max: 3,
    candidateContext: {
      available: true,
      entry_level_only: true,
      us_only: true,
      work_authorized_at_start: true,
      level_band: 'New Grad / Entry-Level',
      evidence: {
        id: 'EV-CANDIDATE',
        source_type: 'candidate-record',
        uri: 'career-ops://candidate/profile',
        content: 'new grad US-only',
        liveness_state: 'UNKNOWN',
        trust_class: 'trusted_evidence',
        derive_oracles: false,
      },
    },
  });

  assert.equal(result.status, 'PLAN');
  assert.equal(result.skipped.length, 2);
  assert.equal(result.pruned, 2);
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].company, 'Humana');
  const remaining = loadScanResults([file]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].company, 'Humana');
  assert.equal(existsSync(join(dir, 'data', 'applications.md')), false);
  const queuePath = join(dataDir, 'evaluate-queue.tsv');
  assert.equal(existsSync(queuePath), true);
  assert.equal(result.queue_path, queuePath);
  assert.equal(loadScanResults([queuePath]).length, 1);
  assert.equal(loadScanResults([queuePath])[0].company, 'Humana');
});

test('evaluateScanResults --from-queue scores only the saved eval queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-from-queue-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const triage = join(dataDir, 'scan-results-2026-09-12.tsv');
  const queuePath = join(dataDir, 'evaluate-queue.tsv');
  writeScanResultsTsv(triage, [{
    url: 'https://jobs.example.com/queued',
    company: 'Queued Co',
    title: 'Software Engineer',
    location: 'Austin, TX',
    source: 'manual',
  }, {
    url: 'https://jobs.example.com/not-in-queue',
    company: 'Other Co',
    title: 'Software Engineer',
    location: 'Austin, TX',
    source: 'manual',
  }]);
  writeScanResultsTsv(queuePath, [{
    url: 'https://jobs.example.com/queued',
    company: 'Queued Co',
    title: 'Software Engineer',
    location: 'Austin, TX',
    source: 'manual',
  }]);

  const longJd = `${'Requirements: build APIs with Node.js and ship reliable services. '.repeat(20)}`;
  const captured = [];
  const providerHandle = {
    async complete(request) {
      captured.push(request.task.subject.company);
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
        response: JSON.stringify({
          decision_inputs: {
            gates: Object.fromEntries([
              'posting_live', 'citizenship_restricted', 'geography_eligible',
              'sponsorship_compatible', 'required_evidence_complete',
            ].map(gate => [gate, {
              value: gate === 'posting_live' || gate === 'required_evidence_complete' ? 'YES'
                : gate === 'citizenship_restricted' ? 'NO'
                  : gate === 'geography_eligible' ? 'YES'
                    : 'YES',
              evidence_refs: [{ evidence_id: 'EV-1', field: gate === 'posting_live' ? 'liveness_state' : gate }],
            }])),
            score: 4.2,
            recommendation: 'APPLY',
            confidence: 0.9,
          },
          presentation_content: {
            A: 'Role', B: 'Match', C: 'Level', D: 'Comp', E: 'Plan', F: 'Interview', G: 'Live',
          },
        }),
        usage: {},
        latency_ms: 1,
        attempts: 1,
        capability_degradation: false,
      };
    },
  };

  const result = await evaluateScanResults({
    target: dir,
    config: {
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
    },
    apply: true,
    fromQueue: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle,
    candidateContext: {
      available: true,
      entry_level_only: true,
      us_only: true,
      work_authorized_at_start: true,
      level_band: 'New Grad / Entry-Level',
      evidence: {
        id: 'EV-CANDIDATE',
        source_type: 'candidate-record',
        uri: 'career-ops://candidate/profile',
        content: 'new grad',
        liveness_state: 'UNKNOWN',
        trust_class: 'trusted_evidence',
        derive_oracles: false,
      },
    },
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'manual',
      content: longJd,
      title: 'Software Engineer',
      liveness_state: 'YES',
      posted_at: new Date().toISOString(),
      method: 'test',
    }),
  });

  assert.equal(result.source, 'queue');
  assert.equal(result.committed, 1, JSON.stringify(result.results, null, 2));
  assert.deepEqual(captured, ['Queued Co']);
  assert.equal(existsSync(queuePath), false);
  assert.equal(loadScanResults([triage]).map(row => row.company).join(','), 'Other Co');
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

test('evaluateScanResults records provider errors in the failure ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evaluate-fail-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, [{
    url: 'https://jobs.example.com/fail-me',
    company: 'Timeout Co',
    title: 'Software Engineer',
    location: 'Remote',
    source: 'manual',
  }]);

  const longJd = `${'Requirements: build APIs with Node.js and ship reliable services. '.repeat(12)}Apply now.`;
  const result = await evaluateScanResults({
    target: dir,
    config: stubConfig(),
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle: {
      async complete() {
        throw Object.assign(new Error('agy exceeded the 120000ms command deadline'), {
          code: 'PROVIDER_TIMEOUT',
        });
      },
    },
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'manual',
      content: longJd,
      title: 'Software Engineer',
      liveness_state: 'YES',
      method: 'test',
    }),
  });

  assert.equal(result.committed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].code, 'PROVIDER_TIMEOUT');
  assert.match(result.results[0].error, /command deadline/);
  const ledgerName = readdirSync(dataDir).find(name => name.startsWith('evaluate-failures-'));
  assert.ok(ledgerName, 'failure ledger should be written');
  const ledger = readFileSync(join(dataDir, ledgerName), 'utf8');
  assert.match(ledger, /PROVIDER_TIMEOUT/);
  assert.match(ledger, /command deadline/);
  assert.equal(existsSync(file), true);
});
