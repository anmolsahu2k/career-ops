import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { candidateForTrackerNumber, diagnoseTrackerRows, eligibleRows, DEDICATED_APPLY_SCORE_FLOOR } from './eligibility.mjs';
import { fieldRisk, submissionGate } from './policy.mjs';
import { confirmUnknownNotSubmitted, getAttempt, listAttempts, queueAttempt, transitionAttempt } from './store.mjs';
import { TERMINAL_ATTEMPT_STATES, attemptKey } from './contracts.mjs';
import { markApplied, recordAppliedArtifacts } from './tracker.mjs';
import { generateBoundedAnswers, generateSalaryPreferences } from './answers.mjs';
import { applicationVoiceProfile } from './voice.mjs';
import { cleanupApplicationArtifacts } from './retention.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';
import { atsFor, enabledAts, isCertifiedAts, rolloutAllowlist, MAIN_PROFILE_ATS } from './ats.mjs';
import { resolveCertifiedApplyUrl, greenhouseJobId } from './apply-url.mjs';
import { livenessAttemptPatch, probePageLiveness } from './liveness-gate.mjs';
import { waitForFieldStability } from './form-stability.mjs';
import { applyHandshakeNative } from '../handshake/apply-native.mjs';
import { mapSanctionsChoice, restrictedCountryStoredAnswer, localOrRelocateAnswer, exportControlCountryAnswer, usPersonExportAnswer, f1OptCptCurrentAnswer, graduationDateAnswer, workAuthorizationStatusAnswer, citizenshipStatusAnswer, citizenshipOtherExplainAnswer, securityClearanceAnswer, namedEmployerHistoryAnswer, currentlyEmployedAtNamedOrgAnswer, militaryReserveOrGuardAnswer, usGovernmentEmploymentAnswer, relativesAtNamedOrgAnswer, applicationAffirmationAnswer, completedEducationLevelAnswer, workLocationInterestAnswer, remoteWorkStateAnswer, relocationPreferenceAnswer, futureOpportunityDeclineAnswer, mapNoneLikeChoice, travelPercentageAnswer, operationalSmsOptInAnswer, degreeGpaAnswer, standardizedTestAnswer, essentialFunctionsAnswer, isOtpVerificationQuestion, findAnswer, matchOption, alignSalaryAnswerToOptions, filledValueMatches, startAvailabilityAnswer, normalizeKey as matcherKey } from '../../extensions/job-autofill/content/matcher.js';

export { enabledAts, atsFor };

const EXTENSION = resolve('extensions/job-autofill');
const EXTENSION_SEED = resolve(EXTENSION, 'data', 'answers.json');
const OTP_READER = resolve('scripts/stage-ats-otp.py');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function apps(config) { return config.applications || {}; }

/** Post-submit Greenhouse email MFA is resumable. It is not a fresh fill. */
export function isMfaOnlyResume(item) {
  const blockers = item?.blockers || [];
  return item?.state === 'WAITING_LOGIN'
    && blockers.some(blocker => blocker.code === 'MFA_REQUIRED')
    && !blockers.some(blocker => ['LOGIN_REQUIRED', 'CAPTCHA', 'ACCOUNT_CREATION'].includes(blocker.code));
}

function onlyMfaBlockers(authentication) {
  const blockers = authentication?.blockers || [];
  return Boolean(authentication)
    && authentication.state === 'WAITING_LOGIN'
    && blockers.length > 0
    && blockers.every(blocker => blocker.code === 'MFA_REQUIRED');
}

/** Pure selection gate kept separate from browser launch so a deferred portal
 * can be proven not to reach navigation in tests. */
export function selectableAttempts(attempts, {
  eligibleKeys = new Set(), maySubmit = false, allowedAts = new Set(), selectedKeys = null,
} = {}) {
  return attempts.filter(item => {
    if (!eligibleKeys.has(item.idempotency_key) || !allowedAts.has(item.ats)) return false;
    if (selectedKeys && !selectedKeys.has(item.idempotency_key)) return false;
    if (item.state === 'QUEUED') return true;
    if (maySubmit && item.state === 'READY_TO_SUBMIT') return true;
    // MFA resume requires an exact selected key so apply run cannot pick up
    // an unrelated WAITING_LOGIN row while draining the queue.
    return Boolean(maySubmit && selectedKeys && isMfaOnlyResume(item));
  });
}
const answerTokens = value => new Set(normalizeIdentity(value).split(' ').filter(token => token.length > 1 && !['are', 'you', 'the', 'for', 'this', 'that', 'with'].includes(token)));
export function approvedAnswer(question, answers) {
  const normalized = normalizeIdentity(question);
  if (/\b(?:not|without|decline)\b/.test(normalized)) return null;
  if (answers[normalized]?.answer) return answers[normalized].answer;
  const questionTokens = answerTokens(normalized);
  const candidates = Object.values(answers)
    .filter(entry => entry?.answer && !/\b(?:not|without|decline)\b/.test(entry.key || ''))
    .map(entry => ({ entry, tokens: answerTokens(entry.key) }))
    .filter(candidate => candidate.tokens.size >= 3 && [...candidate.tokens].every(token => questionTokens.has(token)))
    .sort((a, b) => b.tokens.size - a.tokens.size);
  return candidates.length === 1 || (candidates[0] && candidates[0].tokens.size > candidates[1]?.tokens.size)
    ? candidates[0]?.entry.answer || null : null;
}
function approvedDeterministicOverrides(fields = []) {
  if (!existsSync(EXTENSION_SEED)) return [];
  let seed = {};
  try { seed = JSON.parse(readFileSync(EXTENSION_SEED, 'utf8')); }
  catch { return []; }
  const answers = seed.answers || {};
  const storedRestricted = restrictedCountryStoredAnswer(answers)?.answer;
  const relocateAnswer = approvedAnswer('are you willing to relocate', answers) || answers['are you willing to relocate']?.answer;
  return fields
    .filter(field => field.required === true && !field.current_value)
    .map(field => {
      const raw = approvedAnswer(field.normalized_question || field.question, answers) || storedRestricted;
      const hit = findAnswer(matcherKey(field.question), answers);
      const bankValue = hit?.entry?.answer;
      const mappedBank = bankValue && Array.isArray(field.options) && field.options.length
        ? (matchOption(bankValue, field.options)?.text || matchOption(bankValue, field.options) || bankValue)
        : bankValue;
      const helperValue = localOrRelocateAnswer(field.question, field.options, {
        location: seed.profile?.location,
        relocateAnswer,
      })
        || startAvailabilityAnswer(field.question, field.options, answers, { kind: field.type })
        || usPersonExportAnswer(field.question, field.options, {
          usPerson: /^(yes|true)$/i.test(String(seed.profile?.application?.usPerson || '')),
        })
        || f1OptCptCurrentAnswer(field.question, field.options, seed.profile?.application?.currentlyOnF1OptCpt)
        || graduationDateAnswer(field.question, field.options, seed.profile?.education, { kind: field.type })
        || degreeGpaAnswer(field.question, field.options, seed.profile?.education)
        || standardizedTestAnswer(field.question, field.options)
        || securityClearanceAnswer(field.question, field.options)
        || namedEmployerHistoryAnswer(field.question, field.options, seed.profile?.work)
        || currentlyEmployedAtNamedOrgAnswer(field.question, field.options, seed.profile?.work)
        || militaryReserveOrGuardAnswer(field.question, field.options, seed.profile?.work)
        || usGovernmentEmploymentAnswer(field.question, field.options, seed.profile?.work)
        || relativesAtNamedOrgAnswer(field.question, field.options, answers)
        || applicationAffirmationAnswer(field.question, field.options)
        || completedEducationLevelAnswer(field.question, field.options, seed.profile?.education)
        || workLocationInterestAnswer(field.question, field.options, {
          location: seed.profile?.location,
          relocateAnswer,
        })
        || relocationPreferenceAnswer(field.question, field.options, { relocateAnswer })
        || futureOpportunityDeclineAnswer(field.question, field.options)
        || mapNoneLikeChoice(field.question, field.options, seed.profile?.application?.twitchExperience || 'None')
        || remoteWorkStateAnswer(field.question, field.options, {
          location: seed.profile?.location,
          relocateAnswer,
        })
        || travelPercentageAnswer(field.question, field.options, answers)
        || operationalSmsOptInAnswer(field.question, field.options, answers)
        || workAuthorizationStatusAnswer(field.question, field.options, answers, {
          usPerson: /^(yes|true)$/i.test(String(seed.profile?.application?.usPerson || '')),
        })
        || citizenshipStatusAnswer(field.question, field.options, {
          citizenship: seed.profile?.identity?.citizenship,
          usPerson: /^(yes|true)$/i.test(String(seed.profile?.application?.usPerson || '')),
        })
        || citizenshipOtherExplainAnswer(field.question, {
          citizenship: seed.profile?.identity?.citizenship,
          usPerson: /^(yes|true)$/i.test(String(seed.profile?.application?.usPerson || '')),
        })
        || essentialFunctionsAnswer(field.question, field.options, answers);
      if (helperValue) return { field_id: field.field_id, value: helperValue, provenance: 'deterministic-retry' };
      if (field.risk !== 'DETERMINISTIC_ONLY') return null;
      const value = mapSanctionsChoice(field.question, field.options, raw, seed.profile)
        || exportControlCountryAnswer(field.question, {
          citizenship: seed.profile?.identity?.citizenship,
          storedRestrictedNo: Boolean(storedRestricted),
        })
        || mappedBank
        || raw;
      return value ? { field_id: field.field_id, value, provenance: 'deterministic-retry' } : null;
    })
    .filter(Boolean);
}

const NATIVE_CHOICE_TYPES = new Set([
  'checkbox', 'radio', 'buttongroup', 'select', 'combobox', 'combobox-input',
]);

function nativeOptionText(option) {
  if (typeof option === 'string') return option;
  return String(option?.text || option?.value || '');
}

/** Native required checkboxes often report each option label as a missing field. */
export function redundantNativeChoiceError(fields = [], question = '') {
  const needle = normalizeIdentity(question);
  if (!needle) return true;
  // A native error that already names a known question is the real blocker.
  if (fields.some(field => normalizeIdentity(field.question) === needle)) return false;
  return fields.some(field => {
    if (!NATIVE_CHOICE_TYPES.has(field?.type)) return false;
    return (field.options || []).some(option => normalizeIdentity(nativeOptionText(option)) === needle);
  });
}
export function attemptsForBrowserMode(attempts = [], { tabPolicy = 'dedicated' } = {}) {
  if (tabPolicy === 'owned') return attempts;
  return attempts.filter(item => {
    if (item?.ats === 'handshake') return false;
    try { return atsFor(item.canonical_url) !== 'handshake'; }
    catch { return true; }
  });
}
function configError(message) { const error = new Error(message); error.code = 'APPLICATION_CONFIG'; return error; }
function resumeFor(attempt, config) {
  const resumeKind = attempt.resume_kind || (/(machine learning|ml engineer|data scient)/i.test(attempt.role || '') ? 'mle' : 'sde');
  const path = apps(config).resumes?.[resumeKind] || '';
  if (!path || !existsSync(path)) return { kind: resumeKind, blocker: 'RESUME_MISMATCH' };
  return { kind: resumeKind, path: resolve(path), hash: sha256File(path) };
}
function attemptFromCandidate(target, candidate, selectionOverride = null) {
  return queueAttempt(target, {
    tracker_number: candidate.row.num, canonical_url: candidate.canonical_url,
    report_id: candidate.row.report, ats: atsFor(candidate.canonical_url),
    role: candidate.row.role, company: candidate.row.company,
    resume_kind: /\bsubmit\s+mle\s+resume\b/i.test(candidate.row.notes || '') ? 'mle'
      : /\bsubmit\s+sde\s+resume\b/i.test(candidate.row.notes || '') ? 'sde' : '',
    selection_override: selectionOverride,
  });
}

/** Prefer a certified Greenhouse embed over a company careers shell that only
 * carries gh_jid / greenhouse-api provenance. */
async function withCertifiedApplyUrl(candidate, { fetchImpl, config = null } = {}) {
  if (!candidate?.canonical_url) return candidate;
  const hostAts = atsFor(candidate.canonical_url);
  if (isCertifiedAts(hostAts, config) || MAIN_PROFILE_ATS.includes(hostAts)) return candidate;
  const resolution = await resolveCertifiedApplyUrl(candidate.canonical_url, {
    company: candidate.row?.company || candidate.company || '',
    fetchImpl,
  });
  if (!resolution?.resolved || !resolution.url) {
    return { ...candidate, apply_url_resolution: resolution || null };
  }
  return {
    ...candidate,
    canonical_url: resolution.url,
    apply_url_resolution: resolution,
    idempotency_key: attemptKey(candidate.row.num, resolution.url),
  };
}

/** Discovery provenance is not application-surface certification. A Greenhouse
 * feed URL hosted on an employer careers domain must not stay QUEUED where the
 * ATS allowlist silently drops it into "No queued applications". */
function certifyOrReviewQueuedAttempt(target, result, { allowedAts = null, config = null } = {}) {
  const attempt = result?.attempt;
  if (!attempt) return { ...result, unsupported: false, attempt };
  const effectiveAts = atsFor(attempt.canonical_url);
  const alreadyUnsupported = attempt.state === 'NEEDS_REVIEW'
    && (attempt.blockers || []).some(blocker => blocker.code === 'UNSUPPORTED_PORTAL');
  if (alreadyUnsupported) {
    return { attempt, created: result.created, unsupported: true };
  }
  if (attempt.state !== 'QUEUED') return { ...result, unsupported: false, attempt };
  if (effectiveAts === 'generic' || attempt.ats === 'generic') {
    const next = transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
      ats: effectiveAts === 'generic' ? 'generic' : attempt.ats || effectiveAts,
      blockers: [{ code: 'UNSUPPORTED_PORTAL', detail: 'Application host is not a certified ATS surface' }],
    });
    return { attempt: next, created: result.created, unsupported: true };
  }
  if (allowedAts && !allowedAts.has(effectiveAts)) {
    const enabled = [...allowedAts].join(', ') || 'none';
    const next = transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
      ats: effectiveAts,
      blockers: [{
        code: 'UNSUPPORTED_PORTAL',
        detail: `${effectiveAts} is not in the local supported_ats allowlist (${enabled})`,
      }],
    });
    return { attempt: next, created: result.created, unsupported: true };
  }
  if (attempt.ats !== effectiveAts && isCertifiedAts(effectiveAts, config)) {
    return {
      attempt: transitionAttempt(target, attempt.idempotency_key, 'QUEUED', { ats: effectiveAts, blockers: [] }),
      created: result.created,
      unsupported: false,
    };
  }
  return { ...result, unsupported: false, attempt };
}
async function extensionBridge(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  await worker.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (!self.careerOpsStore && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!self.careerOpsStore) throw new Error('Job Autofill store is not available in the extension worker');
  });
  return worker;
}

