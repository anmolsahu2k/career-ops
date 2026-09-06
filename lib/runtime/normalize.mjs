import { CAPABILITY_RANK, DEFAULT_SANITIZER_LIMITS, GATES, RECOMMENDATIONS, TRI_STATES } from './constants.mjs';
import { assertNormalizedEvaluation, assertRawProviderResult, assertTaskEnvelope } from './contracts.mjs';
import { RuntimeError, canonicalJson, isPlainObject, record } from './util.mjs';

const EVIDENCE_MAX_AGE_MS = Object.freeze({
  posting_live: 24 * 60 * 60 * 1000,
  citizenship_restricted: 180 * 24 * 60 * 60 * 1000,
  geography_eligible: 90 * 24 * 60 * 60 * 1000,
  sponsorship_compatible: 180 * 24 * 60 * 60 * 1000,
  required_evidence_complete: 30 * 24 * 60 * 60 * 1000,
});

function scanJsonSafety(text, limits) {
  if (Buffer.byteLength(text, 'utf8') > limits.raw_response_bytes) {
    throw new RuntimeError('RAW_RESPONSE_TOO_LARGE', `Provider response exceeds ${limits.raw_response_bytes} bytes`);
  }
  const stack = [];
  let inString = false;
  let escaped = false;
  let tokenStart = -1;
  let maxDepth = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        let cursor = index + 1;
        while (/\s/.test(text[cursor] || '')) cursor++;
        if (text[cursor] === ':' && stack.at(-1)?.type === 'object') {
          let key;
          try { key = JSON.parse(text.slice(tokenStart, index + 1)); } catch { continue; }
          if (['__proto__', 'constructor', 'prototype'].includes(key)) {
            throw new RuntimeError('POISON_KEY', `Unsafe JSON key: ${key}`);
          }
          const keys = stack.at(-1).keys;
          if (keys.has(key)) throw new RuntimeError('DUPLICATE_JSON_KEY', `Duplicate JSON key: ${key}`);
          keys.add(key);
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      tokenStart = index;
    } else if (char === '{') {
      stack.push({ type: 'object', keys: new Set() });
    } else if (char === '[') {
      stack.push({ type: 'array' });
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
    maxDepth = Math.max(maxDepth, stack.length);
    if (maxDepth > limits.maximum_depth) {
      throw new RuntimeError('JSON_NESTING_LIMIT', `Provider response exceeds nesting depth ${limits.maximum_depth}`);
    }
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1];

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (start === -1) start = index;
      depth++;
    } else if (char === '}' && start !== -1) {
      depth--;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }
  throw new RuntimeError('JSON_NOT_FOUND', 'Provider response does not contain a complete JSON object');
}

export function parseProviderJson(response, limits = DEFAULT_SANITIZER_LIMITS) {
  if (isPlainObject(response)) {
    const stack = [{ value: response, depth: 1 }];
    const seen = new WeakSet();
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (depth > limits.maximum_depth) throw new RuntimeError('JSON_NESTING_LIMIT', `Provider response exceeds nesting depth ${limits.maximum_depth}`);
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) throw new RuntimeError('CYCLIC_VALUE', 'Provider response cannot contain cycles');
      seen.add(value);
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
    const json = canonicalJson(response);
    scanJsonSafety(json, limits);
    return response;
  }
  if (typeof response !== 'string') throw new RuntimeError('RESPONSE_TYPE_INVALID', 'Provider response must be JSON text or an object');
  const json = extractJson(response);
  scanJsonSafety(json, limits);
  try {
    const parsed = JSON.parse(json);
    if (!isPlainObject(parsed)) throw new Error('top level is not an object');
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('JSON_INVALID', `Provider JSON is invalid: ${error.message}`);
  }
}

function validEvidenceSupport(reference, gate, claimedValue, manifestById, nowMs) {
  if (!isPlainObject(reference) || typeof reference.evidence_id !== 'string') return false;
  const evidence = manifestById.get(reference.evidence_id);
  if (!evidence) return false;
  const retrievedAt = Date.parse(evidence.retrieved_at);
  if (!Number.isFinite(retrievedAt) || retrievedAt > nowMs + 5 * 60_000 || nowMs - retrievedAt > EVIDENCE_MAX_AGE_MS[gate]) return false;
  if (evidence.expires_at && Date.parse(evidence.expires_at) <= nowMs) return false;
  if (reference.field) {
    if (gate === 'posting_live' && reference.field === 'liveness_state') return evidence.liveness_state === claimedValue;
    if (reference.field === gate && Object.prototype.hasOwnProperty.call(evidence.structured_fields || {}, reference.field)) {
      return evidence.structured_fields[reference.field] === claimedValue;
    }
  }
  if (reference.span_hash) return (evidence.spans || []).some(span =>
    span.hash === reference.span_hash && span.gate === gate && span.value === claimedValue);
  return false;
}

function normalizeGate(candidate, gate, manifestById, nowMs, warnings) {
  const item = isPlainObject(candidate) ? candidate : {};
  let value = TRI_STATES.includes(item.value) ? item.value : 'UNKNOWN';
  const evidenceRefs = Array.isArray(item.evidence_refs)
    ? item.evidence_refs.filter(ref => validEvidenceSupport(ref, gate, value, manifestById, nowMs))
    : [];
  if (value !== 'UNKNOWN' && evidenceRefs.length === 0) {
    warnings.push(`${gate}: unsupported ${value} converted to UNKNOWN`);
    value = 'UNKNOWN';
  }
  return { value, evidence_refs: evidenceRefs };
}

