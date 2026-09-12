import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { persistencePaths } from '../runtime/transaction.mjs';
import { canonicalJson, isoNow, newId, record } from '../runtime/util.mjs';
import { assertAttempt, attemptKey, TERMINAL_ATTEMPT_STATES } from './contracts.mjs';

function appDir(target) { return join(persistencePaths(target).runtimeDir, 'applications'); }
function statePath(target) { return join(appDir(target), 'attempts.json'); }
function eventPath(target) { return join(appDir(target), 'events.jsonl'); }
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function read(target) {
  const path = statePath(target);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 'ApplicationAttemptStoreV1', attempts: {} };
}
function append(target, event) {
  mkdirSync(appDir(target), { recursive: true, mode: 0o700 });
  writeFileSync(eventPath(target), `${canonicalJson(event)}\n`, { flag: 'a', mode: 0o600 });
}

export function listAttempts(target) { return Object.values(read(target).attempts); }
export function getAttempt(target, key) { return read(target).attempts[key] || null; }

export function queueAttempt(target, { tracker_number, canonical_url, report_id = '', ats = 'unknown', resume_kind = '', role = '', company = '', selection_override = null }) {
  const key = attemptKey(tracker_number, canonical_url);
  const store = read(target);
  const existing = store.attempts[key];
  if (existing) return { attempt: existing, created: false };
  const attempt = record('ApplicationAttemptV1', {
    schema_version: 1,
    attempt_id: newId('application'),
    idempotency_key: key,
    tracker_number: Number(tracker_number), role, company,
    report_id,
    canonical_url,
    ats,
    resume_kind,
    ...(selection_override ? { selection_override: { ...selection_override, authorized_at: selection_override.authorized_at || isoNow() } } : {}),
    state: 'QUEUED',
    step: 0,
    answers: [], blockers: [], provider_usage: [], artifacts: [], submission_evidence: null,
    created_at: isoNow(), updated_at: isoNow(),
  });
  store.attempts[key] = attempt;
  atomic(statePath(target), store);
  append(target, record('ApplicationEventV1', {
    attempt_id: attempt.attempt_id, idempotency_key: key, type: 'QUEUED', at: isoNow(),
    ...(attempt.selection_override ? { selection_override: attempt.selection_override } : {}),
  }));
  return { attempt, created: true };
}

export function transitionAttempt(target, key, state, patch = {}) {
  const store = read(target);
  const current = store.attempts[key];
  if (!current) throw new Error(`Unknown application attempt: ${key}`);
  assertAttempt(current);
  if (TERMINAL_ATTEMPT_STATES.has(current.state) && current.state !== state) {
    throw new Error(`Refusing to retry terminal attempt ${current.state}`);
  }
  const next = { ...current, ...patch, state, updated_at: isoNow() };
  assertAttempt(next);
  store.attempts[key] = next;
  atomic(statePath(target), store);
  append(target, record('ApplicationEventV1', {
    attempt_id: next.attempt_id, idempotency_key: key, from: current.state, type: state,
    at: next.updated_at, blockers: next.blockers || [],
  }));
  return next;
}

/** An explicit visible ATS rejection may correct an earlier network-only
 * success classification. This is a one-way audit correction, not a retry. */
export function correctFalseSubmission(target, key, { blocker, evidence, artifacts = [] }) {
  const store = read(target);
  const current = store.attempts[key];
  if (!current) throw new Error(`Unknown application attempt: ${key}`);
  assertAttempt(current);
  if (current.state !== 'SUBMITTED' || current.submission_evidence?.confirmation !== 'adapter-network-response') {
    throw new Error('Only a network-only submitted attempt may be corrected after an explicit portal rejection');
  }
  const next = {
    ...current,
    state: 'NEEDS_REVIEW',
    blockers: [blocker],
    submission_evidence: { ...current.submission_evidence, correction: evidence },
    artifacts: [...new Set([...(current.artifacts || []), ...artifacts])],
    updated_at: isoNow(),
  };
  assertAttempt(next);
  store.attempts[key] = next;
  atomic(statePath(target), store);
  append(target, record('ApplicationEventV1', {
    attempt_id: next.attempt_id, idempotency_key: key, from: current.state,
    type: 'SUBMISSION_REJECTED_CORRECTION', at: next.updated_at, blockers: next.blockers,
  }));
  return next;
}

/** Reopen an uncertain attempt only after the candidate explicitly confirms
 * that no application was created. This is the sole safe exception to the
 * terminal-unknown retry rule, and the confirmation remains in the audit log. */
export function confirmUnknownNotSubmitted(target, key, { confirmedAt = isoNow() } = {}) {
  const store = read(target);
  const current = store.attempts[key];
  if (!current) throw new Error(`Unknown application attempt: ${key}`);
  assertAttempt(current);
  if (current.state !== 'SUBMISSION_UNKNOWN') {
    throw new Error('Candidate non-submission confirmation requires SUBMISSION_UNKNOWN');
  }
  const next = {
    ...current,
    state: 'NEEDS_REVIEW',
    blockers: [{ code: 'SUBMISSION_UNCLEAR', detail: 'Candidate confirmed the prior attempt did not create an application.' }],
    submission_evidence: {
      ...(current.submission_evidence || {}),
      candidate_confirmed_not_submitted_at: confirmedAt,
    },
    updated_at: isoNow(),
  };
  assertAttempt(next);
  store.attempts[key] = next;
  atomic(statePath(target), store);
  append(target, record('ApplicationEventV1', {
    attempt_id: next.attempt_id,
    idempotency_key: key,
    from: current.state,
    type: 'CANDIDATE_CONFIRMED_NOT_SUBMITTED',
    at: next.updated_at,
    blockers: next.blockers,
  }));
  return next;
}
