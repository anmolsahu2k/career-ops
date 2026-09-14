import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attemptKey, safeCanonicalUrl } from '../lib/applications/contracts.mjs';
import { candidateForTrackerNumber, eligibleRows } from '../lib/applications/eligibility.mjs';
import { queueAttempt, transitionAttempt, correctFalseSubmission, confirmUnknownNotSubmitted, getAttempt } from '../lib/applications/store.mjs';
import { approvedAnswer, authenticationBlocker, enabledAts, enqueueEligible, enqueuedAttemptKeys, enqueueSelectionOverride, exactAttemptKeys, exactSinglePageFinal, otpDomains, requiresEmailVerification, retryApplication, revealGreenhouseCoverLetter, selectableAttempts, selectionOverrideStillValid, stageMfaCode } from '../lib/applications/runner.mjs';
import { submissionGate } from '../lib/applications/policy.mjs';
import { validateGeneratedAnswers, validateSalaryAnswers, salaryQuestionKind, salaryTask, hostedFallbackProviderIds, answerTask, generateBoundedAnswers, localProseProviderConfig, normalizeCandidateProse } from '../lib/applications/answers.mjs';
import { applicationVoiceProfile } from '../lib/applications/voice.mjs';
import { acknowledgeManualSubmission } from '../lib/applications/acknowledge.mjs';
import { serveApplyBoard } from '../lib/applications/board.mjs';
import { cleanupApplicationArtifacts } from '../lib/applications/retention.mjs';
import { calendarDate, markApplied, recordAppliedArtifacts, revertFalseApplied } from '../lib/applications/tracker.mjs';
import { buildApplicationProseCases, runLocalApplicationProseQualification } from '../lib/applications/local-prose-qualification.mjs';
import { loadRuntimeConfig } from '../lib/runtime/config.mjs';

function target() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-apply-'));
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'reports', 'company'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), [
    '# Applications', '', '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-09-09 | Company | Engineer | 4.5/5 | Evaluated | — | [001](reports/company/001.md) | APPLY |',
    '| 2 | 2026-09-09 | Company | Other | 3.9/5 | Evaluated | — | [002](reports/company/002.md) | APPLY |', '',
  ].join('\n'));
  writeFileSync(join(root, 'reports', 'company', '001.md'), '**URL:** https://jobs.lever.co/company/1?utm_source=x\n');
  writeFileSync(join(root, 'reports', 'company', '002.md'), '**URL:** https://jobs.lever.co/company/2\n');
  return root;
}

test('eligible applications require evaluated, APPLY, 4.0+, and a canonical report URL', () => {
  const root = target(); const rows = eligibleRows(root);
  assert.equal(rows.length, 1); assert.equal(rows[0].row.num, 1);
  assert.equal(rows[0].canonical_url, 'https://jobs.lever.co/company/1');
});

test('application selection prefers the canonical report URL over punctuated tracker prose', () => {
  const root = target();
  const tracker = join(root, 'data', 'applications.md');
  writeFileSync(tracker, readFileSync(tracker, 'utf8').replace(
    '| APPLY |',
    '| APPLY. URL: https://jobs.lever.co/company/wrong. |',
  ));
  assert.equal(candidateForTrackerNumber(root, 1).canonical_url, 'https://jobs.lever.co/company/1');
});

test('approved restricted-country answer survives equivalent Greenhouse wording', () => {
  const answers = {
    'citizen or resident of cuba iran north korea syria or crimea region of ukraine': {
      key: 'citizen or resident of cuba iran north korea syria or crimea region of ukraine',
      answer: 'No',
    },
  };
  assert.equal(approvedAnswer(
    'Please indicate whether you are either a citizen or resident of any of the following countries: Cuba, Iran, North Korea, Syria or Crimea Region of Ukraine.',
    answers,
  ), 'No');
});

test('the active ATS list is enforced separately from the extension capability list', () => {
  assert.deepEqual([...enabledAts({ applications: { supported_ats: ['greenhouse', 'ashby', 'lever', 'workday', 'not-a-board'] } })], ['greenhouse', 'ashby', 'lever', 'workday']);
  assert.deepEqual([...enabledAts({ applications: { supported_ats: ['greenhouse', 'ashby', 'lever'] } })], ['greenhouse', 'ashby', 'lever']);
  assert.deepEqual([...enabledAts({ applications: {} })], []);
});

test('a deferred ATS cannot reach browser navigation even if it is already queued', () => {
  const queued = [
    { idempotency_key: 'greenhouse', ats: 'greenhouse', state: 'QUEUED' },
    { idempotency_key: 'workday', ats: 'workday', state: 'QUEUED' },
    { idempotency_key: 'ready', ats: 'ashby', state: 'READY_TO_SUBMIT' },
  ];
  const allowed = enabledAts({ applications: { supported_ats: ['greenhouse', 'ashby', 'lever'] } });
  const keys = new Set(queued.map(item => item.idempotency_key));
  assert.deepEqual(selectableAttempts(queued, { eligibleKeys: keys, allowedAts: allowed }).map(item => item.idempotency_key), ['greenhouse']);
  assert.deepEqual(selectableAttempts(queued, { eligibleKeys: keys, allowedAts: allowed, maySubmit: true }).map(item => item.idempotency_key), ['greenhouse', 'ready']);
});

