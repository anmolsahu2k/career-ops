export const SCHEMA_VERSION = 1;

export const TRI_STATES = Object.freeze(['YES', 'NO', 'UNKNOWN']);
export const GATES = Object.freeze([
  'posting_live',
  'citizenship_restricted',
  'geography_eligible',
  'sponsorship_compatible',
  'required_evidence_complete',
]);

export const CAPABILITY_CLASSES = Object.freeze([
  'DETERMINISTIC',
  'EXTRACTION',
  'STANDARD',
  'CONSEQUENTIAL',
  'INDEPENDENT_AUDIT',
]);

export const CAPABILITY_RANK = Object.freeze(
  Object.fromEntries(CAPABILITY_CLASSES.map((name, index) => [name, index])),
);

export const TRUST_CLASSES = Object.freeze([
  'trusted_control',
  'trusted_evidence',
  'untrusted_external_evidence',
  'untrusted_model_output',
]);

export const RECOMMENDATIONS = Object.freeze([
  'APPLY',
  'CONSIDER',
  'DO_NOT_APPLY',
  'REVIEW_REQUIRED',
]);

export const POLICY_VERSION = 'career-ops-policy-v1';

// These rules are code-owned. Runtime configuration may add stricter rules,
// but it cannot replace or weaken this table.
export const UNKNOWN_ACTIONS = Object.freeze({
  posting_live: 'PRESERVE_LIVENESS_UNCERTAIN',
  citizenship_restricted: 'DOWNGRADE_TO_CONSIDER',
  geography_eligible: 'DOWNGRADE_TO_CONSIDER',
  sponsorship_compatible: 'DOWNGRADE_TO_CONSIDER',
  required_evidence_complete: 'REVIEW_REQUIRED_NO_SCORE',
});

export const DEFAULT_SANITIZER_LIMITS = Object.freeze({
  raw_response_bytes: 256 * 1024,
  maximum_depth: 24,
  field_characters: 8_000,
  collection_characters: 36_000,
  quotation_characters: 800,
});

export const DEFAULT_TRANSACTION_TIMING = Object.freeze({
  heartbeat_ms: 5_000,
  lease_ms: 60_000,
});

export const TRACKER_HEADER = [
  '# Applications',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '',
].join('\n');

export const NO_PROVIDER_REASONS = Object.freeze([
  'NO_CAPABILITY',
  'QUALITY_FLOOR_UNMET',
  'QUOTA_UNAVAILABLE',
  'RISK_TOO_HIGH',
  'PROVIDER_UNAVAILABLE',
  'AUDIT_INDEPENDENCE_UNAVAILABLE',
  'OBSERVATION_EXPIRED',
]);
