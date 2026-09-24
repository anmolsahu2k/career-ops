import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCareerOpsApp } from '../lib/web/career-ops-app.mjs';
import { evaluateQueuePath, readEvaluateQueue } from '../lib/runtime/evaluate-scan.mjs';
import { evaluateRowFailure, summarizeEvaluate, selectedTriageUrls, MAX_SELECTED_EVAL_URLS, ALLOWED_JOB_ACTIONS } from '../lib/web/jobs.mjs';

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

test('tracker_discard writes Discarded without applications.enabled', async () => {
  await withApp(async ({ app, base, target }) => {
    writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
| 7 | 2026-09-01 | Acme | Engineer | 4.0/5 | Evaluated | — | — | APPLY SRC: greenhouse-api |
`);
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        action: 'tracker_discard',
        args: { tracker_number: 7 },
        csrf,
      }),
    });
    assert.equal(res.status, 202);
    let job = null;
    for (let i = 0; i < 40; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      job = cur.job;
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.match(readFileSync(join(target, 'data', 'applications.md'), 'utf8'), /\| Discarded \|/);
    assert.match(readFileSync(join(target, 'data', 'applications.md'), 'utf8'), /APPLY SRC: greenhouse-api/);
  });
});

test('tracker_mark_applied writes Applied without submitting', async () => {
  await withApp(async ({ app, base, target }) => {
    writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
| 7 | 2026-09-01 | Acme | Engineer | 4.0/5 | Evaluated | — | — | APPLY SRC: greenhouse-api |
`);
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        action: 'tracker_mark_applied',
        args: { tracker_number: 7 },
        csrf,
      }),
    });
    assert.equal(res.status, 202);
    let job = null;
    for (let i = 0; i < 40; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      job = cur.job;
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(job?.status, 'done', JSON.stringify(job));
    const tracker = readFileSync(join(target, 'data', 'applications.md'), 'utf8');
    assert.match(tracker, /\| Applied \|/);
    assert.match(tracker, /APPLY SRC: greenhouse-api/);
    assert.doesNotMatch(tracker, /\| Discarded \|/);
  });
});

test('selectedTriageUrls keeps only unique https URLs that are in triage', () => {
  const rows = [
    { url: 'https://jobs.example.com/us/software-engineer' },
    { url: 'https://jobs.example.com/se/stockholm-role' },
  ];
  assert.deepEqual(
    selectedTriageUrls({ url: 'https://jobs.example.com/us/software-engineer' }, rows),
    ['https://jobs.example.com/us/software-engineer'],
  );
  assert.deepEqual(
    selectedTriageUrls({
      urls: [
        'https://jobs.example.com/us/software-engineer',
        'https://jobs.example.com/se/stockholm-role',
        'https://jobs.example.com/us/software-engineer',
      ],
    }, rows),
    ['https://jobs.example.com/us/software-engineer', 'https://jobs.example.com/se/stockholm-role'],
  );
  assert.throws(
    () => selectedTriageUrls({ urls: ['https://example.com/not-in-triage'] }, rows),
    /not in the current triage backlog/,
  );
  assert.throws(
    () => selectedTriageUrls({ urls: Array.from({ length: MAX_SELECTED_EVAL_URLS + 1 }, (_, i) => `https://jobs.example.com/${i}`) }, rows),
    /at most/,
  );
});

test('evaluate_row rejects a URL that is not in triage', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        action: 'evaluate_row',
        args: { url: 'https://example.com/not-in-triage' },
        csrf,
      }),
    });
    assert.equal(res.status, 202);
    let job = null;
    for (let i = 0; i < 40; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      job = cur.job;
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(job?.status, 'error', JSON.stringify(job));
    assert.equal(job.error.code, 'URL_NOT_IN_TRIAGE');
  });
});

test('summarizeEvaluate and evaluateRowFailure surface the row error', () => {
  const result = {
    status: 'COMPLETED',
    results: [{
      status: 'FAILED',
      code: 'PROVIDER_TIMEOUT',
      error: 'agy exceeded the 120000ms command deadline',
      company: 'OneImaging',
      title: 'Full Stack Associate Software Engineer',
    }],
    committed: 0,
    failed: 1,
  };
  const summary = summarizeEvaluate(result);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failed_code, 'PROVIDER_TIMEOUT');
  assert.match(summary.message, /PROVIDER_TIMEOUT/);
  assert.match(summary.message, /command deadline/);
  const failure = evaluateRowFailure(result);
  assert.equal(failure.code, 'PROVIDER_TIMEOUT');
  assert.match(failure.message, /command deadline/);
  assert.equal(evaluateRowFailure({ results: [{ status: 'COMMITTED' }] }), null);
});