test('a Greenhouse-fed role on an uncertified application host becomes a review item, not an unselectable queue entry', async () => {
  const root = target();
  writeFileSync(join(root, 'reports', 'company', '001.md'), '**URL:** https://careers.example.test/jobs/role?gh_jid=123\n');
  const result = await enqueueEligible(root, {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.deepEqual(result.queued, []);
  assert.equal(result.blocked[0].blocker, 'UNSUPPORTED_PORTAL');
  const attempt = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://careers.example.test/jobs/role?gh_jid=123' }).attempt;
  assert.equal(attempt.state, 'NEEDS_REVIEW');
  assert.deepEqual(attempt.blockers, [{ code: 'UNSUPPORTED_PORTAL', detail: 'Application host is not a certified ATS surface' }]);
});

test('an exact-row enqueue exposes prior terminal state and cannot select another queued attempt', async () => {
  const root = target();
  const first = await enqueueEligible(root, { trackerNumbers: [1], includeCurrent: true });
  assert.equal(first.queued.length, 1);
  const attempt = first.queued[0];
  transitionAttempt(root, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', {
    submission_evidence: { confirmation: 'ambiguous-live-response' },
  });

  const repeated = await enqueueEligible(root, { trackerNumbers: [1], includeCurrent: true });
  assert.deepEqual(repeated.queued, []);
  assert.deepEqual(repeated.blocked, [{
    tracker_number: 1,
    blocker: 'EXISTING_SUBMISSION_UNKNOWN',
    attempt_id: attempt.attempt_id,
  }]);
  assert.deepEqual(enqueuedAttemptKeys(repeated), []);

  const unrelated = queueAttempt(root, {
    tracker_number: 2,
    canonical_url: 'https://jobs.lever.co/company/2',
    ats: 'lever',
  }).attempt;
  const selected = selectableAttempts([attempt, unrelated], {
    eligibleKeys: new Set([attempt.idempotency_key, unrelated.idempotency_key]),
    allowedAts: new Set(['lever']),
    selectedKeys: new Set(enqueuedAttemptKeys(repeated)),
  });
  assert.deepEqual(selected, []);
});

test('Greenhouse accepts only its official same-job canonical redirect as a final form', () => {
  const inspected = { board: 'greenhouse', navigation: { hasSubmit: true } };
  const attempt = {
    canonical_url: 'https://boards.greenhouse.io/chime/jobs/8782503002?gh_jid=8782503002',
    role: 'Software Engineer, Growth', company: 'Chime',
  };
  const identity = {
    url: 'https://job-boards.greenhouse.io/chime/jobs/8782503002?gh_jid=8782503002',
    heading: 'Software Engineer, Growth', title: 'Job Application for Software Engineer, Growth at Chime Financial, Inc', text: 'Chime Financial, Inc',
  };
  assert.equal(exactSinglePageFinal(inspected, attempt, identity), true);
  assert.equal(exactSinglePageFinal(inspected, attempt, { ...identity, url: 'https://evil.example/chime/jobs/8782503002' }), false);
  assert.equal(exactSinglePageFinal(inspected, attempt, { ...identity, url: 'https://job-boards.greenhouse.io/chime/jobs/other' }), false);
  assert.equal(exactSinglePageFinal(
    inspected,
    { ...attempt, canonical_url: 'https://notgreenhouse.io/chime/jobs/8782503002' },
    { ...identity, url: 'https://notgreenhouse.io/chime/jobs/8782503002' },
  ), false);
  const embedAttempt = {
    canonical_url: 'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8645054002',
    role: 'Sr. Forward Deployed Engineer', company: 'Databricks',
  };
  const embedIdentity = {
    url: 'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8645054002',
    heading: 'Sr. Forward Deployed Engineer',
    title: 'Job Application',
    text: 'Databricks application form',
  };
  assert.equal(exactSinglePageFinal(inspected, embedAttempt, embedIdentity), true);
});

test('Greenhouse accepts its first-party short-link only after it resolves to an official job board', () => {
  const inspected = { board: 'greenhouse', navigation: { hasSubmit: true } };
  const attempt = {
    canonical_url: 'https://grnh.se/opaque-greenhouse-short-link',
    role: 'Software Engineer', company: 'Chime',
  };
  const identity = {
    url: 'https://job-boards.greenhouse.io/chime/jobs/8782503002',
    heading: 'Software Engineer', title: 'Software Engineer | Chime', text: 'Chime Software Engineer application',
  };
  assert.equal(exactSinglePageFinal(inspected, attempt, identity), true);
  assert.equal(exactSinglePageFinal(inspected, attempt, { ...identity, url: 'https://evil.example/jobs/8782503002' }), false);
  assert.equal(exactSinglePageFinal(inspected, attempt, { ...identity, heading: 'Other role' }), false);
});

test('a post-submit verification-code page remains a resumable MFA handoff', () => {
  assert.deepEqual(authenticationBlocker({ mfa: true }), {
    state: 'WAITING_LOGIN', blockers: [{ code: 'MFA_REQUIRED' }],
  });
  assert.deepEqual(authenticationBlocker({ captcha: true }), {
    state: 'NEEDS_REVIEW', blockers: [{ code: 'CAPTCHA' }],
  });
  assert.equal(authenticationBlocker({}), null);
});

test('Greenhouse HTTP 428 enters email verification without treating unrelated responses as MFA', () => {
  const greenhouse = { ats: 'greenhouse' };
  assert.equal(requiresEmailVerification(greenhouse, [{ status: 428, url: 'https://boards.greenhouse.io/gitlab/jobs/8773006002' }]), true);
  assert.equal(requiresEmailVerification(greenhouse, [{ status: 428, url: 'https://www.recaptcha.net/reload' }]), false);
  assert.equal(requiresEmailVerification(greenhouse, [{ status: 200, url: 'https://boards.greenhouse.io/gitlab/jobs/8773006002' }]), false);
  assert.equal(requiresEmailVerification({ ats: 'lever' }, [{ status: 428, url: 'https://boards.greenhouse.io/gitlab/jobs/8773006002' }]), false);
});

test('an MFA code is staged only for the exact active attempt', () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'WAITING_LOGIN', { blockers: [{ code: 'MFA_REQUIRED' }] });
  const staged = stageMfaCode(root, 1, 'aB2cD3eF');
  assert.equal(staged.accepted, true);
  assert.equal(staged.attempt_id, attempt.attempt_id);
  assert.throws(() => stageMfaCode(root, 1, '12345678'), /EEXIST|exist/i);
  assert.throws(() => stageMfaCode(root, 2, '12345678'), /exactly one active MFA attempt/);
});

