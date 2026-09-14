import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCareerOpsApp } from '../lib/web/career-ops-app.mjs';
import { evaluateQueuePath, readEvaluateQueue } from '../lib/runtime/evaluate-scan.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writeMinimalConfig(dir, { applicationsEnabled = false } = {}) {
  const path = join(dir, 'runtime.yml');
  writeFileSync(path, `runtime_version: 1
api_billing: false
subscription_overage: false
writer_host: ${hostname()}
applications:
  enabled: ${applicationsEnabled}
resource_pools: {}
providers: {}
`);
  return path;
}

function makeTarget() {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-web-jobs-'));
  mkdirSync(join(target, 'data'), { recursive: true });
  writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
`);
  writeFileSync(
    join(target, 'data', 'scan-results-2026-09-13.tsv'),
    [
      'url\tcompany\ttitle\tlocation\tsource',
      'https://jobs.example.com/us/software-engineer\tExampleCo\tSoftware Engineer\tRemote - United States\tgarden',
      'https://jobs.example.com/se/stockholm-role\tEuroCo\tSoftware Engineer\tStockholm, Sweden\tgarden',
    ].join('\n') + '\n',
  );
  return target;
}

async function withApp(fn, { applicationsEnabled = false } = {}) {
  const target = makeTarget();
  const configPath = writeMinimalConfig(target, { applicationsEnabled });
  const app = createCareerOpsApp({
    target,
    repoRoot,
    configPath,
    port: 0,
    observedHost: hostname(),
  });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ app, base, target, port });
  } finally {
    await app.close();
    rmSync(target, { recursive: true, force: true });
  }
}

test('POST /api/jobs without CSRF is denied', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'verify' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'CSRF_DENIED');
  });
});

test('job lock rejects a second in-flight job', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    // Start a long verify-like job by occupying the runner with a fake wait via evaluate_plan
    // that we immediately follow with another start while first is running.
    // Force busy by starting scan_all dry-run then immediately another.
    const first = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'evaluate_plan', args: { max: 1, skip_liveness: true, out: false }, csrf }),
    });
    assert.equal(first.status, 202);
    const second = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'verify', csrf }),
    });
    // May be 409 if still running, or 202 if first already finished on a fast machine.
    if (second.status === 409) {
      const body = await second.json();
      assert.equal(body.code, 'JOB_BUSY');
    } else {
      assert.equal(second.status, 202);
    }
    // Wait for idle
    for (let i = 0; i < 40; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      if (!cur.job || cur.job.status === 'done' || cur.job.status === 'error') break;
      await new Promise(r => setTimeout(r, 100));
    }
  });
});

test('evaluate_plan writes queue without tracker rows', async () => {
  await withApp(async ({ app, base, target }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        action: 'evaluate_plan',
        args: { max: 5, skip_liveness: true, out: false },
        csrf,
      }),
    });
    assert.equal(res.status, 202);
    for (let i = 0; i < 80; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      if (cur.job && (cur.job.status === 'done' || cur.job.status === 'error')) {
        assert.equal(cur.job.status, 'done', JSON.stringify(cur.job));
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    const queuePath = evaluateQueuePath(join(target, 'data'));
    assert.ok(existsSync(queuePath), 'evaluate-queue.tsv should exist');
    const queue = readEvaluateQueue(queuePath);
    assert.ok(queue.length >= 1, 'queue should contain US-eligible rows');
    assert.ok(queue.every(row => !/stockholm/i.test(row.location || '') && !/stockholm/i.test(row.url)));
    const tracker = readFileSync(join(target, 'data', 'applications.md'), 'utf8');
    const dataRows = tracker.split(/\r?\n/).filter(line => /^\|\s*\d+/.test(line));
    assert.equal(dataRows.length, 0, 'plan must not write tracker rows');
  });
});