/** Pick the job-application tab. Extension pages and about:blank are never https. */
export function applicationTabFromList(tabs = [], applicationUrl = '') {
  const httpTabs = (Array.isArray(tabs) ? tabs : []).filter(tab => /^https?:/.test(String(tab?.url || '')));
  if (!httpTabs.length) return null;
  const target = String(applicationUrl || '').split('#')[0];
  if (target) {
    const exact = httpTabs.find(tab => tab.url === applicationUrl);
    if (exact) return exact;
    const sameDocument = httpTabs.find(tab => String(tab.url || '').split('#')[0] === target);
    if (sameDocument) return sameDocument;
  }
  return httpTabs.length === 1 ? httpTabs[0] : null;
}

async function keepOnlyApplicationPage(context, page) {
  for (const extra of context.pages()) {
    if (extra !== page) await extra.close().catch(() => {});
  }
}

function isSurplusApplicationTabUrl(url) {
  const value = String(url || '');
  return value === 'about:blank'
    || value === 'about:blank#blocked'
    || value.startsWith('chrome-extension://')
    || value.startsWith('chrome://')
    || value.startsWith('devtools://');
}

function attachSurplusTabCloser(context, getApplicationPage) {
  const closeIfSurplus = page => {
    const keep = getApplicationPage();
    if (!keep || page === keep || page.isClosed()) return;
    if (isSurplusApplicationTabUrl(page.url())) page.close().catch(() => {});
  };
  context.on('page', page => {
    closeIfSurplus(page);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) closeIfSurplus(page);
    });
  });
}

async function finishHandshakeNativeAttempt(target, attempt, config, page, native) {
  const blockers = native.blockers || (native.reason ? [{ code: native.reason, detail: native.reason }] : []);
  if (native.status === 'SUBMITTED') {
    const appliedAt = new Date();
    await markApplied(target, attempt.tracker_number, attempt.attempt_id, appliedAt, apps(config).time_zone);
    return transitionAttempt(target, attempt.idempotency_key, 'SUBMITTED', {
      submission_evidence: {
        url: page.url(),
        observed_at: appliedAt.toISOString(),
        confirmation: native.reason || 'handshake-native',
      },
    });
  }
  if (native.status === 'READY_TO_SUBMIT') {
    return transitionAttempt(target, attempt.idempotency_key, 'READY_TO_SUBMIT', { blockers: [] });
  }
  if (native.status === 'SKIPPED') {
    return transitionAttempt(target, attempt.idempotency_key, 'SKIPPED', { blockers });
  }
  if (native.status === 'SUBMISSION_UNKNOWN') {
    return transitionAttempt(target, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', {
      submission_evidence: { url: page.url(), observed_at: new Date().toISOString() },
    });
  }
  return transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers });
}

async function send(bridge, message, applicationPage) {
  const applicationUrl = applicationPage?.url?.() || '';
  return bridge.evaluate(async ({ msg, applicationUrl: url }) => {
    const tabs = await chrome.tabs.query({});
    const httpTabs = tabs.filter(tab => /^https?:/.test(String(tab?.url || '')));
    const target = String(url || '').split('#')[0];
    const tab = httpTabs.find(item => item.url === url)
      || httpTabs.find(item => target && String(item.url || '').split('#')[0] === target)
      || (httpTabs.length === 1 ? httpTabs[0] : null); // keep aligned with applicationTabFromList
    if (!tab) return { ok: false, error: 'application tab not found' };
    // The runner operates full-page, certified ATS flows. Sending to every
    // frame lets an unrelated CAPTCHA/analytics frame race the actual form and
    // return an empty descriptor set. Pinning to frame 0 makes readback and
    // filling refer to the same application document.
    try { return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }); }
    catch (error) { return { ok: false, error: String(error) }; }
  }, { msg: message, applicationUrl });
}
async function seedResume(bridge, resume) {
  const base64 = readFileSync(resume.path).toString('base64');
  const receipt = await bridge.evaluate(async ({ kind, base64, name }) => {
    const store = self.careerOpsStore;
    if (!store) return { name: '', sha256: null };
    await store.setResume({ name, type: 'application/pdf', base64 }, kind);
    const stored = await store.getResumeFor(kind);
    if (!stored?.base64) return { name: stored?.name || '', sha256: null };
    const bytes = Uint8Array.from(atob(stored.base64), char => char.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      name: stored.name || '',
      sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    };
  }, { kind: resume.kind, base64, name: resume.path.split(/[\\/]/).at(-1) });
  const expectedName = resume.path.split(/[\\/]/).at(-1);
  if (receipt?.name !== expectedName || receipt?.sha256 !== resume.hash) {
    throw configError(`Selected ${resume.kind.toUpperCase()} resume did not persist in the dedicated application profile`);
  }
  return receipt;
}
async function seedExtensionData(bridge) {
  if (!existsSync(EXTENSION_SEED)) throw configError('Job Autofill seed data is missing');
  let seed;
  try { seed = JSON.parse(readFileSync(EXTENSION_SEED, 'utf8')); }
  catch { throw configError('Job Autofill seed data is not valid JSON'); }
  return bridge.evaluate(async data => {
    const store = self.careerOpsStore;
    if (!store) throw new Error('Job Autofill store is not available in the extension worker');
    // Never replace captured/manual corrections already made in the dedicated
    // application profile. The repo seed merely initializes a fresh profile.
    await store.importData(data, { replaceAll: false });
    return store.purgeEphemeralStoredAnswers();
  }, seed);
}
function uploadedResume(readback, expected) {
  const matches = (readback.files || []).filter(file => file.is_resume === true && file.name === expected.path.split(/[\\/]/).at(-1));
  return matches.length === 1 && matches[0].sha256 === expected.hash
    ? { hash: matches[0].sha256, expected_hash: expected.hash }
    : { hash: matches[0]?.sha256 || null, expected_hash: expected.hash };
}

/**
 * The extension remains the source of field descriptors and readback.  A few
 * modern Greenhouse pages, however, mount their file controls in a React
 * subtree that replies to extension messages independently.  That can omit
 * an already-attached resume from the message response.  Verify the *native*
 * file control in the same page as a narrow, read-only corroboration rather
 * than treating that transport quirk as permission to submit.
 */
