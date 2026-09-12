// lib/role-match.mjs — shared role-title fuzzy-match stack.
//
// Extracted 2026-07-13 from merge-tracker.mjs and its verbatim copy in
// scripts/gmail-sweep-merge.mjs so matching-rule fixes land once instead of
// drifting across copies. dedup-tracker.mjs keeps its own deliberately
// different variant (no abbreviation expansion) — do not point it here
// without reading its inline comments first.

// Tokens that almost every role shares — must NOT count as signal.
// Includes seniority, work-mode, contract, and common locations.
export const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'intern', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // very common locations (extend in portals.yml later if needed)
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  // regions / countries
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  // prepositions leaking through length filter
  'with', 'from', 'into', 'over', 'this', 'that',
]);

// These describe a broad job family but cannot, by themselves, establish
// that two requisitions are the same opening. URL identity remains the
// primary duplicate signal for generic Software Engineer titles.
export const ROLE_GENERIC_MATCH_TOKENS = new Set(['software', 'engine', 'developer']);

// Role-abbreviation expansion. Maps short tokens (often filtered by the
// >3-char rule, or that diverge across aggregators) to their canonical
// expansion. Catches cases like "Engineering Intern - C&I" (#3113) vs
// "Engineer Intern, Commercial and Industrial" (#3266) where the same
// req gets rendered abbreviated in one feed and expanded in another.
// Both forms get tokens [commercial, industrial] after expansion.
export const ROLE_ABBREVIATIONS = new Map([
  ['c&i', 'commercial industrial'],
  ['ci', 'commercial industrial'],   // when "&" gets stripped
  ['ev', 'electric vehicle'],
  ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'],
  ['cv', 'computer vision'],
  ['nlp', 'natural language processing'],
  ['llm', 'large language model'],
  ['sde', 'software development engineer'],
  ['swe', 'software engineer'],
  ['mle', 'machine learning engineer'],
  ['mlops', 'machine learning operations'],
  ['ds', 'data science'],
  ['de', 'data engineer'],
  ['da', 'data analyst'],
  ['ba', 'business analyst'],
  ['fde', 'forward deployed engineer'],
  ['ux', 'user experience'],
  ['ui', 'user interface'],
  ['rd', 'research development'],
  ['hpc', 'high performance computing'],
  ['qa', 'quality assurance'],
]);

// Stem helper: collapse common English inflections so "engineer" matches
// "engineering" / "engineered" / "engineers". Naive but adequate for role
// titles which are short and stylized.
export function roleStem(token) {
  if (token.length <= 4) return token;
  // Order matters: longer suffixes first.
  for (const suffix of ['ering', 'ation', 'ings', 'ies', 'ing', 'ers', 'ed', 'es', 'er', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

// Tokenize with provenance: each token records whether it was typed out in
// the title (src: null) or produced by expanding an abbreviation
// (src: 'ai', 'ml', 'sde', ...). roleFuzzyMatch needs the provenance to stop
// a single expansion from impersonating multi-token signal.
export function roleTokensWithSource(s) {
  if (!s) return [];
  // First pass: lowercase, replace non-alphanumeric with spaces, but PRESERVE
  // the &-glued abbreviations (c&i → ci) by stripping & before splitting.
  const normalized = s
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  // Second pass: expand known abbreviations IN PLACE so a single-token
  // abbreviation (which the >3-char filter would otherwise drop) contributes
  // its full multi-token expansion to the comparison.
  const expanded = normalized
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(w => ROLE_ABBREVIATIONS.has(w)
      ? ROLE_ABBREVIATIONS.get(w).split(/\s+/).map(t => ({ tok: t, src: w }))
      : [{ tok: w, src: null }]);
  // Third pass: stop-word filter, length filter, then stem.
  return expanded
    .filter(e => e.tok.length > 3 && !ROLE_STOPWORDS.has(e.tok))
    .map(e => ({ tok: roleStem(e.tok), src: e.src }));
}

export function roleTokens(s) {
  return roleTokensWithSource(s).map(e => e.tok);
}

export function roleFuzzyMatch(a, b) {
  const wordsA = roleTokensWithSource(a);
  const wordsB = roleTokensWithSource(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const toksA = wordsA.map(e => e.tok);
  const toksB = wordsB.map(e => e.tok);
  const setB = new Set(toksB);
  const overlap = toksA.filter(t => setB.has(t)).length;
  if (overlap === 0) return false;

  // Identical MULTI-token sets are always the same role. This keeps pure
  // abbreviation rewrites ('SDE' vs 'Software Development Engineer') matching
  // even though their whole overlap is a single expansion group below. The
  // >=2 size guard stops singleton sets from matching: 'iOS Engineer' vs
  // 'Web Engineer' both reduce to {engine} (ios/web fall to the 3-char
  // filter) and are NOT the same role.
  const setA = new Set(toksA);
  if (setA.size >= 2 && setA.size === setB.size && [...setA].every(t => setB.has(t))) return true;

  // Count the overlap in signal UNITS, not raw tokens: every token produced
  // by expanding one abbreviation ('ai' → artificial intelligence) counts as
  // one unit, so two distinct AI-prefixed roles ('AI Engineer' vs 'AI
  // Research Scientist') can no longer satisfy the 2-token minimum on the
  // expansion alone and silently collapse in dedup. Units are counted per
  // side and the SMALLER count wins, which keeps the result symmetric in
  // (a, b) — otherwise a token organic on one side but expansion-derived on
  // the other would make the verdict depend on argument order.
  const srcFor = (entries, tok) => {
    for (const e of entries) if (e.tok === tok && e.src) return e.src;
    return null;
  };
  const overlapToks = new Set(toksA.filter(t => setB.has(t)));
  if (![...overlapToks].some(token => !ROLE_GENERIC_MATCH_TOKENS.has(token))) return false;
  const unitsOn = (words) => {
    const u = new Set();
    for (const tok of overlapToks) {
      const src = srcFor(words, tok);
      u.add(src ? `abbr:${src}` : `tok:${tok}`);
    }
    return u.size;
  };
  const units = Math.min(unitsOn(wordsA), unitsOn(wordsB));

  // Jaccard-style ratio on content tokens. Two roles are "the same" only
  // when the overlap dominates the smaller side — not when they just share
  // a location + "engineer".
  const minLen = Math.min(toksA.length, toksB.length);
  const ratio = overlap / minLen;

  return units >= 2 && ratio >= 0.6;
}
