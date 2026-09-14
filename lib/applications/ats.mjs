/** Certified application surfaces and hostname → ATS mapping. */

export const CERTIFIED_ATS = Object.freeze([
  'workday', 'greenhouse', 'ashby', 'lever', 'successfactors',
]);

const CERTIFIED = new Set(CERTIFIED_ATS);

/** Maturity notes for operator dashboards; never authorize navigation alone. */
export const ATS_MATURITY = Object.freeze({
  greenhouse: { stage: 'production', notes: 'Short-link + 428 OTP + cover-letter reveal covered' },
  ashby: { stage: 'production', notes: 'Application tab + single-page final covered' },
  workday: { stage: 'production', notes: 'Apply / Apply manually multi-step covered' },
  lever: { stage: 'supported', notes: 'Fewer runner special-cases than Greenhouse/Ashby' },
  successfactors: { stage: 'supported', notes: 'Hostname certified; fewer fixtures than Greenhouse' },
  linkedin: { stage: 'deferred', notes: 'Requires explicit main_profile CDP; never copies Chrome profile' },
  handshake: { stage: 'deferred', notes: 'Requires explicit main_profile CDP; never copies Chrome profile' },
  generic: { stage: 'review-only', notes: 'Queued for board review; runner never opens' },
});

export function atsFor(url) {
  const host = new URL(url).hostname;
  if (/\.myworkday(?:jobs|site)\.com$/i.test(host)) return 'workday';
  if (/(^|\.)greenhouse\.io$/i.test(host) || /^grnh\.se$/i.test(host)) return 'greenhouse';
  if (/ashbyhq\.com$/i.test(host)) return 'ashby';
  if (/lever\.co$/i.test(host)) return 'lever';
  if (/successfactors\.(?:com|eu)$|sapsf\.(?:com|eu)$/i.test(host)) return 'successfactors';
  if (/(^|\.)linkedin\.com$/i.test(host)) return 'linkedin';
  if (/(^|\.)joinhandshake\.com$/i.test(host)) return 'handshake';
  return 'generic';
}

/** The configuration is the active portal rollout, not merely documentation. */
export function enabledAts(config = {}) {
  const configured = config.applications?.supported_ats;
  if (!Array.isArray(configured)) return new Set();
  return new Set(configured.filter(ats => typeof ats === 'string' && CERTIFIED.has(ats)));
}

export function isCertifiedAts(ats) {
  return CERTIFIED.has(ats);
}
