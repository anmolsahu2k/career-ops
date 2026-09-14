/**
 * candidate-context.mjs — deterministic candidate facts for job evaluation.
 *
 * The evaluator used to send only the job description, so "CV Match" had
 * nothing to match against and the three consequential gates stayed UNKNOWN
 * on every posting, which capped every decision at CONSIDER. This module
 * loads the candidate record once and resolves everything that is decidable
 * without a model: role level, geography, and eligibility.
 *
 * The candidate record is first-party data, so it enters the evidence
 * manifest as `trusted_evidence`. Job postings stay untrusted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { deriveHardGateFields } from './oracles.mjs';

const MAX_CV_CHARS = 24 * 1024;

// Stable synthetic URI: the candidate record is not a fetchable posting, but
// EvidenceReferenceV1 requires an absolute URI.
export const CANDIDATE_EVIDENCE_URI = 'career-ops://candidate/profile';
export const CANDIDATE_EVIDENCE_ID = 'EV-CANDIDATE';
export const CANDIDATE_SOURCE_TYPE = 'candidate-record';

// Titles above the new-grad band. `sr` was missing from every filter in the
// repo, which is how "Sr. Forward Deployed Engineer" reached the evaluator.
// Strong tokens are decisive on their own.
const STRONG_SENIOR_PATTERNS = [
  /\bsr\.?\b/i,
  /\bsnr\.?\b/i,
  /\bsenior\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\bdistinguished\b/i,
  /\bfellow\b/i,
  /\bhead of\b/i,
  /\bdirector\b/i,
  /\bvice president\b/i,
  /\bvp\b/i,
  /\bmanager\b/i,
  /\bl[5-9]\b/i,
  /\b(?:ic|level)\s*[4-9]\b/i,
  /\b\d{2}\+? years\b/i,
];

// Weak tokens read as senior only when nothing marks the role as entry-level:
// "Associate Solutions Architect" is a real new-grad program title.
const WEAK_SENIOR_PATTERNS = [
  /\barchitect\b/i,
  /\bteam lead\b/i,
  /\btech(?:nical)? lead\b/i,
  /\blead engineer\b/i,
  /\b(?:iii|iv)\b/i,
];

// "Member of Technical Staff" is a deliberate exception in this repo: it reads
// as senior but is the standard new-grad-eligible title at several AI labs.
const SENIOR_TITLE_CARVEOUTS = [
  /member of technical staff/i,
  /technical staff\s*[-–,]/i,
];

const ENTRY_TITLE_PATTERNS = [
  /\bnew\s*grad(?:uate)?\b/i,
  /\bentry[-\s]?level\b/i,
  /\buniversity\s*(?:grad|hire|program)?\b/i,
  /\bcampus\b/i,
  /\bearly\s*career\b/i,
  /\bjunior\b/i,
  /\bjr\.?\b/i,
  /\bassociate\b/i,
  /\brotational\b/i,
  /\b20\d{2}\s*grad/i,
];

const US_STATE_TOKENS = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
];

const US_CITY_TOKENS = [
  'san francisco', 'south san francisco', 'palo alto', 'mountain view', 'sunnyvale',
  'santa clara', 'san jose', 'cupertino', 'menlo park', 'redwood city', 'oakland',
  'berkeley', 'los angeles', 'santa monica', 'san diego', 'irvine', 'sacramento',
  'seattle', 'bellevue', 'redmond', 'portland', 'denver', 'boulder', 'austin',
  'dallas', 'houston', 'san antonio', 'chicago', 'evanston', 'detroit', 'ann arbor',
  'minneapolis', 'st. louis', 'kansas city', 'boston', 'cambridge', 'somerville',
  'new york city', 'nyc', 'brooklyn', 'manhattan', 'jersey city', 'hoboken',
  'philadelphia', 'pittsburgh', 'baltimore', 'arlington', 'reston', 'mclean',
  'atlanta', 'charlotte', 'raleigh', 'durham', 'nashville', 'miami', 'orlando',
  'tampa', 'phoenix', 'tempe', 'scottsdale', 'salt lake city', 'las vegas',
  'columbus', 'cleveland', 'cincinnati', 'indianapolis', 'madison', 'milwaukee',
];

const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
];

const US_GENERAL_PATTERNS = [
  /\bunited states\b/i,
  /\bu\.?s\.?a\b/i,
  /\bus[-\s]?(?:based|only|remote)\b/i,
  /\bremote\s*[-–—,(]?\s*(?:us|usa|u\.s\.|united states|north america|americas|anywhere in the us)\b/i,
  /\b(?:us|usa)\s*[-–—]\s*remote\b/i,
];

const NON_US_PATTERNS = [
  /\b(?:canada|toronto|vancouver|montr[eé]al|ottawa|waterloo|ontario|british columbia|qu[eé]bec)\b/i,
  /\b(?:united kingdom|england|scotland|wales|london|manchester|cambridge, uk|edinburgh)\b/i,
  /\b(?:ireland|dublin|belfast)\b/i,
  /\b(?:germany|berlin|munich|m[uü]nchen|hamburg|frankfurt|cologne)\b/i,
  /\b(?:france|paris|lyon|toulouse)\b/i,
  /\b(?:spain|madrid|barcelona|portugal|lisbon|porto)\b/i,
  /\b(?:netherlands|amsterdam|rotterdam|utrecht|belgium|brussels)\b/i,
  /\b(?:switzerland|zurich|z[uü]rich|geneva|lausanne|austria|vienna)\b/i,
  /\b(?:sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki)\b/i,
  /\b(?:poland|warsaw|krak[oó]w|wroc[lł]aw|czech|prague|romania|bucharest|hungary|budapest)\b/i,
  /\b(?:india|bangalore|bengaluru|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|delhi|kolkata|ahmedabad)\b/i,
  /\b(?:singapore|malaysia|kuala lumpur|indonesia|jakarta|philippines|manila|vietnam|hanoi|ho chi minh)\b/i,
  /\b(?:japan|tokyo|osaka|kyoto|china|beijing|shanghai|shenzhen|hangzhou|hong kong|taiwan|taipei)\b/i,
  /\b(?:korea|seoul|south korea)\b/i,
  /\b(?:australia|sydney|melbourne|brisbane|perth|new zealand|auckland|wellington)\b/i,
  /\b(?:israel|tel aviv|herzliya|haifa)\b/i,
  /\b(?:united arab emirates|dubai|abu dhabi|saudi arabia|riyadh|qatar|doha|egypt|cairo)\b/i,
  /\b(?:brazil|s[aã]o paulo|rio de janeiro|argentina|buenos aires|chile|santiago|colombia|bogot[aá]|peru|lima)\b/i,
  /\b(?:mexico city|guadalajara|monterrey|costa rica|san jos[eé], costa rica)\b/i,
  /\b(?:south africa|cape town|johannesburg|nigeria|lagos|kenya|nairobi)\b/i,
  /\b(?:emea|apac|apj|latam|anz)\b/i,
  /\bremote\s*[-–—,(]?\s*(?:emea|apac|latam|europe|uk|india|canada)\b/i,
];

const WORK_AUTHORIZED_AT_START_PATTERNS = [
  /\bopt\b/i,
  /\bcpt\b/i,
  /\bead\b/i,
  /\bf-?1\b/i,
  /\bstem extension\b/i,
  /\bus citizen\b/i,
  /\bgreen card\b/i,
  /\bpermanent resident\b/i,
  /\bauthorized to work\b/i,
];

/** Return the matched text, not the pattern: reasons are read by humans. */
function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const found = String(text).match(pattern);
    if (found) return { pattern, text: found[0].trim() };
  }
  return null;
}