test('personal Gmail OTP reads are restricted to the current ATS sender allowlist', () => {
  const config = { applications: { gmail_otp: { enabled: true, sender_domains: { greenhouse: ['greenhouse.io', 'greenhouse-mail.io'] } } } };
  assert.deepEqual(otpDomains('greenhouse', config), ['greenhouse.io', 'greenhouse-mail.io']);
  assert.deepEqual(otpDomains('workday', config), []);
  assert.deepEqual(otpDomains('greenhouse', { applications: { gmail_otp: { sender_domains: { greenhouse: ['valid.example', '../invalid'] } } } }), ['valid.example']);
});

test('a user-selected override cannot leave an unresolved careers host QUEUED', async () => {
  const root = target();
  writeFileSync(join(root, 'reports', 'company', '002.md'), '**URL:** https://careers.example.test/jobs/role?gh_jid=999001\n');
  const queued = await enqueueSelectionOverride(root, 2, {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(queued.created, true);
  assert.equal(queued.unsupported, true);
  assert.equal(queued.blocker, 'UNSUPPORTED_PORTAL');
  assert.equal(queued.attempt.state, 'NEEDS_REVIEW');
  assert.equal(queued.attempt.ats, 'generic');
  assert.deepEqual(exactAttemptKeys(root, 2, { queued: [queued.attempt] }), []);
});

test('a greenhouse-api careers shell resolves to the official embed apply URL', async () => {
  const root = target();
  writeFileSync(
    join(root, 'data', 'applications.md'),
    [
      '# Applications', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 2 | 2026-09-09 | Databricks | Sr. Forward Deployed Engineer | 3.5/5 | Evaluated | — | [002](reports/company/002.md) | SRC: greenhouse-api |',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'reports', 'company', '002.md'), '**URL:** https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002\n');
  const queued = await enqueueSelectionOverride(root, 2, {
    fetchImpl: async (url) => {
      assert.match(url, /\/boards\/databricks\/jobs\/8645054002$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 8645054002, title: 'Sr. Forward Deployed Engineer', absolute_url: 'https://databricks.com/...' }),
      };
    },
  });
  assert.equal(queued.unsupported, false);
  assert.equal(queued.attempt.ats, 'greenhouse');
  assert.equal(queued.attempt.state, 'QUEUED');
  assert.equal(
    queued.attempt.canonical_url,
    'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=8645054002',
  );
  assert.equal(queued.apply_url_resolution.reason, 'greenhouse-embed');
  assert.equal(selectionOverrideStillValid(root, queued.attempt), true);
  assert.deepEqual(
    exactAttemptKeys(root, 2, { queued: [queued.attempt] }),
    [queued.attempt.idempotency_key],
  );
});

test('runApplications repairs a stale generic QUEUED override into an explicit portal review', async () => {
  const root = target();
  writeFileSync(join(root, 'reports', 'company', '002.md'), '**URL:** https://careers.example.test/jobs/role?gh_jid=999002\n');
  const { attempt } = queueAttempt(root, {
    tracker_number: 2,
    canonical_url: 'https://careers.example.test/jobs/role?gh_jid=999002',
    ats: 'generic',
    role: 'Other',
    company: 'Company',
    selection_override: { reason: 'USER_SELECTION_OVERRIDE', authorized_at: '2026-09-14T00:00:00.000Z' },
  });
  assert.equal(attempt.state, 'QUEUED');
  const { runApplications } = await import('../lib/applications/runner.mjs');
  const run = await runApplications(root, {
    applications: {
      enabled: true,
      auto_submit: true,
      chrome_profile_dir: join(root, 'chrome-profile'),
      supported_ats: ['greenhouse'],
      resumes: { sde: join(root, 'resume.pdf'), mle: join(root, 'resume.pdf') },
    },
  }, { submit: true, max: 1, attemptKeys: [attempt.idempotency_key] });
  assert.match(run.message, /certified ATS apply URL|#2/);
  assert.equal(getAttempt(root, attempt.idempotency_key).state, 'NEEDS_REVIEW');
});


test('an exact-row run preserves a valid below-threshold override and a ready eligible attempt', async () => {
  const root = target();
  const overridden = (await enqueueSelectionOverride(root, 2)).attempt;
  const normalSelection = await enqueueEligible(root, { trackerNumbers: [2], includeCurrent: true });
  assert.deepEqual(normalSelection.queued, []);
  assert.deepEqual(exactAttemptKeys(root, 2, normalSelection), [overridden.idempotency_key]);

  const eligible = (await enqueueEligible(root, { trackerNumbers: [1], includeCurrent: true })).queued[0];
  transitionAttempt(root, eligible.idempotency_key, 'READY_TO_SUBMIT');
  const repeated = await enqueueEligible(root, { trackerNumbers: [1], includeCurrent: true });
  assert.deepEqual(repeated.queued, []);
  assert.deepEqual(exactAttemptKeys(root, 1, repeated), [eligible.idempotency_key]);
});

test('attempt key is stable and final outcomes cannot be retried', () => {
  const root = target(); const key = attemptKey(1, 'https://jobs.lever.co/company/1?utm_source=x');
  assert.equal(key, '1:https://jobs.lever.co/company/1');
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'SUBMITTED');
  assert.throws(() => transitionAttempt(root, attempt.idempotency_key, 'QUEUED'), /Refusing to retry/);
});

test('candidate confirmation is the only path that reopens an uncertain submission', () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', {
    submission_evidence: { confirmation: 'ambiguous-live-response' },
  });
  assert.throws(() => retryApplication(root, 1), /exactly one retryable attempt/);
  const corrected = confirmUnknownNotSubmitted(root, attempt.idempotency_key, { confirmedAt: '2026-09-11T12:00:00.000Z' });
  assert.equal(corrected.state, 'NEEDS_REVIEW');
  assert.equal(corrected.submission_evidence.candidate_confirmed_not_submitted_at, '2026-09-11T12:00:00.000Z');
  assert.equal(retryApplication(root, 1).state, 'QUEUED');

  const root2 = target();
  const second = queueAttempt(root2, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' }).attempt;
  transitionAttempt(root2, second.idempotency_key, 'SUBMISSION_UNKNOWN');
  assert.equal(retryApplication(root2, 1, { confirmNotSubmitted: true }).state, 'QUEUED');
  assert.match(readFileSync(join(root2, '.career-ops-runtime', 'applications', 'events.jsonl'), 'utf8'), /CANDIDATE_CONFIRMED_NOT_SUBMITTED/);
});

