import { normalizeSource, withSrcToken } from '../sources.mjs';
import { assertPolicyDecision, assertTaskEnvelope } from './contracts.mjs';
import { safeMarkdownCell } from './util.mjs';

const BLOCK_TITLES = Object.freeze({
  A: 'Role Summary',
  B: 'CV Match',
  C: 'Level and Strategy',
  D: 'Comp and Demand',
  E: 'Personalization Plan',
  F: 'Interview Plan',
  G: 'Legitimacy',
});

function safeHeaderText(value, field) {
  const original = String(value ?? '');
  if (Buffer.from(original, 'utf8').toString('utf8') !== original) throw new Error(`${field} contains invalid Unicode`);
  let text = original.normalize('NFKC')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 512) throw new Error(`${field} has an invalid length`);
  if (/<\/?[a-z][^>]*>/i.test(text) || /```|~~~|!\[|\[[^\]]+\]\([^)]*\)/.test(text)) {
    throw new Error(`${field} contains markup`);
  }
  text = text.replace(/([\\`*_{}\[\]<>#|>])/g, '\\$1');
  return safeMarkdownCell(text);
}

function trustedSubject(task) {
  const url = new URL(task.subject.url);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS posting URLs may be rendered');
  if (/[\s<>]/.test(task.subject.url)) throw new Error('Posting URL contains unsafe characters');
  return {
    company: safeHeaderText(task.subject.company, 'company'),
    role: safeHeaderText(task.subject.role, 'role'),
    url: task.subject.url,
    resume: task.subject.resume,
    source: normalizeSource(task.subject.source) || 'unknown',
  };
}

function headerMetadata(task, decision) {
  const live = decision.gate_resolution.posting_live.value;
  return {
    legitimacy: live === 'YES' ? 'High Confidence (validated source, active)'
      : live === 'NO' ? 'Low (posting closed)'
        : 'Medium (liveness uncertain)',
    level: /\b(?:new[ -]?grad|entry[ -]?level|university grad(?:uate)?|graduate program)\b/i.test(task.subject.role)
      ? 'New-grad-only'
      : 'Mixed',
    comp: 'unknown',
  };
}

function recommendationText(decision) {
  const labels = {
    APPLY: 'Apply. The deterministic policy gates passed.',
    CONSIDER: 'Consider after reviewing the unresolved consequential gates.',
    DO_NOT_APPLY: 'Do not apply. One or more deterministic hard gates failed.',
    REVIEW_REQUIRED: 'Manual review required before assigning a final score or acting.',
    DEFERRED: 'Deferred. No write is authorized.',
  };
  const reasonCodes = decision.reasons.map(reason => reason.code).join(', ');
  return `${labels[decision.decision]}${reasonCodes ? ` Policy reasons: ${reasonCodes}.` : ''}`;
}

export function renderEvaluationReport({ task, decision, presentation, reportNumber }) {
  assertTaskEnvelope(task);
  assertPolicyDecision(decision);
  if (!decision.authorized_writes.includes('report')) throw new Error('PolicyDecisionV1 does not authorize a report write');
  const subject = trustedSubject(task);
  const meta = headerMetadata(task, decision);
  const score = decision.score === null ? 'N/A' : `${decision.score.toFixed(1)}/5`;
  const lines = [
    `# ${String(reportNumber).padStart(3, '0')}, ${subject.company} | ${subject.role}`,
    '',
    `**URL:** ${subject.url}`,
    '',
    `**Score:** ${score}  **Status:** ${decision.tracker_status}  **Resume:** ${subject.resume}`,
    `**Legitimacy:** ${meta.legitimacy}`,
    `**Level strategy:** ${meta.level}`,
    `**Comp research:** ${meta.comp}`,
    `**Sponsorship flag:** ${decision.sponsorship_flag}`,
    '',
  ];
  for (const [block, title] of Object.entries(BLOCK_TITLES)) {
    lines.push(`## Block ${block}, ${title}`, '', presentation[block], '');
  }
  lines.push('## Recommendation', '', recommendationText(decision), '');
  return lines.join('\n');
}

function reviewNote(decision) {
  const gates = decision.uncertainty_handling.review_gates;
  if (!gates.length) return '';
  return `REVIEW:${decision.task_id}:${gates.join(',')}.`;
}

export function renderTrackerRow({ task, decision, reportNumber, reportRelativePath, date }) {
  assertTaskEnvelope(task);
  assertPolicyDecision(decision);
  if (!decision.authorized_writes.includes('tracker')) throw new Error('PolicyDecisionV1 does not authorize a tracker write');
  const subject = trustedSubject(task);
  const source = normalizeSource(subject.source) || 'unknown';
  const notes = withSrcToken(reviewNote(decision), source);
  const score = decision.score === null ? 'N/A' : `${decision.score.toFixed(1)}/5`;
  const cells = [
    String(reportNumber), date, subject.company, subject.role, score,
    decision.tracker_status, '❌', `[${String(reportNumber).padStart(3, '0')}](${reportRelativePath})`, notes,
  ].map(safeMarkdownCell);
  const row = `| ${cells.join(' | ')} |`;
  if (row.split('|').length !== 11) throw new Error('Rendered tracker row is not nine columns');
  return row;
}