export function greenhouseResumeUploadFailed(text) {
  return /cannot read properties of undefined \(reading ['"]uploadFile['"]\)/i.test(String(text || ''));
}

async function greenhouseResumeAttachControl(page) {
  const exact = page.locator('button[data-testid="resume-file"]');
  if (await exact.count() === 1 && await exact.first().isVisible().catch(() => false)
    && await exact.first().isEnabled().catch(() => false)) {
    return exact.first();
  }
  const labeled = page.locator('#upload-label-resume').locator('xpath=..').locator('button, [role="button"]');
  const count = await labeled.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const button = labeled.nth(index);
    const text = String(await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (/^attach$/i.test(text) && await button.isVisible().catch(() => false)
      && await button.isEnabled().catch(() => false)) return button;
  }
  return null;
}

/** Attach the hash-verified local resume through Greenhouse's Attach chooser. */
export async function attachCertifiedResume(page, resume, board) {
  if (board !== 'greenhouse' || !resume?.path || !existsSync(resume.path)) return null;
  const expectedName = resume.path.split(/[\\/]/).at(-1);
  const attach = await greenhouseResumeAttachControl(page);
  try {
    if (attach) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
      await attach.click();
      const chooser = await chooserPromise;
      await chooser.setFiles(resume.path);
    } else {
      const input = page.locator('input#resume, input[name="resume"]').first();
      if (!await input.count()) return null;
      await input.setInputFiles(resume.path);
    }
  } catch {
    return null;
  }
  await delay(800);
  await page.waitForFunction(name => {
    const text = document.body?.innerText || '';
    if (/cannot read properties of undefined \(reading ['"]uploadFile['"]\)/i.test(text)) return false;
    return text.includes(name);
  }, expectedName, { timeout: 15000 }).catch(() => {});
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (greenhouseResumeUploadFailed(text) || !text.includes(expectedName)) return null;
  return { hash: resume.hash, expected_hash: resume.hash, name: expectedName };
}

async function observedResume(page, readback, expected, fillReport = null) {
  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (greenhouseResumeUploadFailed(pageText)) {
    return { hash: null, expected_hash: expected.hash };
  }
  const extensionReadback = uploadedResume(readback, expected);
  if (extensionReadback.hash === expected.hash) return extensionReadback;
  const expectedName = expected.path.split(/[\\/]/).at(-1);
  const receipt = fillReport?.resume;
  // Greenhouse replaces `#resume` with a filename receipt after accepting the
  // file, so there may be no native input left to hash.  Require both the
  // extension's just-computed local hash and the board's visible filename;
  // either missing signal fails closed.
  if (receipt?.name === expectedName && receipt.sha256 === expected.hash) {
    const rendered = await page.evaluate(name => {
      const text = document.body?.innerText || '';
      return /\bresume(?:\/cv)?\b/i.test(text) && text.includes(name);
    }, expectedName);
    if (rendered) return { hash: receipt.sha256, expected_hash: expected.hash };
  }
  const files = await page.locator('input[type="file"]').evaluateAll(async (inputs, name) => {
    const digest = async file => {
      try {
        const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      } catch { return null; }
    };
    return Promise.all(inputs.map(async input => {
      const identifiers = [input.id, input.name, input.getAttribute('aria-label')]
        .filter(Boolean).join(' ').replace(/[_-]+/g, ' ');
      const isResume = /\b(?:resume|resum|cv|curriculum\s*vitae)\b/i.test(identifiers)
        && !/\bcover[\s_-]*letter\b/i.test(identifiers);
      const file = input.files?.[0] || null;
      return { isResume, name: file?.name || '', sha256: file ? await digest(file) : null };
    }));
  }, expectedName);
  const matches = files.filter(file => file.isResume && file.name === expectedName);
  return matches.length === 1
    ? { hash: matches[0].sha256, expected_hash: expected.hash }
    : { hash: extensionReadback.hash, expected_hash: expected.hash };
}

const normalizeIdentity = value => String(value || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

/** Reuse previously generated attempt answers instead of calling a model again. */
export function reusableGeneratedAnswers(stored = [], fields = []) {
  const answers = Array.isArray(stored) ? stored : [];
  return (Array.isArray(fields) ? fields : []).flatMap(field => {
    if (!field?.field_id || field.current_value) return [];
    const asked = normalizeIdentity(field.question || field.normalized_question || '');
    const prior = answers.find(answer => {
      if (!String(answer?.text || '').trim()) return false;
      // Unvalidated local/canary prose must never short-circuit a hosted retry.
      // submissionGate would reject it, and after switching prose providers the
      // old text is the wrong execution path.
      if (answer.claims_validated !== true) return false;
      if (answer.field_id && answer.field_id === field.field_id) return true;
      const storedQuestion = normalizeIdentity(answer.question || '');
      return Boolean(storedQuestion && asked && storedQuestion === asked);
    });
    if (!prior) return [];
    return [{
      field_id: field.field_id,
      question: field.question || prior.question || '',
      text: String(prior.text).trim(),
      provenance: prior.provenance || 'hosted-generated',
      claims_validated: true,
      evidence_ids: Array.isArray(prior.evidence_ids) ? prior.evidence_ids : [],
      salary_validated: prior.salary_validated === true,
    }];
  });
}

function alignedSalaryAnswers(answers = [], fields = []) {
  const byId = new Map((Array.isArray(fields) ? fields : []).map(field => [field.field_id, field]));
  return (Array.isArray(answers) ? answers : []).map(answer => {
    const field = byId.get(answer.field_id);
    const text = alignSalaryAnswerToOptions(answer.text, field?.options || []);
    return text === answer.text ? answer : { ...answer, text };
  });
}

function mergeAttemptAnswers(prior = [], next = []) {
  const byId = new Map();
  for (const answer of [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(next) ? next : [])]) {
    if (!answer?.field_id || !String(answer.text || '').trim()) continue;
    byId.set(answer.field_id, answer);
  }
  return [...byId.values()];
}

function identityPageText(identity) {
  return normalizeIdentity(`${identity?.title || ''} ${identity?.heading || ''} ${identity?.text || ''}`);
}

function identityHasRole(identity, role) {
  const normalized = normalizeIdentity(role);
  return Boolean(normalized) && identityPageText(identity).includes(normalized);
}

const COMPANY_ACRONYM_SKIP = new Set([
  'the', 'and', 'of', 'for', 'at', 'in', 'a', 'an', 'to', 'inc', 'llc', 'co',
  'corp', 'corporation', 'company', 'group',
]);

function companyAcronym(company = '') {
  const words = normalizeIdentity(company).split(' ').filter(word => word && !COMPANY_ACRONYM_SKIP.has(word));
  if (words.length < 2) return '';
  const acronym = words.map(word => word[0]).join('');
  return acronym.length >= 3 ? acronym : '';
}

function identityHasCompany(identity, company) {
  const pageText = identityPageText(identity);
  const urlText = normalizeIdentity(identity?.url || '');
  const normalized = normalizeIdentity(company);
  if (normalized && pageText.includes(normalized)) return true;
  const acronym = companyAcronym(company);
  const acronymHit = Boolean(acronym) && (
    new RegExp(`(?:^| )${acronym}(?: |$)`).test(pageText)
    || urlText.includes(acronym)
  );
  if (acronymHit) return true;
  const companyHead = normalized.split(' ').find(token => token.length >= 3 && !COMPANY_ACRONYM_SKIP.has(token));
  return Boolean(companyHead && pageText.includes(companyHead));
}

async function pageIdentity(page) {
  return page.evaluate(() => {
    const chrome = /^(?:apply for this job|job application)\s*$/i;
    const headings = [...document.querySelectorAll('h1')]
      .map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title || '',
      heading: headings.find(text => !chrome.test(text)) || headings[0] || '',
      // Identity only, never form values.  The bounded text keeps this an audit
      // check rather than a duplicate store of a candidate's application.
      text: (document.body?.innerText || '').slice(0, 8000),
    };
  });
}

function isOfficialGreenhouseBoard(hostname) {
  return /^(?:boards|job-boards)\.greenhouse\.io$/i.test(String(hostname || ''));
}

function isOfficialGreenhouseShortLink(hostname) {
  return /^grnh\.se$/i.test(String(hostname || ''));
}

function stripTrailingSlash(pathname = '') {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

function greenhouseChromeHeading(heading = '') {
  return /^(?:apply for this job|job application)$/i.test(normalizeIdentity(heading));
}

export function exactSinglePageFinal(inspected, attempt, identity) {
  if (!['greenhouse', 'ashby'].includes(inspected.board) || !inspected.navigation?.hasSubmit) return false;
  const current = new URL(identity.url);
  const expected = new URL(attempt.canonical_url);
  const expectedPath = inspected.board === 'ashby'
    ? `${stripTrailingSlash(expected.pathname)}/application`
    : stripTrailingSlash(expected.pathname);
  const currentPath = stripTrailingSlash(current.pathname);
  // Greenhouse canonical application links commonly redirect from
  // boards.greenhouse.io to job-boards.greenhouse.io. Both are official
  // Greenhouse hosts, so allow only that exact host pair; all other cross-origin
  // redirects remain a hard rejection even if their page text copies the role.
  const sameOfficialGreenhouse = inspected.board === 'greenhouse'
    && isOfficialGreenhouseBoard(current.hostname)
    && isOfficialGreenhouseBoard(expected.hostname);
  const currentJobId = greenhouseJobId(identity.url);
  const expectedJobId = greenhouseJobId(attempt.canonical_url);
  const sameOfficialJob = sameOfficialGreenhouse && Boolean(currentJobId) && currentJobId === expectedJobId;
  // Company careers shells resolve to the first-party embed form. Match the
  // board token + job id rather than a redirected /jobs/{id} path.
  const sameGreenhouseEmbed = inspected.board === 'greenhouse'
    && sameOfficialGreenhouse
    && /\/embed\/job_app\/?$/i.test(current.pathname)
    && /\/embed\/job_app\/?$/i.test(expected.pathname)
    && current.searchParams.get('for') === expected.searchParams.get('for')
    && (current.searchParams.get('token') || current.searchParams.get('gh_jid'))
      === (expected.searchParams.get('token') || expected.searchParams.get('gh_jid'));
  // grnh.se is Greenhouse's first-party short-link host. It intentionally
  // cannot preserve the destination job id in its opaque path, so matching
  // paths would reject every valid short link. Permit only its one-way
  // redirect to an official board job URL; the exact role and company checks
  // below remain mandatory. No third-party redirect gets this exception.
  const officialShortLinkRedirect = inspected.board === 'greenhouse'
    && isOfficialGreenhouseShortLink(expected.hostname)
    && isOfficialGreenhouseBoard(current.hostname)
    && /\/jobs\/\d+\/?$/i.test(current.pathname);
  // Direct Greenhouse forms must remain on the official board hosts. A
  // same-origin look-alike that copies the title and company is never a
  // certified application page.
  if (inspected.board === 'greenhouse' && !sameOfficialGreenhouse && !officialShortLinkRedirect) return false;
  if (sameGreenhouseEmbed) {
    // Embed chrome uses "Apply for this job" as h1. The board token + job id
    // already pin the requisition; require the tracker role and company to
    // appear in title, heading, or page text rather than h1 equality.
    return identityHasRole(identity, attempt.role) && identityHasCompany(identity, attempt.company);
  }
  if ((!sameOfficialGreenhouse && !officialShortLinkRedirect && current.origin !== expected.origin)
    || (!officialShortLinkRedirect && !sameOfficialJob && currentPath !== expectedPath)) return false;
  // Short links cannot pin a job id, so the live heading must equal the tracker
  // role. Official same-job URLs may keep Greenhouse chrome ("Apply for this
  // job") or a requisition title that drifted from the tracker row.
  const headingEqualsRole = normalizeIdentity(identity.heading) === normalizeIdentity(attempt.role)
    || greenhouseChromeHeading(identity.heading);
  if (officialShortLinkRedirect) {
    if (normalizeIdentity(identity.heading) !== normalizeIdentity(attempt.role)) return false;
  } else if (!headingEqualsRole && !(sameOfficialJob && identityHasCompany(identity, attempt.company))) {
    return false;
  }
  return identityHasCompany(identity, attempt.company);
}

/** Read native required controls as a second, deterministic completeness gate. */
async function formValidation(page) {
  return page.evaluate(() => {
    const resume = document.querySelector('input[type="file"]#resume, input[type="file"]#_systemfield_resume, input[type="file"][name*="resume" i]');
    // Ashby renders a semantic tabpanel (`#form`) instead of a native <form>.
    // It is still the exact application container, and its required controls
    // deserve the same deterministic browser-validation pass.
    const form = resume?.closest('form, [role="tabpanel"]#form') || document.querySelector('form, [role="tabpanel"]#form');
    if (!form) return { found: false, errors: [] };
    const cleanLabel = value => String(value || '').replace(/[*✱∗]/g, '').replace(/\s+/g, ' ').trim();
    const labelFor = el => {
      const direct = cleanLabel(el.labels?.[0]?.textContent);
      if (direct) return direct;
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const labelled = cleanLabel(ids.map(id => document.getElementById(id)?.textContent || '').join(' '));
      if (labelled) return labelled;
      const aria = cleanLabel(el.getAttribute('aria-label'));
      if (aria) return aria;
      const field = el.closest('.field, [class*="question"], fieldset, [role="group"]');
      const grouped = cleanLabel(field?.querySelector(':scope > legend, :scope > label, :scope > p, :scope > [class*="label"]')?.textContent);
      if (grouped) return grouped;
      return cleanLabel(el.id) || cleanLabel(el.name) || '';
    };
    const hasReactSelection = el => {
      const scope = el.closest('[class*="select__control"], [class*="select__container"]') || el.parentElement?.parentElement;
      if (!scope) return false;
      // Greenhouse uses react-select for both one-choice and multi-choice
      // questions.  A multi-choice control leaves its search input empty after
      // selection, but renders each chosen option as a removable chip.  The
      // empty input is therefore not a missing required answer.
      return Boolean(
        scope.querySelector('[class*="single-value"]')?.textContent?.trim()
        || scope.querySelector('[class*="multi-value"]')?.textContent?.trim()
        || scope.querySelector('[aria-label^="Remove "]'),
      );
    };
    const isVisible = el => {
      const style = getComputedStyle(el);
      if (el.type === 'file') return true; // hidden behind the board's upload button.
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getAttribute('aria-hidden') !== 'true';
    };
    const errors = [];
    const seenChoiceGroups = new Set();
    for (const el of form.querySelectorAll('input, select, textarea')) {
      if (el.disabled || el.type === 'hidden' || !isVisible(el)) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true';
      if (!required) continue;
      const choice = /^(checkbox|radio)$/i.test(el.type || '');
      if (choice) {
        // Some Greenhouse pages incorrectly set `required` on every member of
        // a "check all that apply" group, including uniquely named options.
        // Treat the visual question as one control so option labels like
        // "U.S. citizen" are not reported as missing questions.
        const root = el.closest('fieldset, [role="group"], [role="radiogroup"], .field, [class*="question"]')
          || (el.name ? null : el.parentElement);
        const key = root ? `root:${root}` : `${el.type}:${el.name || el.id}`;
        if (seenChoiceGroups.has(key)) continue;
        seenChoiceGroups.add(key);
        const members = root
          ? [...root.querySelectorAll('input')].filter(member => member.type === el.type)
          : [...form.querySelectorAll('input')].filter(member => member.type === el.type && (el.name ? member.name === el.name : member === el));
        const present = members.some(member => member.checked);
        const legend = root?.querySelector(':scope > legend, :scope > label, :scope > p, :scope > [class*="label"]');
        const question = (legend?.textContent || '').replace(/[*✱∗]/g, '').replace(/\s+/g, ' ').trim() || labelFor(el);
        if (!question) continue;
        if (!present || el.getAttribute('aria-invalid') === 'true') errors.push(question);
        continue;
      }
      const present = el.type === 'file' ? Boolean(el.files?.length) : Boolean(el.value?.trim() || hasReactSelection(el));
      if (!present || el.validity?.valid === false || el.getAttribute('aria-invalid') === 'true') {
        const question = labelFor(el);
        if (question) errors.push(question);
      }
    }
    return { found: true, errors: [...new Set(errors)] };
  });
}
function artifactPath(target, attempt, suffix) {
  const dir = join(persistencePaths(target).runtimeDir, 'applications', 'artifacts', attempt.attempt_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, suffix);
}
async function capture(page, target, attempt, suffix) {
  // Screenshots are review aids, not a second store of answers or identity
  // details. Mask native field values before capture. The board only serves
  // these explicitly redacted artifacts.
  const path = artifactPath(target, attempt, `redacted-${suffix}`);
  const style = await page.addStyleTag({ content: `
    input, textarea, select, [contenteditable="true"] {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: 0 0 8px #111 !important;
      caret-color: transparent !important;
    }
  ` }).catch(() => null);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  await style?.evaluate(node => node.remove()).catch(() => {});
  return path;
}
function answerEvidence(target, attempt, config) {
  const files = apps(config).answer_evidence_files || [];
  const evidence = files.filter(path => typeof path === 'string' && existsSync(path)).map(path => ({
    kind: 'trusted-local', text: readFileSync(path, 'utf8').slice(0, 12000),
  }));
  // The current, already-evaluated job report gives the local model role and
  // company context. It is job-scoped evidence, never a reusable answer bank.
  const reportPath = String(attempt.report_id || '').match(/\]\(([^)]+)\)/)?.[1];
  const resolvedReport = reportPath ? resolve(target, reportPath) : null;
  if (resolvedReport && existsSync(resolvedReport)) {
    evidence.push({ kind: 'current-job-report', text: readFileSync(resolvedReport, 'utf8').slice(0, 12000) });
  }
  return evidence;
}
async function exactButton(page, expression, { includeTabs = false } = {}) {
  const controls = includeTabs
    ? 'button, input[type="submit"], [role="button"], [role="tab"], a'
    : 'button, input[type="submit"], [role="button"]';
  const buttons = page.locator(controls);
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const label = await button.innerText().catch(() => '');
    const value = await button.getAttribute('value').catch(() => '');
    const text = `${label || ''} ${value || ''}`.trim();
    if (expression.test(text) && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) return button;
  }
  return null;
}

/** Reveal only Greenhouse's named cover-letter textarea. Resume and cover
 * letter upload sections both say "Enter manually", so text matching alone is
 * unsafe. The board-specific test id is the deterministic slot identity. */
export async function revealGreenhouseCoverLetter(page, inspected, _config) {
  if (inspected?.board !== 'greenhouse') return false;
  const existing = page.locator('textarea#cover_letter_text');
  if (await existing.count() === 1 && await existing.first().isVisible().catch(() => false)) return false;
  const controls = page.locator('button[data-testid="cover_letter-text"]');
  if (await controls.count() !== 1) return false;
  const control = controls.first();
  if (!await control.isVisible().catch(() => false) || !await control.isEnabled().catch(() => false)) return false;
  await control.click();
  try {
    await page.locator('textarea#cover_letter_text').waitFor({ state: 'visible', timeout: 1500 });
  } catch {
    // Greenhouse can paint this button before React hydration attaches its
    // handler. Retry the same exact control once only when the textarea is
    // still absent; never click a second generic "Enter manually" button.
    await delay(750);
    const retry = page.locator('button[data-testid="cover_letter-text"]');
    if (await retry.count() !== 1 || !await retry.first().isVisible().catch(() => false)
      || !await retry.first().isEnabled().catch(() => false)) throw new Error('Greenhouse cover-letter control did not hydrate');
    await retry.first().click();
    await page.locator('textarea#cover_letter_text').waitFor({ state: 'visible', timeout: 5000 });
  }
  return true;
}

async function finalNativeSubmit(page) {
  for (const scope of [page, ...page.frames().filter(frame => frame !== page.mainFrame())]) {
    const exact = await exactButton(scope, /^\s*submit(?: application)?\s*$/i);
    if (exact) return exact;
    // After Greenhouse renders its security-code controls, responsive layout
    // can truncate the label while preserving one native submit control.
    const controls = scope.locator('button[type="submit"], input[type="submit"]');
    const count = await controls.count();
    const visibleEnabled = [];
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) visibleEnabled.push(control);
    }
    if (visibleEnabled.length === 1) return visibleEnabled[0];
  }
  return null;
}

async function clickFinalSubmit(page, button) {
  try {
    await button.click();
    return 'pointer';
  } catch (error) {
    // Some ATS overlays (including extension-owned UI) can intercept pointer
    // events even though the exact final Submit button is visible, enabled,
    // and already passed every deterministic gate. Re-resolve the exact
    // control before using its native DOM activation. This is deliberately
    // limited to the final button; it cannot choose another action or skip a
    // validation, and any outcome is still independently confirmed below.
    const reason = String(error?.message || error);
    if (!/intercepts pointer events|not stable|Timeout .*click/i.test(reason)) throw error;
    const retry = await exactButton(page, /^\s*submit(?: application)?\s*$/i);
    if (!retry) throw error;
    const activated = await retry.evaluate(element => {
      const disabled = element.disabled || element.getAttribute('aria-disabled') === 'true';
      if (disabled) return false;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      element.click();
      return true;
    }).catch(() => false);
    if (!activated) throw error;
    return 'dom-activation-after-pointer-intercept';
  }
}

async function openApplicationForm(page, board) {
  // Ashby renders the form behind an exact "Application" tab instead of an
  // Apply button. This is certified, bounded navigation on the known posting,
  // never a final-submission action.
  const label = board === 'ashby' ? /^\s*application\s*$/i : /^\s*apply\s*$/i;
  const control = await exactButton(page, label, { includeTabs: board === 'ashby' });
  if (!control) return false;
  await control.click();
  await delay(1200);
  return true;
}

function submissionNetworkEvidence(attempt, response) {
  const request = response.request();
  if (request.method() !== 'POST' || response.status() < 200 || response.status() >= 400) return null;
  const url = response.url();
  const body = String(request.postData() || '');
  const known = attempt.ats === 'greenhouse'
    ? /(?:^|\.)greenhouse\.io(?:\/|$)/i.test(url) && /(\/jobs\/\d+|application)/i.test(`${url} ${body}`)
    : attempt.ats === 'ashby'
      ? /(?:^|\.)ashbyhq\.com(?:\/|$)/i.test(url) && /submit.{0,40}application|application.{0,40}submit/i.test(body)
      : false;
  return known ? { url, status: response.status(), observed_at: new Date().toISOString(), confirmation: 'adapter-network-response' } : null;
}