test('candidate-confirmed manual submission updates the tracker exactly once', async () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: 'ACCOUNT_CREATION' }] });
  const first = await acknowledgeManualSubmission(root, 1);
  const second = await acknowledgeManualSubmission(root, 1);
  assert.equal(first.tracker_changed, true);
  assert.equal(second.already_acknowledged, true);
  const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| Applied \|/);
  assert.equal((tracker.match(new RegExp(`APP:${attempt.attempt_id}`, 'g')) || []).length, 1);
});

test('application tracker dates use the configured calendar time zone', async () => {
  const instant = new Date('2026-09-11T03:03:00.000Z');
  assert.equal(calendarDate(instant, 'America/New_York'), '2026-09-10');
  assert.equal(calendarDate(instant, 'UTC'), '2026-09-11');
  const root = target();
  await markApplied(root, 1, 'application-time-zone-test', instant, 'America/New_York');
  assert.match(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), /\| 1 \| 2026-09-10 \|/);
});

test('a submitted application updates its report and archives the apply-time JD', () => {
  const root = target();
  const attempt = {
    tracker_number: 1, company: 'Company', role: 'Engineer',
    canonical_url: 'https://jobs.lever.co/company/1', report_id: '[001](reports/company/001.md)',
  };
  writeFileSync(join(root, 'reports', 'company', '001.md'), [
    '# 001, Company | Engineer', '', '**URL:** https://jobs.lever.co/company/1',
    '**Score:** 4.5/5  **Status:** Evaluated  **Resume:** SDE', '', '## Block A',
  ].join('\n'));
  const recorded = recordAppliedArtifacts(root, attempt, {
    postingText: 'Build reliable systems.', appliedAt: new Date('2026-09-11T02:00:00Z'),
    timeZone: 'America/New_York', sourceUrl: 'https://jobs.lever.co/company/1/apply',
  });
  assert.match(readFileSync(recorded.report_path, 'utf8'), /\*\*Status:\*\* Applied/);
  const archive = readFileSync(recorded.archive_path, 'utf8');
  assert.match(archive, /\*\*Archived:\*\* 2026-09-10 \(at time of application\)/);
  assert.match(archive, /Build reliable systems\./);
});

test('a submitted application upgrades a legacy report without a status header', () => {
  const root = target();
  const attempt = {
    tracker_number: 2, company: 'Company', role: 'Other',
    canonical_url: 'https://jobs.lever.co/company/2', report_id: '[002](reports/company/002.md)',
  };
  writeFileSync(join(root, 'reports', 'company', '002.md'), [
    '**URL:** https://jobs.lever.co/company/2', '', '# Job Evaluation Report', '',
    '**Company:** Company', '**Role:** Other', '**Resume:** SDE PDF', '', '## Block A',
  ].join('\n'));
  const recorded = recordAppliedArtifacts(root, attempt, { postingText: 'Legacy posting.' });
  const report = readFileSync(recorded.report_path, 'utf8');
  assert.match(report, /\*\*Resume:\*\* SDE PDF\n\*\*Status:\*\* Applied/);
  assert.equal((report.match(/\*\*Status:\*\*/g) || []).length, 1);
});

test('runtime config rejects an invalid application time zone', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-time-zone-'));
  const path = join(root, 'runtime.yml');
  writeFileSync(path, [
    'runtime_version: 1',
    'api_billing: false',
    'subscription_overage: false',
    'applications:',
    '  time_zone: Mars/Olympus',
  ].join('\n'));
  assert.throws(() => loadRuntimeConfig(path), /IANA time zone/);
});

test('an explicit portal rejection corrects a network-only false submission and restores Evaluated', async () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'SUBMITTED', { submission_evidence: { confirmation: 'adapter-network-response', status: 200 } });
  await markApplied(root, 1, attempt.attempt_id);
  const corrected = correctFalseSubmission(root, attempt.idempotency_key, {
    blocker: { code: 'SUBMISSION_REJECTED' }, evidence: 'adapter-visible-rejection',
  });
  assert.equal(corrected.state, 'NEEDS_REVIEW');
  await revertFalseApplied(root, 1, attempt.attempt_id);
  const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| Evaluated \|/);
  assert.doesNotMatch(tracker, new RegExp(`APP:${attempt.attempt_id}`));
});

test('submission gates fail closed on uncertain resume, sensitive, and incomplete fields', () => {
  const result = submissionGate({ page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'b' }, fields: [
    { question: 'Expected salary', required: true, value: '100', provenance: 'deterministic' },
    { question: 'Need sponsorship?', required: true, value: '', provenance: null },
  ] });
  assert.equal(result.permitted, false);
  assert.deepEqual(result.blockers.map(x => x.code).sort(), ['RESUME_MISMATCH', 'SALARY_QUESTION', 'SENSITIVE_QUESTION', 'VALIDATION_ERROR'].sort());
});

