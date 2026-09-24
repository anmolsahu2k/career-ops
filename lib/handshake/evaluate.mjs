/**
 * Live Handshake evaluation through the existing A-G pipeline.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { titleLevelCompatible, loadCandidateContext } from '../runtime/candidate-context.mjs';
import { evaluateLivePosting } from '../runtime/evaluate-scan.mjs';
import { buildTitleFilter } from '../scan-io.mjs';
import { extractHandshakeJob, handshakeJobSnapshot } from './job-page.mjs';

const DEFAULT_PROVIDER = 'antigravity-gemini-flash-high';

const MIN_JD = 200;

export function handshakeEvaluateProvider(config = {}) {
  return config.applications?.main_profile?.evaluate_provider
    || DEFAULT_PROVIDER;
}

export function loadPortalsTitleFilter(repoRoot) {
  const path = resolve(repoRoot, 'portals.yml');
  if (!existsSync(path)) return null;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf8')) || {};
    return parsed.title_filter || null;
  } catch {
    return null;
  }
}

export function handshakeHardGate(job, { repoRoot, candidate = null, titleFilter = null } = {}) {
  if (job?.login) return { ok: false, code: 'LOGIN_REQUIRED', detail: 'Handshake page looks logged out' };
  if (!job?.title) return { ok: false, code: 'JOB_EXTRACT_FAILED', detail: 'No job title on the Handshake page' };
  const jd = String(job.jdText || job.pageText || '');
  if (jd.length < MIN_JD) return { ok: false, code: 'JD_TOO_SHORT', detail: `JD ${jd.length} chars` };
  if (titleFilter && !titleFilter(job.title)) {
    return { ok: false, code: 'TITLE_FILTER', detail: job.title };
  }
  if (candidate) {
    const level = titleLevelCompatible(job.title, candidate, { url: job.url });
    if (!level.ok) return { ok: false, code: 'LEVEL_MISMATCH', detail: level.reason };
  }
  return { ok: true, code: null, detail: '' };
}

export async function extractHandshakeJobFromPage(page) {
  const deadline = Date.now() + 12000;
  let extracted = extractHandshakeJob({ url: page.url() });
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(handshakeJobSnapshot);
    extracted = extractHandshakeJob({ ...snapshot, url: page.url() || snapshot.url });
    if (extracted.title && String(extracted.jdText || '').length >= MIN_JD) return extracted;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return extracted;
}

export async function evaluateHandshakeJob({
  target,
  config,
  repoRoot,
  page,
  job = null,
  acknowledgeQuota = true,
  forceProvider = false,
  providerHandle = null,
  onProgress = null,
  candidateContext = null,
} = {}) {
  const extracted = job || await extractHandshakeJobFromPage(page);
  const candidate = candidateContext || loadCandidateContext({ root: repoRoot || null });
  const titleFilter = repoRoot ? buildTitleFilter(loadPortalsTitleFilter(repoRoot) || {}) : null;
  const gate = handshakeHardGate(extracted, { repoRoot, candidate, titleFilter });
  if (!gate.ok) {
    return { status: 'SKIPPED', reason: gate.code, detail: gate.detail, job: extracted, evaluation: null };
  }
  const provider = handshakeEvaluateProvider(config);
  const evaluation = await evaluateLivePosting({
    target,
    config,
    posting: {
      url: extracted.url,
      company: extracted.company || 'Unknown',
      title: extracted.title,
      location: extracted.location || '',
      source: 'handshake',
    },
    pageText: extracted.jdText,
    provider,
    acknowledgeQuota,
    forceProvider,
    providerHandle,
    candidateContext: candidate,
    onProgress,
  });
  const committed = (evaluation.results || []).find(item => item.status === 'COMMITTED') || null;
  return {
    status: committed ? 'EVALUATED' : (evaluation.results?.[0]?.status || evaluation.status || 'FAILED'),
    reason: committed ? null : (evaluation.results?.[0]?.code || evaluation.results?.[0]?.error || evaluation.message),
    job: extracted,
    evaluation,
    committed,
  };
}

export function handshakeShouldApply(committed, { scoreFloor = 3.5 } = {}) {
  if (!committed || committed.status !== 'COMMITTED') return false;
  if (committed.decision === 'DO_NOT_APPLY') return false;
  const score = Number(committed.score);
  if (!Number.isFinite(score) || score < Number(scoreFloor)) return false;
  return committed.decision === 'APPLY' || committed.decision === 'CONSIDER';
}

export function handshakeCommitmentFromTracker(row = {}) {
  const score = Number(String(row.score || '').split('/')[0]);
  const notes = String(row.notes || '');
  let decision = 'APPLY';
  if (/\bDO\s+NOT\s+APPLY\b/i.test(notes)) decision = 'DO_NOT_APPLY';
  else if (/\bAPPLY\b/i.test(notes)) decision = 'APPLY';
  else if (/\bCONSIDER\b/i.test(notes)) decision = 'CONSIDER';
  return {
    status: 'COMMITTED',
    decision,
    score: Number.isFinite(score) ? score : 0,
    report_number: Number(row.num || row.tracker_number),
    notes,
  };
}
