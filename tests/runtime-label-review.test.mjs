import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildHistoricalReviewPack,
  buildHistoricalSplitLabelReviewPack,
  buildHistoricalReplacementReviewPack,
  applyHistoricalRecommendationReplacements,
  approveHistoricalRecommendations,
  explicitRecommendationSignals,
  historicalOutcomeContextDependency,
  redactHistoricalText,
  renderHistoricalReviewMarkdown,
  renderHistoricalSplitLabelReviewMarkdown,
  renderLocalReviewIndex,
} from '../lib/runtime/label-review.mjs';
import { record, sha256 } from '../lib/runtime/util.mjs';

test('conditional application language is a CONSIDER outcome, not APPLY', () => {
  assert.deepEqual(explicitRecommendationSignals('## Block F: Global Score\n3.5/5. Apply if you have spare bandwidth.'), ['CONSIDER']);
  assert.deepEqual(explicitRecommendationSignals('**Global score: 3.8/5** (marginal-to-apply: strong stack, low compensation).'), ['CONSIDER']);
  assert.deepEqual(explicitRecommendationSignals('## Recommendation\nSubmit the SDE resume only if specifically drawn to the domain.'), ['CONSIDER']);
  assert.deepEqual(explicitRecommendationSignals('## Recommendation\nApply now.'), ['APPLY']);
  assert.deepEqual(explicitRecommendationSignals('**Score:** 3.8/5'), ['CONSIDER']);
  assert.deepEqual(explicitRecommendationSignals('## Global Score\n4.0/5'), ['APPLY']);
  assert.deepEqual(explicitRecommendationSignals('**Score:** 2.9/5'), ['DO_NOT_APPLY']);
  assert.deepEqual(explicitRecommendationSignals('# Software Engineer, Recommendation Infrastructure\n**Score:** 4.0/5\n## Recommendation\nConsider this role.'), ['CONSIDER']);
  assert.equal(historicalOutcomeContextDependency('## Recommendation\nConsider because this role is second-best and shares an application limit; apply to the other role first.'), true);
  assert.equal(historicalOutcomeContextDependency('## Recommendation\nConsider because the experience requirement is uncertain.'), false);
});

test('redacts identity, links, contact data, controls, and markdown', () => {
  const output = redactHistoricalText(
    '\u202E**Anmol Sahu** at Acme Corp for Senior Engineer https://example.com a@b.com 412-555-1212',
    { company: 'Acme Corp', role: 'Senior Engineer' },
  );
  assert.equal(output.includes('Anmol'), false);
  assert.equal(output.includes('Acme'), false);
  assert.equal(output.includes('Senior Engineer'), false);
  assert.equal(output.includes('https://'), false);
  assert.equal(output.includes('a@b.com'), false);
  assert.equal(output.includes('412-555-1212'), false);
  assert.equal(output.includes('**'), false);
});

test('human approval produces recommendation-only truth and keeps model audit advisory', () => {
  const cases = Array.from({ length: 50 }, (_, index) => ({
    case_id: `HIST-${String(index + 1).padStart(3, '0')}`,
    cohort: 'positive_action',
    role_archetype: 'SOFTWARE',
    source: { tracker_row_number: index + 1, tracker_status: 'Applied', report_digest: 'a'.repeat(64) },
    proposal: { recommendation: 'APPLY', score: 4, gates: {}, provenance: 'UNTRUSTED_HISTORICAL_LABEL' },
  }));
  const body = record('RuntimeHistoricalLabelReviewPackV1', { cases });
  const pack = { ...body, pack_digest: sha256(body) };
  const audit = record('HistoricalLabelAuditV1', {
    decision: 'CHANGES_REQUIRED',
    reviewed_cases: [{ case_id: 'HIST-001' }],
    discrepancies: [{ case_id: 'HIST-001', field: 'proposal.recommendation', reason: 'conflict' }],
  });
  const approved = approveHistoricalRecommendations(pack, {
    approvedAt: new Date('2026-09-05T00:00:00.000Z'),
    attestationId: 'test-attestation',
    audit,
  });
  assert.equal(approved.representative, true);
  assert.equal(approved.human_approved, true);
  assert.equal(approved.gate_labels_included, false);
  assert.equal(approved.cases.length, 50);
  assert.equal(approved.cases.every(item => item.label_provenance === 'HUMAN_APPROVED'), true);
  assert.equal(approved.independent_audit.authoritative, false);
  assert.equal(approved.independent_audit.recommendation_conflicts.length, 1);
});

