/**
 * Handshake live job / session orchestration (CDP main Chrome).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { record } from '../runtime/util.mjs';
import { classifyApplyLanding, enabledAts, mainProfileAtsEnabled, rolloutAllowlist } from '../applications/ats.mjs';
import { applyScoreFloor, candidateForTrackerNumber } from '../applications/eligibility.mjs';
import {
  connectMainProfile,
  openOwnedTab,
  releaseMainProfile,
} from '../applications/chrome-cdp.mjs';
import { enqueueEligible, enqueuedAttemptKeys, exactAttemptKeys, runQueuedAttemptOnPage } from '../applications/runner.mjs';
import { getAttempt, listAttempts, transitionAttempt } from '../applications/store.mjs';
import { markApplied, markExternalApplyUrl } from '../applications/tracker.mjs';
import { loadCandidateContext, titleLevelCompatible } from '../runtime/candidate-context.mjs';
import { clickHandshakeApply, detectHandshakeApplyMode, submitHandshakeExternalOverlay } from './apply-native.mjs';
import {
  evaluateHandshakeJob,
  extractHandshakeJobFromPage,
  handshakeCommitmentFromTracker,
  handshakeShouldApply,
  loadPortalsTitleFilter,
} from './evaluate.mjs';
import { applyHandshakeFiltersOnPage, handshakeFilterSpec } from './filters.mjs';
import { isHandshakeJobUrl, isHandshakeSearchUrl } from './job-page.mjs';
import { handshakeKeywords } from './keywords.mjs';
import {
  allowHostsFromHints,
  hintUrls,
  isHandshakeOutboundRedirect,
  isIncidentalExternalHost,
  recordableLanding,
  selectExternalLanding,
  unwrapExternalUrl,
} from './external-landing.mjs';
import { listingsFromHtml, listingsFromLivePage, normalizeHandshakeJobUrl } from './listing.mjs';
import { buildTitleFilter } from '../scan-io.mjs';
import { diagnoseHandshake, handshakeStatusSnapshot } from './status.mjs';

function loadProfile(repoRoot) {
  const path = resolve(repoRoot, 'config', 'profile.yml');
  if (!existsSync(path)) return {};
  try { return yaml.load(readFileSync(path, 'utf8')) || {}; }
  catch { return {}; }
}

function findPage(context, predicate) {
  return (context.pages() || []).find(page => {
    try { return predicate(page.url()); } catch { return false; }
  }) || null;
}

function pageHref(page) {
  try { return page.url(); } catch { return ''; }
}

function handshakeResumeFile(config, { notes = '', role = '' } = {}) {
  const kind = /\bsubmit\s+mle\s+resume\b/i.test(notes) || /(machine learning|\bml engineer\b|data scientist)/i.test(role)
    ? 'mle'
    : 'sde';
  const path = String(config?.applications?.resumes?.[kind] || '').trim();
  if (!path || !existsSync(path)) return { kind, path: '' };
  return { kind, path: resolve(path) };
}

function landingFromUrl(url) {
  const landing = classifyApplyLanding(url);
  return landing.url ? landing : null;
}

function preexistingPage(candidate, originPage, beforePages, beforeUrls, beforeHosts) {
  if (candidate === originPage) return false;
  if (beforePages?.has(candidate)) return true;
  const href = pageHref(candidate);
  if (href && beforeUrls.has(href)) return true;
  try {
    const host = new URL(href).hostname;
    if (host && beforeHosts.has(host) && isIncidentalExternalHost(host)) return true;
  } catch { /* ignore */ }
  return false;
}