function repoRootFrom(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'CAREER_OPS.md')) || existsSync(join(dir, 'CLAUDE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** Strip direct contact identifiers; they carry no evaluative signal. */
function redactContactDetails(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email redacted]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone redacted]');
}

/**
 * Classify a posting title into a seniority band.
 * `senior` means above the new-grad band and therefore not worth a provider call.
 */
export function classifyTitleLevel(title = '') {
  const text = String(title).normalize('NFKC');
  if (!text.trim()) return { band: 'unknown', token: null };
  if (firstMatch(SENIOR_TITLE_CARVEOUTS, text)) return { band: 'entry', token: 'technical-staff-carveout' };
  const strong = firstMatch(STRONG_SENIOR_PATTERNS, text);
  if (strong) return { band: 'senior', token: strong.text };
  const entry = firstMatch(ENTRY_TITLE_PATTERNS, text);
  if (entry) return { band: 'entry', token: entry.text };
  const weak = firstMatch(WEAK_SENIOR_PATTERNS, text);
  if (weak) return { band: 'senior', token: weak.text };
  return { band: 'unknown', token: null };
}

/**
 * Some feeds (notably freehire) report a generic title while the URL slug
 * carries the real one: "Software Engineer" pointing at
 * .../Principal-Software-Engineer_R0096913. Read the job slug as a fallback.
 */