test('ordinary stored consents can submit, while credentials and unvalidated salary cannot', () => {
  const base = { page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'a' } };
  const consent = submissionGate({ ...base, fields: [
    { question: 'I certify that the information I provided is accurate', required: true, value: 'Yes', provenance: 'deterministic' },
    { question: 'I consent to processing my demographic information', required: true, value: 'Yes', provenance: 'deterministic' },
    { question: 'Did you use AI tools to complete this application?', required: true, value: 'No', provenance: 'deterministic' },
  ] });
  assert.equal(consent.permitted, true);
  const credential = submissionGate({ ...base, fields: [{ question: 'Do you hold a professional certification?', required: true, value: 'Yes', provenance: 'deterministic' }] });
  assert.deepEqual(credential.blockers.map(item => item.code), ['CERTIFICATION_CHANGED']);
  const salary = submissionGate({ ...base, fields: [{ question: 'Expected salary', required: true, value: '150000', provenance: 'deterministic' }] });
  assert.deepEqual(salary.blockers.map(item => item.code), ['SALARY_QUESTION']);
  const localSalary = submissionGate({ ...base, fields: [{ question: 'Expected salary', required: true, value: '$150,000', provenance: 'local-salary-preference', salary_validated: true }] });
  assert.equal(localSalary.permitted, true);
});

test('optional marketing and future-opportunity consent is never eligible for automatic submission', () => {
  const base = { page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'a' } };
  const blank = submissionGate({ ...base, fields: [{ question: 'Contact me about future opportunities', required: false, value: '', provenance: null }] });
  assert.equal(blank.permitted, true);
  const selected = submissionGate({ ...base, fields: [{ question: 'Contact me about future opportunities', required: false, value: 'Yes', provenance: 'deterministic' }] });
  assert.deepEqual(selected.blockers.map(item => item.code), ['OPTIONAL_CONSENT']);
});

test('AI disclosure blocks only when this application used generated prose', () => {
  const result = submissionGate({
    page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'a' },
    fields: [{ question: 'Did you use generative AI?', required: true, value: 'No', provenance: 'deterministic' }],
    generated: [{ question: 'Why this role?', claims_validated: true, provenance: 'local-generated' }],
  });
  assert.deepEqual(result.blockers.map(item => item.code), ['AI_PROHIBITION']);
});

test('runner reclassifies older generic REVIEW descriptors for salary and AI disclosure', () => {
  const base = { page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'a' } };
  const salary = submissionGate({ ...base, fields: [{ question: 'Expected salary', risk: 'REVIEW', required: true, value: '100000', provenance: 'deterministic' }] });
  assert.deepEqual(salary.blockers.map(item => item.code), ['SALARY_QUESTION']);
  const ai = submissionGate({ ...base, fields: [{ question: 'Did you use generative AI?', risk: 'REVIEW', required: true, value: 'No', provenance: 'deterministic' }], generated: [{ question: 'Why?', claims_validated: true }] });
  assert.deepEqual(ai.blockers.map(item => item.code), ['AI_PROHIBITION']);
});

test('generated field provenance remains distinguishable from stored deterministic answers', () => {
  const generated = [{ field_id: 'q1', text: 'I enjoy this work.', provenance: 'local-generated', claims_validated: true }];
  const field = { field_id: 'q1', current_value: 'I enjoy this work.' };
  const matched = generated.find(answer => answer.field_id === field.field_id && answer.text === field.current_value);
  assert.equal(matched?.provenance, 'local-generated');
});

test('a blank voluntary EEO field does not block an otherwise deterministic application', () => {
  const result = submissionGate({
    page: { certified: true, exactReviewPage: true },
    resume: { hash: 'a', expected_hash: 'a' },
    fields: [{ question: 'Please identify your race', required: false, risk: 'DETERMINISTIC_ONLY', value: '', provenance: null }],
  });
  assert.equal(result.permitted, true);
});

test('local prose canaries never receive submission authority from a model flag', () => {
  const result = submissionGate({
    page: { certified: true, exactReviewPage: true }, resume: { hash: 'a', expected_hash: 'a' },
    generated: [{ claims_validated: true, provenance: 'local-generated-canary', question: 'Additional Information' }],
  });
  assert.equal(result.permitted, false);
  assert.deepEqual(result.blockers.map(item => item.code), ['VALIDATION_ERROR']);
});