async function waitForExternalLanding(page, {
  context = null, timeoutMs = 12000, beforePages = null, allowHosts = new Set(),
} = {}) {
  const before = beforePages instanceof Set ? beforePages : new Set(beforePages || []);
  const beforeUrls = new Set([...before].map(pageHref).filter(Boolean));
  const beforeHosts = new Set();
  for (const href of beforeUrls) {
    try {
      const host = new URL(href).hostname;
      if (host) beforeHosts.add(host);
    } catch { /* ignore */ }
  }
  const deadline = Date.now() + timeoutMs;
  let lastCandidates = [];
  while (Date.now() < deadline) {
    const seen = new Set();
    const candidates = [];
    for (const candidate of [page, ...(context?.pages() || [])]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      const href = pageHref(candidate);
      const landing = landingFromUrl(href);
      if (!landing) continue;
      candidates.push({
        ...landing,
        page: candidate,
        preexisting: preexistingPage(candidate, page, before, beforeUrls, beforeHosts),
      });
    }
    lastCandidates = candidates;
    const picked = selectExternalLanding(candidates, { allowHosts });
    if (picked?.certified || (picked && !isIncidentalExternalHost(picked.host))) return picked;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
  }
  return selectExternalLanding(lastCandidates, { allowHosts })
    || { ...(landingFromUrl(pageHref(page)) || classifyApplyLanding('')), page, off_handshake: false, certified: false, preexisting: false };
}

async function openHintTab(context, ownedPages, url) {
  if (!context?.newPage || !url) return null;
  const tab = await context.newPage();
  ownedPages?.add(tab);
  try { tab.once?.('close', () => ownedPages?.delete(tab)); } catch { /* inspect pages support once */ }
  await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  return tab;
}

async function resolveExternalLanding({ page, context, ownedPages, clicked, beforePages = null }) {
  const hints = hintUrls(clicked, pageHref(page));
  const allowHosts = allowHostsFromHints(hints);
  let landed = await waitForExternalLanding(page, {
    context, timeoutMs: 5000, beforePages, allowHosts,
  });
  if (landed?.certified) return landed;
  if (landed?.off_handshake && !landed.preexisting && landed.host && !isIncidentalExternalHost(landed.host)) {
    return landed;
  }
  for (const href of hints) {
    const landing = landingFromUrl(href);
    if (!landing) continue;
    const picked = selectExternalLanding([{ ...landing, preexisting: false }], { allowHosts });
    if (!picked) continue;
    if (picked.certified) {
      const tab = await openHintTab(context, ownedPages, picked.url);
      if (tab) {
        const followed = await waitForExternalLanding(tab, {
          context, timeoutMs: 8000, beforePages, allowHosts,
        });
        if (followed?.off_handshake) return followed;
        return { ...picked, page: tab };
      }
    }
    return { ...picked, page: null };
  }
  const redirect = hints.find(isHandshakeOutboundRedirect);
  if (redirect) {
    const tab = await openHintTab(context, ownedPages, redirect);
    if (tab) {
      landed = await waitForExternalLanding(tab, {
        context, timeoutMs: 8000, beforePages, allowHosts,
      });
      if (landed?.off_handshake && !landed.preexisting) return landed;
    }
  }
  return landed;
}

function keysForHandshakeAttempt(target, trackerNumber, attemptKeys, queued) {
  const keys = [...new Set((attemptKeys || []).filter(Boolean))];
  if (keys.length) return keys;
  const exact = exactAttemptKeys(target, trackerNumber, queued);
  if (exact.length) return exact;
  return listAttempts(target)
    .filter(item => Number(item.tracker_number) === Number(trackerNumber) && item.idempotency_key)
    .map(item => item.idempotency_key);
}

