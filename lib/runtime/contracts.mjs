import {
  CAPABILITY_CLASSES,
  GATES,
  RECOMMENDATIONS,
  TRI_STATES,
  TRUST_CLASSES,
} from './constants.mjs';
import { RuntimeError, assert, isPlainObject } from './util.mjs';

export class ContractError extends RuntimeError {
  constructor(schema, issues) {
    super('CONTRACT_INVALID', `${schema} failed validation`, { schema, issues });
    this.name = 'ContractError';
    this.issues = issues;
  }
}

function requiredObject(value, path, issues) {
  if (!isPlainObject(value)) issues.push(`${path} must be an object`);
  return isPlainObject(value);
}

function requiredString(value, path, issues, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    issues.push(`${path} must be a string of ${min}-${max} characters`);
    return false;
  }
  return true;
}

function enumValue(value, allowed, path, issues) {
  if (!allowed.includes(value)) issues.push(`${path} must be one of ${allowed.join(', ')}`);
}

function schemaHeader(value, schema, issues) {
  if (!requiredObject(value, '$', issues)) return;
  if (value.schema !== schema) issues.push(`$.schema must equal ${schema}`);
  if (value.schema_version !== 1) issues.push('$.schema_version must equal 1');
}

function isoDate(value, path, issues) {
  if (!requiredString(value, path, issues) || Number.isNaN(Date.parse(value))) {
    issues.push(`${path} must be an ISO-8601 timestamp`);
  }
}

function noUnknownKeys(value, allowed, path, issues) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

export function validateEvidenceReference(value, index = 0) {
  const issues = [];
  const p = `$.evidence_manifest[${index}]`;
  if (requiredObject(value, p, issues)) {
    noUnknownKeys(value, [
      'schema', 'schema_version', 'id', 'source_type', 'uri', 'content_hash', 'retrieved_at', 'liveness_state',
      'trust_class', 'expires_at', 'structured_fields', 'spans',
    ], p, issues);
    if (value.schema !== 'EvidenceReferenceV1' || value.schema_version !== 1) issues.push(`${p} must identify EvidenceReferenceV1 version 1`);
    requiredString(value.id, `${p}.id`, issues, { max: 128 });
    requiredString(value.source_type, `${p}.source_type`, issues, { max: 128 });
    if (requiredString(value.uri, `${p}.uri`, issues, { max: 4096 })) {
      try { new URL(value.uri); } catch { issues.push(`${p}.uri must be an absolute URL`); }
    }
    if (!/^[a-f0-9]{64}$/.test(value.content_hash ?? '')) issues.push(`${p}.content_hash must be a SHA-256 hex digest`);
    isoDate(value.retrieved_at, `${p}.retrieved_at`, issues);
    enumValue(value.liveness_state, TRI_STATES, `${p}.liveness_state`, issues);
    enumValue(value.trust_class, TRUST_CLASSES, `${p}.trust_class`, issues);
    if (value.trust_class === 'trusted_control') issues.push(`${p}.trust_class cannot elevate evidence to trusted_control`);
    if (value.expires_at !== undefined) isoDate(value.expires_at, `${p}.expires_at`, issues);
  }
  return issues;
}

export function assertTaskEnvelope(value) {
  const issues = [];
  schemaHeader(value, 'TaskEnvelopeV1', issues);
  if (isPlainObject(value)) {
    noUnknownKeys(value, [
      'schema', 'schema_version', 'task_id', 'created_at', 'task_class', 'risk',
      'minimum_capability_class', 'required_capabilities', 'rules', 'subject',
      'evidence_manifest', 'expected_output', 'context_hashes', 'idempotency_key',
    ], '$', issues);
    requiredString(value.task_id, '$.task_id', issues, { max: 160 });
    isoDate(value.created_at, '$.created_at', issues);
    requiredString(value.task_class, '$.task_class', issues, { max: 128 });
    enumValue(value.risk, ['LOW', 'MEDIUM', 'HIGH', 'CONSEQUENTIAL'], '$.risk', issues);
    enumValue(value.minimum_capability_class, CAPABILITY_CLASSES, '$.minimum_capability_class', issues);
    if (!Array.isArray(value.required_capabilities) || value.required_capabilities.some(v => typeof v !== 'string')) {
      issues.push('$.required_capabilities must be a string array');
    }
    requiredObject(value.rules, '$.rules', issues);
    if (requiredObject(value.subject, '$.subject', issues)) {
      noUnknownKeys(value.subject, ['company', 'role', 'url', 'resume', 'source'], '$.subject', issues);
      requiredString(value.subject.company, '$.subject.company', issues, { max: 256 });
      requiredString(value.subject.role, '$.subject.role', issues, { max: 512 });
      if (requiredString(value.subject.url, '$.subject.url', issues, { max: 4096 })) {
        try {
          const url = new URL(value.subject.url);
          if (url.protocol !== 'https:') issues.push('$.subject.url must use HTTPS');
        } catch { issues.push('$.subject.url must be an absolute URL'); }
      }
      if (!['SDE', 'MLE'].includes(value.subject.resume)) issues.push('$.subject.resume must be SDE or MLE');
      requiredString(value.subject.source, '$.subject.source', issues, { max: 128 });
    }
    if (!Array.isArray(value.evidence_manifest) || value.evidence_manifest.length === 0) {
      issues.push('$.evidence_manifest must contain at least one evidence reference');
    } else {
      value.evidence_manifest.forEach((item, index) => issues.push(...validateEvidenceReference(item, index)));
      const ids = value.evidence_manifest.map(item => item?.id);
      if (new Set(ids).size !== ids.length) issues.push('$.evidence_manifest ids must be unique');
    }
    requiredObject(value.expected_output, '$.expected_output', issues);
    requiredObject(value.context_hashes, '$.context_hashes', issues);
    requiredString(value.idempotency_key, '$.idempotency_key', issues, { max: 256 });
  }
  if (issues.length) throw new ContractError('TaskEnvelopeV1', [...new Set(issues)]);
  return value;
}