test('hosted answers require requested field mapping, approved evidence, and validation', () => {
  const task = answerTask([{ field_id: 'q1', question: 'Why?', max_length: 100 }], [{ id: 'cv1', kind: 'cv', text: 'Built a service.' }]);
  assert.equal(validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I enjoy this work.', evidence_ids: ['cv1'], claims_validated: false }] }, task).length, 1);
  assert.throws(() => validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I led 12 projects.', evidence_ids: ['bad'], claims_validated: true }] }, task), /unapproved evidence/);
  assert.throws(() => validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I led the project.', evidence_ids: ['cv1'], claims_validated: false }] }, task), /factual claim/);
  assert.equal(validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I led the project.', evidence_ids: ['cv1'], claims_validated: false }] }, task, { allowUnvalidatedFacts: true }).length, 1);
  assert.throws(() => validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'The candidate has relevant experience. Evidence supports this.', evidence_ids: ['cv1'], claims_validated: false }] }, task), /first-person voice/);
  assert.throws(() => validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I am passionate about this work.', evidence_ids: ['cv1'], claims_validated: false }] }, task), /writing style/);
  assert.throws(() => validateGeneratedAnswers({ answers: [{ field_id: 'q1', text: 'I built a system with 99% uptime.', evidence_ids: ['cv1'], claims_validated: true }] }, task), /deterministic validation/);
});

test('cover-letter answers preserve body paragraphs and require job plus profile evidence', () => {
  const task = answerTask([{ field_id: 'cover', question: 'Cover Letter' }], [
    { id: 'job', kind: 'current-job-report', text: 'The role values reliable product engineering.' },
    { id: 'profile', kind: 'trusted-local', text: 'I focus on reliable product engineering.' },
  ]);
  const text = [
    'I build reliable product systems, which directly matches this role.',
    'I focus on clear ownership from design through delivery.',
    'My engineering approach pairs careful testing with practical execution.',
    'I would bring that same product focus to the team.',
  ].join('\n\n');
  const [answer] = validateGeneratedAnswers({ answers: [{
    field_id: 'cover', text, evidence_ids: ['job', 'profile'], confidence: 0.9, claims_validated: false,
  }] }, task);
  assert.equal(answer.text, text);
  assert.throws(() => validateGeneratedAnswers({ answers: [{
    field_id: 'cover', text, evidence_ids: ['profile'], confidence: 0.9, claims_validated: false,
  }] }, task), /job-specific and candidate-profile evidence/);
});

test('cover-letter validation removes only unsupported sentences and rechecks the result', () => {
  const task = answerTask([{ field_id: 'cover', question: 'Cover Letter' }], [
    { id: 'job', kind: 'current-job-report', text: '**Company:** Company\nThe role values reliable product engineering.' },
    { id: 'profile', kind: 'trusted-local', text: 'I focus on reliable product engineering and careful testing.' },
  ]);
  const text = [
    'I focus on reliable product engineering.',
    'I care about careful testing.',
    'I value clear ownership.',
    'I would bring practical execution to the team.',
    'I led 999 unsupported projects.',
  ].join(' ');
  const [answer] = validateGeneratedAnswers({ answers: [{
    field_id: 'cover', text, evidence_ids: ['job', 'profile'], confidence: 0.9, claims_validated: false,
  }] }, task);
  assert.equal(answer.sanitized, 'unsupported-sentences-removed');
  assert.doesNotMatch(answer.text, /999/);
  assert.equal(answer.text.split(/\n\n/).length, 4);
});

test('cover-letter generation never falls through to a hosted provider', async () => {
  const result = await generateBoundedAnswers({
    questions: [{ field_id: 'cover', question: 'Cover Letter' }],
    evidence: [{ id: 'job', kind: 'current-job-report', text: 'Role context.' }],
    runtimeConfig: { applications: { hosted_fallback_providers: ['antigravity-example'] }, providers: {} },
    requireLocal: true,
  });
  assert.equal(result.route.result, 'NO_ELIGIBLE_PROVIDER');
  assert.equal(result.route.reason, 'LOCAL_PROVIDER_UNAVAILABLE');
});

test('Greenhouse cover-letter reveal targets its unique manual control only', async () => {
  let clicked = 0; let waited = 0;
  const button = {
    isVisible: async () => true, isEnabled: async () => true,
    click: async () => { clicked++; },
  };
  const page = { locator(selector) {
    if (selector === 'textarea#cover_letter_text') return {
      count: async () => 0,
      first: () => ({ isVisible: async () => false }),
      waitFor: async options => {
        assert.equal(options.state, 'visible'); waited++;
        if (waited === 1) throw new Error('not hydrated yet');
      },
    };
    assert.equal(selector, 'button[data-testid="cover_letter-text"]');
    return { count: async () => 1, first: () => button };
  } };
  const revealed = await revealGreenhouseCoverLetter(page, { board: 'greenhouse' }, {
    applications: { local_prose: { cover_letters: true } },
  });
  assert.equal(revealed, true);
  assert.equal(clicked, 2);
  assert.equal(waited, 2);
  assert.equal(await revealGreenhouseCoverLetter(page, { board: 'greenhouse' }, {
    applications: { local_prose: { cover_letters: false } },
  }), false);
});

test('salary handling skips current compensation and validates only bounded future preferences', () => {
  assert.equal(salaryQuestionKind('What is your current base salary?'), 'CURRENT_COMPENSATION');
  assert.equal(salaryQuestionKind('What is your current annual bonus?'), 'CURRENT_COMPENSATION');
  assert.equal(salaryQuestionKind('What is the minimum salary you would accept?'), 'MINIMUM_ACCEPTABLE');
  assert.equal(salaryQuestionKind('What is your expected salary range?'), 'DESIRED_RANGE');
  assert.equal(salaryQuestionKind('What is your total compensation expectation?'), 'TOTAL_COMPENSATION');
  assert.equal(salaryQuestionKind('What annual bonus do you expect?'), 'BONUS_EXPECTATION');
  assert.equal(salaryQuestionKind('What annual equity grant do you expect?'), 'EQUITY_EXPECTATION');
  assert.equal(salaryQuestionKind('How many RSUs do you expect?'), 'EQUITY_UNSUPPORTED_UNIT');
  const task = salaryTask([{ field_id: 'salary', question: 'What is your expected salary range?', constraints: { max_length: 30 } }], [{ id: 'report', kind: 'report', text: 'Role and location context.' }]);
  const valid = validateSalaryAnswers({ salaries: [{ field_id: 'salary', value: '$120,000-$140,000', evidence_ids: ['report'], confidence: 0.7 }] }, task);
  assert.equal(valid[0].salary_validated, true);
  assert.equal(valid[0].provenance, 'hosted-salary-preference');
  assert.throws(() => validateSalaryAnswers({ salaries: [{ field_id: 'salary', value: '$150,000-$120,000', evidence_ids: ['report'], confidence: 0.7 }] }, task), /inverted/);
  assert.throws(() => validateSalaryAnswers({ salaries: [{ field_id: 'salary', value: '$120,000', evidence_ids: ['report'], confidence: 0.7 }] }, task), /requires two values/);
  const bonus = salaryTask([{ field_id: 'bonus', question: 'What annual bonus do you expect?', constraints: { max_length: 30 } }], [{ id: 'report', kind: 'report', text: 'Role and location context.' }]);
  assert.equal(validateSalaryAnswers({ salaries: [{ field_id: 'bonus', value: '$20,000', evidence_ids: ['report'], confidence: 0.7 }] }, bonus)[0].salary_kind, 'BONUS_EXPECTATION');
});

test('candidate prose hosted fallback is explicitly restricted to Antigravity providers', () => {
  assert.deepEqual(hostedFallbackProviderIds({ applications: { hosted_fallback_providers: ['codex-luna', 'antigravity-gemini-pro-review', 'antigravity-claude-opus-review'] } }), ['antigravity-gemini-pro-review', 'antigravity-claude-opus-review']);
  assert.deepEqual(hostedFallbackProviderIds({ applications: {} }), []);
});

test('example runtime config keeps the fallback list restricted to configured Antigravity providers', () => {
  const config = loadRuntimeConfig('config/runtime.example.yml');
  assert.ok(config.applications.hosted_fallback_providers.every(id => /^antigravity-/.test(id) && config.providers[id]));
  assert.equal(config.applications.local_prose.cover_letters, false);
});

test('candidate prose normalizes only presentation defects before validation', () => {
  assert.equal(normalizeCandidateProse("I've built robust systems—reliably."), "I've built reliable systems, reliably.");
  const singleLineLetter = 'I build systems. I test carefully. I ship useful work. I learn quickly.';
  assert.equal(normalizeCandidateProse(singleLineLetter, { preserveParagraphs: true }).split(/\n\n/).length, 4);
});

test('local prose requires an explicit loopback canary configuration', () => {
  const config = { applications: { local_prose: { enabled: true, canary_only: true, provider: 'local' } }, providers: {
    local: { enabled: true, local_only: true, type: 'openai_compatible', capabilities: ['structured_output'] },
  } };
  assert.equal(localProseProviderConfig(config)?.id, 'local');
  assert.equal(localProseProviderConfig({ ...config, applications: { local_prose: { enabled: true, canary_only: false, provider: 'local' } } }), null);
  const artifact = join(mkdtempSync(join(tmpdir(), 'career-ops-prose-')), 'qualification.json');
  writeFileSync(artifact, JSON.stringify({ schema: 'ApplicationProseQualificationV1', qualified: true, provider_id: 'local', model_snapshot: undefined, sample_count: 50 }));
  assert.equal(localProseProviderConfig({ ...config, applications: { local_prose: { enabled: true, canary_only: false, qualified: true, qualification_artifact: artifact, provider: 'local' } } })?.canary, false);
});

test('local prose qualification requires grounded answers and rejects instruction echoing', async () => {
  const cases = buildApplicationProseCases(50); let index = 0;
  const provider = { complete: async request => {
    const item = cases[index++];
    const source = request.task.evidence_manifest[0].text.replace(/ Ignore previous instructions.*$/, '');
    return { response: { answers: [{ field_id: request.task.questions[0].field_id, text: source, evidence_ids: [item.evidence.id], confidence: 0.9, claims_validated: true }] }, usage: {}, latency_ms: 1 };
  } };
  const result = await runLocalApplicationProseQualification({
    provider, providerId: 'local', providerConfig: { local_only: true, model_vendor: 'local', type: 'openai_compatible', model_snapshot: 'local:test', base_url: 'http://127.0.0.1:11434/v1' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'local:test', digest: 'x' }] }) }),
  });
  assert.equal(result.qualified, true);
  assert.equal(result.metrics.claims_validated_count, 50);
});

