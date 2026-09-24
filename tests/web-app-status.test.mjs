import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunnelStatus, buildApplyPipeline, listTriagePreview, readReportMarkdown } from '../lib/web/status.mjs';
import { funnelPhaseModels } from '../lib/web/phase-models.mjs';
import { renderCareerOpsPage } from '../lib/web/page.mjs';
import { queueAttempt } from '../lib/applications/store.mjs';

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
  writeFileSync(join(target, 'reports', 'acme', '1.md'), '# Acme\n**URL:** https://job-boards.greenhouse.io/acme/jobs/1\n');
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
    assert.equal(status.tracker.rows[1].posting_url, 'https://job-boards.greenhouse.io/acme/jobs/1');
    assert.equal(status.apply.eligible_count, 1);
    assert.equal(status.apply.near_miss_count, 0);
    assert.equal(status.apply.work_queue_count, 1);
    assert.equal(status.apply.pipeline.length, 2);
    assert.equal(status.apply.pipeline.filter(item => item.state === 'ELIGIBLE').length, 1);
    assert.equal(status.apply.pipeline[0].kind, 'eligible');
    assert.equal(status.apply.pipeline.find(item => Number(item.tracker_number) === 2).state, 'REJECTED');
    assert.equal(status.apply.pipeline.find(item => Number(item.tracker_number) === 2).kind, 'tracker');
    assert.equal(status.apply.attempt_counts.ELIGIBLE, 1);
    assert.equal(status.apply.attempt_counts.REJECTED, 1);
    assert.equal(status.apply.board_path, '/apply/');
    assert.equal(status.apply.doctor, null);
    assert.equal(status.tracker.rows[0].source, 'garden');
    assert.equal(status.tracker.rows[0].can_apply, false);
    assert.equal(status.writable, false);
    assert.ok(!JSON.stringify(status).includes('@gmail'));
    assert.ok(!('cv' in status));
    assert.equal(status.discovery.models[0].role, 'Scan');
    assert.equal(status.discovery.models[0].model, 'none');
    assert.equal(status.discovery.models.find(item => item.role === 'Handshake eval')?.provider_id, 'antigravity-gemini-flash-high');
    assert.equal(status.handshake.enabled, false);
    assert.equal(status.handshake.apply_score_minimum, 3.5);
    assert.equal(status.evaluate.models.find(item => item.role === 'Judge').provider_id, 'antigravity-gemini-flash-high');
    assert.equal(status.tracker.models.find(item => item.role === 'Fill / submit').model, 'none');
    const triage = listTriagePreview(target);
    assert.equal(triage.total, 1);
    assert.equal(triage.rows[0].company, 'Acme');
    assert.equal(triage.rows[0].ats, 'generic');
    queueAttempt(target, {
      tracker_number: 1,
      canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
      ats: 'greenhouse',
      company: 'Acme',
      role: 'Software Engineer',
    });
    const afterQueue = buildFunnelStatus({ target, repoRoot: target });
    assert.equal(afterQueue.apply.eligible_count, 0);
    assert.equal(afterQueue.apply.pipeline.filter(item => item.state === 'ELIGIBLE').length, 0);
    assert.equal(afterQueue.apply.pipeline.filter(item => item.state === 'QUEUED' && item.kind === 'attempt').length, 1);
    assert.equal(afterQueue.apply.pipeline.find(item => Number(item.tracker_number) === 2).state, 'REJECTED');
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
    assert.equal(status.apply.pipeline.filter(item => item.state === 'NEAR_MISS').length, 1);
    assert.equal(status.apply.pipeline[0].kind, 'near_miss');
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

