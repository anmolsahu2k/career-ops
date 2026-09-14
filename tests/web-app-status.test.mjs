import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunnelStatus, listTriagePreview, readReportMarkdown } from '../lib/web/status.mjs';
import { renderCareerOpsPage } from '../lib/web/page.mjs';

function makeTarget() {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-web-status-'));
  mkdirSync(join(target, 'data'), { recursive: true });
  mkdirSync(join(target, 'reports', 'acme'), { recursive: true });
  writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
| 1 | 2026-09-01 | Acme | Software Engineer | 4.2/5 | Evaluated | — | [r](reports/acme/1.md) | APPLY SRC: greenhouse-api |
| 2 | 2026-09-02 | Beta | Staff Engineer | 3.1/5 | Rejected | — | — | NO SRC: garden |
`);
  writeFileSync(
    join(target, 'data', 'scan-results-2026-09-13.tsv'),
    'url\tcompany\ttitle\tlocation\tsource\nhttps://example.com/jobs/1\tAcme\tSoftware Engineer\tRemote, US\tgarden\n',
  );
  writeFileSync(join(target, 'reports', 'acme', '1.md'), '# Acme\n**URL:** https://example.com/jobs/1\n');
  return target;
}

test('buildFunnelStatus returns safe funnel counts without CV text', () => {
  const target = makeTarget();
  try {
    const status = buildFunnelStatus({
      target,
      repoRoot: target,
      writable: false,
      writerHost: 'other',
      observedHost: 'here',
      applicationsEnabled: false,
    });
    assert.equal(status.schema, 'CareerOpsWebStatusV1');
    assert.equal(status.discovery.triage_count, 1);
    assert.equal(status.tracker.total, 2);
    assert.equal(status.tracker.status_counts.Evaluated, 1);
    assert.equal(status.tracker.rows[1].source, 'greenhouse-api');
    assert.equal(status.tracker.rows[1].date, '2026-09-01');
    assert.equal(status.tracker.rows[1].can_apply, true);
    assert.equal(status.tracker.rows[1].apply_eligible, true);
    assert.equal(status.tracker.rows[1].posting_url, 'https://example.com/jobs/1');
    assert.equal(status.apply.eligible_count, 1);
    assert.equal(status.apply.near_miss_count, 0);
    assert.equal(status.apply.board_path, '/apply/');
    assert.equal(status.tracker.rows[0].source, 'garden');
    assert.equal(status.tracker.rows[0].can_apply, false);
    assert.equal(status.writable, false);
    assert.ok(!JSON.stringify(status).includes('email'));
    assert.ok(!('cv' in status));
    const triage = listTriagePreview(target);
    assert.equal(triage.total, 1);
    assert.equal(triage.rows[0].company, 'Acme');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('buildFunnelStatus flags missing APPLY token as near-miss', () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-web-near-'));
  try {
    mkdirSync(join(target, 'data'), { recursive: true });
    mkdirSync(join(target, 'reports', 'acme'), { recursive: true });
    writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
| 1 | 2026-09-01 | Acme | Software Engineer | 4.2/5 | Evaluated | — | [r](reports/acme/1.md) | Submit SDE resume. SRC: greenhouse-api |
`);
    writeFileSync(join(target, 'reports', 'acme', '1.md'), '**URL:** https://boards.greenhouse.io/acme/jobs/1\n');
    const status = buildFunnelStatus({ target, repoRoot: target });
    assert.equal(status.apply.eligible_count, 0);
    assert.equal(status.apply.near_miss_count, 1);
    assert.equal(status.apply.near_misses[0].blocker, 'MISSING_APPLY_TOKEN');
    assert.equal(status.tracker.rows[0].can_apply, false);
    assert.equal(status.tracker.rows[0].apply_near_miss, true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('readReportMarkdown rejects path escape and serves in-target markdown', () => {
  const target = makeTarget();
  try {
    assert.throws(() => readReportMarkdown(target, '../secret.md'), /Invalid report path|escapes/);
    const md = readReportMarkdown(target, 'reports/acme/1.md');
    assert.match(md, /Acme/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('operator page ships funnel nav, job dock, and confirm dialog', () => {
  const html = renderCareerOpsPage({ csrfToken: 'test-csrf', writable: true, applicationsEnabled: false });
  assert.match(html, /funnel-nav/);
  assert.match(html, /job-dock/);
  assert.match(html, /confirm-dialog/);
  assert.match(html, /test-csrf/);
  assert.match(html, /data-job="apply_row"|Apply/);
  assert.match(html, /Run \(submit\)/);
  assert.match(html, /submit=true/);
  assert.match(html, /Near-misses/);
  assert.match(html, /Apply Attempts board/);
  assert.doesNotMatch(html, /Run \(no submit\)/);
  assert.doesNotMatch(html, /The UI never submits/);
});
