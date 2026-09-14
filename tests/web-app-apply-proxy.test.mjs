import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCareerOpsApp } from '../lib/web/career-ops-app.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writeConfig(dir, enabled) {
  const path = join(dir, 'runtime.yml');
  writeFileSync(path, `runtime_version: 1
api_billing: false
subscription_overage: false
writer_host: ${hostname()}
applications:
  enabled: ${enabled}
resource_pools: {}
providers: {}
`);
  return path;
}

function makeTarget() {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-web-apply-'));
  mkdirSync(join(target, 'data'), { recursive: true });
  writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
`);
  return target;
}

async function withApp(enabled, fn) {
  const target = makeTarget();
  const configPath = writeConfig(target, enabled);
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
    await fn({ app, base, target });
  } finally {
    await app.close();
    rmSync(target, { recursive: true, force: true });
  }
}

test('apply board page is composed under /apply/', async () => {
  await withApp(false, async ({ base }) => {
    const res = await fetch(`${base}/apply/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Apply Attempts/);
    const attempts = await fetch(`${base}/apply/api/attempts`);
    assert.equal(attempts.status, 200);
    assert.deepEqual(await attempts.json(), []);
  });
});

test('apply preview and analytics endpoints are read-only', async () => {
  await withApp(false, async ({ base }) => {
    const preview = await fetch(`${base}/api/apply/preview`);
    assert.equal(preview.status, 200);
    const body = await preview.json();
    assert.equal(body.schema, 'ApplicationEnqueuePreviewV1');
    const analytics = await fetch(`${base}/api/apply/analytics`);
    assert.equal(analytics.status, 200);
    assert.equal((await analytics.json()).schema, 'ApplicationAttemptAnalyticsV1');
  });
});

test('apply mutating board actions stay read-only when applications.enabled is false', async () => {
  await withApp(false, async ({ app, base }) => {
    const res = await fetch(`${base}/apply/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': app.csrfToken },
      body: JSON.stringify({ action: 'skip', key: 'missing' }),
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /read-only/i);
  });
});

test('apply_row job is refused when applications.enabled is false', async () => {
  await withApp(false, async ({ app, base }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': app.csrfToken },
      body: JSON.stringify({ action: 'apply_row', args: { tracker_number: 1 }, csrf: app.csrfToken }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'APPLICATIONS_DISABLED');
  });
});
