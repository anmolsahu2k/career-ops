import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { record, sha256 } from './util.mjs';

const DEFAULT_COUNTS = Object.freeze({ positive_action: 20, rejected_at_eval: 20, unresolved: 10 });
const GATE_NAMES = Object.freeze([
  'posting_live',
  'citizenship_restricted',
  'geography_eligible',
  'sponsorship_compatible',
  'required_evidence_complete',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveHistoricalReport(target, cell) {
  const match = String(cell || '').match(/\(([^)#]+)(?:#[^)]*)?\)/);
  if (!match || isAbsolute(match[1])) return null;
  const root = realpathSync(target);
  const candidate = resolve(root, match[1]);
  if (!inside(root, candidate) || !existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) return null;
  const real = realpathSync(candidate);
  return inside(root, real) ? real : null;
}

function replaceExact(text, value, marker) {
  if (!String(value || '').trim()) return text;
  return text.replace(new RegExp(escapeRegExp(String(value).trim()), 'giu'), marker);
}

export function redactHistoricalText(value, identity = {}, maxLength = 320) {
  let text = String(value ?? '').normalize('NFKC')
    .replace(/\0/g, '')
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/giu, '$1 [LINK]')
    .replace(/https?:\/\/\S+/giu, '[URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]')
    .replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, '[PHONE]')
    .replace(/<[^>]*>/g, '')
    .replace(/\bAnmol(?:\s+Sahu)?\b/giu, '[CANDIDATE]');
  text = replaceExact(text, identity.company, '[COMPANY]');
  text = replaceExact(text, identity.role, '[ROLE]');
  const cleaned = text
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(32, Math.min(16_384, Number(maxLength) || 320));
  if (cleaned.length <= limit) return cleaned;
  const boundary = cleaned.slice(0, limit - 3).replace(/\s+\S*$/, '').trimEnd();
  return `${boundary || cleaned.slice(0, limit - 3)}...`;
}

function proposedGate(content, yes, no) {
  if (no.test(content)) return 'NO';
  if (yes.test(content)) return 'YES';
  return 'UNKNOWN';
}

export function proposedGates(content) {
  return {
    posting_live: proposedGate(
      content,
      /\b(?:verified live|posting (?:is )?live|active posting|currently accepting)\b/i,
      /\b(?:posting (?:is )?(?:closed|expired)|no longer accepting|role (?:is )?closed)\b/i,
    ),
    citizenship_restricted: proposedGate(
      content,
      /\b(?:u\.?s\.? citizens? only|citizenship required|must be (?:a )?u\.?s\.? citizen|u\.?s\.? person required)\b/i,
      /\b(?:no citizenship restriction|citizenship is not required)\b/i,
    ),
    geography_eligible: proposedGate(
      content,
      /\b(?:remote[- ]us|remote within (?:the )?u\.?s\.?|geograph(?:y|ic(?:ally)?) eligible)\b/i,
      /\b(?:geographic mismatch|location mismatch|outside (?:the )?eligible geography)\b/i,
    ),
    sponsorship_compatible: proposedGate(
      content,
      /\b(?:will sponsor|sponsorship (?:is )?(?:available|supported|provided)|sponsors? h-?1b)\b/i,
      /\b(?:(?:employment |work |visa )?sponsorship (?:is |will be )?(?:not available|not offered|not provided|not supported)|does not sponsor|cannot sponsor|without sponsorship now or in the future|authori[sz](?:ation|ed) to work.{0,80}without (?:current or future )?(?:visa )?sponsorship)\b/i,
    ),
    required_evidence_complete: proposedGate(
      content,
      /\b(?:required evidence complete|all required evidence (?:is )?(?:present|complete))\b/i,
      /\b(?:required evidence (?:is )?(?:missing|incomplete)|missing required evidence)\b/i,
    ),
  };
}

function scoreValue(score) {
  const match = String(score || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return match ? Number(match[1]) : null;
}

function outcomeHeading(line) {
  const heading = String(line).replace(/^\s*#{1,6}\s+/, '').trim();
  return /^(?:(?:block\s+[A-G])\s*[:,\-]\s*)?(?:recommendation|verdict|overall assessment|global score|final decision)\b/i.test(heading);
}

function explicitOutcomeText(report) {
  const lines = String(report).split(/\r?\n/);
  const outcomeLines = [];
  let inOutcome = false;
  for (const line of lines) {
    if (/^\s*#{1,6}\s+/.test(line)) {
      inOutcome = outcomeHeading(line);
      continue;
    }
    if (inOutcome || /^\s*\*{0,2}(?:global\s+score|score|verdict|recommendation)\b/i.test(line)) outcomeLines.push(line);
  }
  return outcomeLines.join(' ').replace(/\s+/g, ' ').trim();
}

export function historicalOutcomeContextDependency(report) {
  const text = explicitOutcomeText(report);
  const portfolioContext = /\b(?:application|position)\s+(?:allowance|limit|cap)\b|\b(?:same|shared)\s+(?:application|position)\s+(?:allowance|limit|cap)\b|\bsecond[- ]best\b|\b(?:one|single)\s+(?:slot|application)\b|\bcompete\w*\s+for\s+the\s+same\s+(?:slot|allowance|application)\b/i.test(text);
  return portfolioContext && (/\bconsider\b/i.test(text) || /\bdo not apply\b.{0,160}\b(?:portfolio|allowance|limit|cap|slot)\b/i.test(text));
}

export function explicitRecommendationSignals(report) {
  const text = explicitOutcomeText(report);
  const withoutNegative = text.replace(/\b(?:do not|don't|should not|not recommended to)\s+apply\b/gi, ' ');
  const conditionalApply = /\b(?:marginal(?:-to)?[-\s]+apply|apply\s+if\b|submit\b.{0,80}\bonly\s+if\b)/i.test(withoutNegative);
  const signals = [];
  if (/\b(?:do not|don't|should not|not recommended to)\s+apply\b|\b(?:skip|discard)\b/i.test(text)) signals.push('DO_NOT_APPLY');
  if (/\bconsider\b/i.test(text) || conditionalApply) signals.push('CONSIDER');
  if (/\bapply\b/i.test(withoutNegative) && !conditionalApply) signals.push('APPLY');
  if (signals.length === 0) {
    const score = Number(text.match(/\b([0-5](?:\.\d+)?)\s*\/\s*5\b/)?.[1]);
    if (Number.isFinite(score)) {
      if (score >= 4) signals.push('APPLY');
      else if (score >= 3) signals.push('CONSIDER');
      else signals.push('DO_NOT_APPLY');
    }
  }
  return Array.from(new Set(signals));
}

export function roleArchetype(role) {
  const value = String(role || '').toLowerCase();
  if (/machine learning|\bml\b|artificial intelligence|\bai\b|data scientist/.test(value)) return 'ML_AI';
  if (/data engineer|analytics engineer/.test(value)) return 'DATA';
  if (/front.?end|full.?stack/.test(value)) return 'FULL_STACK';
  if (/security|infra|platform|devops|site reliability|\bsre\b/.test(value)) return 'PLATFORM';
  if (/software|backend|developer|engineer/.test(value)) return 'SOFTWARE';
  return 'OTHER';
}

function evidenceSnippets(content) {
  const signals = [
    [/recommend|apply|do not apply/i, 'Historical report contains a recommendation signal.'],
    [/global score|\d+(?:\.\d+)?\s*\/\s*5/i, 'Historical report contains a numeric scoring signal.'],
    [/sponsor|visa|h-?1b|opt|stem/i, 'Historical report discusses sponsorship or work-authorization constraints.'],
    [/citizen|u\.?s\.? person|security clearance/i, 'Historical report discusses citizenship or clearance constraints.'],
    [/geograph|location|remote|hybrid|relocat/i, 'Historical report discusses geography or workplace constraints.'],
    [/posting|liveness|active|closed|expired/i, 'Historical report discusses posting-liveness evidence.'],
    [/experience|senior|junior|entry.level|years? required/i, 'Historical report discusses experience or level fit.'],
  ];
  const found = signals.filter(([pattern]) => pattern.test(content)).map(([, summary]) => summary);
  return found.length ? found.slice(0, 6) : ['Historical report exists; no supported gate signal was extracted.'];
}

function candidatesFromTracker(target) {
  const trackerPath = join(target, 'data', 'applications.md');
  const trackerText = readFileSync(trackerPath, 'utf8');
  const lines = trackerText.split(/\r?\n/);
  const columns = resolveColumns(lines);
  const rows = lines.map(line => parseTrackerRow(line, columns)).filter(Boolean);
  const candidates = [];
  for (const row of rows) {
    let cohort = null;
    if (row.status === 'Applied' || row.status === 'Responded') cohort = 'positive_action';
    else if (row.status === 'Rejected-at-eval') cohort = 'rejected_at_eval';
    else if (row.status === 'Evaluated') cohort = 'unresolved';
    const reportPath = resolveHistoricalReport(target, row.report);
    if (!reportPath) continue;
    candidates.push({ cohort, row, reportPath });
  }
  return { trackerPath, trackerText, candidates };
}

function choose(candidates, cohort, count) {
  const eligible = candidates.filter(item => item.cohort === cohort);
  if (eligible.length < count) throw new Error(`Not enough ${cohort} reports: need ${count}, found ${eligible.length}`);
  return eligible
    .sort((a, b) => sha256(`${cohort}:${a.row.num}`).localeCompare(sha256(`${cohort}:${b.row.num}`)))
    .slice(0, count);
}

export function buildHistoricalReviewPack({ target, counts = DEFAULT_COUNTS, now = new Date() }) {
  const root = realpathSync(resolve(target));
  const { trackerPath, trackerText, candidates } = candidatesFromTracker(root);
  const selected = Object.entries(counts).flatMap(([cohort, count]) => choose(candidates, cohort, count));
  const cases = selected.map((item, index) => {
    const report = readFileSync(item.reportPath, 'utf8');
    const cohortProposal = item.cohort === 'positive_action'
      ? 'APPLY'
      : item.cohort === 'rejected_at_eval' ? 'DO_NOT_APPLY' : 'CONSIDER';
    const explicitSignals = explicitRecommendationSignals(report);
    const proposal = explicitSignals.length === 1 ? explicitSignals[0] : cohortProposal;
    const gates = proposedGates(report);
    const unknownCount = GATE_NAMES.filter(name => gates[name] === 'UNKNOWN').length;
    return record('HistoricalLabelReviewCaseV1', {
      case_id: `HIST-${String(index + 1).padStart(3, '0')}`,
      cohort: item.cohort,
      role_archetype: roleArchetype(item.row.role),
      source: {
        tracker_row_number: item.row.num,
        tracker_status: item.row.status,
        report_digest: sha256(report),
      },
      redacted_evidence: evidenceSnippets(report),
      proposal: {
        recommendation: proposal,
        explicit_report_signals: explicitSignals,
        label_basis: explicitSignals.length === 1 ? 'EXPLICIT_REPORT_OUTCOME' : 'TRACKER_STATUS_FALLBACK',
        score: scoreValue(item.row.score),
        gates,
        consequential_unknown_count: unknownCount,
        provenance: 'UNTRUSTED_HISTORICAL_LABEL',
      },
      review: {
        status: 'REVIEW_REQUIRED',
        approved_recommendation: null,
        approved_gates: null,
        notes: '',
      },
    });
  });
  const body = record('RuntimeHistoricalLabelReviewPackV1', {
    created_at: now.toISOString(),
    representative: false,
    human_approved: false,
    source: {
      tracker_digest: sha256(trackerText),
      tracker_file: relative(root, trackerPath),
      report_contents_embedded: false,
    },
    redaction: {
      normalization: 'NFKC',
      direct_company_and_role_names: 'REDACTED',
      urls_emails_phones_candidate_name: 'REDACTED',
      freeform_report_text: 'NOT_EMBEDDED',
    },
    instructions: [
      'Review every proposed recommendation and gate against the local source row and report.',
      'Set review.status to APPROVED or EDITED and fill approved fields; proposals are not ground truth.',
      'Do not set representative or human_approved true until all 50 cases have completed review.',
    ],
    selection: {
      requested_counts: counts,
      actual_count: cases.length,
      deterministic: true,
    },
    cases,
  });
  return { ...body, pack_digest: sha256(body) };
}

function markdownValue(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();
}

export function renderHistoricalReviewMarkdown(pack) {
  const out = [
    '# Historical Qualification Label Review',
    '',
    `Pack digest: \`${pack.pack_digest}\``,
    '',
    'This pack is not qualification truth. Review all 50 cases before it is used for qualification.',
    '',
    '## How to review',
    '',
    '1. Open the matching case in `historical-label-review-local-index.md`, then inspect its source report.',
    '2. Check the recommendation and all five proposed gates against explicit source evidence. Keep `UNKNOWN` when the report does not establish a gate; do not guess.',
    '3. Change `[ ]` to `[x]`. Under `Reviewer correction/notes`, write `APPROVED` or an explicit correction such as `EDITED: recommendation=CONSIDER; sponsorship_compatible=UNKNOWN`.',
    '4. After all cases are checked, give this checklist back to Codex. Codex will validate the edits and produce the human-approved representative JSON; you do not need to edit the JSON by hand.',
    '',
  ];
  for (const item of pack.cases) {
    out.push(`## ${item.case_id} — ${item.role_archetype}`, '');
    out.push(`- [ ] Reviewed (tracker row ${item.source.tracker_row_number}; historical status: ${markdownValue(item.source.tracker_status)})`);
    out.push(`- Proposed recommendation: \`${item.proposal.recommendation}\`; historical score: \`${item.proposal.score ?? 'UNKNOWN'}\``);
    out.push(`- Proposed gates: \`${markdownValue(JSON.stringify(item.proposal.gates))}\``);
    out.push('- Evidence:');
    for (const snippet of item.redacted_evidence) out.push(`  - ${markdownValue(snippet)}`);
    out.push('- Reviewer correction/notes:', '');
  }
  return `${out.join('\n')}\n`;
}

export function renderLocalReviewIndex(pack, target, indexDir = target) {
  const root = realpathSync(resolve(target));
  const linkBase = existsSync(indexDir) ? realpathSync(resolve(indexDir)) : resolve(indexDir);
  const trackerPath = join(root, 'data', 'applications.md');
  const lines = readFileSync(trackerPath, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  const rows = new Map(lines
    .map(line => parseTrackerRow(line, columns))
    .filter(Boolean)
    .map(row => [row.num, row]));
  const out = [
    '# Local Source Index — Do Not Send to Providers',
    '',
    'This companion contains identifying local paths. Use it only to inspect source reports while reviewing the separately redacted pack.',
    '',
    '| Case | Tracker row | Local report |',
    '|---|---:|---|',
  ];
  for (const item of pack.cases) {
    const row = rows.get(item.source.tracker_row_number);
    const reportPath = row ? resolveHistoricalReport(root, row.report) : null;
    const linkPath = reportPath
      ? relative(linkBase, reportPath).split(sep).map(segment => encodeURIComponent(segment)).join('/')
      : null;
    const link = linkPath ? `[Open source](${linkPath})` : 'Missing';
    out.push(`| ${item.case_id} | ${item.source.tracker_row_number} | ${link} |`);
  }
  return `${out.join('\n')}\n`;
}

export function writeHistoricalReviewPack(pack, outputDir, { target } = {}) {
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jsonPath = join(dir, 'historical-label-review-v1.json');
  const markdownPath = join(dir, 'historical-label-review-v1.md');
  const localIndexPath = target ? join(dir, 'historical-label-review-local-index.md') : null;
  writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    writeFileSync(markdownPath, renderHistoricalReviewMarkdown(pack), { flag: 'wx', mode: 0o600 });
    if (localIndexPath) writeFileSync(localIndexPath, renderLocalReviewIndex(pack, target, dir), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error(`JSON was written at ${jsonPath}, but Markdown creation failed: ${error.message}`);
  }
  return { jsonPath, markdownPath, localIndexPath };
}

function verifySplitReviewSource(recommendationSet) {
  if (recommendationSet?.schema !== 'RuntimeHistoricalRecommendationSetV1'
      || recommendationSet.schema_version !== 1
      || recommendationSet.human_approved !== true) {
    throw new Error('Split-label review requires a human-approved recommendation set');
  }
  const { set_digest: observedDigest, ...unsigned } = recommendationSet;
  if (!observedDigest || sha256(unsigned) !== observedDigest) {
    throw new Error('Split-label review source digest mismatch');
  }
}

export function buildHistoricalSplitLabelReviewPack({ target, recommendationSet, now = new Date() }) {
  verifySplitReviewSource(recommendationSet);
  const root = realpathSync(resolve(target));
  const trackerPath = join(root, 'data', 'applications.md');
  const lines = readFileSync(trackerPath, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  const rows = new Map(lines.map(line => parseTrackerRow(line, columns)).filter(Boolean).map(row => [row.num, row]));
  const cases = recommendationSet.cases.map(item => {
    const row = rows.get(item.source?.tracker_row_number);
    const reportPath = row ? resolveHistoricalReport(root, row.report) : null;
    if (!row || !reportPath) throw new Error(`Split-label source missing for ${item.case_id}`);
    const report = readFileSync(reportPath, 'utf8');
    if (sha256(report) !== item.source.report_digest) throw new Error(`Split-label report digest mismatch for ${item.case_id}`);
    return record('HistoricalSplitLabelReviewCaseV1', {
      case_id: item.case_id,
      role_archetype: item.role_archetype,
      source: item.source,
      approved_final_outcome: item.expected_recommendation,
      proposal: {
        gates: proposedGates(report),
        provenance: 'DETERMINISTIC_PROPOSAL_NOT_TRUTH',
      },
      review: {
        status: 'REVIEW_REQUIRED',
        approved_advisory_recommendation: null,
        approved_gates: null,
        notes: '',
      },
    });
  });
  const body = record('RuntimeHistoricalSplitLabelReviewPackV1', {
    created_at: now.toISOString(),
    source_recommendation_set_digest: recommendationSet.set_digest,
    source_label_semantics: 'FINAL_HISTORICAL_OUTCOME',
    target_label_semantics: ['ADVISORY_RECOMMENDATION', 'HARD_GATE_TRUTH'],
    human_approved: false,
    instructions: [
      'Keep the approved final historical outcome unchanged.',
      'Approve an advisory recommendation based on merit, level, compensation, and domain while ignoring liveness, citizenship, geography, and sponsorship policy effects.',
      'Approve each gate only from explicit source evidence; preserve UNKNOWN when evidence is absent or ambiguous.',
      'The deterministic proposals are review aids, not truth.',
    ],
    case_count: cases.length,
    cases,
  });
  return { ...body, pack_digest: sha256(body) };
}

export function renderHistoricalSplitLabelReviewMarkdown(pack) {
  const out = [
    '# Historical Split-Label Review',
    '',
    `Pack digest: \`${pack.pack_digest}\``,
    '',
    'This review separates the already-approved final outcome from pre-policy advisory merit and explicit hard-gate truth.',
    '',
    '## How to review',
    '',
    '1. Open the matching source in `historical-split-label-review-local-index.md`.',
    '2. Choose the advisory recommendation while ignoring posting liveness, citizenship, geography, and sponsorship effects; PolicyEngine handles those separately.',
    '3. Confirm every gate from explicit evidence only. Use `UNKNOWN` when the report does not prove YES or NO.',
    '4. Check the box and add one line in this exact form: `APPROVED: advisory=APPLY; posting_live=YES; citizenship_restricted=NO; geography_eligible=YES; sponsorship_compatible=UNKNOWN; required_evidence_complete=YES`.',
    '5. Corrections use the same line with `EDITED:` instead of `APPROVED:`.',
    '',
  ];
  for (const item of pack.cases) {
    out.push(`## ${item.case_id} — ${item.role_archetype}`, '');
    out.push(`- [ ] Reviewed (tracker row ${item.source.tracker_row_number})`);
    out.push(`- Approved final outcome, unchanged: \`${item.approved_final_outcome}\``);
    out.push(`- Proposed gates, not truth: \`${markdownValue(JSON.stringify(item.proposal.gates))}\``);
    out.push('- Reviewer decision:', '');
  }
  return `${out.join('\n')}\n`;
}

export function writeHistoricalSplitLabelReviewPack(pack, outputDir, { target } = {}) {
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jsonPath = join(dir, 'historical-split-label-review-v1.json');
  const markdownPath = join(dir, 'historical-split-label-review-v1.md');
  const localIndexPath = target ? join(dir, 'historical-split-label-review-local-index.md') : null;
  writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(markdownPath, renderHistoricalSplitLabelReviewMarkdown(pack), { flag: 'wx', mode: 0o600 });
  if (localIndexPath) writeFileSync(localIndexPath, renderLocalReviewIndex(pack, target, dir), { flag: 'wx', mode: 0o600 });
  return { jsonPath, markdownPath, localIndexPath };
}

function auditMetadata(audit) {
  if (!audit) return null;
  const provenance = audit.audit_provenance || {};
  return {
    provider_id: provenance.provider_id || 'unspecified',
    model_vendor: provenance.model_vendor || 'unspecified',
    model_snapshot: provenance.model_snapshot || 'unspecified',
    execution_surface: provenance.execution_surface || 'unspecified',
    reasoning_effort: provenance.reasoning_effort || 'provider-defined',
    decision: audit.decision,
    reviewed_case_count: audit.reviewed_cases.length,
    discrepancy_count: audit.discrepancies.length,
    audit_digest: sha256(audit),
    authoritative: false,
  };
}

function assertApprovingReplacementAudit(audit, packDigest, replacementPack) {
  if (!audit || audit.schema !== 'HistoricalLabelAuditV1' || audit.schema_version !== 1 || audit.decision !== 'APPROVE') {
    throw new Error('Replacement audit must be an approving HistoricalLabelAuditV1 record');
  }
  if (audit.audit_provenance?.pack_digest !== packDigest) {
    throw new Error('Replacement audit is not bound to the exact replacement pack digest');
  }
  const expected = new Set(replacementPack.replacements.map(item => item.case_id));
  const reviewed = new Set(audit.reviewed_cases
    .filter(item => item.recommendation_supported === true)
    .map(item => item.case_id));
  if (audit.discrepancies.length !== 0 || reviewed.size !== expected.size
      || [...expected].some(caseId => !reviewed.has(caseId))) {
    throw new Error('Replacement audit must support every replacement case without discrepancies');
  }
}

export function approveHistoricalRecommendations(pack, {
  approvedAt = new Date(),
  attestationId,
  audit = null,
} = {}) {
  if (pack?.schema !== 'RuntimeHistoricalLabelReviewPackV1' || pack.schema_version !== 1) {
    throw new Error('Expected RuntimeHistoricalLabelReviewPackV1 version 1');
  }
  const { pack_digest: observedDigest, ...unsignedPack } = pack;
  if (!observedDigest || sha256(unsignedPack) !== observedDigest) throw new Error('Review pack digest mismatch');
  if (!Array.isArray(pack.cases) || pack.cases.length < 50) throw new Error('Representative recommendation set requires at least 50 cases');
  if (!attestationId) throw new Error('Explicit human approval attestation is required');
  if (audit && (audit.schema !== 'HistoricalLabelAuditV1' || audit.schema_version !== 1)) {
    throw new Error('Independent audit must be HistoricalLabelAuditV1 version 1');
  }
  const recommendationConflicts = (audit?.discrepancies || [])
    .filter(item => item.field === 'proposal.recommendation')
    .map(item => ({ case_id: item.case_id, reason: item.reason }));
  const body = record('RuntimeHistoricalRecommendationSetV1', {
    evaluation_set_version: 'historical-human-approved-v1',
    created_at: approvedAt.toISOString(),
    representative: true,
    human_approved: true,
    label_scope: ['recommendation'],
    gate_labels_included: false,
    source_review_pack_digest: observedDigest,
    approval: {
      authority: 'user',
      method: 'explicit_conversation_attestation',
      attestation_digest: sha256(attestationId),
      approved_at: approvedAt.toISOString(),
      approved_case_count: pack.cases.length,
    },
    independent_audit: audit ? {
      ...auditMetadata(audit),
      recommendation_conflicts: recommendationConflicts,
    } : null,
    cases: pack.cases.map(item => ({
      case_id: item.case_id,
      cohort: item.cohort,
      role_archetype: item.role_archetype,
      expected_recommendation: item.proposal.recommendation,
      historical_score: item.proposal.score,
      source: item.source,
      label_provenance: 'HUMAN_APPROVED',
    })),
  });
  return { ...body, set_digest: sha256(body) };
}

export function writeApprovedRecommendationSet(set, outputPath) {
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

function replacementEvidence(report, identity) {
  const lines = String(report).split(/\r?\n/)
    .filter(line => !/\b(?:recommendation|verdict|global score|overall assessment|apply with|do not apply|action items|tracker line)\b/i.test(line))
    .filter(line => !/^\s*```/.test(line))
    .map(line => redactHistoricalText(line, identity, 600))
    .filter(Boolean);
  return Array.from(new Set(lines)).join('\n').slice(0, 6_000).trim();
}

export function buildHistoricalReplacementReviewPack({
  target,
  recommendationSet,
  replacementCaseIds,
  replacementTrackerRows,
  replacementReason = 'INCOMPLETE_SOURCE',
  now = new Date(),
}) {
  const root = realpathSync(resolve(target));
  const { set_digest: observedDigest, ...unsignedSet } = recommendationSet || {};
  if (recommendationSet?.schema !== 'RuntimeHistoricalRecommendationSetV1'
      || !observedDigest || sha256(unsignedSet) !== observedDigest) {
    throw new Error('Replacement source recommendation set is invalid');
  }
  if (!Array.isArray(replacementCaseIds) || replacementCaseIds.length === 0
      || replacementCaseIds.length !== replacementTrackerRows?.length) {
    throw new Error('Replacement case IDs and tracker rows must be non-empty and have equal lengths');
  }
  const { candidates } = candidatesFromTracker(root);
  const byRow = new Map(candidates.map(item => [item.row.num, item]));
  const existingRows = new Set(recommendationSet.cases.map(item => item.source?.tracker_row_number));
  const existingCases = new Map(recommendationSet.cases.map(item => [item.case_id, item]));
  const highestCaseNumber = Math.max(...recommendationSet.cases.map(item => Number(item.case_id?.match(/(\d+)$/)?.[1] || 0)));
  const seenRows = new Set();
  const replacements = replacementCaseIds.map((replacementFor, index) => {
    const sourceCase = existingCases.get(replacementFor);
    if (!sourceCase) throw new Error(`Unknown replacement source case: ${replacementFor}`);
    const sourceCandidate = byRow.get(sourceCase.source?.tracker_row_number);
    if (!sourceCandidate) throw new Error(`Source report is unavailable for ${replacementFor}`);
    const sourceReport = readFileSync(sourceCandidate.reportPath, 'utf8');
    if (replacementReason === 'INCOMPLETE_SOURCE') {
      if (!/Pending Evaluation Stub/i.test(sourceReport)) {
        throw new Error(`${replacementFor} is not an incomplete historical case`);
      }
    } else if (replacementReason === 'CONTRADICTORY_HISTORICAL_OUTCOME') {
      const sourceSignals = explicitRecommendationSignals(sourceReport);
      if (!sourceSignals.length || sourceSignals.includes(sourceCase.expected_recommendation)) {
        throw new Error(`${replacementFor} does not have a contradictory explicit outcome`);
      }
    } else if (replacementReason === 'CONTEXT_DEPENDENT_HISTORICAL_OUTCOME') {
      if (!historicalOutcomeContextDependency(sourceReport)) {
        throw new Error(`${replacementFor} does not have a context-dependent historical outcome`);
      }
    } else {
      throw new Error(`Unsupported replacement reason: ${replacementReason}`);
    }
    const trackerRow = Number(replacementTrackerRows[index]);
    if (existingRows.has(trackerRow) || seenRows.has(trackerRow)) throw new Error(`Replacement tracker row is duplicated: ${trackerRow}`);
    seenRows.add(trackerRow);
    const candidate = byRow.get(trackerRow);
    const expectedCohort = sourceCase.expected_recommendation === 'APPLY'
      ? 'positive_action'
      : sourceCase.expected_recommendation === 'DO_NOT_APPLY' ? 'rejected_at_eval' : 'unresolved';
    if (!candidate) throw new Error(`Replacement tracker row is unavailable: ${trackerRow}`);
    const report = readFileSync(candidate.reportPath, 'utf8');
    if (/Pending Evaluation Stub/i.test(report)) throw new Error(`Replacement tracker row has only a pending stub: ${trackerRow}`);
    if (historicalOutcomeContextDependency(report)) {
      throw new Error(`Replacement tracker row has a context-dependent outcome: ${trackerRow}`);
    }
    const evidence = replacementEvidence(report, { company: candidate.row.company, role: candidate.row.role });
    if (!evidence) throw new Error(`Replacement tracker row produced no safe calibration evidence: ${trackerRow}`);
    const replacementSignals = explicitRecommendationSignals(report);
    if (replacementSignals.length !== 1 || replacementSignals[0] !== sourceCase.expected_recommendation) {
      throw new Error(`Replacement tracker row lacks one unambiguous explicit ${sourceCase.expected_recommendation} outcome: ${trackerRow}`);
    }
    return record('HistoricalReplacementReviewCaseV1', {
      case_id: `HIST-${String(highestCaseNumber + index + 1).padStart(3, '0')}`,
      replaces_case_id: replacementFor,
      cohort: expectedCohort,
      role_archetype: roleArchetype(candidate.row.role),
      source: {
        tracker_row_number: trackerRow,
        tracker_status: candidate.row.status,
        report_digest: sha256(report),
      },
      proposed_recommendation: sourceCase.expected_recommendation,
      replacement_reason: replacementReason,
      explicit_report_signals: replacementSignals,
      redacted_evidence: evidence,
      review: { status: 'REVIEW_REQUIRED', notes: '' },
    });
  });
  const body = record('RuntimeHistoricalReplacementReviewPackV1', {
    created_at: now.toISOString(),
    source_recommendation_set_digest: observedDigest,
    replacement_count: replacements.length,
    replacement_reason: replacementReason,
    replacements,
  });
  return { ...body, pack_digest: sha256(body) };
}

export function applyHistoricalRecommendationReplacements({
  recommendationSet,
  replacementPack,
  attestationId,
  audit = null,
  now = new Date(),
}) {
  const { set_digest: sourceDigest, ...unsignedSet } = recommendationSet || {};
  const { pack_digest: packDigest, ...unsignedPack } = replacementPack || {};
  if (!sourceDigest || sha256(unsignedSet) !== sourceDigest
      || replacementPack?.schema !== 'RuntimeHistoricalReplacementReviewPackV1'
      || !packDigest || sha256(unsignedPack) !== packDigest
      || replacementPack.source_recommendation_set_digest !== sourceDigest) {
    throw new Error('Replacement lineage or digest is invalid');
  }
  if (!attestationId) throw new Error('Explicit human approval attestation is required');
  if (audit) assertApprovingReplacementAudit(audit, packDigest, replacementPack);
  const replacements = new Map(replacementPack.replacements.map(item => [item.replaces_case_id, item]));
  if (replacements.size !== replacementPack.replacement_count) throw new Error('Replacement pack contains duplicate targets');
  const replacedCases = [];
  const cases = recommendationSet.cases.map(item => {
    const replacement = replacements.get(item.case_id);
    if (!replacement) return item;
    replacedCases.push(item.case_id);
    return {
      case_id: replacement.case_id,
      cohort: replacement.cohort,
      role_archetype: replacement.role_archetype,
      expected_recommendation: replacement.proposed_recommendation,
      historical_score: null,
      source: replacement.source,
      label_provenance: 'HUMAN_APPROVED_REPLACEMENT',
    };
  });
  if (replacedCases.length !== replacements.size) throw new Error('Replacement pack target is absent from source set');
  const body = record('RuntimeHistoricalRecommendationSetV1', {
    evaluation_set_version: `historical-human-approved-v${Number(recommendationSet.evaluation_set_version?.match(/-v(\d+)$/)?.[1] || 1) + 1}`,
    created_at: now.toISOString(),
    representative: true,
    human_approved: true,
    label_scope: ['recommendation'],
    gate_labels_included: false,
    source_review_pack_digest: recommendationSet.source_review_pack_digest,
    approval: {
      authority: 'user',
      method: audit ? 'explicit_user_delegation_with_independent_model_audit' : 'explicit_conversation_blanket_attestation',
      attestation_digest: sha256(attestationId),
      approved_at: now.toISOString(),
      approved_case_count: replacementPack.replacement_count,
    },
    independent_audit: auditMetadata(audit),
    revision: {
      source_set_digest: sourceDigest,
      replacement_pack_digest: packDigest,
      replaced_case_ids: replacedCases,
    },
    cases,
  });
  return { ...body, set_digest: sha256(body) };
}