/** Greenhouse uses HTTP 428 after a valid application POST when its spam
 * protection requires the candidate to verify their email. It is not a
 * submission result and must enter the bounded OTP handoff. */
export function requiresEmailVerification(attempt, observations = []) {
  if (attempt?.ats !== 'greenhouse') return false;
  return observations.some(item => {
    if (Number(item?.status) !== 428) return false;
    let parsed;
    try { parsed = new URL(item.url); } catch { return false; }
    if (!/(^|\.)greenhouse\.io$/i.test(parsed.hostname)) return false;
    return /\/jobs\/\d+/i.test(parsed.pathname) || /\/embed\/job_app/i.test(parsed.pathname);
  });
}

export function greenhouseSubmissionSuccessText(text) {
  return /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(String(text || ''));
}

/** A Greenhouse 428 can correctly start MFA, but it must not keep the runner
 * in MFA after the OTP page has already given way to a thank-you screen. */
export function applyPostOtpEmailVerificationFlag(navigation = {}, {
  emailVerificationRequired = false, remaining = null, successVisible = false,
} = {}) {
  const next = { ...navigation };
  if (successVisible || next.success) {
    next.success = true;
    next.mfa = false;
    return next;
  }
  if (next.submissionRejected) return next;
  if (emailVerificationRequired && remaining) next.mfa = true;
  return next;
}

export async function enqueueEligible(target, { includeCurrent = false, trackerNumbers = null, fetchImpl, config = null, scoreFloor = DEDICATED_APPLY_SCORE_FLOOR } = {}) {
  const allowedAts = rolloutAllowlist(config);
  const selected = trackerNumbers ? new Set([...trackerNumbers].map(Number)) : null;
  const rows = diagnoseTrackerRows(target, { allowedAts, scoreFloor }).filter(item => {
    if (selected && !selected.has(Number(item.row.num))) return false;
    return selected ? true : item.eligible;
  });
  const queued = [];
  const blocked = [];
  for (const raw of rows) {
    if (!raw.eligible) {
      blocked.push({
        tracker_number: raw.row.num,
        blocker: raw.blocker || 'NOT_ELIGIBLE',
        detail: raw.detail || undefined,
      });
      continue;
    }
    const candidate = await withCertifiedApplyUrl(raw, { fetchImpl, config });
    const certified = certifyOrReviewQueuedAttempt(target, attemptFromCandidate(target, candidate), { allowedAts, config });
    const attempt = certified.attempt;
    const unsupported = certified.unsupported === true;
    if (unsupported) {
      blocked.push({
        tracker_number: candidate.row.num,
        blocker: 'UNSUPPORTED_PORTAL',
        detail: candidate.apply_url_resolution?.reason || undefined,
      });
    }
    if (certified.created && !unsupported) queued.push(attempt);
    else if (includeCurrent && attempt.state === 'QUEUED' && !unsupported) queued.push(attempt);
    else if (!unsupported) {
      // An idempotency hit is operationally important, especially for a
      // user-selected one-row run.  Do not report it as an empty queue: a
      // terminal unknown may already have reached the employer, while a
      // review state needs an explicit repair/retry rather than a fresh run.
      blocked.push({
        tracker_number: candidate.row.num,
        blocker: `EXISTING_${attempt.state}`,
        attempt_id: attempt.attempt_id,
      });
    }
  }
  return { queued, blocked, eligible_count: rows.filter(item => item.eligible).length };
}

/** Bind a runner invocation to only the attempts returned by its enqueue.
 * Keeping this conversion in the application module makes it hard for a CLI
 * caller to accidentally fall back to the global queue after selecting rows. */
export function enqueuedAttemptKeys(result = {}) {
  return [...new Set((result.queued || [])
    .filter(item => item
      && ['QUEUED', 'READY_TO_SUBMIT'].includes(item.state)
      && item.ats !== 'generic'
      && atsFor(item.canonical_url) !== 'generic')
    .map(item => item.idempotency_key)
    .filter(Boolean))];
}

/** Resolve an exact-row CLI selection without widening it to the global queue.
 * A user override can authorize a row that is intentionally absent from
 * eligibleRows(), while an eligible dry run may already be READY_TO_SUBMIT.
 * Both states must remain selectable on the next exact-row invocation. */
export function exactAttemptKeys(target, trackerNumber, enqueueResult = {}) {
  const queued = enqueuedAttemptKeys(enqueueResult);
  if (queued.length) return queued;
  const candidate = candidateForTrackerNumber(target, trackerNumber);
  if (!candidate?.idempotency_key) return [];
  const attempt = getAttempt(target, candidate.idempotency_key);
  if (!attempt || !['QUEUED', 'READY_TO_SUBMIT'].includes(attempt.state)) return [];
  if (atsFor(attempt.canonical_url) === 'generic' || attempt.ats === 'generic') return [];
  // An already-queued or ready attempt stays selectable by exact tracker number
  // even when a fresh eligibility pass would block a new enqueue (EXISTING_*).
  // Without this, `apply run --tracker-number` no-ops on rows that are already
  // QUEUED and never reaches the submit branch the operator authorized.
  return [attempt.idempotency_key];
}

/** A user can select one Evaluated role outside the score/recommendation gate.
 * The exception is persisted on that attempt and is not reusable for any other
 * row, URL, or later tracker revision. */
export async function enqueueSelectionOverride(target, trackerNumber, { fetchImpl, config = null } = {}) {
  const allowedAts = rolloutAllowlist(config);
  const raw = candidateForTrackerNumber(target, trackerNumber, { allowedAts });
  if (!raw) throw new Error(`Tracker row ${trackerNumber} was not found`);
  if (String(raw.row.status).trim() !== 'Evaluated') {
    throw new Error(`Tracker row ${trackerNumber} is no longer Evaluated`);
  }
  if (!raw.canonical_url) {
    throw new Error(`Tracker row ${trackerNumber} cannot be queued: ${raw.blocker || 'CANONICAL_URL_MISSING'}`);
  }
  const candidate = await withCertifiedApplyUrl(raw, { fetchImpl });
  const certified = certifyOrReviewQueuedAttempt(
    target,
    attemptFromCandidate(target, candidate, { reason: 'USER_SELECTION_OVERRIDE' }),
    { allowedAts },
  );
  return {
    attempt: certified.attempt,
    created: certified.created,
    unsupported: certified.unsupported === true,
    blocker: certified.unsupported === true ? 'UNSUPPORTED_PORTAL' : null,
    apply_url_resolution: candidate.apply_url_resolution || null,
    tracker_number: Number(trackerNumber),
    normal_eligibility: raw.eligible,
  };
}

/** Re-open a locally blocked attempt only after an operator or an adapter fix.
 * Terminal submission states remain permanently non-retryable. */
export function retryApplication(target, trackerNumber, { confirmNotSubmitted = false } = {}) {
  let attempts = listAttempts(target).filter(item => item.tracker_number === Number(trackerNumber));
  if (confirmNotSubmitted) {
    const uncertain = attempts.filter(item => item.state === 'SUBMISSION_UNKNOWN');
    if (uncertain.length !== 1) throw new Error(`Expected exactly one uncertain attempt for tracker row ${trackerNumber}`);
    confirmUnknownNotSubmitted(target, uncertain[0].idempotency_key);
    attempts = listAttempts(target).filter(item => item.tracker_number === Number(trackerNumber));
  }
  const matches = attempts.filter(item => ['NEEDS_REVIEW', 'WAITING_LOGIN', 'FAILED'].includes(item.state));
  if (matches.length !== 1) throw new Error(`Expected exactly one retryable attempt for tracker row ${trackerNumber}`);
  return transitionAttempt(target, matches[0].idempotency_key, 'QUEUED', { blockers: [] });
}

/** A sign-in or one-time-code challenge can arrive only after the ATS accepts
 * the final click. It is not an ambiguous submission: retain it as a resumable
 * manual-authentication handoff and never read an inbox or enter a rotating
 * code on the candidate's behalf. */
export function authenticationBlocker(navigation = {}) {
  const blockers = [
    navigation.login && { code: 'LOGIN_REQUIRED' },
    navigation.mfa && { code: 'MFA_REQUIRED' },
    navigation.captcha && { code: 'CAPTCHA' },
    navigation.accountCreation && { code: 'ACCOUNT_CREATION' },
  ].filter(Boolean);
  if (!blockers.length) return null;
  return {
    state: navigation.login || navigation.mfa ? 'WAITING_LOGIN' : 'NEEDS_REVIEW',
    blockers,
  };
}

async function awaitManualAuthentication(page, timeoutMs) {
  // This is an explicit interactive handoff, not an attempt to automate an
  // inbox, TOTP, CAPTCHA, or identity challenge. The headed dedicated Chrome
  // window remains available to the candidate while we only observe the ATS
  // page for an unambiguous outcome.
  await page.bringToFront().catch(() => {});
  return page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    if (/application (?:has been )?(?:submitted|received)|thank you for applying/i.test(text)) return 'success';
    if (/possible spam|unable to submit|submission (?:was )?(?:rejected|failed)/i.test(text)) return 'rejected';
    return null;
  }, { timeout: timeoutMs }).then(handle => handle.jsonValue()).catch(() => null);
}

async function fillOneTimeCodeInScope(scope, code) {
  const inputs = scope.locator('input');
  const candidates = await inputs.evaluateAll(elements => elements.map((element, index) => {
    const style = getComputedStyle(element);
    const visible = style.display !== 'none' && style.visibility !== 'hidden'
      && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
    const hint = [element.name, element.id, element.getAttribute('autocomplete'), element.placeholder, element.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    const hinted = /one-time-code|verification|security.?code|\botp\b/.test(hint);
    const lengthGuess = (['text', 'tel', 'number'].includes(element.type || 'text')
      && Number(element.maxLength) >= 6 && Number(element.maxLength) <= 12);
    return {
      index, visible, hinted,
      conventional: hinted || lengthGuess,
      value: element.value || '',
      maxLength: Number(element.maxLength) || null,
    };
  }).filter(item => item.visible));
  const hinted = candidates.filter(item => item.hinted);
  if (hinted.length === 1) {
    await inputs.nth(hinted[0].index).fill(code);
    return { filled: true, detail: 'OTP_SINGLE_FIELD_FILLED' };
  }
  const emptyConventional = candidates.filter(item => item.conventional && !item.value);
  const single = emptyConventional.length === 1 ? emptyConventional : [];
  if (single.length === 1) {
    await inputs.nth(single[0].index).fill(code);
    return { filled: true, detail: 'OTP_SINGLE_FIELD_FILLED' };
  }
  const hintedSlots = hinted.filter(item => item.maxLength === 1);
  const emptySlots = emptyConventional.filter(item => item.maxLength === 1);
  const slots = hintedSlots.length === code.length ? hintedSlots : emptySlots;
  if (slots.length !== code.length) return { filled: false, detail: `${hinted.length}_${slots.length}` };
  for (let index = 0; index < slots.length; index++) await inputs.nth(slots[index].index).fill(code[index]);
  return { filled: true, detail: 'OTP_SLOT_GROUP_FILLED' };
}

function collectPiercedInputNodes(root) {
  const nodes = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.nodeName === 'INPUT' && Number(node.backendNodeId) > 0) nodes.push(node);
    for (const child of node.children || []) visit(child);
    for (const shadow of node.shadowRoots || []) visit(shadow);
    visit(node.contentDocument);
    visit(node.templateContent);
  };
  visit(root);
  return nodes;
}

function closedShadowOtpSlots(nodes, codeLength) {
  const single = nodes.filter(node => {
    const attributes = Object.fromEntries((node.attributes || []).reduce((pairs, value, index) => {
      if (index % 2 === 0) pairs.push([String(value).toLowerCase(), String(node.attributes[index + 1] || '')]);
      return pairs;
    }, []));
    return attributes.maxlength === '1';
  });
  if (single.length === codeLength) return single;
  const hinted = nodes.filter(node => {
    const attributes = Object.fromEntries((node.attributes || []).reduce((pairs, value, index) => {
      if (index % 2 === 0) pairs.push([String(value).toLowerCase(), String(node.attributes[index + 1] || '')]);
      return pairs;
    }, []));
    return attributes.maxlength === '1'
      || /one.time|verification|security.code|character/i.test(`${attributes.autocomplete || ''} ${attributes['aria-label'] || ''} ${attributes.name || ''}`);
  });
  return hinted;
}

export function otpSlotValuesMatch(values = [], code = '') {
  const expected = String(code || '');
  if (!/^[A-Za-z0-9]{6,12}$/.test(expected)) return false;
  if (!Array.isArray(values) || values.length !== expected.length) return false;
  return values.every((value, index) => String(value || '') === expected[index]);
}

/** True when an 8-box widget stored the first half of the code twice.
 * Chromium inserts on keyDown.text and again on char, so each character
 * occupies two maxlength=1 slots and the second half is dropped. */
export function otpLooksCharacterDoubled(values = [], code = '') {
  const expected = String(code || '');
  const joined = (Array.isArray(values) ? values : []).map(value => String(value || '')).join('');
  if (!expected || joined.length !== expected.length || expected.length % 2 !== 0) return false;
  const half = expected.slice(0, expected.length / 2);
  let doubled = '';
  for (const char of half) doubled += char + char;
  return joined === doubled;
}