async function persistExternalLanding(target, trackerNumber, attemptKeys, queued, landed) {
  const url = unwrapExternalUrl(landed?.url || landed?.external_url || '');
  let host = String(landed?.host || landed?.external_host || '').trim();
  if (!host && url) {
    try { host = new URL(url).hostname; } catch { /* ignore */ }
  }
  if (!host && !url) return;
  if (host && /(^|\.)joinhandshake\.com$/i.test(host)) return;
  const patch = {
    external_host: host.slice(0, 200),
    external_url: (url || (host ? `https://${host}` : '')).slice(0, 500),
    external_ats: String(landed?.ats || '').slice(0, 40),
  };
  if (!landed?.certified) {
    patch.blockers = [{
      code: 'UNSUPPORTED_PORTAL',
      detail: `Apply externally: ${patch.external_url || host}`,
    }];
  }
  for (const key of keysForHandshakeAttempt(target, trackerNumber, attemptKeys, queued)) {
    const current = getAttempt(target, key);
    if (!current) continue;
    const terminal = current.state === 'SUBMITTED' || current.state === 'SUBMISSION_UNKNOWN' || current.state === 'SKIPPED';
    const nextState = !landed?.certified && !terminal ? 'NEEDS_REVIEW' : current.state;
    try { transitionAttempt(target, key, nextState, patch); } catch { /* keep apply result */ }
  }
  await markExternalApplyUrl(target, trackerNumber, patch.external_url, patch.external_host).catch(() => {});
}

export async function persistHandshakeExternalLanding(target, trackerNumber, landed) {
  await persistExternalLanding(target, trackerNumber, null, {}, landed);
}

/** Certified hosts still need the local supported_ats rollout before fill or submit. */
export function handshakeExternalFollowThrough(recorded, config) {
  return Boolean(recorded?.certified) && enabledAts(config).has(recorded?.ats);
}

export { diagnoseHandshake, handshakeStatusSnapshot };

