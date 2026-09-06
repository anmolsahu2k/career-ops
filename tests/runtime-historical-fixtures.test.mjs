import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildHistoricalQualificationFixtures,
  writeHistoricalQualificationFixtures,
} from '../lib/runtime/historical-fixtures.mjs';
import { expandQualificationSet, runShadowQualification } from '../lib/runtime/shadow.mjs';
import { record, sha256 } from '../lib/runtime/util.mjs';
import { makeResponse } from './runtime-fixtures.mjs';
import { captureHistoricalEvidence } from '../lib/runtime/historical-evidence.mjs';

const NOW = new Date('2026-09-05T00:00:00.000Z');

function makeSource() {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-historical-fixtures-'));
  mkdirSync(join(target, 'data'));
  mkdirSync(join(target, 'reports'));
  const rows = [];
  const cases = [];
  for (let index = 0; index < 50; index++) {
    const number = index + 1;
    const company = `Private Company ${number}`;
    const role = `Software Engineer ${number}`;
    const report = index === 49
      ? '# Pending Evaluation Stub\n**Status:** Evaluated (placeholder, awaiting full eval)\n'
      : [
          `# ${company} | ${role}`,
          '**Score:** 4.5/5 **Status:** Applied',
          '## Block A, Role Summary',
          '| TL;DR | This is the strongest match and should apply immediately. |',
          `| Role | ${role} building reliable services |`,
          '| Location | Eligible remote location |',
          `Transferable evidence appears first. ${'Additional non-outcome context. '.repeat(20)}Late risk evidence remains visible.`,
          '## Block B, CV Match',
          '| Requirement | Candidate has production Java and Python experience |',
          '## Block E, Risks',
          '| Experience gap | One preferred framework is not on the resume |',
          '## Block G, Legitimacy',
          'Employer-owned posting with an active application control.',
          '## Recommendation',
          '**APPLY IMMEDIATELY.**',
        ].join('\n');
    const reportName = `${number}.md`;
    writeFileSync(join(target, 'reports', reportName), report);
    rows.push(`| ${number} | 2026-01-01 | ${company} | ${role} | 4.5/5 | Applied | — | [${number}](reports/${reportName}) | Not yet evaluated; promote to per-role eval before applying. URL: https://example.com/${number}. |`);
    cases.push({
      case_id: `HIST-${String(number).padStart(3, '0')}`,
      cohort: 'positive_action',
      role_archetype: 'SOFTWARE',
      expected_recommendation: 'APPLY',
      historical_score: 4.5,
      source: { tracker_row_number: number, tracker_status: 'Applied', report_digest: sha256(report) },
      label_provenance: 'HUMAN_APPROVED',
    });
  }
  writeFileSync(join(target, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n'));
  const body = record('RuntimeHistoricalRecommendationSetV1', {
    evaluation_set_version: 'historical-test-v1', representative: true, human_approved: true,
    gate_labels_included: false, cases,
  });
  return { target, recommendationSet: { ...body, set_digest: sha256(body) } };
}

test('builds digest-bound historical fixtures without leaking labels or target identity', () => {
  const { target, recommendationSet } = makeSource();
  const prepared = buildHistoricalQualificationFixtures({ target, recommendationSet, now: NOW });
  assert.equal(prepared.case_count, 50);
  assert.equal(prepared.incomplete_source_count, 1);
  assert.equal(prepared.promotion_eligible, false);
  assert.equal(prepared.truth_source, 'HUMAN_APPROVED_HISTORY');
  assert.deepEqual(prepared.label_scope, ['historical_final_outcome']);
  assert.equal(prepared.source_label_semantics, 'FINAL_HISTORICAL_OUTCOME');
  assert.deepEqual(prepared.promotion_blockers, ['RECOMMENDATION_ONLY_LABELS', 'SPLIT_LABEL_REVIEW_REQUIRED', 'INCOMPLETE_HISTORICAL_EVIDENCE']);
  assert.equal(prepared.cases[0].evidence_content['EV-1'].includes('Private Company'), false);
  assert.equal(/APPLY IMMEDIATELY|DO NOT APPLY|Rejected-at-eval|strongest match/i.test(prepared.cases[0].evidence_content['EV-1']), false);
  assert.match(prepared.cases[0].evidence_content['EV-1'], /Historical evidence block A:/);
  assert.match(prepared.cases[0].evidence_content['EV-1'], /Historical evidence block B:/);
  assert.match(prepared.cases[0].evidence_content['EV-1'], /Historical evidence block E:/);
  assert.match(prepared.cases[0].evidence_content['EV-1'], /Historical evidence block G:/);
  assert.match(prepared.cases[0].evidence_content['EV-1'], /Late risk evidence remains visible/);
  assert.equal(prepared.cases[0].evidence_content['EV-1'].includes('Sponsorship flag:'), false);
  assert.equal(prepared.cases[0].task.evidence_manifest[0].structured_fields.required_evidence_complete, 'YES');
  assert.equal(prepared.cases[49].task.evidence_manifest[0].structured_fields.required_evidence_complete, 'NO');
  assert.equal(prepared.cases[49].evidence_content['EV-1'].includes('https://'), false);
  assert.equal(sha256(prepared.cases[0].evidence_content['EV-1']), prepared.cases[0].evidence_digest);
  assert.equal(expandQualificationSet(prepared).length, 50);

  const output = join(target, 'prepared.json');
  writeHistoricalQualificationFixtures(prepared, output);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).set_digest, prepared.set_digest);
});