export function levelFromUrlSlug(url) {
  if (!url) return { band: 'unknown', token: null };
  let slug;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    slug = decodeURIComponent(segments.at(-1) || '').replace(/[_+-]+/g, ' ');
  } catch {
    return { band: 'unknown', token: null };
  }
  if (!slug || firstMatch(SENIOR_TITLE_CARVEOUTS, slug)) return { band: 'unknown', token: null };
  // Only strong tokens: a slug carries more incidental words than a title.
  const strong = firstMatch(STRONG_SENIOR_PATTERNS, slug);
  return strong ? { band: 'senior', token: strong.text } : { band: 'unknown', token: null };
}

/**
 * Hard level filter. A new-grad profile should never spend a provider call on a
 * senior requisition, and should never see it surface as CONSIDER.
 */
export function titleLevelCompatible(title, context, { url = '' } = {}) {
  const level = classifyTitleLevel(title);
  if (!context?.entry_level_only) return { ok: true, band: level.band, reason: null };
  if (level.band === 'senior') {
    return {
      ok: false,
      band: level.band,
      reason: `title says "${level.token}", above the ${context.level_band} band`,
    };
  }
  const fromUrl = levelFromUrlSlug(url);
  if (fromUrl.band === 'senior') {
    return {
      ok: false,
      band: fromUrl.band,
      reason: `posting URL says "${fromUrl.token}", above the ${context.level_band} band (feed title was generic)`,
    };
  }
  return { ok: true, band: level.band, reason: null };
}

/**
 * Resolve `geography_eligible` from the posting location, falling back to the
 * job description when the location column is blank or just "Remote".
 */
export function resolveGeographyGate({ locationText = '', jdText = '', context }) {
  if (!context?.us_only) return { value: 'UNKNOWN', reason: 'no geography constraint configured' };
  for (const [scope, text] of [['location', locationText], ['description', jdText]]) {
    const haystack = String(text || '').normalize('NFKC');
    if (!haystack.trim()) continue;
    const nonUs = firstMatch(NON_US_PATTERNS, haystack);
    const us = firstMatch(US_GENERAL_PATTERNS, haystack)
      || matchesUsPlace(haystack);
    if (us && !nonUs) return { value: 'YES', reason: `US ${scope} match: "${us.text}"` };
    if (nonUs && !us) return { value: 'NO', reason: `non-US ${scope} match: "${nonUs.text}"` };
    if (nonUs && us) return { value: 'UNKNOWN', reason: `multi-region ${scope}` };
  }
  return { value: 'UNKNOWN', reason: 'no geography signal in location or description' };
}

function matchesUsPlace(text) {
  const lower = text.toLowerCase();
  for (const token of US_STATE_TOKENS) if (lower.includes(token)) return { text: token };
  for (const token of US_CITY_TOKENS) if (lower.includes(token)) return { text: token };
  for (const code of US_STATE_CODES) {
    if (new RegExp(`(?:,\\s*|\\s)${code}\\b`).test(text)) return { text: code };
  }
  return null;
}

/**
 * Resolve the eligibility gates the job description leaves silent.
 *
 * Posting silence is not evidence of incompatibility, but it is also not a
 * reason to hold every role at CONSIDER forever. When the full posting has
 * been read and contains no restriction language, record that absence.
 */
export function resolveEligibilityGates({ jdText = '', livenessState = 'YES', context, scorable = false }) {
  const derived = deriveHardGateFields({ content: jdText, liveness_state: livenessState });
  const gates = {};
  const reasons = [];

  if (derived.citizenship_restricted && derived.citizenship_restricted !== 'UNKNOWN') {
    gates.citizenship_restricted = derived.citizenship_restricted;
  } else if (scorable) {
    gates.citizenship_restricted = 'NO';
    reasons.push('citizenship_restricted: full posting contains no citizenship or clearance restriction');
  }

  if (derived.sponsorship_compatible && derived.sponsorship_compatible !== 'UNKNOWN') {
    gates.sponsorship_compatible = derived.sponsorship_compatible;
  } else if (scorable && context?.work_authorized_at_start) {
    gates.sponsorship_compatible = 'YES';
    reasons.push('sponsorship_compatible: candidate is work-authorized at start and the posting excludes nobody');
  }

  return { gates, reasons };
}