async function applyCommittedHandshake({
  target, config, page, context, ownedPages, committed, job, submit, onProgress,
}) {
  const scoreFloor = applyScoreFloor(config, { ats: 'handshake' });
  if (!handshakeShouldApply(committed, { scoreFloor })) {
    onProgress?.({ stage: 'handshake', phase: 'skip', result: 'below_floor_or_do_not_apply', title: job.title, company: job.company });
    return { status: 'SKIPPED_APPLY', committed };
  }
  const trackerNumber = Number(committed.report_number);
  const queued = await enqueueEligible(target, {
    trackerNumbers: [trackerNumber],
    includeCurrent: true,
    config,
    scoreFloor,
  });
  const keys = enqueuedAttemptKeys(queued);
  const attemptKeys = keys.length ? keys : exactAttemptKeys(target, trackerNumber, queued);
  const detected = await detectHandshakeApplyMode(page);
  if (detected.mode === 'already_applied') {
    const appliedAt = new Date();
    for (const key of keysForHandshakeAttempt(target, trackerNumber, attemptKeys, queued)) {
      const current = getAttempt(target, key);
      if (!current || current.state === 'SUBMITTED' || current.state === 'SUBMISSION_UNKNOWN' || current.state === 'SKIPPED') continue;
      await markApplied(target, trackerNumber, current.attempt_id, appliedAt, config.applications?.time_zone).catch(() => {});
      try {
        transitionAttempt(target, key, 'SUBMITTED', {
          blockers: [],
          submission_evidence: {
            url: page.url(),
            observed_at: appliedAt.toISOString(),
            confirmation: 'handshake-withdraw-application',
          },
        });
      } catch { /* a terminal attempt stays as recorded */ }
    }
    onProgress?.({
      stage: 'handshake',
      phase: 'done',
      result: 'SUBMITTED',
      company: job.company,
      title: job.title,
    });
    return { status: 'SUBMITTED', reason: 'handshake-withdraw-application', queued };
  }
  const maySubmit = submit && config.applications?.auto_submit === true;
  const sessionOpts = {
    submit: maySubmit,
    max: 1,
    attemptKeys,
    existingSession: {
      context,
      page,
      tabPolicy: 'owned',
      ownedPages,
      skipHandshakeClick: true,
    },
    skipNavigation: true,
    scoreFloor,
    onProgress,
  };
  if (detected.mode === 'external') {
    const resume = handshakeResumeFile(config, {
      notes: committed?.notes || '',
      role: job.title || job.role || '',
    });
    if (!resume.path) {
      return { status: 'NEEDS_REVIEW', reason: 'RESUME_MISMATCH', queued };
    }
    const beforePages = new Set(context.pages() || []);
    let popupPromise = null;
    const clicked = await submitHandshakeExternalOverlay(page, {
      resumePath: resume.path,
      beforeLeave: () => {
        popupPromise = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
      },
    });
    if (clicked?.status !== 'OPENED') {
      const reason = clicked?.reason || 'EXTERNAL_OVERLAY_MISSING';
      for (const key of keysForHandshakeAttempt(target, trackerNumber, attemptKeys, queued)) {
        const current = getAttempt(target, key);
        if (!current || current.state === 'SUBMITTED' || current.state === 'SUBMISSION_UNKNOWN' || current.state === 'SKIPPED') continue;
        try {
          transitionAttempt(target, key, 'NEEDS_REVIEW', { blockers: [{ code: reason, detail: reason }] });
        } catch { /* keep the apply result */ }
      }
      onProgress?.({
        stage: 'handshake',
        phase: 'review',
        result: reason,
        company: job.company,
        title: job.title,
      });
      return {
        status: 'NEEDS_REVIEW',
        reason,
        queued,
      };
    }
    const popup = popupPromise ? await popupPromise : null;
    if (popup) ownedPages?.add(popup);
    const landed = await resolveExternalLanding({
      page: popup || page,
      context,
      ownedPages,
      clicked,
      beforePages,
    });
    const recorded = recordableLanding(landed, clicked, pageHref(page));
    const followThrough = handshakeExternalFollowThrough(recorded, config);
    await persistExternalLanding(target, trackerNumber, attemptKeys, queued, {
      ...recorded,
      certified: followThrough,
    });
    const host = recorded.host || '';
    if (!followThrough) {
      onProgress?.({
        stage: 'handshake',
        phase: 'review',
        result: 'UNSUPPORTED_PORTAL',
        title: host || recorded.ats || 'unknown-host',
        company: job.company,
      });
      return {
        status: 'NEEDS_REVIEW',
        reason: 'UNSUPPORTED_PORTAL',
        ats: recorded.ats,
        host,
        external_host: host,
        url: recorded.url,
        queued,
      };
    }
    const workPage = recorded.page || popup || page;
    sessionOpts.existingSession.page = workPage;
    const run = await runQueuedAttemptOnPage(target, config, sessionOpts);
    return {
      status: 'EXTERNAL_ATS',
      ats: recorded.ats,
      host,
      external_host: host,
      url: recorded.url,
      run,
      queued,
    };
  }
  await clickHandshakeApply(page);
  onProgress?.({ stage: 'handshake', phase: 'apply', company: job.company, title: job.title });
  if (!attemptKeys.length) {
    return { status: 'NEEDS_REVIEW', reason: 'ENQUEUE_FAILED', queued };
  }
  const run = await runQueuedAttemptOnPage(target, config, sessionOpts);
  return { status: run?.results?.[0]?.state || 'NATIVE', run, queued };
}

function pagesMatchHandshakeJob(href, wanted) {
  try {
    return Boolean(wanted) && normalizeHandshakeJobUrl(href) === wanted;
  } catch {
    return false;
  }
}

/** Tracker Apply / retry for Handshake: reuse the committed row and apply in
 * the already-open Chrome. Never launches dedicated Chromium. */