test('historical final outcomes remain diagnostic and cannot promote without split labels', async () => {
  const { target, recommendationSet } = makeSource();
  const prepared = buildHistoricalQualificationFixtures({ target, recommendationSet, now: NOW });
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async request => record('RawProviderResultV1', {
      task_id: request.task.task_id,
      provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
      response: makeResponse({ recommendation: 'APPLY', gates: { sponsorship_compatible: 'NO' } }),
      usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 1, attempts: 1, capability_degradation: false,
    }),
  };
  const run = await runShadowQualification({ definition: prepared, provider: fakeProvider, providerId: 'fake', limit: 1 });
  assert.equal(run.results[0].actual_recommendation, 'CONSIDER');
  assert.equal(run.results[0].recommendation_comparison_eligible, false);
  assert.equal(run.results[0].actual_score, 4.4);
  assert.equal(run.results[0].actual_confidence, 0.94);
  assert.equal(run.results[0].consequential_gate_count, 0);
  assert.equal(run.metrics.sample_count, 0);
  assert.equal(run.metrics.transport_sample_count, 1);
  assert.equal(run.gate_labels_included, false);
  assert.equal(run.promotion_eligible, false);
  assert.equal(run.qualification.lifecycle_state, 'candidate');
  assert.equal(run.qualification.checks.shadow_passed, false);
});

test('context-dependent portfolio outcomes block standalone qualification', () => {
  const { target, recommendationSet } = makeSource();
  const path = join(target, 'reports', '1.md');
  const report = readFileSync(path, 'utf8').replace(
    '**APPLY IMMEDIATELY.**',
    '**CONSIDER only because the shared application limit should be used on another role first.**',
  );
  writeFileSync(path, report);
  const { set_digest: _oldDigest, ...unsigned } = recommendationSet;
  unsigned.cases = unsigned.cases.map(item => item.case_id === 'HIST-001'
    ? {
        ...item,
        cohort: 'unresolved',
        expected_recommendation: 'CONSIDER',
        source: { ...item.source, report_digest: sha256(report) },
      }
    : item);
  const revised = { ...unsigned, set_digest: sha256(unsigned) };
  const prepared = buildHistoricalQualificationFixtures({ target, recommendationSet: revised, now: NOW });
  assert.equal(prepared.context_dependent_outcome_count, 1);
  assert.ok(prepared.promotion_blockers.includes('CONTEXT_DEPENDENT_HISTORICAL_OUTCOME'));
});

