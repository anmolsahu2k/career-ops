/** Fail-closed application-attempt contract.  Kept outside the tracker so the
 * public nine-column tracker remains the source of application status only. */
export const ATTEMPT_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'WAITING_LOGIN', 'NEEDS_REVIEW', 'READY_TO_SUBMIT',
  'SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNKNOWN', 'SKIPPED', 'FAILED',
]);

export const TERMINAL_ATTEMPT_STATES = new Set([
  // Failed attempts may be explicitly retried after a local repair. Submission
  // outcomes never can: an unknown confirmation may already be a submission.
  'SUBMITTED', 'SUBMISSION_UNKNOWN', 'SKIPPED',
]);

export const REVIEW_BLOCKERS = Object.freeze([
  'LOGIN_REQUIRED', 'MFA_REQUIRED', 'CAPTCHA', 'ACCOUNT_CREATION',
  'UNSUPPORTED_CONTROL', 'AMBIGUOUS_ANSWER', 'SALARY_QUESTION',
  'ASSESSMENT', 'TAKE_HOME', 'AI_PROHIBITION', 'SENSITIVE_QUESTION',
  'CERTIFICATION_CHANGED', 'VALIDATION_ERROR', 'SUBMISSION_UNCLEAR',
  'OPTIONAL_CONSENT',
  'SUBMISSION_REJECTED',
  'NO_QUALIFIED_PROVIDER', 'QUOTA_UNAVAILABLE', 'UNSUPPORTED_PORTAL',
  'LIVENESS_UNCERTAIN', 'LIVENESS_EXPIRED', 'RESUME_MISMATCH', 'TRACKER_CHANGED',
  'MISSING_APPLY_TOKEN',
]);

export function assertAttempt(value) {
  if (!value || value.schema !== 'ApplicationAttemptV1') throw new Error('Expected ApplicationAttemptV1');
  if (!ATTEMPT_STATES.includes(value.state)) throw new Error(`Invalid application attempt state: ${value.state}`);
  if (!value.idempotency_key || !value.tracker_number || !value.canonical_url) {
    throw new Error('Application attempt needs idempotency_key, tracker_number, and canonical_url');
  }
  if (value.selection_override && (
    value.selection_override.reason !== 'USER_SELECTION_OVERRIDE'
    || typeof value.selection_override.authorized_at !== 'string'
  )) {
    throw new Error('Invalid application selection override');
  }
  return value;
}

export function safeCanonicalUrl(value) {
  const url = new URL(value);
  url.hash = '';
  // Tracking parameters must never make a second attempt look like a new job.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|source$|ref$|gh_src$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function attemptKey(trackerNumber, canonicalUrl) {
  return `${Number(trackerNumber)}:${safeCanonicalUrl(canonicalUrl)}`;
}