export async function runHandshakeTrackerApply({
  target, config, repoRoot, trackerNumber, url = '', submit = false, onProgress = null,
} = {}) {
  if (!mainProfileAtsEnabled(config, 'handshake')) {
    throw Object.assign(new Error('Handshake requires applications.main_profile.enabled and ats: [handshake]'), { code: 'HANDSHAKE_DISABLED' });
  }
  const candidate = candidateForTrackerNumber(target, trackerNumber, {
    allowedAts: rolloutAllowlist(config),
    scoreFloor: applyScoreFloor(config, { ats: 'handshake' }),
  });
  if (!candidate) {
    throw Object.assign(new Error(`Tracker row ${trackerNumber} was not found`), { code: 'TRACKER_NOT_FOUND' });
  }
  const jobUrl = url || candidate.canonical_url;
  if (!jobUrl) {
    throw Object.assign(new Error(`Tracker row ${trackerNumber} has no Handshake URL`), { code: 'CANONICAL_URL_MISSING' });
  }
  const committed = handshakeCommitmentFromTracker(candidate.row);
  const scoreFloor = applyScoreFloor(config, { ats: 'handshake' });
  if (!handshakeShouldApply(committed, { scoreFloor })) {
    return record('HandshakeTrackerApplyV1', {
      status: 'SKIPPED_APPLY',
      reason: committed.decision === 'DO_NOT_APPLY' ? 'DO_NOT_APPLY' : 'SCORE_BELOW_FLOOR',
      committed,
      apply: null,
    });
  }
  const wanted = normalizeHandshakeJobUrl(jobUrl) || jobUrl;
  const session = await connectMainProfile(config, { onProgress });
  try {
    let page = findPage(session.context, href => pagesMatchHandshakeJob(href, wanted));
    if (!page) page = await openOwnedTab(session, wanted);
    onProgress?.({
      stage: 'handshake',
      phase: 'open',
      tracker_number: Number(trackerNumber),
      company: candidate.row?.company,
      title: candidate.row?.role,
      result: page.url(),
    });
    let job = {
      url: wanted,
      company: candidate.row?.company || '',
      title: candidate.row?.role || '',
      location: '',
      jdText: '',
    };
    try {
      const extracted = await extractHandshakeJobFromPage(page);
      if (extracted?.login) {
        return record('HandshakeTrackerApplyV1', {
          status: 'SKIPPED_APPLY',
          reason: 'LOGIN_REQUIRED',
          committed,
          job: extracted,
          apply: null,
        });
      }
      if (extracted?.title) job = { ...job, ...extracted, url: extracted.url || wanted };
    } catch {
      // Tracker already committed A-G; continue on this page.
    }
    const apply = await applyCommittedHandshake({
      target,
      config,
      page,
      context: session.context,
      ownedPages: session.ownedPages,
      committed,
      job,
      submit,
      onProgress,
    });
    return record('HandshakeTrackerApplyV1', {
      status: apply?.status || 'COMPLETED',
      committed,
      job,
      apply,
    });
  } finally {
    await releaseMainProfile(session);
  }
}

export async function runHandshakeJob({
  target, config, repoRoot, submit = false, acknowledgeQuota = true,
  forceProvider = false, providerHandle = null, onProgress = null, fetchImpl = fetch,
} = {}) {
  if (!mainProfileAtsEnabled(config, 'handshake')) {
    throw Object.assign(new Error('Handshake requires applications.main_profile.enabled and ats: [handshake]'), { code: 'HANDSHAKE_DISABLED' });
  }
  const session = await connectMainProfile(config, { onProgress });
  try {
    const page = findPage(session.context, isHandshakeJobUrl);
    if (!page) {
      throw Object.assign(new Error('No Handshake job tab is open in the CDP Chrome'), { code: 'HANDSHAKE_JOB_TAB_MISSING' });
    }
    onProgress?.({ stage: 'handshake', phase: 'extract', title: page.url() });
    const evaluated = await evaluateHandshakeJob({
      target, config, repoRoot, page, acknowledgeQuota, forceProvider, providerHandle, onProgress,
    });
    if (evaluated.status !== 'EVALUATED') return record('HandshakeJobResultV1', { ...evaluated, apply: null });
    const apply = await applyCommittedHandshake({
      target, config, page, context: session.context, ownedPages: session.ownedPages,
      committed: evaluated.committed, job: evaluated.job, submit, onProgress,
    });
    return record('HandshakeJobResultV1', { ...evaluated, apply });
  } finally {
    await releaseMainProfile(session);
  }
}

