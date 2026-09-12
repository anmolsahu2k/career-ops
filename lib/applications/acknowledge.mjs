import { getAttempt, listAttempts, transitionAttempt } from './store.mjs';
import { markApplied } from './tracker.mjs';

/** Reconcile a submission the candidate confirms they completed outside the
 * runner. This is intentionally explicit: uncertain runner outcomes remain
 * non-retryable and cannot be acknowledged into a tracker write. */
export async function acknowledgeManualSubmission(target, trackerNumber, { timeZone } = {}) {
  const matches = listAttempts(target).filter(item => item.tracker_number === Number(trackerNumber));
  if (matches.length !== 1) throw new Error(`Expected one application attempt for tracker row ${trackerNumber}`);
  const attempt = getAttempt(target, matches[0].idempotency_key);
  if (!attempt) throw new Error(`Application attempt for tracker row ${trackerNumber} is missing`);
  if (attempt.state === 'SUBMISSION_UNKNOWN') throw new Error('Refusing to acknowledge an uncertain submission outcome');
  if (attempt.state === 'SKIPPED') throw new Error('Refusing to acknowledge a skipped attempt');
  if (attempt.state === 'SUBMITTED') return { attempt, tracker_changed: false, already_acknowledged: true };

  const tracker = await markApplied(target, attempt.tracker_number, attempt.attempt_id, new Date(), timeZone);
  const next = transitionAttempt(target, attempt.idempotency_key, 'SUBMITTED', {
    blockers: [],
    submission_evidence: {
      confirmation: 'candidate-confirmed-manual-submission',
      observed_at: new Date().toISOString(),
    },
  });
  return { attempt: next, tracker_changed: tracker.changed, already_acknowledged: false };
}
