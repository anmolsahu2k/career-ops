import { DEFAULT_SANITIZER_LIMITS } from './constants.mjs';
import { assertPolicyDecision } from './contracts.mjs';
import { RuntimeError } from './util.mjs';

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI_AND_ZERO_WIDTH = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const RAW_HTML = /<\/?[a-z][^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const MARKDOWN_LINK = /\[[^\]]+\]\([^)]*\)/;
const BARE_URL = /\bhttps?:\/\/\S+/i;
const CODE_FENCE = /```|~~~/;
const PROMPT_INJECTION = /\b(ignore|disregard|override)\b.{0,50}\b(instruction|prompt|policy|system|previous)\b/i;
const CANDIDATE_PROHIBITED = /\b(?:F-?1|OPT|H-?1B|OIE|Heinz)\b/i;

export class SanitizationError extends RuntimeError {
  constructor(field, reason) {
    super('PRESENTATION_UNSAFE', `${field}: ${reason}`, { field, reason });
    this.name = 'SanitizationError';
  }
}

function escapeMarkdown(text) {
  return text
    .replace(/([\\`*_{}\[\]<>#|>])/g, '\\$1')
    .replace(/^(\s*)([-+])\s/gm, '$1\\$2 ')
    .replace(/^(\s*)(\d+)\./gm, '$1$2\\.');
}

function sanitizeField(field, value, limits) {
  if (typeof value !== 'string') throw new SanitizationError(field, 'must be plain text');
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new SanitizationError(field, 'contains invalid Unicode');
  let text = value.normalize('NFKC');
  if (text.includes('\0')) throw new SanitizationError(field, 'contains NUL');
  text = text.replace(ANSI, '').replace(DISALLOWED_CONTROLS, '').replace(BIDI_AND_ZERO_WIDTH, '');
  text = text.replace(/[\u2013\u2014]/g, '-');
  if (text.length > limits.field_characters) throw new SanitizationError(field, 'exceeds field length limit');
  if (RAW_HTML.test(text)) throw new SanitizationError(field, 'contains raw HTML');
  if (MARKDOWN_IMAGE.test(text)) throw new SanitizationError(field, 'contains a Markdown image');
  if (MARKDOWN_LINK.test(text)) throw new SanitizationError(field, 'contains an embedded link');
  if (BARE_URL.test(text)) throw new SanitizationError(field, 'contains a bare URL');
  if (CODE_FENCE.test(text)) throw new SanitizationError(field, 'contains a code fence');
  if (PROMPT_INJECTION.test(text)) throw new SanitizationError(field, 'contains prompt-injection language');
  if (CANDIDATE_PROHIBITED.test(text)) throw new SanitizationError(field, 'contains prohibited candidate-facing visa or school explainer content');
  return escapeMarkdown(text.trim()).replace(/\n{3,}/g, '\n\n');
}

function assertConsistent(content, decision) {
  const combined = Object.values(content).join('\n');
  if (decision.gate_resolution.sponsorship_compatible.value === 'NO' && /sponsorship[- ](?:safe|friendly|available)/i.test(combined)) {
    throw new SanitizationError('presentation_content', 'contradicts sponsorship policy decision');
  }
  if (decision.gate_resolution.posting_live.value === 'NO' && /posting (?:is )?(?:live|active|open)/i.test(combined)) {
    throw new SanitizationError('presentation_content', 'contradicts liveness policy decision');
  }
  if (decision.gate_resolution.citizenship_restricted.value === 'YES' && /no citizenship restriction/i.test(combined)) {
    throw new SanitizationError('presentation_content', 'contradicts citizenship policy decision');
  }
}

export function sanitizePresentation(presentation, decision, limits = DEFAULT_SANITIZER_LIMITS) {
  assertPolicyDecision(decision);
  const sanitized = {};
  let total = 0;
  for (const field of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    sanitized[field] = sanitizeField(field, presentation?.[field], limits);
    total += sanitized[field].length;
  }
  if (total > limits.collection_characters) {
    throw new SanitizationError('presentation_content', 'exceeds total presentation length limit');
  }
  assertConsistent(sanitized, decision);
  return Object.freeze(sanitized);
}