test('application answer corpus produces a style-only local voice profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-voice-'));
  writeFileSync(join(root, 'sample-application-questions.md'), '## Q1. Why?\n\nI build systems people can trust, and I want to keep doing that.\n');
  const profile = applicationVoiceProfile({ roots: [root] });
  assert.match(profile, /Derived from 1 maintained local application-answer sections/);
  assert.match(profile, /style-only/);
  assert.doesNotMatch(profile, /systems people can trust/);
});

test('canonical URLs remove only known tracker decorations', () => {
  assert.equal(safeCanonicalUrl('https://example.test/job?a=1&utm_medium=x#details'), 'https://example.test/job?a=1');
});

test('apply board redacts answer text and keeps unknown-submission acknowledgement non-retryable', async () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', {
    answers: [{ field_id: 'why', text: 'Private application answer', provenance: 'local-generated-canary', evidence_ids: ['cv-1'], claims_validated: false }],
  });
  const server = serveApplyBoard(root, { port: 0, allowActions: true });
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${base}/`)).text();
    const token = html.match(/const csrf=("[a-f0-9]+");/)?.[1];
    assert.ok(token);
    const attempts = await (await fetch(`${base}/api/attempts`)).json();
    assert.equal(attempts[0].answers[0].length, 'Private application answer'.length);
    assert.doesNotMatch(JSON.stringify(attempts), /Private application answer/);
    assert.equal((await fetch(`${base}/api/attempts`, { headers: { origin: 'https://outside.example' } })).status, 403);
    const action = await fetch(`${base}/api/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': JSON.parse(token) },
      body: JSON.stringify({ action: 'ack', key: attempt.idempotency_key }),
    });
    assert.equal(action.status, 200);
    assert.equal((await import('../lib/applications/store.mjs')).getAttempt(root, attempt.idempotency_key).state, 'SUBMISSION_UNKNOWN');
    assert.match((await import('node:fs')).readFileSync(join(root, '.career-ops-runtime', 'applications', 'events.jsonl'), 'utf8'), /SUBMISSION_UNKNOWN/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('apply board is read-only by default and invokes a replay only for the exact retried key', async () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 1, canonical_url: 'https://jobs.lever.co/company/1' });
  transitionAttempt(root, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: 'VALIDATION_ERROR' }] });
  const readOnly = serveApplyBoard(root, { port: 0 });
  await once(readOnly, 'listening');
  const readOnlyPort = readOnly.address().port;
  try {
    assert.match(await (await fetch(`http://127.0.0.1:${readOnlyPort}/`)).text(), /const actions=false/);
    assert.equal((await fetch(`http://127.0.0.1:${readOnlyPort}/api/action`, { method: 'POST' })).status, 403);
  } finally { await new Promise(resolve => readOnly.close(resolve)); }
  const replayed = [];
  const server = serveApplyBoard(root, { port: 0, allowActions: true, onRetry: async key => { replayed.push(key); } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/`)).text();
    const token = html.match(/const csrf=("[a-f0-9]+");/)?.[1];
    const response = await fetch(`${base}/api/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': JSON.parse(token) },
      body: JSON.stringify({ action: 'retry', key: attempt.idempotency_key }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(replayed, [attempt.idempotency_key]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('application artifact retention deletes only aged attempt artifacts', () => {
  const root = target();
  const old = join(root, '.career-ops-runtime', 'applications', 'artifacts', 'application-old');
  const recent = join(root, '.career-ops-runtime', 'applications', 'artifacts', 'application-recent');
  mkdirSync(old, { recursive: true }); mkdirSync(recent, { recursive: true });
  writeFileSync(join(old, 'review.png'), 'x'); writeFileSync(join(recent, 'review.png'), 'x');
  utimesSync(old, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const result = cleanupApplicationArtifacts(root, { days: 14, now: new Date('2026-09-09T00:00:00Z') });
  assert.equal(result.removed, 1);
  assert.throws(() => readFileSync(join(old, 'review.png')));
  assert.equal(readFileSync(join(recent, 'review.png'), 'utf8'), 'x');
});

test('missing APPLY token is a near-miss, not an eligible enqueue', async () => {
  const { hasApplyToken, diagnoseTrackerRows } = await import('../lib/applications/eligibility.mjs');
  assert.equal(hasApplyToken('APPLY. SRC: greenhouse-api'), true);
  assert.equal(hasApplyToken('DO NOT APPLY. SRC: greenhouse-api'), false);
  const root = target();
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-09-14 | Acme | SWE | 4.5/5 | Evaluated | ❌ | [001](reports/acme/1-swe-2026-09-14.md) | Submit SDE resume. SRC: greenhouse-api |',
    '| 2 | 2026-09-14 | Beta | SWE | 4.5/5 | Evaluated | ❌ | [002](reports/beta/2-swe-2026-09-14.md) | APPLY. Submit SDE resume. SRC: ashby-api |',
    '',
  ].join('\n'));
  mkdirSync(join(root, 'reports', 'acme'), { recursive: true });
  mkdirSync(join(root, 'reports', 'beta'), { recursive: true });
  writeFileSync(join(root, 'reports', 'acme', '1-swe-2026-09-14.md'), '**URL:** https://boards.greenhouse.io/acme/jobs/1\n');
  writeFileSync(join(root, 'reports', 'beta', '2-swe-2026-09-14.md'), '**URL:** https://jobs.ashbyhq.com/beta/2\n');
  const diagnosed = diagnoseTrackerRows(root);
  assert.equal(diagnosed.find(item => item.row.num === 1)?.blocker, 'MISSING_APPLY_TOKEN');
  assert.equal(diagnosed.find(item => item.row.num === 1)?.near_miss, true);
  assert.equal(diagnosed.find(item => item.row.num === 2)?.eligible, true);
  const { applicationQueuePreview } = await import('../lib/applications/enqueue-summary.mjs');
  const preview = applicationQueuePreview(root);
  assert.equal(preview.eligible_count, 1);
  assert.equal(preview.near_misses[0].blocker, 'MISSING_APPLY_TOKEN');
  assert.match(preview.human_summary, /Near-miss/);
});

test('liveness gate maps expired and uncertain verdicts fail-closed', async () => {
  const { livenessAttemptPatch } = await import('../lib/applications/liveness-gate.mjs');
  assert.equal(livenessAttemptPatch({ result: 'active' }), null);
  assert.equal(livenessAttemptPatch({ result: 'expired', reason: 'gone' }).state, 'SKIPPED');
  assert.equal(livenessAttemptPatch({ result: 'uncertain', reason: 'spa' }).blockers[0].code, 'LIVENESS_UNCERTAIN');
});

test('apply doctor reports configuration gaps without mutating attempts', async () => {
  const { diagnoseApplications } = await import('../lib/applications/doctor.mjs');
  const report = diagnoseApplications(target(), {
    applications: {
      enabled: false,
      chrome_profile_dir: '',
      resumes: { sde: '', mle: '' },
      supported_ats: ['greenhouse'],
    },
  });
  assert.equal(report.schema, 'ApplicationDoctorReportV1');
  assert.equal(report.ready, false);
  assert.ok(report.checks.some(item => item.code === 'APPLICATIONS_ENABLED' && item.ok === false));
});

test('attempt analytics aggregates states and blockers', async () => {
  const root = target();
  const { attempt } = queueAttempt(root, { tracker_number: 9, canonical_url: 'https://boards.greenhouse.io/acme/jobs/9', ats: 'greenhouse' });
  transitionAttempt(root, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: 'LIVENESS_UNCERTAIN' }] });
  const { applicationAttemptAnalytics } = await import('../lib/applications/analytics.mjs');
  const stats = applicationAttemptAnalytics(root);
  assert.equal(stats.by_state.NEEDS_REVIEW, 1);
  assert.equal(stats.top_blockers[0].code, 'LIVENESS_UNCERTAIN');
  assert.equal(stats.by_ats.greenhouse, 1);
});

test('ATS hostname mapping covers certified and deferred boards', async () => {
  const { atsFor, ATS_MATURITY } = await import('../lib/applications/ats.mjs');
  assert.equal(atsFor('https://boards.greenhouse.io/x/jobs/1'), 'greenhouse');
  assert.equal(atsFor('https://www.linkedin.com/jobs/view/1'), 'linkedin');
  assert.equal(ATS_MATURITY.linkedin.stage, 'deferred');
});

test('field stability wait reports a quiet required-control count', async () => {
  const { waitForFieldStability } = await import('../lib/applications/form-stability.mjs');
  let polls = 0;
  const page = {
    evaluate: async () => {
      polls += 1;
      return polls < 3 ? polls : 2;
    },
  };
  const result = await waitForFieldStability(page, { timeoutMs: 2000, quietMs: 50, pollMs: 10 });
  assert.equal(result.stable, true);
  assert.equal(result.field_count, 2);
});
