import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { verifyHistoricalEvidenceCache } from './historical-evidence.mjs';
import {
  explicitRecommendationSignals,
  historicalOutcomeContextDependency,
  redactHistoricalText,
  resolveHistoricalReport,
} from './label-review.mjs';
import { prepareTask } from './prepare.mjs';
import { record, sha256 } from './util.mjs';

const ALLOWED_RECOMMENDATIONS = new Set(['APPLY', 'CONSIDER', 'DO_NOT_APPLY']);
const INCLUDED_BLOCKS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'FIT']);
const HISTORICAL_PREPARATION_VERSION = 14;
const SECTION_BUDGETS = Object.freeze({
  HEADER: 700,
  A: 1_500,
  B: 2_000,
  C: 700,
  D: 500,
  E: 1_500,
  F: 1_500,
  G: 1_100,
  FIT: 1_800,
});

function verifyRecommendationSet(set) {
  if (set?.schema !== 'RuntimeHistoricalRecommendationSetV1' || set.schema_version !== 1) {
    throw new Error('Expected RuntimeHistoricalRecommendationSetV1 version 1');
  }
  const { set_digest: observedDigest, ...unsigned } = set;
  if (!observedDigest || sha256(unsigned) !== observedDigest) throw new Error('Historical recommendation set digest mismatch');
  if (set.human_approved !== true || set.representative !== true || set.gate_labels_included !== false) {
    throw new Error('Historical recommendation set must be human-approved, representative, and recommendation-only');
  }
  if (!Array.isArray(set.cases) || set.cases.length < 50) throw new Error('Historical recommendation set requires at least 50 cases');
}

