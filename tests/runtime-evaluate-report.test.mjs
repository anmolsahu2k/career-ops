import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatEvaluateProgress,
  formatEvaluateSummary,
  progressBar,
  shortTarget,
  shouldUseHumanEvaluateOutput,
} from '../lib/runtime/evaluate-report.mjs';

test('progressBar renders bounded fill', () => {
  assert.match(progressBar(0, 10), /0%/);
  assert.match(progressBar(5, 10), /50%/);
  assert.match(progressBar(10, 10), /100%/);
});

test('formatEvaluateProgress includes stage and counts', () => {
  const line = formatEvaluateProgress({
    stage: 'liveness',
    done: 3,
    total: 10,
    url: 'https://jobs.example.com/very/long/path/to/role',
    result: 'active',
  });
  assert.match(line, /Liveness/);
  assert.match(line, /3\/10/);
  assert.doesNotMatch(line, /Liveness$/);
  assert.match(line, /jobs\.example\.com/);
});

test('shortTarget never appends stage labels', () => {
  assert.equal(shortTarget('https://jobs.ashbyhq.com/acme/job', 40), 'jobs.ashbyhq.com/acme/job');
  assert.doesNotMatch(shortTarget('https://jobs.ashbyhq.com/p', 40), /Liveness/);
});

test('formatEvaluateSummary explains PLAN dry-run', () => {
  const text = formatEvaluateSummary({
    schema: 'EvaluateScanResultV1',
    status: 'PLAN',
    apply: false,
    candidate_count: 2,
    files: ['ft/data/scan-results-2026-09-12.tsv'],
    liveness: { active: 1, uncertain: 1, expired: 1 },
    expired: [
      { url: 'https://ex.com/1', reason: 'insufficient content — likely nav/footer only' },
      { url: 'https://ex.com/2', reason: 'HTTP 404' },
    ],
    queue: [
      { company: 'Acme', title: 'SWE', liveness: 'active', url: 'https://jobs.example.com/1', source: 'manual' },
      { company: 'Beta', title: 'MLE', liveness: 'uncertain', url: 'https://jobs.example.com/2', source: 'ashby-api' },
    ],
    message: 'No provider commits.',
  });
  assert.match(text, /Status:\s+PLAN/);
  assert.match(text, /Eval queue \(2\)/);
  assert.match(text, /Acme — SWE/);
  assert.match(text, /https:\/\/jobs\.example\.com\/1/);
  assert.match(text, /Top expired reasons/);
  assert.match(text, /insufficient content/);
  assert.match(text, /No A–G reports written/);
  assert.match(text, /evaluate:judge/);
});

test('formatEvaluateSummary notes triage pruning on plan', () => {
  const text = formatEvaluateSummary({
    schema: 'EvaluateScanResultV1',
    status: 'PLAN',
    apply: false,
    candidate_count: 5,
    pruned: 5,
    queue_path: 'ft/data/evaluate-queue.tsv',
    queue: [{ company: 'Humana', title: 'SWE', liveness: 'active' }],
    triage_updates: [{ path: 'ft/data/scan-results-2026-09-12.tsv', deleted: false, remaining: 747 }],
    liveness: { active: 0, uncertain: 0, expired: 0 },
    skipped: [{ company: 'Wiz', title: 'SWE', code: 'GEOGRAPHY_INELIGIBLE', reason: 'non-US' }],
  });
  assert.match(text, /Triage updated: pruned 5/);
  assert.match(text, /Eval queue saved \(1\)/);
  assert.match(text, /No A–G reports written/);
});

test('formatEvaluateSummary lists committed jobs with url and report', () => {
  const text = formatEvaluateSummary({
    schema: 'EvaluateScanResultV1',
    status: 'COMPLETED',
    apply: true,
    candidate_count: 1,
    liveness: { active: 1, uncertain: 0, expired: 0 },
    committed: 1,
    failed: 0,
    results: [{
      company: 'Databricks',
      title: 'Sr. Forward Deployed Engineer',
      status: 'COMMITTED',
      decision: 'CONSIDER',
      score: 3.5,
      report_number: 6200,
      report_path: 'reports/databricks/6200-sr-forward-deployed-engineer-2026-09-13.md',
      url: 'https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002',
      source: 'greenhouse-api',
      liveness: 'active',
      policy_reasons: ['CONSEQUENTIAL_GATE_UNKNOWN'],
    }],
  });
  assert.match(text, /Databricks — Sr\. Forward Deployed Engineer/);
  assert.match(text, /3\.5\/5/);
  assert.match(text, /#6200/);
  assert.match(text, /reports\/databricks\/6200/);
  assert.match(text, /gh_jid=8645054002/);
  assert.match(text, /CONSEQUENTIAL_GATE_UNKNOWN/);
});

test('shouldUseHumanEvaluateOutput defaults to TTY unless --json', () => {
  assert.equal(shouldUseHumanEvaluateOutput({ flags: {}, stdoutIsTTY: true }), true);
  assert.equal(shouldUseHumanEvaluateOutput({ flags: {}, stdoutIsTTY: false }), false);
  assert.equal(shouldUseHumanEvaluateOutput({ flags: { json: true }, stdoutIsTTY: true }), false);
  assert.equal(shouldUseHumanEvaluateOutput({ flags: { human: true }, stdoutIsTTY: false }), true);
});