test('buildFunnelStatus exposes Gmail OTP readiness without mailbox details', () => {
  const target = makeTarget();
  try {
    const off = buildFunnelStatus({
      target,
      repoRoot: target,
      config: { applications: { gmail_otp: { enabled: false } } },
    });
    assert.equal(off.apply.doctor.gmail_otp.enabled, false);
    assert.equal(off.apply.doctor.gmail_otp.ready, false);
    assert.match(off.apply.doctor.gmail_otp.detail, /disabled/i);
    const broken = buildFunnelStatus({
      target,
      repoRoot: target,
      config: { applications: { gmail_otp: { enabled: true, python_command: '' } } },
    });
    assert.equal(broken.apply.doctor.gmail_otp.enabled, true);
    assert.equal(broken.apply.doctor.gmail_otp.ready, false);
    assert.equal(broken.apply.doctor.gmail_otp.expires_in_seconds, null);
    assert.ok(!JSON.stringify(broken).includes('gmail.com'));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('operator page ships funnel nav, job dock, and confirm dialog', () => {
  const html = renderCareerOpsPage({ csrfToken: 'test-csrf', writable: true, applicationsEnabled: false });
  assert.match(html, /funnel-nav/);
  assert.match(html, /job-dock/);
  assert.match(html, /confirm-dialog/);
  assert.match(html, /let csrf = "test-csrf"/);
  assert.match(html, /CSRF_DENIED/);
  assert.match(html, /function refreshCsrf/);
  assert.match(html, /function connectEvents/);
  assert.match(html, /id="triage-ats-filters"/);
  assert.match(html, /data-triage-ats/);
  assert.match(html, /p\.error/);
  assert.match(html, /function evaluateRowButton/);
  assert.match(html, /'','Company','Title','ATS','Source',''/);
  assert.match(html, /id="select-triage"/);
  assert.match(html, /id="evaluate-selected"/);
  assert.match(html, /function visibleTriageRows/);
  assert.match(html, /function shownTriageSelection/);
  assert.match(html, /Select all shown/);
  assert.match(html, /data-selected="1"/);
  assert.match(html, /data-triage-url/);
  assert.match(html, /data-job="tracker_discard"/);
  assert.match(html, /data-job="tracker_mark_applied"/);
  assert.match(html, /function markAppliedRowButton/);
  assert.match(html, /function discardRowButton/);
  assert.match(html, /function applyRowButton/);
  assert.match(html, /already-open Handshake Chrome/);
  assert.match(html, /x\.external_host/);
  assert.match(html, /x\.external_url/);
  assert.match(html, /data-apply-url/);
  assert.match(html, /data-job-url/);
  assert.match(html, /id="row-menu"/);
  assert.match(html, /Copy job link/);
  assert.match(html, /data-row-menu="copy-job"/);
  assert.match(html, /function applyLinkLabel/);
  assert.match(html, /function linkifyDetail/);
  assert.doesNotMatch(html, /attempt-urls/);
  assert.doesNotMatch(html, /data-posting-url/);
  assert.match(html, /Run queued/);
  assert.match(html, /submit=true/);
  assert.match(html, /Near-miss/);
  assert.match(html, /<h3>Pipeline<\/h3>/);
  assert.match(html, /ELIGIBLE/);
  assert.match(html, /NEAR_MISS/);
  assert.match(html, /<span class="kicker">03 track<\/span>/);
  assert.match(html, /<span class="kicker">04 hygiene<\/span>/);
  assert.match(html, /if \(name === 'apply'\) name = 'tracker'/);
  assert.match(html, /hashTab === 'apply'/);
  assert.doesNotMatch(html, /data-tab="apply"/);
  assert.doesNotMatch(html, /<h2>Apply<\/h2>/);
  assert.doesNotMatch(html, /id="tracker-table"/);
  assert.doesNotMatch(html, /Eligible & near-miss/);
  assert.doesNotMatch(html, /id="eligible-table"/);
  assert.doesNotMatch(html, /id="near-miss-table"/);
  assert.match(html, /id="cdp-chip"/);
  assert.match(html, /id="handshake-card"/);
  assert.match(html, /id="handshake-ready"/);
  assert.match(html, /data-job="handshake_session"/);
  assert.match(html, /data-job="handshake_job"/);
  assert.match(html, /data-job="handshake_doctor"/);
  assert.match(html, /existing Evaluate judge/);
  assert.match(html, /chrome:\/\/inspect\/#remote-debugging/);
  assert.match(html, /second Allow dialog/);
  assert.match(html, /job-bar-meta \.grow[\s\S]*white-space:\s*normal/);
  assert.match(html, /submissionGate/);
  assert.match(html, /status && status.handshake && status.handshake.enabled/);
  assert.match(html, /Gmail OTP ready/);
  assert.match(html, /id="discovery-models"/);
  assert.match(html, /id="evaluate-models"/);
  assert.match(html, /id="tracker-models"/);
  assert.match(html, /function renderPhaseModels/);
  assert.doesNotMatch(html, /Run \(no submit\)/);
  assert.doesNotMatch(html, /The UI never submits/);
});

test('funnel phase models name the tab actions from live config', () => {
  const models = funnelPhaseModels({
    applications: {
      hosted_fallback_providers: ['antigravity-gemini-flash-medium'],
      local_prose: { cover_letters: false, provider: 'ollama-qwen3-4b' },
    },
    providers: {
      'antigravity-gemini-flash-high': { model_snapshot: 'gemini-3.8-flash-high' },
      'antigravity-gemini-flash-medium': { model_snapshot: 'gemini-3.8-flash-medium' },
      'cerebras-gpt-oss-120b': { model_snapshot: 'gpt-oss-120b' },
      'groq-llama-70b': { model_snapshot: 'llama-3.3-70b-versatile' },
      'ollama-qwen3-4b': { model_snapshot: 'qwen3:4b-instruct-2507-q4_K_M' },
    },
  });
  assert.equal(models.discovery.find(item => item.role === 'Scan').model, 'none');
  assert.equal(models.discovery.find(item => item.role === 'Evaluate row').model, 'Gemini 3.8 Flash High');
  assert.equal(models.discovery.find(item => item.role === 'Handshake eval').provider_id, 'antigravity-gemini-flash-high');
  assert.equal(models.evaluate.find(item => item.role === 'Plan').model, 'none');
  assert.equal(models.evaluate.find(item => item.role === 'Judge').model, 'Gemini 3.8 Flash High');
  assert.equal(models.evaluate.find(item => item.role === 'Sweep').model, 'GPT OSS 120b');
  assert.equal(models.evaluate.find(item => item.role === 'Overflow').model, 'Llama 3.3 70b Versatile');
  assert.equal(models.tracker.find(item => item.role === 'Cover letter').model, 'Gemini 3.8 Flash Medium');
  assert.equal(models.tracker.find(item => item.role === 'Cover letter').provider_id, 'antigravity-gemini-flash-medium');
  assert.equal(models.tracker.find(item => item.role === 'Salary preference').model, 'Gemini 3.8 Flash Medium');
  assert.equal(models.tracker.find(item => item.role === 'Salary preference').provider_id, 'antigravity-gemini-flash-medium');
});

test('funnel phase models keep local salary only when local_prose is enabled', () => {
  const models = funnelPhaseModels({
    applications: {
      hosted_fallback_providers: ['antigravity-gemini-flash-medium'],
      local_prose: { enabled: true, cover_letters: false, provider: 'ollama-qwen3-4b' },
    },
    providers: {
      'antigravity-gemini-flash-high': { model_snapshot: 'gemini-3.8-flash-high' },
      'antigravity-gemini-flash-medium': { model_snapshot: 'gemini-3.8-flash-medium' },
      'cerebras-gpt-oss-120b': { model_snapshot: 'gpt-oss-120b' },
      'groq-llama-70b': { model_snapshot: 'llama-3.3-70b-versatile' },
      'ollama-qwen3-4b': { model_snapshot: 'qwen3:4b-instruct-2507-q4_K_M' },
    },
  });
  assert.match(models.tracker.find(item => item.role === 'Salary preference').model, /Qwen3/);
  assert.equal(models.tracker.find(item => item.role === 'Cover letter').provider_id, 'antigravity-gemini-flash-medium');
});

test('workday APPLY rows are unsupported when greenhouse is the only enabled ATS', () => {
  const target = makeTarget();
  try {
    writeFileSync(join(target, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
| 1 | 2026-09-01 | Acme | Software Engineer | 4.2/5 | Evaluated | — | [r](reports/acme/1.md) | APPLY SRC: greenhouse-api |
| 2 | 2026-09-01 | Leidos | Software Engineer | 4.0/5 | Evaluated | — | [r](reports/leidos/2.md) | APPLY SRC: workday |
`);
    mkdirSync(join(target, 'reports', 'leidos'), { recursive: true });
    writeFileSync(join(target, 'reports', 'leidos', '2.md'), '**URL:** https://leidos.wd1.myworkdayjobs.com/en-US/External/job/Software-Engineer_R-1\n');
    const status = buildFunnelStatus({
      target,
      repoRoot: target,
      config: { applications: { supported_ats: ['greenhouse'] } },
    });
    const leidos = status.apply.pipeline.find(item => Number(item.tracker_number) === 2);
    const acme = status.apply.pipeline.find(item => Number(item.tracker_number) === 1);
    assert.equal(acme.state, 'ELIGIBLE');
    assert.equal(leidos.state, 'NEAR_MISS');
    assert.equal(leidos.blockers[0].code, 'UNSUPPORTED_PORTAL');
    assert.equal(status.apply.eligible_count, 1);
    assert.equal(status.tracker.rows.find(row => Number(row.num) === 2).apply_reason, 'unsupported_portal');
    assert.equal(status.tracker.rows.find(row => Number(row.num) === 2).can_apply, false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('apply pipeline keeps the attempt and drops eligible or near-miss duplicates', () => {
  const rows = buildApplyPipeline({
    attempts: [{
      tracker_number: 1, state: 'QUEUED', company: 'Acme', role: 'SE',
      ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    }],
    eligible: [
      { tracker_number: 1, company: 'Acme', role: 'SE', score: '4.2/5', ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/1' },
      { tracker_number: 2, company: 'Beta', role: 'SE', score: '4.0/5', ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/beta/jobs/2' },
    ],
    near_misses: [
      { tracker_number: 1, company: 'Acme', role: 'SE', blocker: 'MISSING_APPLY_TOKEN' },
      { tracker_number: 3, company: 'Gamma', role: 'SE', blocker: 'MISSING_APPLY_TOKEN', canonical_url: 'https://job-boards.greenhouse.io/gamma/jobs/3' },
    ],
  });
  assert.deepEqual(rows.map(item => [item.tracker_number, item.state, item.kind]), [
    [2, 'ELIGIBLE', 'eligible'],
    [1, 'QUEUED', 'attempt'],
    [3, 'NEAR_MISS', 'near_miss'],
  ]);
});

test('buildApplyPipeline overlays remaining tracker rows after attempt wins', () => {
  const rows = buildApplyPipeline({
    attempts: [{
      tracker_number: 1, state: 'SUBMITTED', company: 'Acme', role: 'SE',
      ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    }],
    eligible: [
      { tracker_number: 2, company: 'Beta', role: 'SE', score: '4.0/5', ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/beta/jobs/2' },
    ],
    near_misses: [
      { tracker_number: 3, company: 'Gamma', role: 'SE', blocker: 'MISSING_APPLY_TOKEN', canonical_url: 'https://job-boards.greenhouse.io/gamma/jobs/3' },
    ],
    tracker: [
      { num: 1, status: 'Applied', company: 'Acme', role: 'SE', score: '4.2/5', date: '2026-09-01', source: 'greenhouse-api', report_path: 'reports/acme/1.md' },
      { num: 2, status: 'Evaluated', company: 'Beta', role: 'SE', score: '4.0/5', can_apply: true, apply_eligible: true },
      { num: 3, status: 'Evaluated', company: 'Gamma', role: 'SE', score: '4.1/5', apply_near_miss: true, apply_reason: 'missing_apply_token' },
      { num: 4, status: 'Applied', company: 'Delta', role: 'SE', score: '4.1/5', date: '2026-09-02' },
      { num: 5, status: 'Rejected', company: 'Echo', role: 'SE', score: '2.0/5' },
    ],
  });
  assert.equal(rows.filter(item => item.tracker_number === 1).length, 1);
  assert.equal(rows.find(item => item.tracker_number === 1).kind, 'attempt');
  assert.equal(rows.find(item => item.tracker_number === 1).state, 'SUBMITTED');
  assert.equal(rows.find(item => item.tracker_number === 1).report_path, 'reports/acme/1.md');
  assert.equal(rows.find(item => item.tracker_number === 2).kind, 'eligible');
  assert.equal(rows.find(item => item.tracker_number === 3).kind, 'near_miss');
  assert.equal(rows.find(item => item.tracker_number === 4).kind, 'tracker');
  assert.equal(rows.find(item => item.tracker_number === 4).state, 'APPLIED');
  assert.equal(rows.find(item => item.tracker_number === 5).state, 'REJECTED');
});

test('buildApplyPipeline keeps Handshake Apply Externally host on the tracker row', () => {
  const rows = buildApplyPipeline({
    attempts: [{
      tracker_number: 6247,
      state: 'NEEDS_REVIEW',
      company: 'Cruitical',
      role: 'Full-Stack Software Engineer',
      ats: 'handshake',
      canonical_url: 'https://cmu.joinhandshake.com/jobs/11458140',
      external_host: 'careers.cruitical.com',
      external_url: 'https://careers.cruitical.com/jobs/full-stack',
    }],
    tracker: [{
      num: 6247,
      status: 'Evaluated',
      company: 'Cruitical',
      role: 'Full-Stack Software Engineer',
      score: '4.5/5',
      date: '2026-09-21',
      source: 'handshake',
    }],
  });
  assert.equal(rows[0].external_host, 'careers.cruitical.com');
  assert.equal(rows[0].external_url, 'https://careers.cruitical.com/jobs/full-stack');
  assert.equal(rows[0].ats, 'handshake');
});

test('manual Applied tracker status replaces an open attempt in the pipeline', () => {
  const rows = buildApplyPipeline({
    attempts: [
      {
        tracker_number: 6247,
        state: 'NEEDS_REVIEW',
        company: 'Cruitical',
        role: 'Full-Stack Software Engineer',
        ats: 'handshake',
        canonical_url: 'https://cmu.joinhandshake.com/jobs/11458140',
      },
      {
        tracker_number: 8,
        state: 'SUBMITTED',
        company: 'Acme',
        role: 'SE',
        ats: 'greenhouse',
        canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/8',
      },
    ],
    tracker: [
      { num: 6247, status: 'Applied', company: 'Cruitical', role: 'Full-Stack Software Engineer' },
      { num: 8, status: 'Applied', company: 'Acme', role: 'SE' },
    ],
  });
  const cruitical = rows.find(item => item.tracker_number === 6247);
  const acme = rows.find(item => item.tracker_number === 8);
  assert.equal(cruitical.state, 'APPLIED');
  assert.equal(cruitical.can_apply, false);
  assert.equal(acme.state, 'SUBMITTED');
});

test('buildApplyPipeline keeps one winning attempt per tracker number', () => {
  const rows = buildApplyPipeline({
    attempts: [
      {
        tracker_number: 6202, state: 'NEEDS_REVIEW', ats: 'generic',
        canonical_url: 'https://databricks.com/company/careers/open-positions/job?gh_jid=8721005002',
        company: 'Databricks', role: 'Sr. Solutions Engineer', updated_at: '2026-09-18T10:00:00Z',
      },
      {
        tracker_number: 6202, state: 'SUBMITTED', ats: 'greenhouse',
        canonical_url: 'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8721005002',
        company: 'Databricks', role: 'Sr. Solutions Engineer', updated_at: '2026-09-18T09:00:00Z',
      },
      {
        tracker_number: 6200, state: 'NEEDS_REVIEW', ats: 'generic',
        canonical_url: 'https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002',
        company: 'Databricks', role: 'Sr. Forward Deployed Engineer', updated_at: '2026-09-18T12:00:00Z',
      },
      {
        tracker_number: 6200, state: 'NEEDS_REVIEW', ats: 'greenhouse',
        canonical_url: 'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8645054002',
        company: 'Databricks', role: 'Sr. Forward Deployed Engineer', updated_at: '2026-09-18T11:00:00Z',
      },
    ],
  });
  assert.equal(rows.filter(item => item.tracker_number === 6202).length, 1);
  assert.equal(rows.find(item => item.tracker_number === 6202).state, 'SUBMITTED');
  assert.equal(rows.find(item => item.tracker_number === 6202).ats, 'greenhouse');
  assert.equal(rows.filter(item => item.tracker_number === 6200).length, 1);
  assert.equal(rows.find(item => item.tracker_number === 6200).ats, 'greenhouse');
});

test('listTriagePreview labels ATS from the posting host', () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-web-ats-'));
  try {
    mkdirSync(join(target, 'data'), { recursive: true });
    writeFileSync(join(target, 'data', 'scan-results-2026-09-18.tsv'), [
      'url\tcompany\ttitle\tlocation\tsource',
      'https://job-boards.greenhouse.io/acme/jobs/1\tAcme\tSoftware Engineer\tRemote\tgreenhouse-api',
      'https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002\tDatabricks\tFDE\tSF\tgreenhouse-api',
      'https://leidos.wd1.myworkdayjobs.com/en-US/External/job/SE_R-1\tLeidos\tSoftware Engineer\tVA\tworkday',
      'https://example.com/jobs/1\tBeta\tEngineer\tRemote, US\tgarden',
      'https://careers.garmin.com/jobs/16587?icims=1\tGarmin\tSoftware Engineer\tKS\tsimplify',
      'https://www.workatastartup.com/jobs/81444\tYC\tFounding Engineer\tSF\tvansh',
    ].join('\n') + '\n');
    const triage = listTriagePreview(target);
    assert.equal(triage.total, 6);
    assert.equal(triage.rows.find(row => row.company === 'Acme').ats, 'greenhouse');
    assert.equal(triage.rows.find(row => row.company === 'Databricks').ats, 'greenhouse');
    assert.equal(triage.rows.find(row => row.company === 'Leidos').ats, 'workday');
    assert.equal(triage.rows.find(row => row.company === 'Beta').ats, 'generic');
    assert.equal(triage.rows.find(row => row.company === 'Garmin').ats, 'generic');
    assert.equal(triage.rows.find(row => row.company === 'YC').ats, 'generic');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
