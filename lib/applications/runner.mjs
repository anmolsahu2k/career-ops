import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { candidateForTrackerNumber, eligibleRows } from './eligibility.mjs';
import { fieldRisk, submissionGate } from './policy.mjs';
import { confirmUnknownNotSubmitted, getAttempt, listAttempts, queueAttempt, transitionAttempt } from './store.mjs';
import { TERMINAL_ATTEMPT_STATES } from './contracts.mjs';
import { markApplied, recordAppliedArtifacts } from './tracker.mjs';
import { generateBoundedAnswers, generateSalaryPreferences } from './answers.mjs';
import { applicationVoiceProfile } from './voice.mjs';
import { cleanupApplicationArtifacts } from './retention.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';

const EXTENSION = resolve('extensions/job-autofill');
const EXTENSION_SEED = resolve(EXTENSION, 'data', 'answers.json');
const OTP_READER = resolve('scripts/stage-ats-otp.py');
const CERTIFIED = new Set(['workday', 'greenhouse', 'ashby', 'lever', 'successfactors']);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function apps(config) { return config.applications || {}; }
/** The configuration is the active portal rollout, not merely documentation.
 * A queued attempt for a deferred board remains visible on the review board but
 * is never opened by the unattended runner until the board is explicitly
 * enabled locally. */
export function enabledAts(config = {}) {
  const configured = apps(config).supported_ats;
  if (!Array.isArray(configured)) return new Set();
  return new Set(configured.filter(ats => typeof ats === 'string' && CERTIFIED.has(ats)));
}

/** Pure selection gate kept separate from browser launch so a deferred portal
 * can be proven not to reach navigation in tests. */
