import { prepareTask } from '../lib/runtime/prepare.mjs';

export const NOW = '2026-09-05T16:00:00.000Z';

export function makeTask(overrides = {}) {
  const structuredFields = {
    citizenship_restricted: 'NO',
    geography_eligible: 'YES',
    sponsorship_compatible: 'YES',
    required_evidence_complete: 'YES',
    ...(overrides.structured_fields || {}),
  };
  return prepareTask({
    company: 'Example Systems',
    role: 'Software Engineer, New Grad',
    url: 'https://jobs.example.com/roles/123',
    resume: 'SDE',
    source: 'greenhouse',
    evidence: [{
      id: 'EV-1',
      source_type: 'greenhouse',
      uri: 'https://jobs.example.com/roles/123',
      content: 'Validated job posting evidence.',
      retrieved_at: NOW,
      expires_at: '2027-01-01T00:00:00.000Z',
      liveness_state: overrides.posting_live || 'YES',
      structured_fields: structuredFields,
    }],
    rules: overrides.rules,
    minimum_capability_class: overrides.minimum_capability_class,
    idempotency_key: overrides.idempotency_key,
  }, { now: NOW, taskId: overrides.task_id || 'task-fixture-1' });
}

function gateRef(gate) {
  return [{ evidence_id: 'EV-1', field: gate === 'posting_live' ? 'liveness_state' : gate }];
}

export function makeResponse(overrides = {}) {
  const values = {
    posting_live: 'YES',
    citizenship_restricted: 'NO',
    geography_eligible: 'YES',
    sponsorship_compatible: 'YES',
    required_evidence_complete: 'YES',
    ...(overrides.gates || {}),
  };
  return {
    decision_inputs: {
      gates: Object.fromEntries(Object.entries(values).map(([gate, value]) => [gate, {
        value,
        evidence_refs: value === 'UNKNOWN' ? [] : gateRef(gate),
      }])),
      score: overrides.score === undefined ? 4.4 : overrides.score,
      recommendation: overrides.recommendation || 'APPLY',
      confidence: overrides.confidence === undefined ? 0.94 : overrides.confidence,
      ...(overrides.extra_decision_inputs || {}),
    },
    presentation_content: {
      A: 'A new graduate software engineering role building production services.',
      B: 'The resume evidence matches backend systems and testing requirements.',
      C: 'The stated level aligns with an entry-level candidate.',
      D: 'Compensation evidence was not provided, so compensation remains unknown.',
      E: 'Lead with production service ownership and measurable reliability work.',
      F: 'Prepare system design, coding, testing, and behavioral examples.',
      G: 'The validated source states that the posting is active.',
      ...(overrides.presentation || {}),
    },
    ...(overrides.extra || {}),
  };
}