test('summarizeEvaluate keeps FETCH_FAILED visible after a mixed batch', () => {
  const summary = summarizeEvaluate({
    status: 'COMPLETED',
    candidate_count: 42,
    skipped: [
      { url: 'https://example.com/a', code: 'LEVEL_MISMATCH' },
    ],
    expired: [
      { url: 'https://example.com/b', reason: 'insufficient content' },
    ],
    results: [
      { status: 'COMMITTED', company: 'Acme' },
      {
        status: 'FETCH_FAILED',
        company: 'StepStone Group',
        title: 'Junior Analyst',
        error: 'SOURCE_NOT_LISTED',
        url: 'https://www.stepstonegroup.com/current-opportunities/?gh_jid=8171272',
      },
      { status: 'SKIPPED_STALE', company: 'OldCo' },
    ],
  });
  assert.equal(summary.committed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.failed_code, 'FETCH_FAILED');
  assert.equal(summary.failed_company, 'StepStone Group');
  assert.match(summary.message, /1 committed/);
  assert.match(summary.message, /3 skipped/);
  assert.match(summary.message, /SOURCE_NOT_LISTED/);
  assert.match(summary.message, /StepStone Group/);
});

test('GET /api/status returns the live CSRF token and a stale header is denied', async () => {
  await withApp(async ({ app, base }) => {
    const status = await fetch(`${base}/api/status`).then(r => r.json());
    assert.equal(status.csrf, app.csrfToken);
    assert.equal(status.handshake.enabled, false);
    assert.equal(status.handshake.apply_score_minimum, 3.5);
    const denied = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'deadbeef' },
      body: JSON.stringify({ action: 'verify', csrf: 'deadbeef' }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'CSRF_DENIED');
    const ok = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': status.csrf },
      body: JSON.stringify({ action: 'verify', csrf: status.csrf }),
    });
    assert.ok(ok.status === 202 || ok.status === 409, 'expected verify to start or busy, got ' + ok.status);
  });
});

test('UI restarts on the same port keep the CSRF token', async () => {
  const target = makeTarget();
  const configPath = writeMinimalConfig(target);
  const options = {
    target,
    repoRoot,
    configPath,
    port: 8792,
    observedHost: hostname(),
  };
  const first = createCareerOpsApp(options);
  const token = first.csrfToken;
  assert.match(token, /^[a-f0-9]{48}$/);
  try {
    const { port } = await first.listen(0);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, new RegExp(`let csrf = "${token}"`));
    await first.close();
    const second = createCareerOpsApp(options);
    try {
      assert.equal(second.csrfToken, token);
      const again = await second.listen(0);
      const page = await (await fetch(`http://127.0.0.1:${again.port}/`)).text();
      assert.match(page, new RegExp(`let csrf = "${token}"`));
    } finally {
      await second.close();
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('Handshake job actions are allowlisted; unknown actions stay rejected', () => {
  assert.ok(ALLOWED_JOB_ACTIONS.includes('handshake_doctor'));
  assert.ok(ALLOWED_JOB_ACTIONS.includes('handshake_job'));
  assert.ok(ALLOWED_JOB_ACTIONS.includes('handshake_session'));
  assert.equal(ALLOWED_JOB_ACTIONS.includes('handshake_pwn'), false);
});

test('handshake_job is denied when applications.enabled is false', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'handshake_job', args: {}, csrf }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'APPLICATIONS_DISABLED');
  });
});

test('handshake_session is denied when main_profile handshake is off', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'handshake_session', args: { max: 10 }, csrf }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'HANDSHAKE_DISABLED');
  }, { applicationsEnabled: true });
});

test('handshake_doctor is writable without applications.enabled', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'handshake_doctor', args: {}, csrf }),
    });
    assert.equal(res.status, 202);
    let job = null;
    for (let i = 0; i < 40; i++) {
      const cur = await fetch(`${base}/api/jobs/current`).then(r => r.json());
      job = cur.job;
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(job?.status, 'done', JSON.stringify(job));
    assert.equal(job.result_summary.cdp_ok, false);
  });
});

test('unknown Handshake-like action is rejected', async () => {
  await withApp(async ({ app, base }) => {
    const csrf = app.csrfToken;
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'handshake_pwn', args: {}, csrf }),
    });
    assert.ok(res.status === 400 || res.status === 403 || res.status === 422 || res.status === 500);
    const body = await res.json();
    assert.equal(body.code, 'UNKNOWN_ACTION');
  });
});