export function selectableAttempts(attempts, {
  eligibleKeys = new Set(), maySubmit = false, allowedAts = new Set(), selectedKeys = null,
} = {}) {
  return attempts.filter(item => (item.state === 'QUEUED' || (maySubmit && item.state === 'READY_TO_SUBMIT'))
    && eligibleKeys.has(item.idempotency_key)
    && allowedAts.has(item.ats)
    && (!selectedKeys || selectedKeys.has(item.idempotency_key)));
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
  let answers = {};
  try { answers = JSON.parse(readFileSync(EXTENSION_SEED, 'utf8')).answers || {}; }
  catch { return []; }
  return fields
    .filter(field => field.required === true && field.risk === 'DETERMINISTIC_ONLY' && !field.current_value)
    .map(field => {
      const value = approvedAnswer(field.normalized_question || field.question, answers);
      return value ? { field_id: field.field_id, value, provenance: 'deterministic-retry' } : null;
    })
    .filter(Boolean);
}
function atsFor(url) {
  const host = new URL(url).hostname;
  if (/\.myworkday(?:jobs|site)\.com$/i.test(host)) return 'workday';
  if (/(^|\.)greenhouse\.io$/i.test(host) || /^grnh\.se$/i.test(host)) return 'greenhouse';
  if (/ashbyhq\.com$/i.test(host)) return 'ashby';
  if (/lever\.co$/i.test(host)) return 'lever';
  if (/successfactors\.(?:com|eu)$|sapsf\.(?:com|eu)$/i.test(host)) return 'successfactors';
  return 'generic';
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
async function extensionId(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return new URL(worker.url()).host;
}
async function send(optionsPage, message) {
  return optionsPage.evaluate(async msg => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.filter(t => /^https?:/.test(t.url || '')).at(-1);
    if (!tab) return { ok: false, error: 'application tab not found' };
    // The runner operates full-page, certified ATS flows. Sending to every
    // frame lets an unrelated CAPTCHA/analytics frame race the actual form and
    // return an empty descriptor set. Pinning to frame 0 makes readback and
    // filling refer to the same application document.
    try { return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }); }
    catch (error) { return { ok: false, error: String(error) }; }
  }, message);
}
async function seedResume(optionsPage, resume) {
  const base64 = readFileSync(resume.path).toString('base64');
  const receipt = await optionsPage.evaluate(async ({ kind, base64, name }) => {
    const { setResume, getResumeFor } = await import('../content/store.js');
    await setResume({ name, type: 'application/pdf', base64 }, kind);
    const stored = await getResumeFor(kind);
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
async function seedExtensionData(optionsPage) {
  if (!existsSync(EXTENSION_SEED)) throw configError('Job Autofill seed data is missing');
  let seed;
  try { seed = JSON.parse(readFileSync(EXTENSION_SEED, 'utf8')); }
  catch { throw configError('Job Autofill seed data is not valid JSON'); }
  return optionsPage.evaluate(async data => {
    const { importData } = await import('../content/store.js');
    // Never replace captured/manual corrections already made in the dedicated
    // application profile. The repo seed merely initializes a fresh profile.
    return importData(data, { replaceAll: false });
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
async function observedResume(page, readback, expected, fillReport = null) {
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

async function pageIdentity(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title || '',
    heading: document.querySelector('h1')?.textContent || '',
    // Identity only, never form values.  The bounded text keeps this an audit
    // check rather than a duplicate store of a candidate's application.
    text: (document.body?.innerText || '').slice(0, 8000),
  }));
}

function isOfficialGreenhouseBoard(hostname) {
  return /^(?:boards|job-boards)\.greenhouse\.io$/i.test(String(hostname || ''));
}

function isOfficialGreenhouseShortLink(hostname) {
  return /^grnh\.se$/i.test(String(hostname || ''));
}

export function exactSinglePageFinal(inspected, attempt, identity) {
  if (!['greenhouse', 'ashby'].includes(inspected.board) || !inspected.navigation?.hasSubmit) return false;
  const current = new URL(identity.url);
  const expected = new URL(attempt.canonical_url);
  const expectedPath = inspected.board === 'ashby'
    ? `${expected.pathname.replace(/\/$/, '')}/application`
    : expected.pathname;
  // Greenhouse canonical application links commonly redirect from
  // boards.greenhouse.io to job-boards.greenhouse.io. Both are official
  // Greenhouse hosts, so allow only that exact host pair; all other cross-origin
  // redirects remain a hard rejection even if their page text copies the role.
  const sameOfficialGreenhouse = inspected.board === 'greenhouse'
    && isOfficialGreenhouseBoard(current.hostname)
    && isOfficialGreenhouseBoard(expected.hostname);
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
  if ((!sameOfficialGreenhouse && !officialShortLinkRedirect && current.origin !== expected.origin)
    || (!officialShortLinkRedirect && current.pathname !== expectedPath)) return false;
  if (normalizeIdentity(identity.heading) !== normalizeIdentity(attempt.role)) return false;
  const pageText = normalizeIdentity(`${identity.title} ${identity.text}`);
  const company = normalizeIdentity(attempt.company);
  const companyHead = company.split(' ').find(token => token.length >= 3);
  return pageText.includes(company) || Boolean(companyHead && pageText.includes(companyHead));
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
    const labelFor = el => {
      const direct = el.labels?.[0]?.textContent;
      if (direct) return direct.replace(/[*✱∗]/g, '').trim();
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const labelled = ids.map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      return labelled || el.getAttribute('aria-label') || el.id || el.name || 'Required field';
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
        // a same-name "check all that apply" group.  Treat it as the semantic
        // group the page presents, so the audit board reports one actionable
        // question rather than nine misleading option-level failures.  We do
        // not use this to override a browser rejection at submit time.
        const key = `${el.type}:${el.name || el.id}`;
        if (seenChoiceGroups.has(key)) continue;
        seenChoiceGroups.add(key);
        const members = [...form.querySelectorAll('input')]
          .filter(member => member.type === el.type && (el.name ? member.name === el.name : member === el));
        const present = members.some(member => member.checked);
        if (!present || el.getAttribute('aria-invalid') === 'true') errors.push(labelFor(el));
        continue;
      }
      const present = el.type === 'file' ? Boolean(el.files?.length) : Boolean(el.value?.trim() || hasReactSelection(el));
      if (!present || el.validity?.valid === false || el.getAttribute('aria-invalid') === 'true') errors.push(labelFor(el));
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
export async function revealGreenhouseCoverLetter(page, inspected, config) {
  if (inspected?.board !== 'greenhouse' || apps(config).local_prose?.cover_letters !== true) return false;
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
  return observations.some(item => Number(item?.status) === 428
    && /(^|\.)greenhouse\.io$/i.test(new URL(item.url).hostname)
    && /\/jobs\/\d+/i.test(new URL(item.url).pathname));
}

export function enqueueEligible(target, { includeCurrent = false, trackerNumbers = null } = {}) {
  const rows = eligibleRows(target);
  const queued = [];
  const blocked = [];
  const allowed = trackerNumbers ? new Set([...trackerNumbers].map(Number)) : null;
  for (const candidate of rows) {
    if (allowed && !allowed.has(candidate.row.num)) continue;
    if (!candidate.eligible) { blocked.push({ tracker_number: candidate.row.num, blocker: candidate.blocker }); continue; }
    const result = attemptFromCandidate(target, candidate);
    // Discovery provenance is not application-surface certification. Some
    // employers publish a Greenhouse feed yet send candidates to a separate
    // hosted workflow. Do not leave those records indefinitely QUEUED where
    // the ATS allowlist silently excludes them. They are useful review-board
    // items, but cannot be opened or submitted by the certified runner.
    const unsupported = result.attempt.ats === 'generic' && result.attempt.state === 'QUEUED';
    const attempt = unsupported
      ? transitionAttempt(target, result.attempt.idempotency_key, 'NEEDS_REVIEW', {
        blockers: [{ code: 'UNSUPPORTED_PORTAL', detail: 'Application host is not a certified ATS surface' }],
      })
      : result.attempt;
    if (unsupported) blocked.push({ tracker_number: candidate.row.num, blocker: 'UNSUPPORTED_PORTAL' });
    if (result.created && !unsupported) queued.push(attempt);
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
  return { queued, blocked, eligible_count: rows.filter(item => item.eligible && (!allowed || allowed.has(item.row.num))).length };
}

/** Bind a runner invocation to only the attempts returned by its enqueue.
 * Keeping this conversion in the application module makes it hard for a CLI
 * caller to accidentally fall back to the global queue after selecting rows. */
export function enqueuedAttemptKeys(result = {}) {
  return [...new Set((result.queued || []).map(item => item?.idempotency_key).filter(Boolean))];
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
  return candidate.eligible || selectionOverrideStillValid(target, attempt)
    ? [attempt.idempotency_key]
    : [];
}

/** A user can select one Evaluated role outside the score/recommendation gate.
 * The exception is persisted on that attempt and is not reusable for any other
 * row, URL, or later tracker revision. */
export function enqueueSelectionOverride(target, trackerNumber) {
  const candidate = candidateForTrackerNumber(target, trackerNumber);
  if (!candidate) throw new Error(`Tracker row ${trackerNumber} was not found`);
  if (String(candidate.row.status).trim() !== 'Evaluated') {
    throw new Error(`Tracker row ${trackerNumber} is no longer Evaluated`);
  }
  if (!candidate.canonical_url) {
    throw new Error(`Tracker row ${trackerNumber} cannot be queued: ${candidate.blocker || 'CANONICAL_URL_MISSING'}`);
  }
  const result = attemptFromCandidate(target, candidate, { reason: 'USER_SELECTION_OVERRIDE' });
  return { ...result, tracker_number: Number(trackerNumber), normal_eligibility: candidate.eligible };
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
    const conventional = /one-time-code|verification|security.?code|\bcode\b|otp/.test(hint)
      || (['text', 'tel', 'number'].includes(element.type || 'text') && Number(element.maxLength) >= 6 && Number(element.maxLength) <= 12);
    return { index, visible, conventional, value: element.value || '', maxLength: Number(element.maxLength) || null };
  }).filter(item => item.visible && !item.value));
  const single = candidates.filter(item => item.conventional);
  if (single.length === 1) {
    await inputs.nth(single[0].index).fill(code);
    return { filled: true, detail: 'OTP_SINGLE_FIELD_FILLED' };
  }
  const slots = candidates.filter(item => item.maxLength === 1);
  if (slots.length !== code.length) return { filled: false, detail: `${single.length}_${slots.length}` };
  for (let index = 0; index < slots.length; index++) await inputs.nth(slots[index].index).fill(code[index]);
  return { filled: true, detail: 'OTP_SLOT_GROUP_FILLED' };
}

async function fillOneTimeCodeInClosedShadowRoot(page, code) {
  // Some certified Greenhouse widgets keep their OTP inputs in a closed shadow
  // root. Playwright's ordinary locators correctly cannot cross that boundary,
  // but Chrome's DevTools DOM tree can identify the real, max-length-one input
  // nodes. This remains a deterministic, exact-field operation, not visual
  // guessing or model-driven computer use.
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
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
    const slots = nodes.filter(node => {
      const attributes = Object.fromEntries((node.attributes || []).reduce((pairs, value, index) => {
        if (index % 2 === 0) pairs.push([String(value).toLowerCase(), String(node.attributes[index + 1] || '')]);
        return pairs;
      }, []));
      return attributes.maxlength === '1'
        || /one.time|verification|security.code|character/i.test(`${attributes.autocomplete || ''} ${attributes['aria-label'] || ''} ${attributes.name || ''}`);
    });
    if (slots.length !== code.length) return { filled: false, detail: `CLOSED_SHADOW_OTP_UNRESOLVED_${slots.length}` };
    for (const [index, slot] of slots.entries()) {
      const resolved = await session.send('DOM.resolveNode', { backendNodeId: slot.backendNodeId });
      const objectId = resolved.object?.objectId;
      if (!objectId) return { filled: false, detail: 'CLOSED_SHADOW_OTP_RESOLVE_FAILED' };
      await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(value) {
          this.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(this, value); else this.value = value;
          this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }`,
        arguments: [{ value: code[index] }],
        awaitPromise: true,
      });
    }
    return { filled: true, detail: 'OTP_CLOSED_SHADOW_SLOTS_FILLED' };
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
  const scopes = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
  const unresolved = [];
  for (const [index, scope] of scopes.entries()) {
    const result = await fillOneTimeCodeInScope(scope, code).catch(() => ({ filled: false, detail: 'SCOPE_UNAVAILABLE' }));
    if (result.filled) return { ...result, detail: `${result.detail}_FRAME_${index}` };
    unresolved.push(result.detail);
  }
  const closedShadow = await fillOneTimeCodeInClosedShadowRoot(page, code)
    .catch(() => ({ filled: false, detail: 'CLOSED_SHADOW_OTP_UNAVAILABLE' }));
  if (closedShadow.filled) return closedShadow;
  unresolved.push(closedShadow.detail);
  // Chime's Greenhouse verification widget exposes the label to the main page
  // but encapsulates its segmented boxes outside the ordinary DOM/frame query
  // surfaces. Anchor a keyboard entry to that exact visible label instead of
  // using screen-global coordinates. This path runs only after navigation has
  // already classified the page as MFA and all normal adapter routes failed.
  const label = page.getByText(/^security code$/i).first();
  const box = await label.boundingBox().catch(() => null);
  if (box) {
    // Greenhouse's eight boxes are fixed-width, horizontally adjacent slots
    // in this certified widget. Its private controller advances focus from
    // ordinary keyboard events; re-clicking later slots can reset that state.
    const firstX = box.x + Math.min(28, Math.max(12, box.width / 4));
    const centerY = box.y + box.height + 30;
    await page.mouse.click(firstX, centerY);
    await page.keyboard.type(code, { delay: 45 });
    return { filled: true, detail: 'OTP_SEGMENTED_LABEL_ANCHORED_SEQUENTIAL_TYPED' };
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
async function fetchPersonalGmailOtp(target, attempt, config) {
  const policy = apps(config).gmail_otp;
  const domains = policy?.enabled === true ? otpDomains(attempt.ats, config) : [];
  if (!domains.length || !existsSync(OTP_READER)) return '';
  const path = mfaHandoffPath(target, attempt);
  const timeout = Math.max(15, Math.min(180, Number(policy.timeout_seconds || 90)));
  const started = Date.now() - 60000;
  await new Promise(resolveProcess => {
    const child = spawn(policy.python_command || 'python', [OTP_READER, '--out', path, '--not-before', String(started), '--domains', domains.join(','), '--timeout-seconds', String(timeout)], { stdio: 'ignore', windowsHide: true });
    child.once('error', resolveProcess); child.once('exit', resolveProcess);
  });
  return takeMfaCode(target, attempt, 1);
}

function selectionOverrideStillValid(target, attempt) {
  if (attempt.selection_override?.reason !== 'USER_SELECTION_OVERRIDE') return false;
  const current = candidateForTrackerNumber(target, attempt.tracker_number);
  return Boolean(current
    && String(current.row.status).trim() === 'Evaluated'
    && current.canonical_url === attempt.canonical_url
    && current.row.report === attempt.report_id
    && current.row.role === attempt.role
    && current.row.company === attempt.company);
}

/** Processes exactly one queue entry at a time.  The submit branch is guarded
 * by config *and* the CLI --submit flag so unattended canaries cannot submit. */
export async function runApplications(target, config, { submit = false, max = 1, pauseForAuthentication = false, attemptKeys = null } = {}) {
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
  // A run consumes only rows explicitly authorized by a preceding enqueue.
  // Re-check those rows immediately before opening the browser; a stale score,
  // duplicate, URL change, or manual tracker edit silently removes authority.
  const eligible = new Map(eligibleRows(target).filter(item => item.eligible).map(item => [item.idempotency_key, item]));
  const maySubmit = submit && apps(config).auto_submit === true;
  const selectedKeys = attemptKeys === null ? null : new Set(attemptKeys);
  const allowedAts = enabledAts(config);
  const attempts = listAttempts(target);
  const eligibleKeys = new Set(eligible.keys());
  for (const attempt of attempts) {
    if (selectionOverrideStillValid(target, attempt)) eligibleKeys.add(attempt.idempotency_key);
  }
  const pending = selectableAttempts(attempts, { eligibleKeys, maySubmit, allowedAts, selectedKeys })
    .slice(0, Math.max(1, Number(max)));
  const results = [];
  if (!pending.length) return { results, message: 'No queued applications' };
  const profile = apps(config).chrome_profile_dir;
  if (!profile) throw configError('applications.chrome_profile_dir is required');
  const context = await chromium.launchPersistentContext(resolve(profile), {
    // Prefer the installed Chrome channel. Unlike Playwright's bundled
    // Chromium it is present on the user's workstation and supports the same
    // persistent extension profile; local config may explicitly select another
    // installed channel for diagnostics.
    headless: false, channel: apps(config).chrome_channel || 'chrome',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`], viewport: { width: 1280, height: 1000 },
  });
  try {
    let options = null;
    for (const queued of pending) {
      const latest = getAttempt(target, queued.idempotency_key);
      if (!latest || TERMINAL_ATTEMPT_STATES.has(latest.state)) continue;
      let attempt = transitionAttempt(target, latest.idempotency_key, 'RUNNING');
      const resume = resumeFor(attempt, config);
      if (resume.blocker) { results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: resume.blocker }] })); continue; }
      const page = await context.newPage();
      try {
        await page.goto(attempt.canonical_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(1800);
        if (!options) {
          const id = await extensionId(context);
          options = await context.newPage();
          await options.goto(`chrome-extension://${id}/options/options.html`);
          await seedExtensionData(options);
        }
        await seedResume(options, resume);
        let inspected = await send(options, { type: 'inspect' });
        if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed');
        // A certified Workday posting is not the application itself. Advancing
        // through its exact Apply control is safe navigation, never final
        // submission; unfamiliar portals never receive this action.
        const enabledBoard = allowedAts.has(inspected.board);
        if (enabledBoard && CERTIFIED.has(inspected.board) && inspected.fieldCount === 0 && !inspected.navigation?.login) {
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
            inspected = await send(options, { type: 'inspect' });
            if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed after Apply');
          }
        }
        const pageState = { ...inspected.navigation, certified: enabledBoard && CERTIFIED.has(inspected.board), exactReviewPage: inspected.navigation.review };
        const initialAuthentication = authenticationBlocker(pageState);
        if (initialAuthentication) {
          results.push(transitionAttempt(target, attempt.idempotency_key, initialAuthentication.state, {
            blockers: initialAuthentication.blockers,
            artifacts: [await capture(page, target, attempt, 'blocked.png')],
          }));
          continue;
        }
        if (enabledBoard && await revealGreenhouseCoverLetter(page, inspected, config)) {
          inspected = await send(options, { type: 'inspect' });
          if (!inspected.ok) throw new Error(inspected.error || 'Extension inspection failed after revealing cover letter');
        }
        // Certified adapters may advance only through an exact Next/Continue
        // control.  Generic portals are deliberately left on their current
        // page for review; the runner never explores an unfamiliar flow.
        let filled;
        const maxSteps = Math.max(1, Math.min(12, Number(apps(config).max_steps || 8)));
        for (let step = 1; step <= maxSteps; step++) {
          filled = await send(options, { type: 'fillOverrides', overrides: [], resumeKind: resume.kind });
          if (!filled.ok) throw new Error(filled.error || 'Extension fill failed');
          inspected = await send(options, { type: 'inspect' });
          // A controlled select/radio can accept the first generic fill then
          // lose its selected state during the ATS' re-render. Retry only a
          // still-empty, required deterministic field using the exact same
          // approved local answer bank; no prose or model is involved.
          const deterministicOverrides = approvedDeterministicOverrides(inspected.fields);
          if (deterministicOverrides.length) {
            const retried = await send(options, { type: 'fillOverrides', overrides: deterministicOverrides, resumeKind: resume.kind });
            if (!retried.ok) throw new Error(retried.error || 'Extension deterministic retry failed');
            inspected = await send(options, { type: 'inspect' });
          }
          if (inspected.navigation?.login || inspected.navigation?.mfa || inspected.navigation?.captcha) break;
          if (!enabledBoard || !CERTIFIED.has(inspected.board) || !inspected.navigation?.hasNext || inspected.navigation?.review) break;
          const next = await exactButton(page, /^\s*(?:next|continue|save and continue)\s*$/i);
          if (!next) break;
          await next.click(); await delay(900);
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
        const hasAiDisclosure = (inspected.fields || []).some(field => fieldRisk(field.question) === 'AI_DISCLOSURE');
        const custom = hasAiDisclosure ? [] : (inspected.fields || []).filter(field => field.risk === 'CUSTOM_PROSE'
          && field.type !== 'file' && !field.current_value);
        if (custom.length) {
          const evidence = answerEvidence(target, attempt, config);
          if (!evidence.length) generationBlockers = [{ code: 'NO_QUALIFIED_PROVIDER', detail: 'No trusted local evidence configured for custom prose' }];
          else {
            const result = await generateBoundedAnswers({
              questions: custom, evidence, runtimeConfig: config,
              voiceProfile: applicationVoiceProfile(),
              // The user explicitly enabled local cover-letter generation.
              // It must never consume a hosted fallback if the local model is
              // unavailable or fails qualification.
              requireLocal: custom.some(field => /\bcover[\s_-]*letter\b/i.test(field.question)),
            });
            if (result.blocker) generationBlockers = [{ code: result.blocker === 'QUOTA_UNAVAILABLE' ? 'QUOTA_UNAVAILABLE' : 'NO_QUALIFIED_PROVIDER' }];
            else {
              generated = result.answers;
              const overrideResponse = await send(options, { type: 'fillOverrides', resumeKind: resume.kind, overrides: generated.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) });
              if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension generated-answer fill failed');
              inspected = await send(options, { type: 'readback' });
              const accepted = new Map((overrideResponse.overrideResults || []).map(item => [item.field_id, item]));
              for (const answer of generated) {
                const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
                const result = accepted.get(answer.field_id);
                if (!result?.accepted || field?.current_value !== answer.text) {
                  generationBlockers.push({ code: 'VALIDATION_ERROR', question: field?.question || answer.field_id, detail: 'Generated answer did not survive form readback' });
                }
              }
              attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', { answers: generated, provider_usage: [result.usage || {}] });
            }
          }
        }
        // Current-compensation questions are purposely left blank. Other
        // salary prompts receive an individualized *future preference* from
        // the qualified local model, with the configured Antigravity-only
        // fallback. They never read or reuse a global salary-bank answer.
        const salary = hasAiDisclosure ? [] : (inspected.fields || []).filter(field => fieldRisk(field.question) === 'SALARY'
          && field.type !== 'file' && !field.current_value);
        if (salary.length) {
          const evidence = answerEvidence(target, attempt, config);
          if (!evidence.length) generationBlockers.push({ code: 'NO_QUALIFIED_PROVIDER', detail: 'No trusted local evidence configured for salary preference' });
          else {
            const result = await generateSalaryPreferences({ questions: salary, evidence, runtimeConfig: config });
            if (result.blocker) generationBlockers.push({ code: result.blocker === 'QUOTA_UNAVAILABLE' ? 'QUOTA_UNAVAILABLE' : 'NO_QUALIFIED_PROVIDER', question: salary[0]?.question });
            else {
              const salaryAnswers = result.answers || [];
              generated = [...generated, ...salaryAnswers];
              const overrideResponse = await send(options, { type: 'fillOverrides', resumeKind: resume.kind, overrides: salaryAnswers.map(answer => ({ field_id: answer.field_id, value: answer.text, provenance: answer.provenance })) });
              if (!overrideResponse.ok) throw new Error(overrideResponse.error || 'Extension salary-preference fill failed');
              inspected = await send(options, { type: 'readback' });
              const accepted = new Map((overrideResponse.overrideResults || []).map(item => [item.field_id, item]));
              for (const answer of salaryAnswers) {
                const field = (inspected.fields || []).find(item => item.field_id === answer.field_id);
                if (!accepted.get(answer.field_id)?.accepted || field?.current_value !== answer.text) {
                  generationBlockers.push({ code: 'VALIDATION_ERROR', question: field?.question || answer.field_id, detail: 'Salary preference did not survive form readback' });
                }
              }
              attempt = transitionAttempt(target, attempt.idempotency_key, 'RUNNING', { answers: generated, provider_usage: [result.usage || {}] });
            }
          }
        }
        const readback = await send(options, { type: 'readback' });
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
        const gate = submissionGate({ page: { ...inspected.navigation, certified: enabledBoard && CERTIFIED.has(inspected.board), exactReviewPage }, fields, resume: attachedResume, generated });
        if (!nativeValidation.found) gate.blockers.push({ code: 'UNSUPPORTED_PORTAL', question: 'Application form not found' });
        for (const question of nativeValidation.errors) {
          // Ashby replaces its required resume input after acceptance, leaving
          // the replacement empty while its visual receipt remains. The
          // extension receipt plus rendered filename/hash check above is the
          // stronger verification for that one control.
          if (/^resume\b/i.test(question) && attachedResume.hash === resume.hash) continue;
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
          results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: gate.blockers, selected_resume: { kind: resume.kind, hash: attachedResume.hash, expected_hash: resume.hash }, artifacts: [manifestPath, await capture(page, target, attempt, 'review.png')] }));
          continue;
        }
        const reviewArtifact = await capture(page, target, attempt, 'review.png');
        attempt = transitionAttempt(target, attempt.idempotency_key, 'READY_TO_SUBMIT', { selected_resume: { kind: resume.kind, hash: attachedResume.hash, expected_hash: resume.hash }, artifacts: [manifestPath, reviewArtifact] });
        if (!maySubmit) { results.push(attempt); continue; }
        const button = await exactButton(page, /^\s*submit(?: application)?\s*$/i);
        if (!button) { results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', { blockers: [{ code: 'UNSUPPORTED_PORTAL' }] })); continue; }
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
        const clickMethod = await clickFinalSubmit(page, button);
        // A success response is frequently accompanied by a client-side route
        // change. Wait long enough for it, but never keep a live application
        // page open indefinitely; anything ambiguous remains non-retryable.
        await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(document.body?.innerText || ''), { timeout: 7500 }).catch(() => {});
        let confirmation = await send(options, { type: 'inspect' }).catch(() => ({ navigation: {} }));
        // An ATS can reply 200 while rendering an explicit rejection (notably
        // anti-spam screens).  DOM rejection is therefore authoritative and
        // never reaches either the success transition or tracker writer.
        if (confirmation.navigation?.submissionRejected) {
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
        const postSubmitAuthentication = authenticationBlocker(confirmation.navigation);
        if (postSubmitAuthentication) {
          const configured = Number(apps(config).authentication_handoff_timeout_ms || 10 * 60_000);
          const timeoutMs = Math.max(60_000, Math.min(30 * 60_000, configured));
          const gmailCode = oneTimeCode ? '' : await fetchPersonalGmailOtp(target, attempt, config);
          const deliveredCode = oneTimeCode || gmailCode || (pauseForAuthentication
            ? await takeMfaCode(target, attempt, timeoutMs)
            : '');
          let attemptedCode = false;
          let mfaAction = '';
          if (postSubmitAuthentication.state === 'WAITING_LOGIN' && deliveredCode) {
            const codeFill = await fillOneTimeCode(page, deliveredCode);
            if (codeFill.filled) {
              attemptedCode = true;
              mfaAction = codeFill.detail;
              await delay(450);
              const resubmit = await finalNativeSubmit(page);
              if (resubmit) {
                mfaAction = 'CODE_FILLED_SUBMIT_REQUESTED';
                networkEvidence.length = 0;
                await clickFinalSubmit(page, resubmit);
                // Greenhouse may spend several seconds validating an accepted
                // human-verification code before replacing the form. Keep the
                // page open long enough to observe that authoritative result;
                // an unchanged MFA form still fails closed below.
                await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying/i.test(document.body?.innerText || ''), { timeout: 30000 }).catch(() => {});
                confirmation = await send(options, { type: 'inspect' }).catch(() => ({ navigation: {} }));
              } else mfaAction = 'CODE_FILLED_SUBMIT_CONTROL_UNAVAILABLE';
            } else mfaAction = codeFill.detail;
          }
          const remainingAuthentication = authenticationBlocker(confirmation.navigation);
          const remainingBlockers = mfaAction
            ? remainingAuthentication?.blockers.map(blocker => ({ ...blocker, detail: mfaAction }))
            : remainingAuthentication?.blockers;
          if (!remainingAuthentication) {
            // The code was accepted or the page changed. Continue through the
            // same success/rejection evidence checks used by an unattended run.
          } else if (pauseForAuthentication && !attemptedCode) {
            // This interactive mode is opt-in on the command line. Unattended
            // runs keep their existing fail-closed behavior and close here.
            const handoff = await awaitManualAuthentication(page, timeoutMs);
            if (handoff === 'success') {
              confirmation = await send(options, { type: 'inspect' }).catch(() => ({ navigation: {} }));
            } else if (handoff === 'rejected') {
              results.push(transitionAttempt(target, attempt.idempotency_key, 'NEEDS_REVIEW', {
                blockers: [{ code: 'SUBMISSION_REJECTED', detail: 'The ATS explicitly rejected the submission after manual authentication.' }],
                submission_evidence: { url: page.url(), observed_at: new Date().toISOString(), confirmation: 'adapter-visible-rejection' },
                artifacts: [await capture(page, target, attempt, 'rejected.png')],
              }));
              continue;
            } else {
              results.push(transitionAttempt(target, attempt.idempotency_key, remainingAuthentication.state, {
                blockers: remainingBlockers,
                artifacts: [await capture(page, target, attempt, 'authentication.png')],
              }));
              continue;
            }
          } else {
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
      } catch (error) {
        results.push(transitionAttempt(target, attempt.idempotency_key, 'FAILED', { blockers: [{ code: 'VALIDATION_ERROR', detail: String(error.message).slice(0, 300) }] }));
      } finally { await page.close().catch(() => {}); }
    }
  } finally { await context.close(); }
  return { results };
}