async function readClosedShadowOtpValues(page, expectedLength) {
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const slots = closedShadowOtpSlots(collectPiercedInputNodes(root), expectedLength);
    const values = [];
    for (const slot of slots) {
      const resolved = await session.send('DOM.resolveNode', { backendNodeId: slot.backendNodeId });
      const objectId = resolved.object?.objectId;
      if (!objectId) {
        values.push('');
        continue;
      }
      const result = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return String(this.value || ""); }',
        returnByValue: true,
      });
      values.push(String(result.result?.value || ''));
    }
    return values;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function setClosedShadowOtpSlot(session, slot, value) {
  const resolved = await session.send('DOM.resolveNode', { backendNodeId: slot.backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) return false;
  await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(next) {
      this.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(this, next); else this.value = next;
      this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: next }));
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }`,
    arguments: [{ value: String(value || '') }],
    awaitPromise: true,
  });
  return true;
}

async function typeOneTimeCodeAtSecurityCodeLabel(page, code) {
  // Chime's Greenhouse verification widget exposes the label to the main page
  // but encapsulates its segmented boxes outside the ordinary DOM/frame query
  // surfaces. Anchor a keyboard entry to that exact visible label instead of
  // using screen-global coordinates.
  const label = page.getByText(/^security code$/i).first();
  const box = await label.boundingBox().catch(() => null);
  if (!box) return { filled: false, detail: 'OTP_LABEL_MISSING' };
  await page.bringToFront().catch(() => {});
  const firstX = box.x + Math.min(28, Math.max(12, box.width / 4));
  const centerY = box.y + box.height + 30;
  await page.mouse.click(firstX, centerY);
  // insertText, not keyboard.type. type() sends keyDown.text, and these
  // segmented boxes also insert on keydown, so each character occupies two slots.
  for (const char of code) {
    await page.keyboard.insertText(char);
    await delay(40);
  }
  const values = await readClosedShadowOtpValues(page, code.length).catch(() => []);
  if (otpSlotValuesMatch(values, code)) return { filled: true, detail: 'OTP_SEGMENTED_LABEL_ANCHORED_INSERT_TEXT' };
  if (!values.length) return { filled: true, detail: 'OTP_SEGMENTED_LABEL_ANCHORED_INSERT_TEXT' };
  return { filled: false, detail: 'OTP_SEGMENTED_LABEL_VALUE_MISMATCH' };
}

async function fillOneTimeCodeInClosedShadowRoot(page, code) {
  // Some certified Greenhouse widgets keep their OTP inputs in a closed shadow
  // root. Playwright's ordinary locators correctly cannot cross that boundary,
  // but Chrome's DevTools DOM tree can identify the real, max-length-one input
  // nodes. Set each slot once. Do not synthesize keyDown.text plus char:
  // Chromium inserts on both, so an 8-box widget stores the first four
  // characters doubled and drops the rest.
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const slots = closedShadowOtpSlots(collectPiercedInputNodes(root), code.length);
    if (slots.length !== code.length) return { filled: false, detail: `CLOSED_SHADOW_OTP_UNRESOLVED_${slots.length}` };
    for (const [index, slot] of slots.entries()) {
      const ok = await setClosedShadowOtpSlot(session, slot, code[index]);
      if (!ok) return { filled: false, detail: 'CLOSED_SHADOW_OTP_RESOLVE_FAILED' };
    }
    const values = await readClosedShadowOtpValues(page, code.length);
    if (otpSlotValuesMatch(values, code)) return { filled: true, detail: 'OTP_CLOSED_SHADOW_SLOTS_FILLED' };
    return { filled: false, detail: 'OTP_CLOSED_SHADOW_VALUE_MISMATCH' };
  } finally {
    await session.detach().catch(() => {});
  }
}

async function fillOneTimeCode(page, code) {
  // The code is supplied only through the short-lived runner environment after
  // a narrowly scoped mailbox read the candidate authorized. It is never
  // written to an attempt, artifact, extension store, or log. Only fill a
  // single visible conventional OTP control on a page already classified MFA.
  if (!/^[A-Za-z0-9]{6,12}$/.test(code)) return { filled: false, detail: 'OTP_CODE_FORMAT_REJECTED' };
  const unresolved = [];
  if (await greenhouseOtpVisible(page)) {
    const existing = await readClosedShadowOtpValues(page, code.length).catch(() => []);
    if (otpSlotValuesMatch(existing, code)) return { filled: true, detail: 'OTP_ALREADY_MATCHED' };
    const closedShadow = await fillOneTimeCodeInClosedShadowRoot(page, code)
      .catch(() => ({ filled: false, detail: 'CLOSED_SHADOW_OTP_UNAVAILABLE' }));
    if (closedShadow.filled) return closedShadow;
    unresolved.push(closedShadow.detail);
    const typed = await typeOneTimeCodeAtSecurityCodeLabel(page, code).catch(() => ({ filled: false, detail: 'OTP_LABEL_UNAVAILABLE' }));
    if (typed.filled) return typed;
    unresolved.push(typed.detail);
  }
  const scopes = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
  for (const [index, scope] of scopes.entries()) {
    const result = await fillOneTimeCodeInScope(scope, code).catch(() => ({ filled: false, detail: 'SCOPE_UNAVAILABLE' }));
    if (result.filled) return { ...result, detail: `${result.detail}_FRAME_${index}` };
    unresolved.push(result.detail);
  }
  if (!(await greenhouseOtpVisible(page))) {
    const closedShadow = await fillOneTimeCodeInClosedShadowRoot(page, code)
      .catch(() => ({ filled: false, detail: 'CLOSED_SHADOW_OTP_UNAVAILABLE' }));
    if (closedShadow.filled) return closedShadow;
    unresolved.push(closedShadow.detail);
    const typed = await typeOneTimeCodeAtSecurityCodeLabel(page, code).catch(() => ({ filled: false, detail: 'OTP_LABEL_UNAVAILABLE' }));
    if (typed.filled) return typed;
    unresolved.push(typed.detail);
  }
  return { filled: false, detail: `OTP_TARGET_UNRESOLVED_${unresolved.join('_')}` };
}

function mfaHandoffPath(target, attempt) {
  const attemptId = String(attempt?.attempt_id || '');
  if (!/^application-[a-f0-9-]{36}$/i.test(attemptId)) throw new Error('Invalid application MFA handoff target');
  return join(persistencePaths(target).runtimeDir, 'applications', 'mfa-handoff', `${attemptId}.code`);
}

/** Stage one short-lived local code for the exact application currently at MFA.
 * The runner deletes it before attempting a fill, and neither the value nor its
 * path enters artifacts, attempt state, logs, or the extension answer store. */
export function stageMfaCode(target, trackerNumber, code) {
  const value = String(code || '').trim();
  if (!/^[A-Za-z0-9]{6,12}$/.test(value)) throw new Error('MFA code must be 6-12 letters or digits');
  const matches = listAttempts(target).filter(attempt => attempt.tracker_number === Number(trackerNumber)
    && ['SUBMITTING', 'WAITING_LOGIN'].includes(attempt.state));
  if (matches.length !== 1) throw new Error(`Expected exactly one active MFA attempt for tracker row ${trackerNumber}`);
  const path = mfaHandoffPath(target, matches[0]);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { tracker_number: Number(trackerNumber), attempt_id: matches[0].attempt_id, accepted: true };
}

async function takeMfaCode(target, attempt, timeoutMs) {
  const path = mfaHandoffPath(target, attempt);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      let value = '';
      try { value = readFileSync(path, 'utf8').trim(); } finally { unlinkSync(path); }
      return /^[A-Za-z0-9]{6,12}$/.test(value) ? value : '';
    }
    await delay(400);
  }
  return '';
}

export function otpDomains(ats, config) {
  const configured = apps(config).gmail_otp?.sender_domains?.[ats];
  return Array.isArray(configured) ? configured.filter(domain => /^[a-z0-9.-]+$/i.test(domain)) : [];
}
function readGmailOtpStatus(statusPath) {
  try {
    const parsed = JSON.parse(readFileSync(statusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function gmailOtpMissDetail(status, exitCode) {
  if (Number(exitCode) === 3 || status?.error === 'token_expired' || status?.auth?.expired) return 'GMAIL_OTP_TOKEN_EXPIRED';
  if (exitCode !== 0) return `GMAIL_OTP_READER_EXIT_${exitCode}`;
  if (!status) return 'GMAIL_OTP_STATUS_MISSING';
  if (status.extracted === true && Number(status.code_length) > 0) return 'GMAIL_OTP_HANDOFF_MISSING';
  if (Number(status.listed) === 0) return 'GMAIL_OTP_NO_MESSAGES';
  const hits = Array.isArray(status.hits) ? status.hits : [];
  if (hits.some(item => item?.allowlisted) && hits.every(item => !item?.allowlisted || item?.too_old)) {
    return 'GMAIL_OTP_NO_FRESH_MESSAGES';
  }
  if (Number(status.allowlisted) === 0) return 'GMAIL_OTP_SENDER_NOT_ALLOWLISTED';
  return 'GMAIL_OTP_NO_EXTRACTABLE_CODE';
}

async function fetchPersonalGmailOtp(target, attempt, config, { once = false, notBeforeMs = null } = {}) {
  const policy = apps(config).gmail_otp;
  const domains = policy?.enabled === true ? otpDomains(attempt.ats, config) : [];
  if (!domains.length || !existsSync(OTP_READER)) return { code: '', detail: 'GMAIL_OTP_DISABLED' };
  const path = mfaHandoffPath(target, attempt);
  const statusPath = `${path}.status.json`;
  try { if (existsSync(path)) unlinkSync(path); } catch { /* a stale exclusive file would hide a fresh code */ }
  try { if (existsSync(statusPath)) unlinkSync(statusPath); } catch { /* ignore leftover status */ }
  const timeout = once
    ? 15
    : Math.max(15, Math.min(300, Number(policy.timeout_seconds || 180)));
  const started = Number.isFinite(notBeforeMs) ? Number(notBeforeMs) : Date.now() - 2 * 60_000;
  const args = [
    OTP_READER, '--out', path, '--not-before', String(started),
    '--domains', domains.join(','), '--timeout-seconds', String(timeout),
    '--status-out', statusPath,
  ];
  if (once) args.push('--once');
  const exitCode = await new Promise(resolveProcess => {
    const child = spawn(policy.python_command || 'python', args, {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    child.stderr?.resume?.();
    child.once('error', () => resolveProcess(1));
    child.once('exit', code => resolveProcess(code ?? 1));
  });
  const code = await takeMfaCode(target, attempt, 2000);
  if (/^[A-Za-z0-9]{6,12}$/.test(code)) return { code, detail: 'GMAIL_OTP_CODE_READ' };
  return { code: '', detail: gmailOtpMissDetail(readGmailOtpStatus(statusPath), exitCode) };
}

export function otpFieldsLookComplete(fields = []) {
  const visible = fields.filter(field => field.visible);
  const slots = visible.filter(field => field.maxLength === 1);
  if (slots.length >= 6 && slots.length <= 12) {
    return slots.every(field => String(field.value || '').trim());
  }
  const otp = visible.filter(field => field.otp === true);
  if (otp.length !== 1) return false;
  return /^[A-Za-z0-9]{6,12}$/.test(String(otp[0].value || '').trim());
}

export function otpFilledPayload(fields = []) {
  const visible = fields.filter(field => field.visible);
  const slots = visible.filter(field => field.maxLength === 1);
  if (slots.length >= 6 && slots.length <= 12) {
    return slots.map(field => String(field.value || '').trim()).join('');
  }
  const otp = visible.filter(field => field.otp === true);
  if (otp.length === 1) return String(otp[0].value || '').trim();
  return '';
}

export function otpChangedFromBaseline(fields = [], baseline = '') {
  if (!otpFieldsLookComplete(fields)) return false;
  return otpFilledPayload(fields) !== String(baseline || '');
}

export function isOtpOnlySurface(inspected = {}) {
  if (!inspected?.navigation?.mfa) return false;
  const visible = (inspected.fields || []).filter(field => !['hidden', 'submit', 'button', 'file'].includes(field.type));
  if (!visible.length) return true;
  return visible.every(field => isOtpVerificationQuestion(field.question || ''));
}

async function inspectOtpFields(page) {
  return page.evaluate(() => [...document.querySelectorAll('input')].map(element => {
    const style = getComputedStyle(element);
    const visible = style.display !== 'none' && style.visibility !== 'hidden'
      && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
    const hint = [element.name, element.id, element.getAttribute('autocomplete'), element.placeholder, element.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    return {
      visible,
      maxLength: Number(element.maxLength) || 0,
      value: element.value || '',
      otp: /one-time-code|verification|security.?code|\botp\b/.test(hint),
    };
  })).catch(() => []);
}

async function greenhouseOtpVisible(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /verification code was sent|enter the 8-character code|security code/i.test(text);
}

async function greenhouseSubmissionSuccessVisible(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return greenhouseSubmissionSuccessText(text);
}

async function otpLooksComplete(page) {
  return otpFieldsLookComplete(await inspectOtpFields(page));
}

async function completeEmailVerification({
  page, target, attempt, config, bridge, oneTimeCode = '', pauseForAuthentication = false, note,
  mailNotBefore = Date.now() - 10 * 60_000,
}) {
  let leftoverCode = String(oneTimeCode || '').trim();
  let confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => ({ navigation: {} }));
  const configured = Number(apps(config).authentication_handoff_timeout_ms || 10 * 60_000);
  const timeoutMs = Math.max(60_000, Math.min(30 * 60_000, configured));
  const deadline = Date.now() + timeoutMs;
  let mfaAction = '';
  let otpBaseline = null;
  const lookback = Number.isFinite(mailNotBefore) ? Number(mailNotBefore) : Date.now() - 10 * 60_000;
  while (Date.now() < deadline) {
    if (!confirmation.navigation) confirmation.navigation = {};
    if (await greenhouseSubmissionSuccessVisible(page)) {
      confirmation.navigation = { ...confirmation.navigation, success: true, mfa: false };
      return { confirmation, remaining: null, mfaAction: mfaAction || 'OTP_SUCCESS_VISIBLE' };
    }
    if (confirmation.navigation.success || confirmation.navigation.submissionRejected) {
      return { confirmation, remaining: authenticationBlocker(confirmation.navigation), mfaAction };
    }
    const otpVisible = await greenhouseOtpVisible(page)
      || Boolean(authenticationBlocker(confirmation.navigation)?.blockers.some(item => item.code === 'MFA_REQUIRED'));
    if (!otpVisible) {
      return { confirmation, remaining: authenticationBlocker(confirmation.navigation), mfaAction };
    }
    const otpFields = await inspectOtpFields(page);
    if (otpBaseline === null) otpBaseline = otpFilledPayload(otpFields);
    const fetched = leftoverCode
      ? { code: leftoverCode, detail: 'MFA_HANDOFF_CODE' }
      : await fetchPersonalGmailOtp(target, attempt, config, { once: true, notBeforeMs: lookback });
    leftoverCode = '';
    if (fetched.code) {
      const codeFill = await fillOneTimeCode(page, fetched.code);
      mfaAction = codeFill.detail;
      if (codeFill.filled) {
        await delay(450);
        const resubmit = await finalNativeSubmit(page);
        if (resubmit) {
          mfaAction = 'CODE_FILLED_SUBMIT_REQUESTED';
          await clickFinalSubmit(page, resubmit);
          await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(document.body?.innerText || ''), { timeout: 30000 }).catch(() => {});
        } else mfaAction = 'CODE_FILLED_SUBMIT_CONTROL_UNAVAILABLE';
      }
      confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => confirmation);
      continue;
    }
    mfaAction = fetched.detail || mfaAction;
    if (otpChangedFromBaseline(otpFields, otpBaseline)) {
      const resubmit = await finalNativeSubmit(page);
      if (resubmit) {
        mfaAction = 'OTP_COMPLETE_SUBMIT_REQUESTED';
        await clickFinalSubmit(page, resubmit);
        await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(document.body?.innerText || ''), { timeout: 30000 }).catch(() => {});
      }
      confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => confirmation);
      continue;
    }
    note?.({
      phase: 'blocked',
      result: 'WAITING_LOGIN',
      title: mfaAction || 'MFA_REQUIRED',
      company: attempt.company,
      tracker_number: attempt.tracker_number,
    });
    if (pauseForAuthentication) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const slice = Math.max(4000, Math.min(15000, remaining));
      const handoff = await awaitManualAuthentication(page, slice).catch(() => null);
      if (handoff === 'success' || handoff === 'rejected') {
        confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => confirmation);
        if (handoff === 'success' && confirmation.navigation) confirmation.navigation.success = true;
        if (handoff === 'rejected' && confirmation.navigation) confirmation.navigation.submissionRejected = true;
        continue;
      }
    } else {
      await delay(4000);
    }
    confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => confirmation);
  }
  const remaining = authenticationBlocker(confirmation.navigation) || {
    state: 'WAITING_LOGIN',
    blockers: [{ code: 'MFA_REQUIRED', detail: mfaAction || 'OTP_TIMEOUT' }],
  };
  return { confirmation, remaining, mfaAction };
}

/** Report careers shells and resolved Greenhouse embeds share a job id even
 * when their hosts differ. Override validity must survive that rewrite. */
function sameApplicationIdentity(reportUrl, attemptUrl) {
  if (!reportUrl || !attemptUrl) return false;
  if (reportUrl === attemptUrl) return true;
  const reportJob = greenhouseJobId(reportUrl);
  const attemptJob = greenhouseJobId(attemptUrl);
  return Boolean(reportJob && attemptJob && reportJob === attemptJob);
}

export function selectionOverrideStillValid(target, attempt) {
  if (attempt.selection_override?.reason !== 'USER_SELECTION_OVERRIDE') return false;
  const current = candidateForTrackerNumber(target, attempt.tracker_number);
  return Boolean(current
    && String(current.row.status).trim() === 'Evaluated'
    && sameApplicationIdentity(current.canonical_url, attempt.canonical_url)
    && current.row.report === attempt.report_id
    && current.row.role === attempt.role
    && current.row.company === attempt.company);
}

/** Processes exactly one queue entry at a time.  The submit branch is guarded
 * by config *and* the CLI --submit flag so unattended canaries cannot submit. */
export async function runApplications(target, config, {
  submit = false, max = 1, pauseForAuthentication = false, attemptKeys = null, onProgress = null,
  existingSession = null, skipNavigation = false, scoreFloor = DEDICATED_APPLY_SCORE_FLOOR,
} = {}) {
  const note = (progress = {}) => {
    try { onProgress?.({ stage: 'apply', ...progress }); } catch { /* ignore listener errors */ }
  };
  if (apps(config).enabled !== true) throw configError('applications.enabled must be true in ignored local config');
  // Consume immediately so it cannot propagate to child tools or a later run.
  const oneTimeCode = String(process.env.CAREER_OPS_MFA_CODE || '').trim();
  delete process.env.CAREER_OPS_MFA_CODE;
  cleanupApplicationArtifacts(target, { days: apps(config).artifact_retention_days || 14 });
  // A process can be interrupted after the click but before an adapter can
  // observe confirmation. That is never safe to retry: recover it into the
  // same terminal uncertainty state used for an ambiguous live response.
  for (const interrupted of listAttempts(target).filter(item => item.state === 'SUBMITTING')) {
    transitionAttempt(target, interrupted.idempotency_key, 'SUBMISSION_UNKNOWN', {
      submission_evidence: {
        url: interrupted.canonical_url,
        observed_at: new Date().toISOString(),
        confirmation: 'interrupted-after-submit-click',
      },
    });
  }
  // Repair older override/enqueue bugs that left generic hosts QUEUED. Those
  // records cannot pass the ATS allowlist and must surface as review items.
  for (const stale of listAttempts(target).filter(item => item.state === 'QUEUED'
    && (item.ats === 'generic' || atsFor(item.canonical_url) === 'generic'))) {
    certifyOrReviewQueuedAttempt(target, { attempt: stale, created: false }, { config });
  }
  // A run consumes only rows explicitly authorized by a preceding enqueue.
  // Re-check those rows immediately before opening the browser; a stale score,
  // duplicate, URL change, or manual tracker edit silently removes authority.
  const tabPolicy = existingSession?.tabPolicy === 'owned' ? 'owned' : 'dedicated';
  const allowedAts = enabledAts(config);
  const eligible = new Map(eligibleRows(target, {
    allowedAts: rolloutAllowlist(config),
    scoreFloor,
  }).map(item => [item.idempotency_key, item]));
  const maySubmit = submit && apps(config).auto_submit === true;
  const selectedKeys = attemptKeys === null ? null : new Set(attemptKeys);
  const attempts = listAttempts(target);
  const eligibleKeys = new Set(eligible.keys());
  const eligibleTrackerNumbers = new Set([...eligible.values()]
    .map(item => Number(item.tracker_number || item.row?.num))
    .filter(num => Number.isInteger(num) && num > 0));
  for (const attempt of attempts) {
    if (selectionOverrideStillValid(target, attempt)) eligibleKeys.add(attempt.idempotency_key);
    // Greenhouse (and similar) apply-URL resolution rewrites the report shell
    // URL into a certified embed URL, which changes the idempotency key.
    // Keep the already-queued resolved attempt runnable while its tracker row
    // remains eligible under the unresolved shell URL.
    if (eligibleTrackerNumbers.has(attempt.tracker_number)
      && ['QUEUED', 'READY_TO_SUBMIT'].includes(attempt.state)
      && allowedAts.has(attempt.ats)) {
      eligibleKeys.add(attempt.idempotency_key);
    }
  }
  if (selectedKeys) {
    for (const key of selectedKeys) eligibleKeys.add(key);
  }
  const pending = attemptsForBrowserMode(
    selectableAttempts(attempts, { eligibleKeys, maySubmit, allowedAts, selectedKeys })
      .slice(0, Math.max(1, Number(max))),
    { tabPolicy },
  );
  const results = [];
  if (!pending.length) {
    const selected = selectedKeys
      ? attempts.filter(item => selectedKeys.has(item.idempotency_key))
      : [];
    const handshakeOnly = selected.some(item => item.ats === 'handshake') && tabPolicy !== 'owned';
    const unsupported = selected.find(item => item.state === 'NEEDS_REVIEW'
      && (item.blockers || []).some(blocker => blocker.code === 'UNSUPPORTED_PORTAL'));
    const message = handshakeOnly
      ? 'Handshake attempts require applications.main_profile CDP (handshake job/session); dedicated Chrome is not used'
      : unsupported
        ? `No runnable applications: #${unsupported.tracker_number} needs a certified ATS apply URL (host is not Workday/Greenhouse/Ashby/Lever/SuccessFactors)`
        : selected.length
          ? `No runnable applications among ${selected.length} selected attempt(s); check state, ATS allowlist, and eligibility`
          : 'No queued applications';
    note({ phase: 'idle', result: message });
    return { results, message };
  }
  let context;
  let ownsContext = false;
  if (existingSession?.context) {
    context = existingSession.context;
    note({
      phase: 'attach',
      result: maySubmit ? 'submit_enabled' : 'submit_disabled',
      title: `${pending.length} queued`,
    });
  } else {
    const profile = apps(config).chrome_profile_dir;
    if (!profile) throw configError('applications.chrome_profile_dir is required');
    note({
      phase: 'launch',
      result: maySubmit ? 'submit_enabled' : 'submit_disabled',
      title: `${pending.length} queued`,
    });
    context = await chromium.launchPersistentContext(resolve(profile), {
      // Prefer the installed Chrome channel. Unlike Playwright's bundled
      // Chromium it is present on the user's workstation and supports the same
      // persistent extension profile; local config may explicitly select another
      // installed channel for diagnostics.
      headless: false, channel: apps(config).chrome_channel || 'chrome',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`], viewport: { width: 1280, height: 1000 },
    });
    ownsContext = true;
  }
  const trimTabs = async (page) => {
    if (tabPolicy === 'owned') return;
    await keepOnlyApplicationPage(context, page);
  };
  try {
    let applicationPage = null;
    if (tabPolicy !== 'owned') attachSurplusTabCloser(context, () => applicationPage);
    let bridge = null;
    try {
      bridge = await extensionBridge(context);
      await seedExtensionData(bridge);
    } catch (error) {
      if (tabPolicy !== 'owned') throw error;
      bridge = null;
    }
    const starter = tabPolicy === 'owned'
      ? (existingSession?.page && !existingSession.page.isClosed() ? existingSession.page : null)
      : context.pages()[0];
    if (starter) {
      applicationPage = starter;
      await trimTabs(starter);
    }
    for (const queued of pending) {
      const latest = getAttempt(target, queued.idempotency_key);
      if (!latest || TERMINAL_ATTEMPT_STATES.has(latest.state)) continue;
      note({
        phase: 'start',
        tracker_number: queued.tracker_number,
        company: queued.company,
        title: queued.role,
      });
      const mfaOnly = isMfaOnlyResume(latest);
      let attempt = transitionAttempt(target, latest.idempotency_key, 'RUNNING');
      const resume = resumeFor(attempt, config);
      let liveHost = attempt.ats;
      if (skipNavigation && existingSession?.page && !existingSession.page.isClosed()) {
        try { liveHost = atsFor(existingSession.page.url()); } catch { liveHost = attempt.ats; }
      }
      if (resume.blocker && !mfaOnly && liveHost !== 'handshake') {
        note({
          phase: 'review',
          result: resume.blocker,
          company: attempt.company,
          tracker_number: attempt.tracker_number,
        });
        results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: resume.blocker }] }));
        continue;
      }
      let page;
      if (skipNavigation && existingSession?.page && !existingSession.page.isClosed()) {
        page = existingSession.page;
      } else if (tabPolicy === 'owned') {
        page = await context.newPage();
        existingSession?.ownedPages?.add(page);
      } else {
        page = context.pages()[0] || await context.newPage();
      }
      applicationPage = page;
      await trimTabs(page);
      try {
        const navigation = skipNavigation
          ? { status() { return 200; } }
          : await page.goto(attempt.canonical_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await trimTabs(page);
        if (!skipNavigation) await delay(1800);
        note({
          phase: 'open',
          tracker_number: attempt.tracker_number,
          company: attempt.company,
          title: attempt.role,
        });
        // Mandatory pre-fill liveness gate: expired URLs never reach prose or
        // submit; uncertain URLs become explicit review items.
        const liveness = await probePageLiveness(page, { status: navigation?.status() ?? 0 });
        const livenessPatch = livenessAttemptPatch(liveness);
        if (livenessPatch && !mfaOnly) {
          note({
            phase: 'blocked',
            result: livenessPatch.state,
            title: liveness.result,
            company: attempt.company,
            tracker_number: attempt.tracker_number,
          });
          results.push(transitionAttempt(target, attempt.idempotency_key, livenessPatch.state, {
            blockers: livenessPatch.blockers,
            artifacts: [await capture(page, target, attempt, 'liveness.png')],
          }));
          continue;
        }
        let liveAts = 'generic';
        try { liveAts = atsFor(page.url()); } catch { liveAts = 'generic'; }
        if (!bridge) {
          if (liveAts === 'handshake') {
            const native = await applyHandshakeNative(page, {
              maySubmit,
              certified: isCertifiedAts('handshake', config),
              skipClick: existingSession?.skipHandshakeClick === true,
              coverLetter: {
                target,
                config,
                reportId: attempt.report_id,
                trackerNumber: attempt.tracker_number,
              },
            });
            const next = await finishHandshakeNativeAttempt(target, attempt, config, page, native);
            note({ phase: 'done', result: next.state, company: attempt.company, tracker_number: attempt.tracker_number });
            results.push(next);
            continue;
          }
          results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
            blockers: [{ code: 'EXTENSION_MISSING', detail: 'Job Autofill is not loaded in this Chrome profile' }],
          }));
          continue;
        }
        if (!(mfaOnly && resume.blocker)) await seedResume(bridge, resume);
        await trimTabs(page);
        let inspected = await send(bridge, { type: 'inspect' }, page);
        if (!inspected.ok && liveAts === 'handshake') {
          const native = await applyHandshakeNative(page, {
            maySubmit,
            certified: isCertifiedAts('handshake', config),
            skipClick: existingSession?.skipHandshakeClick === true,
            coverLetter: {
              target,
              config,
              reportId: attempt.report_id,
              trackerNumber: attempt.tracker_number,
            },
          });
          const next = await finishHandshakeNativeAttempt(target, attempt, config, page, native);
          note({ phase: 'done', result: next.state, company: attempt.company, tracker_number: attempt.tracker_number });
          results.push(next);
          continue;
        }
        if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed');
        // A certified Workday posting is not the application itself. Advancing
        // through its exact Apply control is safe navigation, never final
        // submission; unfamiliar portals never receive this action.
        const enabledBoard = allowedAts.has(inspected.board);
        const boardCertified = enabledBoard && isCertifiedAts(inspected.board, config);
        if (!mfaOnly && boardCertified && inspected.fieldCount === 0 && !inspected.navigation?.login) {
          if (await openApplicationForm(page, inspected.board)) {
            // Workday offers a convenience path that may use an opaque,
            // previously stored Workday resume. Decline that convenience and
            // enter the manual flow so our configured, hash-verified resume is
            // the only document the extension can upload.
            const manual = await exactButton(page, /^\s*apply manually\s*$/i);
            if (manual) {
              await manual.click();
              await delay(1200);
            }
            inspected = await send(bridge, { type: 'inspect' }, page);
            if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed after Apply');
          }
        }
        const pageState = { ...inspected.navigation, certified: boardCertified, exactReviewPage: inspected.navigation.review };
        const initialAuthentication = authenticationBlocker(pageState);
        const resumeMfa = mfaOnly || (onlyMfaBlockers(initialAuthentication) && isOtpOnlySurface(inspected));
        if (initialAuthentication && !onlyMfaBlockers(initialAuthentication)) {
          note({
            phase: 'blocked',
            result: initialAuthentication.state,
            company: attempt.company,
            title: (initialAuthentication.blockers || []).map(item => item.code).filter(Boolean).slice(0, 4).join(','),
          });
          results.push(transitionAttempt(target, attempt.idempotency_key, initialAuthentication.state, {
            blockers: initialAuthentication.blockers,
            artifacts: [await capture(page, target, attempt, 'blocked.png')],
          }));
          continue;
        }
        if (resumeMfa) {
          if (!(await greenhouseOtpVisible(page)) && !onlyMfaBlockers(initialAuthentication)) {
            note({
              phase: 'blocked',
              result: 'WAITING_LOGIN',
              title: 'MFA_REQUIRED',
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            results.push(transitionAttempt(target, attempt.idempotency_key, 'WAITING_LOGIN', {
              blockers: [{ code: 'MFA_REQUIRED', detail: 'OTP_UI_MISSING' }],
              artifacts: [await capture(page, target, attempt, 'authentication.png')],
            }));
            continue;
          }
          note({
            phase: 'blocked',
            result: 'WAITING_LOGIN',
            title: 'MFA_REQUIRED',
            company: attempt.company,
            tracker_number: attempt.tracker_number,
          });
          attempt = transitionAttempt(target, attempt.idempotency_key, 'SUBMITTING');
          const networkEvidence = [];
          const networkObservations = [];
          const observeResponse = response => {
            const evidence = submissionNetworkEvidence(attempt, response);
            if (evidence) networkEvidence.push(evidence);
            const request = response.request();
            if (request.method() === 'POST') networkObservations.push({
              status: response.status(),
              url: response.url().slice(0, 500),
            });
          };
          page.on('response', observeResponse);
          const otp = await completeEmailVerification({
            page, target, attempt, config, bridge, oneTimeCode, pauseForAuthentication: true, note,
          });
          let confirmation = otp.confirmation || { navigation: {} };
          if (!confirmation.navigation) confirmation.navigation = {};
          confirmation.navigation = applyPostOtpEmailVerificationFlag(confirmation.navigation, {
            emailVerificationRequired: requiresEmailVerification(attempt, networkObservations),
            remaining: otp.remaining,
            successVisible: await greenhouseSubmissionSuccessVisible(page),
          });
          if (confirmation.navigation.submissionRejected) {
            page.off('response', observeResponse);
            note({
              phase: 'done',
              result: 'SUBMISSION_REJECTED',
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
              blockers: [{ code: 'SUBMISSION_REJECTED', detail: 'The ATS explicitly rejected the submission after the submit click.' }],
              submission_evidence: { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-visible-rejection' },
              artifacts: [await capture(page, target, attempt, 'rejected.png')],
            }));
            continue;
          }
          const remainingAuthentication = otp.remaining && !confirmation.navigation.success
            ? otp.remaining
            : authenticationBlocker(confirmation.navigation);
          if (remainingAuthentication && !confirmation.navigation.success) {
            page.off('response', observeResponse);
            const remainingBlockers = otp.mfaAction
              ? remainingAuthentication.blockers.map(blocker => ({ ...blocker, detail: otp.mfaAction }))
              : remainingAuthentication.blockers;
            note({
              phase: 'blocked',
              result: remainingAuthentication.state,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            results.push(transitionAttempt(target, attempt.idempotency_key, remainingAuthentication.state, {
              blockers: remainingBlockers,
              artifacts: [await capture(page, target, attempt, 'authentication.png')],
            }));
            continue;
          }
          page.off('response', observeResponse);
          const evidence = confirmation.navigation?.success
            ? { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-text' }
            : networkEvidence[0] || null;
          if (!evidence) {
            const diagnosticPath = artifactPath(target, attempt, 'submission-unknown-diagnostic.json');
            writeFileSync(diagnosticPath, JSON.stringify({
              schema: 'ApplicationSubmissionDiagnosticV1',
              schema_version: 1,
              click_method: 'mfa-resume',
              observed_url: page.url(),
              navigation: confirmation.navigation || {},
              post_responses: networkObservations,
            }, null, 2));
            results.push(transitionAttempt(target, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', {
              submission_evidence: { url: page.url(), observed_at: new Date().toISOString() },
              artifacts: [diagnosticPath, await capture(page, target, attempt, 'unknown.png')],
            }));
            note({ phase: 'done', result: 'SUBMISSION_UNKNOWN', company: attempt.company, tracker_number: attempt.tracker_number });
            continue;
          }
          const appliedAt = new Date();
          await markApplied(target, attempt.tracker_number, attempt.attempt_id, appliedAt, apps(config).time_zone);
          const submittedArtifact = await capture(page, target, attempt, 'submitted.png');
          let recordArtifacts = [];
          let recordBlockers = [];
          try {
            const recorded = recordAppliedArtifacts(target, attempt, {
              postingText: '', appliedAt, timeZone: apps(config).time_zone, sourceUrl: page.url(),
            });
            recordArtifacts = [recorded.archive_path];
          } catch (error) {
            recordBlockers = [{ code: 'VALIDATION_ERROR', detail: `Application submitted, but local report/JD reconciliation failed: ${String(error.message).slice(0, 180)}` }];
          }
          results.push(transitionAttempt(target, attempt.idempotency_key, 'SUBMITTED', {
            submission_evidence: evidence, blockers: recordBlockers, artifacts: [submittedArtifact, ...recordArtifacts],
          }));
          note({
            phase: 'done',
            result: 'SUBMITTED',
            company: attempt.company,
            title: attempt.role,
            tracker_number: attempt.tracker_number,
          });
          continue;
        }
        if (enabledBoard && await revealGreenhouseCoverLetter(page, inspected, config)) {
          inspected = await send(bridge, { type: 'inspect' }, page);
          if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed after revealing cover letter');
        }
        // Certified adapters may advance only through an exact Next/Continue
        // control.  Generic portals are deliberately left on their current
        // page for review; the runner never explores an unfamiliar flow.
        let filled;
        const maxSteps = Math.max(1, Math.min(12, Number(apps(config).max_steps || 8)));
        for (let step = 1; step <= maxSteps; step++) {
          note({
            phase: 'fill',
            step,
            done: step,
            total: maxSteps,
            tracker_number: attempt.tracker_number,
            company: attempt.company,
            title: attempt.role,
          });
          filled = await send(bridge, { type: 'fillOverrides', overrides: [], resumeKind: resume.kind }, page);
          if (!filled.ok) throw new Error(filled.error || 'Extension fill failed');
          inspected = await send(bridge, { type: 'inspect' }, page);
          // A controlled select/radio can accept the first generic fill then
          // lose its selected state during the ATS' re-render. Retry only a
          // still-empty, required deterministic field using the exact same
          // approved local answer bank; no prose or model is involved.
          const deterministicOverrides = approvedDeterministicOverrides(inspected.fields);
          if (deterministicOverrides.length) {
            const retried = await send(bridge, { type: 'fillOverrides', overrides: deterministicOverrides, resumeKind: resume.kind }, page);
            if (!retried.ok) throw new Error(retried.error || 'Extension deterministic retry failed');
            inspected = await send(bridge, { type: 'inspect' }, page);
          }
          if (inspected.navigation?.login || inspected.navigation?.mfa || inspected.navigation?.captcha) break;
          if (!boardCertified || !inspected.navigation?.hasNext || inspected.navigation?.review) break;
          const next = await exactButton(page, /^\s*(?:next|continue|save and continue)\s*$/i);
          if (!next) break;
          await next.click();
          await waitForFieldStability(page);
          attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', { step });
        }
        let generated = [];
        let generationBlockers = [];
        // A generated answer belongs only in an actual text response. A cover
        // letter *upload* is a document slot, never prose authority; feeding
        // it to a model cannot attach a file and must not consume local-model
        // capacity.
        // An exact stored answer of "No" to an AI-use disclosure can only be
        // truthful when this application contains no generated prose or
        // prospective compensation.  In that mode we still complete every
        // deterministic field, but leave remaining bespoke fields for review.
        const priorGenerated = Array.isArray(attempt.answers) ? attempt.answers : [];
        const hasAiDisclosure = (inspected.fields || []).some(field => fieldRisk(field.question) === 'AI_DISCLOSURE');
        const custom = hasAiDisclosure ? [] : (inspected.fields || []).filter(field => {
          if (field.type === 'file' || field.current_value) return false;
          if (field.risk === 'CUSTOM_PROSE') return true;
          return field.required === true
            && field.risk === 'LOW'
            && ['text', 'textarea'].includes(field.type)
            && /why (?:do you|are you)|describe |tell us |motivat|cover letter/i.test(field.question || '');
        });
        if (custom.length) {
          const reused = reusableGeneratedAnswers(priorGenerated, custom);
          const reusedIds = new Set(reused.map(answer => answer.field_id));
          if (reused.length) {
            note({
              phase: 'prose',
              result: `reused ${reused.length} prior answers`,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            const overrideResponse = await send(bridge, { type: 'fillOverrides', resumeKind: resume.kind, overrides: reused.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) }, page);
            if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension generated-answer fill failed');
            inspected = await send(bridge, { type: 'readback' }, page);
            for (const answer of reused) {
              const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
              if (filledValueMatches(field?.current_value, answer.text)) {
                generated.push(answer);
              } else {
                reusedIds.delete(answer.field_id);
              }
            }
          }
          const remainingCustom = custom.filter(field => !reusedIds.has(field.field_id));
          if (remainingCustom.length) {
            note({
              phase: 'prose',
              result: `${remainingCustom.length} custom fields`,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            const evidence = answerEvidence(target, attempt, config);
            if (!evidence.length) generationBlockers = [{ code: 'NO_QUALIFIED_PROVIDER', detail: 'No trusted local evidence configured for custom prose' }];
            else {
              const result = await generateBoundedAnswers({
                questions: remainingCustom, evidence, runtimeConfig: config,
                voiceProfile: applicationVoiceProfile(),
              });
              if (result.blocker) generationBlockers = [{ code: result.blocker === 'QUOTA_UNAVAILABLE' ? 'QUOTA_UNAVAILABLE' : 'NO_QUALIFIED_PROVIDER', detail: result.detail || result.route?.reason || result.blocker }];
              else {
                generated = [...generated, ...result.answers];
                const overrideResponse = await send(bridge, { type: 'fillOverrides', resumeKind: resume.kind, overrides: result.answers.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) }, page);
                if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension generated-answer fill failed');
                inspected = await send(bridge, { type: 'readback' }, page);
                for (const answer of result.answers) {
                  const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
                  if (!filledValueMatches(field?.current_value, answer.text)) {
                    generationBlockers.push({ code: 'VALIDATION_ERROR', question: field?.question || answer.field_id, detail: 'Generated answer did not survive form readback' });
                  }
                }
                attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', {
                  answers: mergeAttemptAnswers(priorGenerated, generated),
                  provider_usage: [...(attempt.provider_usage || []), result.usage || {}],
                });
              }
            }
          } else if (generated.length) {
            attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', {
              answers: mergeAttemptAnswers(priorGenerated, generated),
            });
          }
        }
        // Current-compensation questions are purposely left blank. Other
        // salary prompts receive an individualized *future preference* from
        // the qualified local model, with the configured Antigravity-only
        // fallback. They never read or reuse a global salary-bank answer.
        const salary = hasAiDisclosure ? [] : (inspected.fields || []).filter(field => fieldRisk(field.question) === 'SALARY'
          && field.type !== 'file' && !field.current_value);
        if (salary.length) {
          const reusedSalary = alignedSalaryAnswers(reusableGeneratedAnswers(priorGenerated, salary), salary);
          const reusedSalaryIds = new Set(reusedSalary.map(answer => answer.field_id));
          if (reusedSalary.length) {
            note({
              phase: 'salary',
              result: `reused ${reusedSalary.length} prior answers`,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            const overrideResponse = await send(bridge, { type: 'fillOverrides', resumeKind: resume.kind, overrides: reusedSalary.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) }, page);
            if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension salary-preference fill failed');
            inspected = await send(bridge, { type: 'readback' }, page);
            const accepted = new Map((overrideResponse.overrideResults || []).map(item => [item.field_id, item]));
            for (const answer of reusedSalary) {
              const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
              const live = accepted.get(answer.field_id);
              if (filledValueMatches(field?.current_value, answer.text) || live?.accepted) {
                generated.push(answer);
              } else {
                reusedSalaryIds.delete(answer.field_id);
              }
            }
          }
          const remainingSalary = salary.filter(field => !reusedSalaryIds.has(field.field_id));
          if (remainingSalary.length) {
            note({
              phase: 'salary',
              result: `${remainingSalary.length} salary fields`,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            const evidence = answerEvidence(target, attempt, config);
            if (!evidence.length) generationBlockers.push({ code: 'NO_QUALIFIED_PROVIDER', detail: 'No trusted local evidence configured for salary preference' });
            else {
              const result = await generateSalaryPreferences({ questions: remainingSalary, evidence, runtimeConfig: config });
              if (result.blocker) generationBlockers.push({ code: result.blocker === 'QUOTA_UNAVAILABLE' ? 'QUOTA_UNAVAILABLE' : 'NO_QUALIFIED_PROVIDER', question: remainingSalary[0]?.question });
              else {
                const salaryAnswers = alignedSalaryAnswers(result.answers || [], remainingSalary);
                generated = [...generated, ...salaryAnswers];
                const overrideResponse = await send(bridge, { type: 'fillOverrides', resumeKind: resume.kind, overrides: salaryAnswers.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) }, page);
                if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension salary-preference fill failed');
                inspected = await send(bridge, { type: 'readback' }, page);
                const accepted = new Map((overrideResponse.overrideResults || []).map(item => [item.field_id, item]));
                for (const answer of salaryAnswers) {
                  const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
                  const live = accepted.get(answer.field_id);
                  if (filledValueMatches(field?.current_value, answer.text) || live?.accepted) continue;
                  generationBlockers.push({ code: 'VALIDATION_ERROR', question: field?.question || answer.field_id, detail: 'Salary preference did not survive form readback' });
                }
                attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', {
                  answers: mergeAttemptAnswers(priorGenerated, generated),
                  provider_usage: [...(attempt.provider_usage || []), result.usage || {}],
                });
              }
            }
          } else if (generated.length) {
            attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', {
              answers: mergeAttemptAnswers(priorGenerated, generated),
            });
          }
        }
        if (!mfaOnly && inspected.board === 'greenhouse') {
          const recovered = await attachCertifiedResume(page, resume, inspected.board);
          if (recovered) filled = { ...(filled || {}), resume: { name: recovered.name, sha256: recovered.hash } };
        }
        const onFormOtp = (inspected.fields || []).some(field => isOtpVerificationQuestion(field.question));
        if (!mfaOnly && onFormOtp) {
          const otpBaseline = otpFilledPayload(await inspectOtpFields(page));
          const otpDeadline = Date.now() + 45_000;
          while (Date.now() < otpDeadline) {
            const delivered = await fetchPersonalGmailOtp(target, attempt, config, { once: true, notBeforeMs: Date.now() - 10 * 60_000 });
            if (delivered.code) {
              const codeFill = await fillOneTimeCode(page, delivered.code);
              if (codeFill.filled) break;
            }
            const current = await inspectOtpFields(page);
            if (otpChangedFromBaseline(current, otpBaseline)) break;
            await delay(4000);
          }
        }
        const readback = await send(bridge, { type: 'readback' }, page);
        if (!readback.ok) throw new Error(readback.error || 'Extension final readback failed');
        inspected = readback;
        const attachedResume = await observedResume(page, readback, resume, filled);
        const nativeValidation = await formValidation(page);
        const nativeErrors = new Set(nativeValidation.errors.map(normalizeIdentity));
        const fillReceipt = new Map((filled?.fields || []).map(field => [field.field_id, field]));
        const fields = (inspected.fields || []).map(field => {
          // Greenhouse labels both upload controls "Attach". The extension
          // resolves the actual input role from local DOM identifiers before
          // producing this redacted descriptor, so the gate never mistakes a
          // cover-letter slot for a resume or loses a valid generic label.
          const isVerifiedResume = field.file_role === 'resume' && attachedResume.hash === resume.hash;
          const receipt = fillReceipt.get(field.field_id);
          // React occasionally clears an input's `value` during an extension
          // readback even though the live native control remains valid.  For
          // ordinary required fields only, retain the just-recorded extension
          // receipt when that independent form check says the named control is
          // valid. Legal/sensitive fields never take this recovery path.
          const stableValue = field.required === true && field.risk !== 'DETERMINISTIC_ONLY'
            && !field.current_value && receipt?.current_value
            && !nativeErrors.has(normalizeIdentity(field.question))
            ? receipt.current_value : field.current_value;
          const generatedAnswer = generated.find(answer => answer.field_id === field.field_id
            && answer.text === stableValue);
          return {
            ...field,
            value: isVerifiedResume ? '[attached]' : stableValue,
            provenance: isVerifiedResume ? 'deterministic'
              : generatedAnswer?.provenance || (stableValue ? 'deterministic' : null),
            claims_validated: generatedAnswer?.claims_validated === true,
            salary_validated: generatedAnswer?.salary_validated === true,
          };
        });
        const identity = await pageIdentity(page);
        const postingText = await page.evaluate(() => {
          const clone = document.body?.cloneNode(true);
          if (!clone) return '';
          for (const el of clone.querySelectorAll('form, input, select, textarea, button, iframe, script, style, noscript')) el.remove();
          return String(clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        });
        // Greenhouse and Ashby have a single final form rather than a separate
        // Review step. It counts as exact only when the current canonical
        // posting, heading, and employer identity all match the queued row.
        // Other adapters retain their explicit Review-screen requirement.
        const exactReviewPage = inspected.navigation.review
          || exactSinglePageFinal(inspected, attempt, identity);
        const gate = submissionGate({ page: { ...inspected.navigation, certified: boardCertified, exactReviewPage }, fields, resume: attachedResume, generated });
        if (!nativeValidation.found) gate.blockers.push({ code: 'UNSUPPORTED_PORTAL', question: 'Application form not found' });
        for (const question of nativeValidation.errors) {
          // Ashby replaces its required resume input after acceptance, leaving
          // the replacement empty while its visual receipt remains. The
          // extension receipt plus rendered filename/hash check above is the
          // stronger verification for that one control.
          if (/^resume\b/i.test(question) && attachedResume.hash === resume.hash) continue;
          if (redundantNativeChoiceError(fields, question)) continue;
          gate.blockers.push({ code: 'VALIDATION_ERROR', question });
        }
        // A framework can keep required state outside native controls.  The
        // exact, enabled submit button is therefore the final browser-side
        // completeness check even during a submit-disabled canary.
        const submitControl = await exactButton(page, /^\s*submit(?: application)?\s*$/i);
        if (!submitControl) gate.blockers.push({ code: 'VALIDATION_ERROR', question: 'Submit control is not enabled' });
        gate.blockers.push(...generationBlockers);
        gate.blockers = gate.blockers.filter((blocker, index, all) =>
          all.findIndex(other => other.code === blocker.code && other.question === blocker.question) === index);
        gate.permitted = gate.blockers.length === 0;
        const manifest = {
          canonical_url: attempt.canonical_url,
          tracker_number: attempt.tracker_number,
          resume: { kind: resume.kind, hash: attachedResume.hash, expected_hash: resume.hash },
          // A manifest is an audit artifact, never a copy of application data.
          fields: fields.map(({ field_id, question, type, file_role, required, risk, constraints, options, value }) => ({
            field_id, question, type, file_role, required, risk, constraints, options, present: Boolean(value),
          })),
        };
        const manifestPath = artifactPath(target, attempt, 'pre-submit-manifest.json');
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        if (!gate.permitted) {
          note({
            phase: 'review',
            result: 'NEEDS_REVIEW',
            company: attempt.company,
            title: (gate.blockers || []).map(item => item.code).filter(Boolean).slice(0, 6).join(','),
            tracker_number: attempt.tracker_number,
          });
          results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: gate.blockers, selected_resume: { kind: resume.kind, hash: attachedResume.hash, expected_hash: resume.hash }, artifacts: [manifestPath, await capture(page, target, attempt, 'review.png')] }));
          continue;
        }
        const reviewArtifact = await capture(page, target, attempt, 'review.png');
        attempt = transitionAttempt(target, attempt.idempotency_key, 'READY_TO_SUBMIT', { selected_resume: { kind: resume.kind, hash: attachedResume.hash, expected_hash: resume.hash }, artifacts: [manifestPath, reviewArtifact] });
        if (!maySubmit) {
          note({ phase: 'ready', result: 'submit_disabled', company: attempt.company, tracker_number: attempt.tracker_number });
          results.push(attempt); continue;
        }
        const button = await exactButton(page, /^\s*submit(?: application)?\s*$/i);
        if (!button) {
          note({
            phase: 'review',
            result: 'UNSUPPORTED_PORTAL',
            company: attempt.company,
            tracker_number: attempt.tracker_number,
          });
          results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: 'UNSUPPORTED_PORTAL' }] }));
          continue;
        }
        note({
          phase: 'submit',
          company: attempt.company,
          title: attempt.role,
          tracker_number: attempt.tracker_number,
        });
        attempt = transitionAttempt(target, attempt.idempotency_key, 'SUBMITTING');
        const networkEvidence = [];
        const networkObservations = [];
        const observeResponse = response => {
          const evidence = submissionNetworkEvidence(attempt, response);
          if (evidence) networkEvidence.push(evidence);
          const request = response.request();
          if (request.method() === 'POST') networkObservations.push({
            status: response.status(),
            url: response.url().slice(0, 500),
          });
        };
        page.on('response', observeResponse);
        const otpMailNotBefore = Date.now() - 10 * 60_000;
        const clickMethod = await clickFinalSubmit(page, button);
        // A success response is frequently accompanied by a client-side route
        // change. Wait long enough for it, but never keep a live application
        // page open indefinitely; anything ambiguous remains non-retryable.
        await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(document.body?.innerText || ''), { timeout: 7500 }).catch(() => {});
        let confirmation = await send(bridge, { type: 'inspect' }, page).catch(() => ({ navigation: {} }));
        // An ATS can reply 200 while rendering an explicit rejection (notably
        // anti-spam screens).  DOM rejection is therefore authoritative and
        // never reaches either the success transition or tracker writer.
        if (confirmation.navigation?.submissionRejected) {
          note({
            phase: 'done',
            result: 'SUBMISSION_REJECTED',
            company: attempt.company,
            tracker_number: attempt.tracker_number,
          });
          results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
            blockers: [{ code: 'SUBMISSION_REJECTED', detail: 'The ATS explicitly rejected the submission after the submit click.' }],
            submission_evidence: { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-visible-rejection' },
            artifacts: [await capture(page, target, attempt, 'rejected.png')],
          }));
          continue;
        }
        // Some ATSes request a one-time email/security code only after the
        // candidate clicks Submit. This is a resumable authentication state,
        // not a submission result. Email is never accessed here; an explicit
        // short-lived handoff may provide a code through process memory.
        // Trust the certified adapter's top-level navigation state. Scanning
        // arbitrary iframe text here misclassified Greenhouse's reCAPTCHA
        // provider frame (which contains identity-verification language) as
        // an email OTP screen even though the completed application form was
        // still visible. Real Greenhouse OTP UI is surfaced in the top-level
        // page, including its closed-shadow-root variant handled below.
        if (!confirmation.navigation) confirmation.navigation = {};
        if (requiresEmailVerification(attempt, networkObservations)) confirmation.navigation.mfa = true;
        const postSubmitAuthentication = authenticationBlocker(confirmation.navigation)
          || ((await greenhouseOtpVisible(page)) ? { state: 'WAITING_LOGIN', blockers: [{ code: 'MFA_REQUIRED' }] } : null);
        if (postSubmitAuthentication) {
          note({
            phase: 'blocked',
            result: postSubmitAuthentication.state,
            title: (postSubmitAuthentication.blockers || []).map(item => item.code).filter(Boolean).slice(0, 4).join(','),
            company: attempt.company,
            tracker_number: attempt.tracker_number,
          });
          const otp = await completeEmailVerification({
            page, target, attempt, config, bridge, oneTimeCode, pauseForAuthentication: true, note,
            mailNotBefore: otpMailNotBefore,
          });
          confirmation = otp.confirmation || confirmation;
          if (!confirmation.navigation) confirmation.navigation = {};
          confirmation.navigation = applyPostOtpEmailVerificationFlag(confirmation.navigation, {
            emailVerificationRequired: requiresEmailVerification(attempt, networkObservations),
            remaining: otp.remaining,
            successVisible: await greenhouseSubmissionSuccessVisible(page),
          });
          if (confirmation.navigation.submissionRejected) {
            note({
              phase: 'done',
              result: 'SUBMISSION_REJECTED',
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
              blockers: [{ code: 'SUBMISSION_REJECTED', detail: 'The ATS explicitly rejected the submission after the submit click.' }],
              submission_evidence: { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-visible-rejection' },
              artifacts: [await capture(page, target, attempt, 'rejected.png')],
            }));
            continue;
          }
          const remainingAuthentication = otp.remaining && !confirmation.navigation.success
            ? otp.remaining
            : authenticationBlocker(confirmation.navigation);
          if (remainingAuthentication && !confirmation.navigation.success) {
            const remainingBlockers = otp.mfaAction
              ? remainingAuthentication.blockers.map(blocker => ({ ...blocker, detail: otp.mfaAction }))
              : remainingAuthentication.blockers;
            note({
              phase: 'blocked',
              result: remainingAuthentication.state,
              company: attempt.company,
              tracker_number: attempt.tracker_number,
            });
            results.push(transitionAttempt(target, attempt.idempotency_key, remainingAuthentication.state, {
              blockers: remainingBlockers,
              artifacts: [await capture(page, target, attempt, 'authentication.png')],
            }));
            continue;
          }
        }
        page.off('response', observeResponse);
        const evidence = confirmation.navigation?.success
          ? { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-text' }
          : networkEvidence[0] || null;
        if (!evidence) {
          const postClickValidation = await formValidation(page).catch(() => ({ found: false, errors: [] }));
          const diagnosticPath = artifactPath(target, attempt, 'submission-unknown-diagnostic.json');
          writeFileSync(diagnosticPath, JSON.stringify({
            schema: 'ApplicationSubmissionDiagnosticV1',
            schema_version: 1,
            click_method: clickMethod,
            observed_url: page.url(),
            navigation: confirmation.navigation || {},
            post_click_validation: postClickValidation,
            post_responses: networkObservations,
          }, null, 2));
          results.push(transitionAttempt(target, attempt.idempotency_key, 'SUBMISSION_UNKNOWN', { submission_evidence: { url: page.url(), observed_at: new Date().toISOString() }, artifacts: [diagnosticPath, await capture(page, target, attempt, 'unknown.png')] }));
          note({ phase: 'done', result: 'SUBMISSION_UNKNOWN', company: attempt.company, tracker_number: attempt.tracker_number });
          continue;
        }
        const appliedAt = new Date();
        await markApplied(target, attempt.tracker_number, attempt.attempt_id, appliedAt, apps(config).time_zone);
        const submittedArtifact = await capture(page, target, attempt, 'submitted.png');
        let recordArtifacts = [];
        let recordBlockers = [];
        try {
          const recorded = recordAppliedArtifacts(target, attempt, {
            postingText, appliedAt, timeZone: apps(config).time_zone, sourceUrl: identity.url,
          });
          recordArtifacts = [recorded.archive_path];
        } catch (error) {
          recordBlockers = [{ code: 'VALIDATION_ERROR', detail: `Application submitted, but local report/JD reconciliation failed: ${String(error.message).slice(0, 180)}` }];
        }
        results.push(transitionAttempt(target, attempt.idempotency_key, 'SUBMITTED', {
          submission_evidence: evidence, blockers: recordBlockers, artifacts: [submittedArtifact, ...recordArtifacts],
        }));
        note({
          phase: 'done',
          result: 'SUBMITTED',
          company: attempt.company,
          title: attempt.role,
          tracker_number: attempt.tracker_number,
        });
      } catch (error) {
        note({
          phase: 'error',
          result: String(error.message || error).slice(0, 200),
          company: attempt?.company || queued.company,
          tracker_number: queued.tracker_number,
        });
        results.push(transitionAttempt(target, attempt.idempotency_key, 'FAILED', { blockers: [{ code: 'VALIDATION_ERROR', detail: String(error.message).slice(0, 300) }] }));
      } finally {
        applicationPage = context.pages().includes(page) ? page : context.pages()[0] || null;
      }
    }
  } finally {
    if (ownsContext) await context.close();
  }
  return { results };
}

export async function runQueuedAttemptOnPage(target, config, options = {}) {
  const existing = {
    tabPolicy: 'owned',
    ...(options.existingSession || {}),
    context: options.existingSession?.context || options.context,
    page: options.existingSession?.page || options.page,
    ownedPages: options.existingSession?.ownedPages || options.ownedPages,
    skipHandshakeClick: options.existingSession?.skipHandshakeClick ?? options.skipHandshakeClick,
  };
  return runApplications(target, config, {
    ...options,
    existingSession: existing,
    skipNavigation: options.skipNavigation !== false,
    max: options.max || 1,
  });
}