test('legacy Fit sections preserve hard-gate evidence without leaking the outcome', () => {
  const { target, recommendationSet } = makeSource();
  const path = join(target, 'reports', '2.md');
  const report = readFileSync(path, 'utf8')
    .replace('## Recommendation', '## Fit\n\nAn active Secret security clearance is required. This is a disqualifier.\n\n## Recommendation')
    .replace('**APPLY IMMEDIATELY.**', '**DO NOT APPLY.**');
  writeFileSync(path, report);
  const { set_digest: _oldDigest, ...unsigned } = recommendationSet;
  unsigned.cases = unsigned.cases.map(item => item.case_id === 'HIST-002'
    ? {
        ...item,
        cohort: 'rejected_at_eval',
        expected_recommendation: 'DO_NOT_APPLY',
        source: { ...item.source, report_digest: sha256(report) },
      }
    : item);
  const revised = { ...unsigned, set_digest: sha256(unsigned) };
  const prepared = buildHistoricalQualificationFixtures({ target, recommendationSet: revised, now: NOW });
  assert.match(prepared.cases[1].evidence_content['EV-1'], /Historical fit evidence:/);
  assert.match(prepared.cases[1].evidence_content['EV-1'], /active Secret security clearance is required/);
  assert.doesNotMatch(prepared.cases[1].evidence_content['EV-1'], /disqualifier|DO NOT APPLY/i);
  assert.equal(prepared.cases[1].task.evidence_manifest[0].structured_fields.citizenship_restricted, 'YES');
});

test('prepared fixture digests fail closed after evidence mutation', () => {
  const { target, recommendationSet } = makeSource();
  const prepared = buildHistoricalQualificationFixtures({ target, recommendationSet, now: NOW });
  prepared.cases[0].evidence_content['EV-1'] += ' changed';
  assert.throws(() => expandQualificationSet(prepared), /digest mismatch/);
});

test('exact ATS cache replaces discovery-only evidence without making the set promotable', async () => {
  const { target, recommendationSet } = makeSource();
  const cache = await captureHistoricalEvidence({
    caseId: 'HIST-050',
    sourceUrl: 'https://job-boards.greenhouse.io/example/jobs/50',
    expectedTitle: 'Software Engineer 50',
    now: NOW,
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({
        title: 'Software Engineer 50',
        content: `<p>${'Build Java and Python production services. No citizenship requirement. '.repeat(20)}</p>`,
      }),
    }),
  });
  const prepared = buildHistoricalQualificationFixtures({
    target,
    recommendationSet,
    now: NOW,
    externalEvidenceByCase: new Map([['HIST-050', cache]]),
    candidateEvidence: 'Production software engineer with Java, Python, cloud, testing, and distributed systems experience.',
  });
  assert.equal(prepared.incomplete_source_count, 0);
  assert.equal(prepared.live_ats_source_count, 1);
  assert.equal(prepared.live_ats_label_review_required_count, 1);
  assert.equal(prepared.cases[49].source_quality, 'LIVE_ATS_EVIDENCE_UNREVIEWED');
  assert.equal(prepared.cases[49].task.evidence_manifest[0].liveness_state, 'YES');
  assert.equal(prepared.cases[49].task.evidence_manifest[0].structured_fields.required_evidence_complete, 'YES');
  assert.equal(prepared.promotion_eligible, false);
  assert.ok(prepared.promotion_blockers.includes('LIVE_EVIDENCE_LABEL_REVIEW_REQUIRED'));

  const { set_digest: _digest, ...unsigned } = recommendationSet;
  const approvedUnsigned = {
    ...unsigned,
    cases: unsigned.cases.map(item => item.case_id === 'HIST-050'
      ? { ...item, approved_evidence_record_digest: cache.record_digest }
      : item),
  };
  const approvedSet = { ...approvedUnsigned, set_digest: sha256(approvedUnsigned) };
  const approved = buildHistoricalQualificationFixtures({
    target,
    recommendationSet: approvedSet,
    now: NOW,
    externalEvidenceByCase: new Map([['HIST-050', cache]]),
    candidateEvidence: 'Production software engineer with Java, Python, cloud, testing, and distributed systems experience.',
  });
  assert.equal(approved.live_ats_label_review_required_count, 0);
  assert.equal(approved.cases[49].source_quality, 'LIVE_ATS_EVIDENCE');
  assert.equal(approved.promotion_blockers.includes('LIVE_EVIDENCE_LABEL_REVIEW_REQUIRED'), false);
});