export async function runHandshakeSession({
  target, config, repoRoot, submit = false, max = 10, acknowledgeQuota = true,
  forceProvider = false, providerHandle = null, onProgress = null,
} = {}) {
  if (!mainProfileAtsEnabled(config, 'handshake')) {
    throw Object.assign(new Error('Handshake requires applications.main_profile.enabled and ats: [handshake]'), { code: 'HANDSHAKE_DISABLED' });
  }
  const cap = Math.max(1, Math.min(50, Number(max) || 10));
  const spec = handshakeFilterSpec(config);
  const profile = loadProfile(repoRoot);
  const keywords = handshakeKeywords(spec, profile);
  const titleFilter = buildTitleFilter(loadPortalsTitleFilter(repoRoot) || {});
  const candidate = loadCandidateContext({ root: repoRoot || null });
  const session = await connectMainProfile(config, { onProgress });
  const results = [];
  try {
    const search = await openOwnedTab(session, spec.search_url);
    onProgress?.({ stage: 'handshake', phase: 'filters', result: spec.search_url });
    const filtered = await applyHandshakeFiltersOnPage(search, spec, { keywords });
    if (filtered.fail_closed) {
      throw Object.assign(
        new Error(`Handshake filters not confirmed (${filtered.missing.join(', ') || 'unknown'}). Refusing to walk an unfiltered list.`),
        { code: 'HANDSHAKE_FILTERS_UNCONFIRMED', details: filtered },
      );
    }
    const collected = await listingsFromLivePage(search);
    const listings = collected.filter((row) => {
      if (!titleFilter(row.title)) return false;
      const level = titleLevelCompatible(row.title, candidate, { url: row.url });
      return level.ok;
    });
    if (!listings.length) {
      const preview = await search.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 180)).catch(() => '');
      onProgress?.({
        stage: 'handshake',
        phase: 'listings',
        result: `0 cards raw=${collected.length} query=${keywords || '(none)'} page=${preview}`,
        total: 0,
      });
    } else {
      onProgress?.({ stage: 'handshake', phase: 'listings', result: `${listings.length} cards`, total: listings.length });
    }
    let used = 0;
    for (const listing of listings) {
      if (used >= cap) break;
      const page = await openOwnedTab(session, listing.url);
      try {
        onProgress?.({ stage: 'handshake', phase: 'extract', company: listing.company, title: listing.title, done: used, total: cap });
        const existing = await detectHandshakeApplyMode(page);
        if (existing.mode === 'already_applied') {
          onProgress?.({
            stage: 'handshake',
            phase: 'skip',
            result: 'already_applied',
            company: listing.company,
            title: listing.title,
          });
          results.push({ listing, status: 'SKIPPED', reason: 'already_applied', apply: null });
          continue;
        }
        const evaluated = await evaluateHandshakeJob({
          target, config, repoRoot, page, acknowledgeQuota, forceProvider, providerHandle, onProgress, candidateContext: candidate,
        });
        used += 1;
        if (evaluated.status !== 'EVALUATED') {
          onProgress?.({
            stage: 'handshake',
            phase: 'skip',
            result: evaluated.reason || evaluated.status,
            title: evaluated.detail || evaluated.job?.title || listing.title,
            company: evaluated.job?.company || listing.company,
          });
          results.push({ listing, ...evaluated, apply: null });
          continue;
        }
        const apply = await applyCommittedHandshake({
          target, config, page, context: session.context, ownedPages: session.ownedPages,
          committed: evaluated.committed, job: evaluated.job, submit, onProgress,
        });
        results.push({ listing, ...evaluated, apply });
      } finally {
        if (!page.isClosed()) await page.close().catch(() => {});
        session.ownedPages?.delete(page);
      }
    }
    onProgress?.({
      stage: 'handshake',
      phase: 'done',
      done: results.length,
      total: cap,
      result: `processed ${results.length} of ${listings.length}`,
    });
    return record('HandshakeSessionResultV1', {
      filters: { ...spec, keywords, confirmation: filtered },
      listing_count: listings.length,
      raw_listing_count: collected.length,
      processed: results.length,
      max: cap,
      results,
    });
  } finally {
    await releaseMainProfile(session);
  }
}

export { listingsFromHtml, isHandshakeSearchUrl, enabledAts };