/** Whole days between a posting date and now, or null when unknown. */
export function postingAgeDays(postedAt, now = Date.now()) {
  const parsed = Date.parse(postedAt || '');
  if (!Number.isFinite(parsed)) return null;
  const days = Math.floor((now - parsed) / 86_400_000);
  return days < 0 ? 0 : days;
}

function summarizeProfile(profile) {
  const candidate = profile?.candidate || {};
  const location = profile?.location || {};
  const constraints = profile?.ft_constraints || {};
  const targets = profile?.target_roles || {};
  const lines = [
    '# Candidate record (first-party, trusted)',
    '',
    '## Search parameters',
    `Target level: ${targets.archetypes?.[0]?.level || 'New Grad / Entry-Level'}`,
    `Primary target roles: ${(targets.primary || []).join('; ') || 'unspecified'}`,
    `Based in: ${location.city || ''}${location.city && location.country ? ', ' : ''}${location.country || ''}`.trim(),
    `Geography constraint: ${constraints.geography || 'unspecified'}`,
    `Work authorization: ${constraints.work_auth || location.visa_status || 'unspecified'}`,
    `Availability: ${constraints.availability || 'unspecified'}`,
  ];
  if (candidate.full_name) lines.splice(2, 0, `Name: ${candidate.full_name}`, '');
  return lines.filter(Boolean).join('\n');
}

const cache = new Map();

/**
 * Load the candidate record once per root. Returns the trusted evidence item
 * plus the deterministic facts the evaluator gates on.
 */
export function loadCandidateContext({ root = null, profilePath = null, cvPath = null, reload = false } = {}) {
  const resolvedRoot = resolve(root || repoRootFrom(dirname(fileURLToPath(import.meta.url))));
  const key = `${resolvedRoot}|${profilePath || ''}|${cvPath || ''}`;
  if (!reload && cache.has(key)) return cache.get(key);

  const profileFile = profilePath ? resolve(profilePath) : join(resolvedRoot, 'config', 'profile.yml');
  const cvFile = cvPath ? resolve(cvPath) : join(resolvedRoot, 'cv.md');

  let profile = null;
  if (existsSync(profileFile)) {
    try { profile = loadYaml(readFileSync(profileFile, 'utf8')); } catch { profile = null; }
  }
  const cvText = existsSync(cvFile) ? readFileSync(cvFile, 'utf8') : '';

  const geographyRaw = `${profile?.ft_constraints?.geography || ''} ${profile?.location?.country || ''}`;
  const workAuthRaw = `${profile?.ft_constraints?.work_auth || ''} ${profile?.location?.visa_status || ''}`;
  const levelBand = profile?.target_roles?.archetypes?.[0]?.level || '';
  const levelSignal = `${levelBand} ${(profile?.target_roles?.primary || []).join(' ')}`;

  const content = [summarizeProfile(profile), '', '---', '', redactContactDetails(cvText).trim()]
    .join('\n')
    .slice(0, MAX_CV_CHARS);

  const context = Object.freeze({
    root: resolvedRoot,
    profile,
    available: Boolean(profile || cvText),
    level_band: levelBand || 'New Grad / Entry-Level',
    entry_level_only: /new\s*grad|entry[-\s]?level|university|early\s*career/i.test(levelSignal),
    us_only: /\bus[-\s]?only\b/i.test(geographyRaw) || /united states/i.test(geographyRaw),
    work_authorized_at_start: Boolean(firstMatch(WORK_AUTHORIZED_AT_START_PATTERNS, workAuthRaw)),
    evidence: Object.freeze({
      id: CANDIDATE_EVIDENCE_ID,
      source_type: CANDIDATE_SOURCE_TYPE,
      uri: CANDIDATE_EVIDENCE_URI,
      content,
      // Deliberately UNKNOWN: the candidate record is not a posting, and
      // deterministic enrichment reads liveness_state from every evidence item.
      // A YES here would resolve posting_live for an uncertain posting.
      liveness_state: 'UNKNOWN',
      trust_class: 'trusted_evidence',
      derive_oracles: false,
    }),
  });
  cache.set(key, context);
  return context;
}
