const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

// Strong evidence a posting is open on any host.
const STRONG_APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  /\bautofill (with|from)\b/i,
  /autofill resume/i,
  /\bi(?:'|’)m interested\b/i,
  /express interest/i,
  /\bsign in (?:to|and) apply\b/i,
  /\bview job\b/i,
  /\brefer (a )?friend\b/i,
];

// Weak CTAs are only trusted on known ATS hosts (Workday etc. hide Apply).
const WEAK_APPLY_PATTERNS = [
  /\bget started\b/i,
  /\bcontinue\b/i,
  /\bcreate (an )?account\b/i,
];

const AUTH_WALL_PATTERNS = [
  /continue with google/i,
  /continue with apple/i,
  /sign in with email/i,
  /join now/i,
  /user agreement/i,
];

// Challenge / bot interstitial pages. These are not closed jobs.
const BOT_WALL_PATTERNS = [
  /one quick security check/i,
  /security check/i,
  /verify that you'?re not a robot/i,
  /are you a robot/i,
  /access denied/i,
  /permission to access/i,
  /enable javascript/i,
  /cf-browser-verification/i,
  /just a moment/i,
  /attention required/i,
  /checking your browser/i,
  /preparing secure check/i,
];

// Aggregator / mirror hosts where an empty Playwright shell is normal and must
// never be treated as expiry by itself.
const MIRROR_HOSTS = [
  /(?:^|\.)jobright\.ai$/i,
  /(?:^|\.)linkedin\.com$/i,
  /(?:^|\.)indeed\.com$/i,
  /(?:^|\.)glassdoor\.com$/i,
  /(?:^|\.)ziprecruiter\.com$/i,
];

// Hosts known to be JS-rendered (SPA). Liveness checker bumps the SPA
// hydration wait for these so apply buttons appear before classification.
const SPA_HOSTS = [
  /myworkdayjobs\.com/i,
  /\.icims\.com/i,
  /jobs\.lever\.co/i,
  /ashbyhq\.com/i,
  /greenhouse\.io/i,
  /workable\.com/i,
  /bamboohr\.com/i,
  /\.smartrecruiters\.com/i,
  /successfactors\.com/i,
  /taleo\.net/i,
  /metacareers\.com/i,
  /apply\.careers\.microsoft\.com/i,
  /lifeattiktok\.com/i,
  /avature\.net/i,
  /tesla\.com/i,
  /jobs\.apple\.com/i,
];

const ATS_HOSTS = [
  ...SPA_HOSTS,
  /boards\.greenhouse\.io/i,
  /job-boards\.greenhouse\.io/i,
  /jobs\.lever\.co/i,
  /ashbyhq\.com/i,
  /myworkdayjobs\.com/i,
  /jobvite\.com/i,
  /greenhouse\.io/i,
];

export function isSpaHost(url = '') {
  return SPA_HOSTS.some((p) => p.test(url));
}

export function isAtsHost(url = '') {
  return ATS_HOSTS.some((p) => p.test(url));
}

export function isMirrorHost(url = '') {
  try {
    return MIRROR_HOSTS.some((p) => p.test(new URL(url).hostname));
  } catch {
    return MIRROR_HOSTS.some((p) => p.test(url));
  }
}

const MIN_CONTENT_CHARS = 300;
const MIN_JD_ACTIVE_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function isAuthWallControl(control = '') {
  return AUTH_WALL_PATTERNS.some((pattern) => pattern.test(control));
}

function controlLooksLikeApply(control = '', { allowWeak = false } = {}) {
  if (!control || isAuthWallControl(control)) return false;
  if (STRONG_APPLY_PATTERNS.some((pattern) => pattern.test(control))) return true;
  if (allowWeak && WEAK_APPLY_PATTERNS.some((pattern) => pattern.test(control))) return true;
  return false;
}

function hasApplyControl(controls = [], finalUrl = '') {
  const allowWeak = isAtsHost(finalUrl);
  return controls.some((control) => controlLooksLikeApply(control, { allowWeak }));
}

function bodySuggestsOpenPosting(bodyText = '', finalUrl = '') {
  // ATS and LinkedIn job pages often expose Apply only in body text.
  if (!isAtsHost(finalUrl) && !isMirrorHost(finalUrl)) return false;
  if (bodyText.trim().length < MIN_JD_ACTIVE_CHARS) return false;
  return STRONG_APPLY_PATTERNS.some((pattern) => pattern.test(bodyText));
}

function controlsLookLikeAuthWall(controls = []) {
  if (!controls.length) return false;
  return controls.every((control) => {
    if (isAuthWallControl(control)) return true;
    return /^(continue|sign in|log in|join now|dismiss)$/i.test(String(control).trim());
  });
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  // Access denied / challenge responses are scraper failures, not closed jobs.
  if (status === 401 || status === 403 || status === 429 || status === 503) {
    return { result: 'uncertain', reason: `HTTP ${status} block/challenge` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  const botWall = firstMatch(BOT_WALL_PATTERNS, bodyText);
  if (botWall) {
    return { result: 'uncertain', reason: `bot/challenge wall: ${botWall.source}` };
  }

  if (hasApplyControl(applyControls, finalUrl)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  if (controlsLookLikeAuthWall(applyControls)) {
    return { result: 'uncertain', reason: 'authentication wall without apply control' };
  }

  if (bodySuggestsOpenPosting(bodyText, finalUrl)) {
    return { result: 'active', reason: 'job page text includes apply language' };
  }

  // Known ATS job pages with a real JD body and no closed banner are live even
  // when the Apply control sits in sticky chrome the scraper missed.
  if (isAtsHost(finalUrl) && bodyText.trim().length >= MIN_JD_ACTIVE_CHARS) {
    return { result: 'active', reason: 'ATS host with substantial JD content' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    if (isAtsHost(finalUrl) && status !== 404 && status !== 410) {
      return {
        result: 'uncertain',
        reason: 'empty SPA shell on ATS host — not proof of expiry',
      };
    }
    if (isMirrorHost(finalUrl)) {
      return {
        result: 'uncertain',
        reason: 'empty mirror/aggregator shell — not proof of expiry',
      };
    }
    // Generic short pages with a non-error HTTP status are usually bot walls or
    // unbroken SPAs, not closed reqs. Only hard signals may expire.
    if (status && status !== 404 && status !== 410) {
      return {
        result: 'uncertain',
        reason: 'insufficient content without closed-job evidence',
      };
    }
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}