function trackerRows(target) {
  const text = readFileSync(join(target, 'data', 'applications.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  const columns = resolveColumns(lines);
  return new Map(lines.map(line => parseTrackerRow(line, columns)).filter(Boolean).map(row => [row.num, row]));
}

function sectionFor(line) {
  const headingMatch = line.match(/^\s*#{2,4}\s+(.+?)\s*$/);
  if (!headingMatch) return null;
  const heading = headingMatch[1];
  const match = heading.match(/^(?:Block\s+)?([A-G])(?:\b|,)/i);
  const name = match?.[1]?.toUpperCase()
    || (/^(?:role\s+)?fit\b|^(?:role\s+)?analysis\b|^evaluation\b|^assessment\b/i.test(heading) ? 'FIT' : null);
  return {
    name,
    containsOutcome: /\b(?:recommendation|verdict|overall|global score|final decision)\b/i.test(heading),
    excludedFSection: name === 'F'
      && !/\b(?:red flag|risk|constraint|gap|eligib|sponsor|authorization)\b/i.test(heading),
  };
}

function leaksHistoricalOutcome(line) {
  return /\b(?:recommendation|recommended action|status recorded|rejected-at-eval|rejection|rejected|disqualif\w*|known-ineligible|apply immediately|do not apply|no application will be submitted|correct action is to skip|should not (?:apply|be pursued)|not yet evaluated|awaiting full eval|promote to per-role eval|strongest match|closest .{0,40} match)\b/i.test(line)
    || /^\s*\|?\s*TL;?DR\b/i.test(line)
    || /^\s*\*{0,2}Verdict\b/i.test(line)
    || /^\s*\*{0,2}(?:score|status)\b/i.test(line)
    || /\b(?:do not apply|should apply|worth applying|apply with (?:a )?referral|consider\s*\/\s*apply|skip this|discard(?: this| the role)?)\b/i.test(line);
}

function usefulLine(line) {
  const text = String(line || '').trim();
  if (!text || /^[-|:\s]+$/.test(text)) return false;
  if (/^\s*#{1,6}\s+/.test(text)) return false;
  return !leaksHistoricalOutcome(text);
}

function evidenceUnits(line) {
  const text = String(line || '').trim();
  if (/^\s*\|/.test(text)) return [text];
  return text.split(/(?<=[.!?])\s+(?=[A-Z[\]])/).filter(Boolean);
}

function reportEvidence(report, identity) {
  const lines = String(report).split(/\r?\n/);
  let block = null;
  const selected = { HEADER: [], A: [], B: [], C: [], D: [], E: [], F: [], G: [], FIT: [] };
  for (const line of lines) {
    const nextSection = sectionFor(line);
    if (nextSection) {
      block = nextSection.containsOutcome || nextSection.excludedFSection ? null : nextSection.name;
      continue;
    }
    const headerEvidence = !block && /^\s*\*{0,2}(?:Legitimacy|Level strategy|Comp research|Sponsorship flag)\b/i.test(line);
    if (!INCLUDED_BLOCKS.has(block) && !headerEvidence) continue;
    const targetSection = headerEvidence ? 'HEADER' : block;
    for (const unit of evidenceUnits(line)) {
      if (!usefulLine(unit)) continue;
      const perLineLimit = /^\s*\|/.test(unit)
        ? 320
        : Math.min(1_200, SECTION_BUDGETS[targetSection]);
      const redacted = redactHistoricalText(unit, identity, perLineLimit)
        .replace(/^Sponsorship flag:\s*(?:YES|NO|Y|N|UNKNOWN|\?)\s*/i, 'Work authorization evidence: ');
      if (!redacted || /^[-:\s]+$/.test(redacted)) continue;
      selected[targetSection].push(redacted);
    }
  }
  const headings = {
    HEADER: 'Posting metadata:',
    A: 'Historical evidence block A:',
    B: 'Historical evidence block B:',
    C: 'Historical evidence block C:',
    D: 'Historical evidence block D:',
    E: 'Historical evidence block E:',
    F: 'Historical evidence block F:',
    G: 'Historical evidence block G:',
    FIT: 'Historical fit evidence:',
  };
  const output = [];
  for (const section of ['HEADER', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'FIT']) {
    const bounded = [];
    let length = 0;
    for (const line of new Set(selected[section])) {
      if (length + line.length + 1 > SECTION_BUDGETS[section]) continue;
      bounded.push(line);
      length += line.length + 1;
    }
    if (bounded.length) output.push(headings[section], ...bounded);
  }
  return output.join('\n').trim();
}

function trackerFallback(row) {
  const notes = String(row.notes || '')
    .replace(/\b(?:Not yet evaluated; promote to per-role eval before applying|LIVENESS-UNCERTAIN\s+\d{4}-\d{2}-\d{2})\.?/giu, '')
    .replace(/\bURL:\s*https?:\/\/\S+/giu, '')
    .replace(/\bSRC:\s*[^.]+\.?/giu, '');
  return redactHistoricalText(
    `Only discovery metadata is available. Role title: ${row.role}. ${notes}`,
    { company: row.company },
  );
}

export function auditHistoricalRecommendationEvidence({ target, recommendationSet }) {
  verifyRecommendationSet(recommendationSet);
  const rows = trackerRows(resolve(target));
  const cases = recommendationSet.cases.map(sourceCase => {
    const row = rows.get(sourceCase.source?.tracker_row_number);
    const reportPath = row ? resolveHistoricalReport(resolve(target), row.report) : null;
    if (!row || !reportPath) throw new Error(`Historical source missing for ${sourceCase.case_id}`);
    const report = readFileSync(reportPath, 'utf8');
    if (sha256(report) !== sourceCase.source.report_digest) throw new Error(`Report digest mismatch for ${sourceCase.case_id}`);
    const pending = /Pending Evaluation Stub/i.test(report);
    const signals = pending ? [] : explicitRecommendationSignals(report);
    const contextDependent = !pending && historicalOutcomeContextDependency(report);
    const status = pending
      ? 'NO_HISTORICAL_OUTCOME'
      : contextDependent
        ? 'CONTEXT_DEPENDENT_OUTCOME'
      : signals.length === 0
        ? 'NO_EXPLICIT_OUTCOME'
        : signals.includes(sourceCase.expected_recommendation)
          ? signals.length === 1 ? 'SUPPORTED' : 'AMBIGUOUS'
          : 'CONTRADICTED';
    return {
      case_id: sourceCase.case_id,
      tracker_row_number: row.num,
      expected_recommendation: sourceCase.expected_recommendation,
      explicit_signals: signals,
      status,
    };
  });
  return record('HistoricalRecommendationEvidenceAuditV1', {
    source_recommendation_set_digest: recommendationSet.set_digest,
    case_count: cases.length,
    contradicted_count: cases.filter(item => item.status === 'CONTRADICTED').length,
    context_dependent_count: cases.filter(item => item.status === 'CONTEXT_DEPENDENT_OUTCOME').length,
    ambiguous_count: cases.filter(item => item.status === 'AMBIGUOUS').length,
    no_explicit_outcome_count: cases.filter(item => item.status === 'NO_EXPLICIT_OUTCOME' || item.status === 'NO_HISTORICAL_OUTCOME').length,
    cases,
  });
}

function liveEvidence(cache, row, candidateEvidence) {
  const jd = redactHistoricalText(cache.content, { company: row.company, role: row.role }, 4_200);
  const candidate = redactHistoricalText(candidateEvidence, { company: row.company, role: row.role }, 1_200);
  return [
    'Exact ATS job evidence:',
    jd,
    'Candidate qualification evidence:',
    candidate,
    'Work authorization is evaluated only through gate policy and must not be repeated in presentation content.',
  ].join('\n');
}

function containsLeak(text) {
  return /\b(?:DO_NOT_APPLY|DO NOT APPLY|APPLY IMMEDIATELY|REJECTED-AT-EVAL|DISQUALIF\w*|KNOWN-INELIGIBLE)\b/i.test(text)
    || /https?:\/\//i.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\bAnmol(?:\s+Sahu)?\b/i.test(text);
}

export function buildHistoricalQualificationFixtures({
  target,
  recommendationSet,
  externalEvidenceByCase = new Map(),
  candidateEvidence = '',
  now = new Date(),
}) {
  verifyRecommendationSet(recommendationSet);
  const root = resolve(target);
  const rows = trackerRows(root);
  const recommendationEvidenceAudit = auditHistoricalRecommendationEvidence({ target: root, recommendationSet });
  let incompleteSourceCount = 0;
  let liveAtsSourceCount = 0;
  let liveAtsLabelReviewRequiredCount = 0;
  const cases = recommendationSet.cases.map((sourceCase, index) => {
    if (!ALLOWED_RECOMMENDATIONS.has(sourceCase.expected_recommendation)) {
      throw new Error(`Unsupported recommendation for ${sourceCase.case_id}`);
    }
    const row = rows.get(sourceCase.source?.tracker_row_number);
    if (!row) throw new Error(`Tracker row missing for ${sourceCase.case_id}`);
    const reportPath = resolveHistoricalReport(root, row.report);
    if (!reportPath) throw new Error(`Report missing or unsafe for ${sourceCase.case_id}`);
    const report = readFileSync(reportPath, 'utf8');
    if (sha256(report) !== sourceCase.source.report_digest) throw new Error(`Report digest mismatch for ${sourceCase.case_id}`);
    const incompleteSource = /Pending Evaluation Stub/i.test(report);
    const cached = externalEvidenceByCase.get(sourceCase.case_id);
    const usableCache = incompleteSource
      && Boolean(candidateEvidence)
      && cached?.complete === true
      && verifyHistoricalEvidenceCache(cached);
    const liveEvidenceLabelApproved = usableCache
      && sourceCase.approved_evidence_record_digest === cached.record_digest;
    if (usableCache) {
      liveAtsSourceCount++;
      if (!liveEvidenceLabelApproved) liveAtsLabelReviewRequiredCount++;
    }
    else if (incompleteSource) incompleteSourceCount++;
    const extracted = usableCache
      ? liveEvidence(cached, row, candidateEvidence)
      : incompleteSource
        ? trackerFallback(row)
        : reportEvidence(report, { company: row.company, role: row.role });
    if (!extracted || containsLeak(extracted)) throw new Error(`Unsafe or empty prepared evidence for ${sourceCase.case_id}`);
    const evidenceContent = [
      `Historical calibration case ${sourceCase.case_id}.`,
      `Role archetype: ${sourceCase.role_archetype}.`,
      extracted,
    ].join('\n');
    const retrievedAt = now.toISOString();
    const sourceType = usableCache ? cached.source_type : 'unknown';
    const task = prepareTask({
      task_class: 'job_evaluation',
      risk: 'MEDIUM',
      minimum_capability_class: 'STANDARD',
      company: `Historical Company ${String(index + 1).padStart(3, '0')}`,
      role: row.role,
      url: `https://jobs.example.invalid/historical/${sourceCase.case_id}`,
      resume: 'SDE',
      source: sourceType,
      evidence: [{
        id: 'EV-1',
        source_type: sourceType,
        uri: `https://jobs.example.invalid/historical/${sourceCase.case_id}`,
        content: evidenceContent,
        retrieved_at: retrievedAt,
        liveness_state: usableCache ? cached.liveness_state : 'UNKNOWN',
        structured_fields: {
          required_evidence_complete: incompleteSource && !usableCache ? 'NO' : 'YES',
        },
        ...(usableCache ? { country: 'US', allowed_countries: ['US'] } : {}),
      }],
      rules: {
        maximum_enrichment_passes: 0,
        ...(usableCache ? { required_source_types: [sourceType] } : {}),
      },
      idempotency_key: sha256(`${recommendationSet.set_digest}:${sourceCase.case_id}:${sha256(evidenceContent)}`),
    }, { now: retrievedAt, taskId: `historical-${sourceCase.case_id}` });
    return {
      id: sourceCase.case_id,
      comparison_stage: 'DIAGNOSTIC_FINAL_OUTCOME',
      label_semantics: 'FINAL_HISTORICAL_OUTCOME',
      task,
      evidence_content: { 'EV-1': evidenceContent },
      expected_recommendation: sourceCase.expected_recommendation,
      expected_gates: {},
      source_quality: usableCache
        ? liveEvidenceLabelApproved ? 'LIVE_ATS_EVIDENCE' : 'LIVE_ATS_EVIDENCE_UNREVIEWED'
        : incompleteSource ? 'DISCOVERY_METADATA_ONLY' : 'HISTORICAL_REPORT_SUMMARY',
      evidence_digest: sha256(evidenceContent),
      ...(usableCache ? { external_evidence_record_digest: cached.record_digest } : {}),
    };
  });
  const body = record('RuntimePreparedQualificationSetV1', {
    evaluation_set_version: `${recommendationSet.evaluation_set_version}-prepared-v${HISTORICAL_PREPARATION_VERSION}`,
    created_at: now.toISOString(),
    representative: true,
    human_approved: true,
    truth_source: 'HUMAN_APPROVED_HISTORY',
    label_scope: ['historical_final_outcome'],
    source_label_semantics: 'FINAL_HISTORICAL_OUTCOME',
    gate_labels_included: false,
    promotion_eligible: false,
    promotion_blockers: [
      'RECOMMENDATION_ONLY_LABELS',
      'SPLIT_LABEL_REVIEW_REQUIRED',
      ...(incompleteSourceCount ? ['INCOMPLETE_HISTORICAL_EVIDENCE'] : []),
      ...(liveAtsLabelReviewRequiredCount ? ['LIVE_EVIDENCE_LABEL_REVIEW_REQUIRED'] : []),
      ...(recommendationEvidenceAudit.contradicted_count ? ['CONTRADICTORY_HISTORICAL_OUTCOME'] : []),
      ...(recommendationEvidenceAudit.context_dependent_count ? ['CONTEXT_DEPENDENT_HISTORICAL_OUTCOME'] : []),
    ],
    task_class: 'job_evaluation',
    risk: 'MEDIUM',
    minimum_capability_class: 'STANDARD',
    source_recommendation_set_digest: recommendationSet.set_digest,
    case_count: cases.length,
    incomplete_source_count: incompleteSourceCount,
    live_ats_source_count: liveAtsSourceCount,
    live_ats_label_review_required_count: liveAtsLabelReviewRequiredCount,
    label_evidence_conflict_count: recommendationEvidenceAudit.contradicted_count,
    context_dependent_outcome_count: recommendationEvidenceAudit.context_dependent_count,
    cases,
  });
  return { ...body, set_digest: sha256(body) };
}

export function writeHistoricalQualificationFixtures(set, outputPath, { replace = false } = {}) {
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && !replace) throw new Error(`Prepared fixture already exists: ${path}; pass replace explicitly`);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(set, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}