test('builds an explicitly unapproved, traceable, redacted review pack', () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-label-review-'));
  mkdirSync(join(target, 'data'));
  mkdirSync(join(target, 'reports'));
  const statuses = [
    ['Applied', '4.5/5'],
    ['Rejected-at-eval', '2.0/5'],
    ['Evaluated', '3.5/5'],
  ];
  const rows = statuses.map(([status, score], index) => {
    const number = index + 1;
    writeFileSync(
      join(target, 'reports', `${number}.md`),
      `# Acme ${number} Senior Engineer ${number}\nRecommendation and location. Sponsorship unknown. https://example.com/${number}\n`,
    );
    return `| ${number} | 2026-01-01 | Acme ${number} | Senior Engineer ${number} | ${score} | ${status} | — | [${number}](reports/${number}.md) | — |`;
  });
  writeFileSync(join(target, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n'));
  const pack = buildHistoricalReviewPack({
    target,
    counts: { positive_action: 1, rejected_at_eval: 1, unresolved: 1 },
    now: new Date('2026-09-05T00:00:00.000Z'),
  });
  assert.equal(pack.cases.length, 3);
  assert.equal(pack.representative, false);
  assert.equal(pack.human_approved, false);
  assert.ok(pack.cases.every(item => item.review.status === 'REVIEW_REQUIRED'));
  assert.ok(pack.cases.every(item => item.proposal.provenance === 'UNTRUSTED_HISTORICAL_LABEL'));
  const rendered = renderHistoricalReviewMarkdown(pack);
  assert.equal(rendered.includes('Acme'), false);
  assert.equal(rendered.includes('Senior Engineer'), false);
  assert.equal(rendered.includes('https://'), false);
  assert.match(rendered, /you do not need to edit the JSON by hand/);
  const indexDir = join(target, '.career-ops-runtime', 'label-review');
  mkdirSync(indexDir, { recursive: true });
  const index = renderLocalReviewIndex(pack, target, indexDir);
  assert.match(index, /\[Open source\]\(\.\.\/\.\.\/reports\/1\.md\)/);
  assert.equal(index.includes(target), false);
  assert.equal(readFileSync(join(target, 'data', 'applications.md'), 'utf8').includes('Applied'), true);

  const sourceBody = record('RuntimeHistoricalRecommendationSetV1', {
    human_approved: true,
    cases: pack.cases.map(item => ({
      case_id: item.case_id,
      role_archetype: item.role_archetype,
      expected_recommendation: item.proposal.recommendation,
      source: item.source,
    })),
  });
  const split = buildHistoricalSplitLabelReviewPack({
    target,
    recommendationSet: { ...sourceBody, set_digest: sha256(sourceBody) },
    now: new Date('2026-09-05T00:00:00.000Z'),
  });
  assert.equal(split.case_count, 3);
  assert.equal(split.source_label_semantics, 'FINAL_HISTORICAL_OUTCOME');
  assert.ok(split.cases.every(item => item.review.approved_advisory_recommendation === null));
  assert.ok(split.cases.every(item => item.review.approved_gates === null));
  assert.match(renderHistoricalSplitLabelReviewMarkdown(split), /ignoring posting liveness/);
});

test('replacement pack swaps only incomplete approved cases with explicitly attested reports', () => {
  const target = mkdtempSync(join(tmpdir(), 'career-ops-label-replacement-'));
  mkdirSync(join(target, 'data'));
  mkdirSync(join(target, 'reports'));
  const rows = [];
  const cases = [];
  for (let number = 1; number <= 51; number++) {
    const pending = number === 1;
    const report = pending
      ? '# Pending Evaluation Stub\nOnly discovery metadata is available.'
      : `# Evaluation Report ${number}\n## Block A\nCandidate evidence ${number}.\n## Block B\nRole evidence ${number}.\n## Block G\nPosting evidence ${number}.\n## Recommendation\nConsider this role.`;
    writeFileSync(join(target, 'reports', `${number}.md`), report);
    const trackerStatus = number === 51 ? 'Purged' : 'Evaluated';
    rows.push(`| ${number} | 2026-01-01 | Acme ${number} | Engineer ${number} | 3.5/5 | ${trackerStatus} | — | [${number}](reports/${number}.md) | — |`);
    if (number <= 50) cases.push({
      case_id: `HIST-${String(number).padStart(3, '0')}`,
      cohort: 'unresolved', role_archetype: 'SOFTWARE', expected_recommendation: 'CONSIDER', historical_score: 3.5,
      source: { tracker_row_number: number, tracker_status: 'Evaluated', report_digest: sha256(report) },
      label_provenance: 'HUMAN_APPROVED',
    });
  }
  writeFileSync(join(target, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n'));
  const sourceBody = record('RuntimeHistoricalRecommendationSetV1', {
    evaluation_set_version: 'historical-v1', created_at: '2026-09-05T00:00:00.000Z', representative: true,
    human_approved: true, label_scope: ['recommendation'], gate_labels_included: false,
    source_review_pack_digest: 'a'.repeat(64), approval: {}, independent_audit: null, cases,
  });
  const source = { ...sourceBody, set_digest: sha256(sourceBody) };
  const pack = buildHistoricalReplacementReviewPack({
    target, recommendationSet: source, replacementCaseIds: ['HIST-001'], replacementTrackerRows: [51],
    now: new Date('2026-09-05T00:00:00.000Z'),
  });
  assert.equal(pack.replacements[0].case_id, 'HIST-051');
  assert.equal(pack.replacements[0].proposed_recommendation, 'CONSIDER');
  assert.equal(pack.replacements[0].source.tracker_status, 'Purged');
  assert.equal(pack.replacements[0].redacted_evidence.includes('Acme 51'), false);
  assert.throws(() => applyHistoricalRecommendationReplacements({ recommendationSet: source, replacementPack: pack }), /attestation/);
  const auditBody = record('HistoricalLabelAuditV1', {
    decision: 'APPROVE',
    sample_strategy: 'Reviewed every replacement case.',
    reviewed_cases: [{
      case_id: 'HIST-051', recommendation_supported: true, gates_supported: true, notes: 'Supported.',
    }],
    discrepancies: [],
    summary: 'Approved.',
    audit_provenance: {
      provider_id: 'antigravity-claude-audit',
      model_vendor: 'anthropic',
      model_snapshot: 'claude-sonnet-4-6',
      execution_surface: 'antigravity-cli',
      reasoning_effort: 'provider-defined',
      pack_digest: pack.pack_digest,
    },
  });
  const wrongPackAudit = structuredClone(auditBody);
  wrongPackAudit.audit_provenance.pack_digest = 'f'.repeat(64);
  assert.throws(() => applyHistoricalRecommendationReplacements({
    recommendationSet: source, replacementPack: pack, attestationId: 'delegated review', audit: wrongPackAudit,
  }), /exact replacement pack digest/);
  const revised = applyHistoricalRecommendationReplacements({
    recommendationSet: source, replacementPack: pack, attestationId: 'delegated review', audit: auditBody,
    now: new Date('2026-09-05T01:00:00.000Z'),
  });
  assert.equal(revised.cases.length, 50);
  assert.equal(revised.cases.some(item => item.case_id === 'HIST-001'), false);
  assert.equal(revised.cases.some(item => item.case_id === 'HIST-051' && item.source.tracker_row_number === 51), true);
  assert.deepEqual(revised.revision.replaced_case_ids, ['HIST-001']);
  assert.equal(revised.approval.method, 'explicit_user_delegation_with_independent_model_audit');
  assert.equal(revised.independent_audit.model_vendor, 'anthropic');
  assert.equal(revised.independent_audit.model_snapshot, 'claude-sonnet-4-6');
});