export function assertRawProviderResult(value) {
  const issues = [];
  schemaHeader(value, 'RawProviderResultV1', issues);
  if (isPlainObject(value)) {
    requiredString(value.task_id, '$.task_id', issues, { max: 160 });
    requiredObject(value.provider_snapshot, '$.provider_snapshot', issues);
    if (typeof value.response !== 'string' && !isPlainObject(value.response)) {
      issues.push('$.response must be a string or object');
    }
    requiredObject(value.usage, '$.usage', issues);
    if (!Number.isFinite(value.latency_ms) || value.latency_ms < 0) issues.push('$.latency_ms must be a non-negative number');
    if (!Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > 2) issues.push('$.attempts must be 1 or 2');
    if (typeof value.capability_degradation !== 'boolean') issues.push('$.capability_degradation must be boolean');
  }
  if (issues.length) throw new ContractError('RawProviderResultV1', [...new Set(issues)]);
  return value;
}

export function assertNormalizedEvaluation(value) {
  const issues = [];
  schemaHeader(value, 'NormalizedEvaluationV1', issues);
  if (isPlainObject(value)) {
    requiredString(value.task_id, '$.task_id', issues, { max: 160 });
    if (requiredObject(value.decision_inputs, '$.decision_inputs', issues)) {
      requiredObject(value.decision_inputs.gates, '$.decision_inputs.gates', issues);
      for (const gate of GATES) {
        const item = value.decision_inputs.gates?.[gate];
        if (requiredObject(item, `$.decision_inputs.gates.${gate}`, issues)) {
          enumValue(item.value, TRI_STATES, `$.decision_inputs.gates.${gate}.value`, issues);
          if (!Array.isArray(item.evidence_refs)) issues.push(`$.decision_inputs.gates.${gate}.evidence_refs must be an array`);
        }
      }
      const score = value.decision_inputs.score;
      if (score !== null && (!Number.isFinite(score) || score < 0 || score > 5)) issues.push('$.decision_inputs.score must be null or 0-5');
      enumValue(value.decision_inputs.recommendation, RECOMMENDATIONS, '$.decision_inputs.recommendation', issues);
      if (!Number.isFinite(value.decision_inputs.confidence) || value.decision_inputs.confidence < 0 || value.decision_inputs.confidence > 1) {
        issues.push('$.decision_inputs.confidence must be 0-1');
      }
    }
    if (requiredObject(value.presentation_content, '$.presentation_content', issues)) {
      for (const block of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        if (typeof value.presentation_content[block] !== 'string') issues.push(`$.presentation_content.${block} must be a string`);
      }
    }
    if (!Array.isArray(value.unknowns) || !Array.isArray(value.validation_warnings)) {
      issues.push('$.unknowns and $.validation_warnings must be arrays');
    }
  }
  if (issues.length) throw new ContractError('NormalizedEvaluationV1', [...new Set(issues)]);
  return value;
}

export function assertPolicyDecision(value) {
  const issues = [];
  schemaHeader(value, 'PolicyDecisionV1', issues);
  if (isPlainObject(value)) {
    requiredString(value.task_id, '$.task_id', issues, { max: 160 });
    enumValue(value.decision, [...RECOMMENDATIONS, 'DEFERRED'], '$.decision', issues);
    requiredObject(value.gate_resolution, '$.gate_resolution', issues);
    if (!Array.isArray(value.authorized_writes)) issues.push('$.authorized_writes must be an array');
    if (typeof value.review_required !== 'boolean') issues.push('$.review_required must be boolean');
    requiredString(value.policy_version, '$.policy_version', issues, { max: 128 });
    if (!/^[a-f0-9]{64}$/.test(value.policy_hash ?? '')) issues.push('$.policy_hash must be a SHA-256 digest');
    if (!/^[a-f0-9]{64}$/.test(value.decision_hash ?? '')) issues.push('$.decision_hash must be a SHA-256 digest');
  }
  if (issues.length) throw new ContractError('PolicyDecisionV1', [...new Set(issues)]);
  return value;
}

export function assertMinimumCapability(required, actual) {
  assert(CAPABILITY_CLASSES.includes(required), 'CAPABILITY_CLASS_INVALID', `Unknown required capability class: ${required}`);
  assert(CAPABILITY_CLASSES.includes(actual), 'CAPABILITY_CLASS_INVALID', `Unknown actual capability class: ${actual}`);
}
