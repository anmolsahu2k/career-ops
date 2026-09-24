/** Certified application surfaces and hostname → ATS mapping. */

export const CERTIFIED_ATS = Object.freeze([
  'workday', 'greenhouse', 'ashby', 'lever', 'successfactors',
]);

export const MAIN_PROFILE_ATS = Object.freeze(['handshake']);

const CERTIFIED = new Set(CERTIFIED_ATS);
const MAIN_PROFILE = new Set(MAIN_PROFILE_ATS);

/** Maturity notes for operator dashboards; never authorize navigation alone. */
export const ATS_MATURITY = Object.freeze({
  greenhouse: { stage: 'production', notes: 'Short-link + 428 OTP + cover-letter reveal + embed chrome heading covered' },
  ashby: { stage: 'production', notes: 'Application tab + single-page final covered' },
  workday: { stage: 'production', notes: 'Apply / Apply manually multi-step covered' },
  lever: { stage: 'supported', notes: 'Fewer runner special-cases than Greenhouse/Ashby' },
  successfactors: { stage: 'supported', notes: 'Hostname certified; fewer fixtures than Greenhouse' },
  linkedin: { stage: 'deferred', notes: 'Requires explicit main_profile CDP; never copies Chrome profile' },
  handshake: { stage: 'main_profile', notes: 'Attaches to already-open Chrome via inspect WS or HTTP CDP; never copies Chrome profile' },
  generic: { stage: 'review-only', notes: 'Queued for board review; runner never opens' },
});

export function classifyApplyLanding(url) {
  try {
    const href = String(url || '');
    const host = new URL(href).hostname;
    const ats = atsFor(href);
    const offHandshake = ats !== 'handshake';
    return {
      url: href,
      host,
      ats,
      off_handshake: offHandshake,
      certified: offHandshake && ats !== 'generic' && CERTIFIED.has(ats),
    };
  } catch {
    return { url: '', host: '', ats: 'generic', off_handshake: false, certified: false };
  }
}

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

export function mainProfileAtsEnabled(config = {}, ats) {
  const main = config.applications?.main_profile;
  return main?.enabled === true
    && Array.isArray(main.ats)
    && main.ats.includes(ats)
    && MAIN_PROFILE.has(ats);
}

/** The configuration is the active portal rollout, not merely documentation. */
export function enabledAts(config = {}) {
  const configured = config.applications?.supported_ats;
  const set = new Set();
  if (Array.isArray(configured)) {
    for (const ats of configured) {
      if (typeof ats === 'string' && CERTIFIED.has(ats)) set.add(ats);
    }
  }
  for (const ats of MAIN_PROFILE_ATS) {
    if (mainProfileAtsEnabled(config, ats)) set.add(ats);
  }
  return set;
}

/** Null when no local allowlist is configured. An explicit list, including
 * empty, is the active rollout and must be passed into eligibility. */
export function rolloutAllowlist(config) {
  if (!config || !Array.isArray(config.applications?.supported_ats)) return null;
  return enabledAts(config);
}

export function isCertifiedAts(ats, config = null) {
  if (CERTIFIED.has(ats)) return true;
  if (config) return mainProfileAtsEnabled(config, ats);
  return false;
}
