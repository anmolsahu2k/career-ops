import { GATES, POLICY_VERSION, UNKNOWN_ACTIONS } from './constants.mjs';
import { assertNormalizedEvaluation, assertPolicyDecision, assertTaskEnvelope } from './contracts.mjs';
import { canonicalJson, deepFreeze, isoNow, record, sha256 } from './util.mjs';

const POLICY_DEFINITION = deepFreeze({
  policy_version: POLICY_VERSION,
  unknown_actions: UNKNOWN_ACTIONS,
  authorization: {
    provider_may_authorize: false,
    renderer_may_authorize: false,
    review_reports_use_existing_tracker_schema: true,
  },
  hard_gates: {
    posting_live: { NO: 'DEFERRED' },
    citizenship_restricted: { YES: 'DO_NOT_APPLY' },
    geography_eligible: { NO: 'DO_NOT_APPLY' },
    sponsorship_compatible: { NO: 'DO_NOT_APPLY' },
    required_evidence_complete: { NO: 'REVIEW_REQUIRED', UNKNOWN: 'REVIEW_REQUIRED' },
  },
});

export const POLICY_HASH = sha256(POLICY_DEFINITION);

function addReason(reasons, code, gate, detail) {
  reasons.push({ code, gate, detail });
}

export function decide(task, normalized, { now = isoNow() } = {}) {
  assertTaskEnvelope(task);
  assertNormalizedEvaluation(normalized);
  if (task.task_id !== normalized.task_id) throw new Error('Task and normalized evaluation IDs differ');
  const gates = normalized.decision_inputs.gates;
  const reasons = [];
  let decision = normalized.decision_inputs.recommendation;
  let score = normalized.decision_inputs.score;

  if (gates.posting_live.value === 'NO') {
    decision = 'DEFERRED';
    addReason(reasons, 'POSTING_NOT_LIVE', 'posting_live', 'A closed posting is not committed by the evaluation runtime');
  }
  if (decision !== 'DEFERRED' && gates.citizenship_restricted.value === 'YES') {
    decision = 'DO_NOT_APPLY';
    addReason(reasons, 'CITIZENSHIP_RESTRICTED', 'citizenship_restricted', 'The role has a consequential citizenship restriction');
  }
  if (decision !== 'DEFERRED' && gates.geography_eligible.value === 'NO') {
    decision = 'DO_NOT_APPLY';
    addReason(reasons, 'GEOGRAPHY_INELIGIBLE', 'geography_eligible', 'The role is outside eligible geography');
  }
  if (decision !== 'DEFERRED' && gates.sponsorship_compatible.value === 'NO') {
    decision = 'DO_NOT_APPLY';
    addReason(reasons, 'SPONSORSHIP_INCOMPATIBLE', 'sponsorship_compatible', 'The role is incompatible with required sponsorship');
  }

  const requiredEvidenceMissing = gates.required_evidence_complete.value !== 'YES';
  if (decision !== 'DEFERRED' && requiredEvidenceMissing) {
    decision = 'REVIEW_REQUIRED';
    score = null;
    addReason(reasons, 'REQUIRED_EVIDENCE_INCOMPLETE', 'required_evidence_complete', 'A final score is not authorized without required evidence');
  }

  const consequentialUnknowns = ['citizenship_restricted', 'geography_eligible', 'sponsorship_compatible']
    .filter(gate => gates[gate].value === 'UNKNOWN');
  if (decision === 'APPLY' && consequentialUnknowns.length) decision = 'CONSIDER';
  for (const gate of consequentialUnknowns) {
    addReason(reasons, 'CONSEQUENTIAL_GATE_UNKNOWN', gate, `Unresolved ${gate} downgraded APPLY to CONSIDER`);
  }
  if (gates.posting_live.value === 'UNKNOWN') {
    addReason(reasons, 'LIVENESS_UNCERTAIN', 'posting_live', 'Preserve the existing LIVENESS-UNCERTAIN behavior');
  }

  const hardRejection = reasons.some(reason => [
    'CITIZENSHIP_RESTRICTED',
    'GEOGRAPHY_INELIGIBLE',
    'SPONSORSHIP_INCOMPATIBLE',
  ].includes(reason.code));
  if (score === null && decision !== 'DEFERRED' && decision !== 'REVIEW_REQUIRED' && !hardRejection) {
    decision = 'REVIEW_REQUIRED';
    addReason(reasons, 'SCORE_MISSING', 'required_evidence_complete', 'A missing score requires review');
  }

  const reviewGates = [...new Set(reasons
    .filter(reason => ['CONSEQUENTIAL_GATE_UNKNOWN', 'REQUIRED_EVIDENCE_INCOMPLETE', 'LIVENESS_UNCERTAIN'].includes(reason.code))
    .map(reason => reason.gate))];
  const reviewRequired = decision === 'REVIEW_REQUIRED' || reviewGates.length > 0;
  const authorizedWrites = decision === 'DEFERRED' ? [] : ['decision', 'report', 'tracker', 'receipt'];
  const trackerStatus = decision === 'DO_NOT_APPLY' ? 'Rejected-at-eval' : 'Evaluated';
  const sponsorshipFlag = gates.sponsorship_compatible.value === 'YES'
    ? 'Y'
    : gates.sponsorship_compatible.value === 'NO' ? 'N' : 'Unknown';

  const body = record('PolicyDecisionV1', {
    task_id: task.task_id,
    decided_at: now,
    decision,
    score,
    tracker_status: trackerStatus,
    sponsorship_flag: sponsorshipFlag,
    gate_resolution: Object.fromEntries(GATES.map(gate => [gate, {
      value: gates[gate].value,
      unknown_action: UNKNOWN_ACTIONS[gate],
      evidence_refs: gates[gate].evidence_refs,
    }])),
    authorized_writes: authorizedWrites,
    uncertainty_handling: {
      enrichment_passes: normalized.enrichment_passes,
      unresolved_gates: normalized.unknowns,
      review_gates: reviewGates,
    },
    review_required: reviewRequired,
    reasons,
    policy_version: POLICY_VERSION,
    policy_hash: POLICY_HASH,
  });
  const immutable = { ...body, decision_hash: sha256(canonicalJson(body)) };
  assertPolicyDecision(immutable);
  return deepFreeze(immutable);
}

export function verifyPolicyDecision(decision) {
  assertPolicyDecision(decision);
  const { decision_hash: observed, ...body } = decision;
  return observed === sha256(canonicalJson(body)) && decision.policy_hash === POLICY_HASH;
}
