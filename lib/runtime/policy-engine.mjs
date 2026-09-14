import { AUTHORIZED_WRITES, GATES, POLICY_VERSION, UNKNOWN_ACTIONS } from './constants.mjs';
import { assertNormalizedEvaluation, assertPolicyDecision, assertTaskEnvelope } from './contracts.mjs';
import { canonicalJson, deepFreeze, isoNow, record, sha256 } from './util.mjs';

/**
 * Single source of truth for evaluation write authorization.
 * Precedence (first matching terminal outcome wins for hard gates):
 *   1. posting_live NO → DEFERRED (no writes)
 *   2. citizenship / geography / sponsorship hard rejects → DO_NOT_APPLY
 *   3. required_evidence_complete missing → REVIEW_REQUIRED (never weakens step 2)
 *   4. consequential UNKNOWN on APPLY → CONSIDER
 *   5. missing score → REVIEW_REQUIRED (never weakens step 2)
 */
const GATE_REASONS = deepFreeze({
  posting_live: {
    NO: {
      code: 'POSTING_NOT_LIVE',
      detail: 'A closed posting is not committed by the evaluation runtime',
    },
  },
  citizenship_restricted: {
    YES: {
      code: 'CITIZENSHIP_RESTRICTED',
      detail: 'The role has a consequential citizenship restriction',
    },
  },
  geography_eligible: {
    NO: {
      code: 'GEOGRAPHY_INELIGIBLE',
      detail: 'The role is outside eligible geography',
    },
  },
  sponsorship_compatible: {
    NO: {
      code: 'SPONSORSHIP_INCOMPATIBLE',
      detail: 'The role is incompatible with required sponsorship',
    },
  },
  required_evidence_complete: {
    NO: {
      code: 'REQUIRED_EVIDENCE_INCOMPLETE',
      detail: 'A final score is not authorized without required evidence',
    },
    UNKNOWN: {
      code: 'REQUIRED_EVIDENCE_INCOMPLETE',
      detail: 'A final score is not authorized without required evidence',
    },
  },
});

const POLICY_DEFINITION = deepFreeze({
  policy_version: POLICY_VERSION,
  unknown_actions: UNKNOWN_ACTIONS,
  authorization: {
    provider_may_authorize: false,
    renderer_may_authorize: false,
    review_reports_use_existing_tracker_schema: true,
    authorized_writes: AUTHORIZED_WRITES,
  },
  // Ordered application of hard_gates outcomes. Later steps cannot weaken
  // DO_NOT_APPLY or DEFERRED once set.
  gate_precedence: [
    'posting_live',
    'citizenship_restricted',
    'geography_eligible',
    'sponsorship_compatible',
    'required_evidence_complete',
  ],
  hard_gates: {
    posting_live: { NO: 'DEFERRED' },
    citizenship_restricted: { YES: 'DO_NOT_APPLY' },
    geography_eligible: { NO: 'DO_NOT_APPLY' },
    sponsorship_compatible: { NO: 'DO_NOT_APPLY' },
    required_evidence_complete: { NO: 'REVIEW_REQUIRED', UNKNOWN: 'REVIEW_REQUIRED' },
  },
  hard_rejection_codes: [
    'CITIZENSHIP_RESTRICTED',
    'GEOGRAPHY_INELIGIBLE',
    'SPONSORSHIP_INCOMPATIBLE',
  ],
  consequential_unknown_gates: [
    'citizenship_restricted',
    'geography_eligible',
    'sponsorship_compatible',
  ],
  gate_reasons: GATE_REASONS,
});

export const POLICY_HASH = sha256(POLICY_DEFINITION);

function addReason(reasons, code, gate, detail) {
  reasons.push({ code, gate, detail });
}

function isHardRejection(reasons) {
  return reasons.some(reason => POLICY_DEFINITION.hard_rejection_codes.includes(reason.code));
}

export function decide(task, normalized, { now = isoNow() } = {}) {
  assertTaskEnvelope(task);
  assertNormalizedEvaluation(normalized);
  if (task.task_id !== normalized.task_id) throw new Error('Task and normalized evaluation IDs differ');
  const gates = normalized.decision_inputs.gates;
  const reasons = [];
  let decision = normalized.decision_inputs.recommendation;
  let score = normalized.decision_inputs.score;

  for (const gate of POLICY_DEFINITION.gate_precedence) {
    const value = gates[gate].value;
    const outcome = POLICY_DEFINITION.hard_gates[gate]?.[value];
    if (!outcome) continue;
    const reason = POLICY_DEFINITION.gate_reasons[gate]?.[value];
    if (!reason) throw new Error(`Missing policy reason for ${gate}=${value}`);

    if (outcome === 'DEFERRED') {
      decision = 'DEFERRED';
      addReason(reasons, reason.code, gate, reason.detail);
      break;
    }
    if (decision === 'DEFERRED') break;

    if (outcome === 'DO_NOT_APPLY') {
      decision = 'DO_NOT_APPLY';
      addReason(reasons, reason.code, gate, reason.detail);
      continue;
    }

    if (outcome === 'REVIEW_REQUIRED') {
      // Incomplete evidence withholds a final score but must not weaken a
      // deterministic hard rejection already established above.
      score = null;
      if (decision === 'DO_NOT_APPLY' || isHardRejection(reasons)) continue;
      decision = 'REVIEW_REQUIRED';
      addReason(reasons, reason.code, gate, reason.detail);
    }
  }

  const consequentialUnknowns = POLICY_DEFINITION.consequential_unknown_gates
    .filter(gate => gates[gate].value === 'UNKNOWN');
  if (decision === 'APPLY' && consequentialUnknowns.length) decision = 'CONSIDER';
  for (const gate of consequentialUnknowns) {
    addReason(reasons, 'CONSEQUENTIAL_GATE_UNKNOWN', gate, `Unresolved ${gate} downgraded APPLY to CONSIDER`);
  }
  if (gates.posting_live.value === 'UNKNOWN') {
    addReason(reasons, 'LIVENESS_UNCERTAIN', 'posting_live', 'Preserve the existing LIVENESS-UNCERTAIN behavior');
  }

  const hardRejection = isHardRejection(reasons);
  if (score === null && decision !== 'DEFERRED' && decision !== 'REVIEW_REQUIRED' && !hardRejection) {
    decision = 'REVIEW_REQUIRED';
    addReason(reasons, 'SCORE_MISSING', 'required_evidence_complete', 'A missing score requires review');
  }

  const reviewGates = [...new Set(reasons
    .filter(reason => ['CONSEQUENTIAL_GATE_UNKNOWN', 'REQUIRED_EVIDENCE_INCOMPLETE', 'LIVENESS_UNCERTAIN'].includes(reason.code))
    .map(reason => reason.gate))];
  const reviewRequired = decision === 'REVIEW_REQUIRED' || reviewGates.length > 0;
  const authorizedWrites = decision === 'DEFERRED' ? [] : [...AUTHORIZED_WRITES];
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
    policy_version: POLICY_DEFINITION.policy_version,
    policy_hash: POLICY_HASH,
  });
  const immutable = { ...body, decision_hash: sha256(canonicalJson(body)) };
  assertPolicyDecision(immutable);
  return deepFreeze(immutable);
}

export function verifyPolicyDecision(decision) {
  try {
    assertPolicyDecision(decision);
  } catch {
    return false;
  }
  const { decision_hash: observed, ...body } = decision;
  return observed === sha256(canonicalJson(body)) && decision.policy_hash === POLICY_HASH;
}