function enrichmentSupport(gate, evidence, nowMs) {
  const retrievedAt = Date.parse(evidence.retrieved_at);
  if (!Number.isFinite(retrievedAt) || retrievedAt > nowMs + 5 * 60_000 || nowMs - retrievedAt > EVIDENCE_MAX_AGE_MS[gate]) return null;
  if (evidence.expires_at && Date.parse(evidence.expires_at) <= nowMs) return null;
  if (gate === 'posting_live' && TRI_STATES.includes(evidence.liveness_state) && evidence.liveness_state !== 'UNKNOWN') {
    return { value: evidence.liveness_state, evidence_refs: [{ evidence_id: evidence.id, field: 'liveness_state' }] };
  }
  const value = evidence.structured_fields?.[gate];
  if (TRI_STATES.includes(value) && value !== 'UNKNOWN') {
    return { value, evidence_refs: [{ evidence_id: evidence.id, field: gate }] };
  }
  return null;
}

function enrichUnknowns(gates, evidenceManifest, nowMs, warnings) {
  let changed = false;
  for (const gate of GATES) {
    if (gates[gate].value !== 'UNKNOWN') continue;
    const candidates = evidenceManifest.map(item => enrichmentSupport(gate, item, nowMs)).filter(Boolean);
    const values = new Set(candidates.map(item => item.value));
    if (values.size === 1) {
      gates[gate] = candidates[0];
      warnings.push(`${gate}: resolved by deterministic evidence enrichment`);
      changed = true;
    } else if (values.size > 1) {
      warnings.push(`${gate}: conflicting deterministic evidence preserved as UNKNOWN`);
    }
  }
  return changed ? 1 : 0;
}

function validateCandidateShape(candidate) {
  if (!isPlainObject(candidate.decision_inputs)) throw new RuntimeError('SEMANTIC_INVALID', 'decision_inputs must be an object');
  if (!isPlainObject(candidate.decision_inputs.gates)) throw new RuntimeError('SEMANTIC_INVALID', 'decision_inputs.gates must be an object');
  if (!isPlainObject(candidate.presentation_content)) throw new RuntimeError('SEMANTIC_INVALID', 'presentation_content must be an object');
  for (const block of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    if (typeof candidate.presentation_content[block] !== 'string') {
      throw new RuntimeError('SEMANTIC_INVALID', `presentation_content.${block} must be plain text`);
    }
  }
  const extraGates = Object.keys(candidate.decision_inputs.gates).filter(gate => !GATES.includes(gate));
  if (extraGates.length) throw new RuntimeError('SEMANTIC_INVALID', `Unknown gates: ${extraGates.join(', ')}`);
}

export function normalizeEvaluation(task, rawResult, { now = new Date().toISOString(), limits = DEFAULT_SANITIZER_LIMITS } = {}) {
  assertTaskEnvelope(task);
  assertRawProviderResult(rawResult);
  if (rawResult.task_id !== task.task_id) throw new RuntimeError('TASK_ID_MISMATCH', 'Provider result belongs to another task');
  if (rawResult.capability_degradation === true) throw new RuntimeError('CAPABILITY_DEGRADATION', 'A degraded provider result cannot satisfy the task envelope');
  const actualClass = rawResult.provider_snapshot.capability_class;
  if (!(actualClass in CAPABILITY_RANK) || CAPABILITY_RANK[actualClass] < CAPABILITY_RANK[task.minimum_capability_class]) {
    throw new RuntimeError('MINIMUM_CAPABILITY_UNMET', `Provider capability ${actualClass || 'UNKNOWN'} is below ${task.minimum_capability_class}`);
  }
  const candidate = parseProviderJson(rawResult.response, limits);
  validateCandidateShape(candidate);
  const warnings = [];
  const nowMs = Date.parse(now);
  const manifestById = new Map(task.evidence_manifest.map(item => [item.id, item]));
  const gates = {};
  for (const gate of GATES) gates[gate] = normalizeGate(candidate.decision_inputs.gates[gate], gate, manifestById, nowMs, warnings);
  const enrichmentPasses = enrichUnknowns(gates, task.evidence_manifest, nowMs, warnings);
  const score = candidate.decision_inputs.score === null || candidate.decision_inputs.score === undefined
    ? null
    : Number(candidate.decision_inputs.score);
  const recommendation = RECOMMENDATIONS.includes(candidate.decision_inputs.recommendation)
    ? candidate.decision_inputs.recommendation
    : 'REVIEW_REQUIRED';
  if (!RECOMMENDATIONS.includes(candidate.decision_inputs.recommendation)) warnings.push('invalid recommendation converted to REVIEW_REQUIRED');
  const confidence = Number(candidate.decision_inputs.confidence);

  const normalized = record('NormalizedEvaluationV1', {
    task_id: task.task_id,
    decision_inputs: {
      gates,
      score: Number.isFinite(score) && score >= 0 && score <= 5 ? score : null,
      recommendation,
      confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0,
    },
    presentation_content: Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(block => [block, candidate.presentation_content[block]]),
    ),
    unknowns: GATES.filter(gate => gates[gate].value === 'UNKNOWN'),
    validation_warnings: warnings,
    enrichment_passes: enrichmentPasses,
  });
  return assertNormalizedEvaluation(normalized);
}
