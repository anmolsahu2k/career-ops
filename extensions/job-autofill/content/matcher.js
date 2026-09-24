/**
 * matcher.js — pure matching logic. No DOM, no chrome.* APIs.
 *
 * Imported by the content script AND by tests/matcher.test.mjs under
 * `node --test`, so it must stay free of browser globals.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'you', 'your', 'to', 'of', 'in', 'for', 'are', 'do', 'did',
  'is', 'was', 'this', 'that', 'and', 'or', 'if', 'on', 'at', 'be', 'with',
  'have', 'has', 'will', 'would', 'any', 'we', 'us', 'our', 'i', 'my', 'me',
  'please', 'select', 'enter', 'provide', 'tell', 'about',
  // Connectives that carry no meaning in a question but block a containment
  // match: "available to GO to the office 5 times PER week" is the same
  // question as "willing to work in the office 5 days a week".
  'go', 'per',
]);

const BOILERPLATE_PREFIXES = [
  'please select', 'please enter', 'please provide', 'please indicate',
  'please specify', 'please tell us', 'select one', 'choose one',
];

/** Questions whose answers should never be reused across companies. */
const VOLATILE_PATTERNS = /\b(why|company|role|position|team|product|us)\b/;

/** Rotating email/SMS codes and human-verification prompts. Never store or bank-fill. */
const OTP_VERIFICATION_QUESTION = /(?:verification|security|one[ -]?time|authentication)\s+code|8-character code|confirm you(?:['’]re| are) a human|one-time password|\botp\b|two[ -]?factor|authenticator/i;

/** Answers that are one-shot or job-specific and must never enter the global bank. */
const NEVER_STORE_QUESTION = new RegExp(
  `${OTP_VERIFICATION_QUESTION.source}|cover letter|(?:minimum|desired|expected|target).{0,24}(?:salary|compensation|pay)|base salary|salary requirement|salary expectation|compensation expectation|why (?:do you|are you) (?:want|apply|interested)`,
  'i',
);

const EEO_PATTERN =
  /gender|race|ethnic|veteran|disab|hispanic|latin|orientation|transgender|pronoun|self.?identif/i;

/**
 * Collapse a raw question/label into a stable lookup key.
 * Punctuation, required markers, and en/em dashes all normalize away so that
 * "Phone Number *" and "phone number?" hit the same stored answer.
 */
export function normalizeKey(text) {
  if (!text) return '';
  let s = String(text)
    .replace(/[–—−]/g, ' ')
    .toLowerCase()
    .replace(/\((?:optional|required)\)/g, ' ')
    // "Given Name(s)" and "Family Name(s)" must key the same as the singular.
    .replace(/\(s\)/g, '')
    .replace(/[*✱∗]/g, ' ')
    // keep + # / so "c++", "c#", "and/or" survive
    .replace(/[^a-z0-9+#/ ]+/g, ' ')
    .replace(/\s*\/\s*/g, m => (m === '/' ? '/' : ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(optional|required)$/g, '');

  for (const prefix of BOILERPLATE_PREFIXES) {
    if (s.startsWith(prefix + ' ')) {
      s = s.slice(prefix.length + 1);
      break;
    }
  }
  return s.trim();
}

/**
 * Names for one country that must compare as equal.
 *
 * Boards return their own spelling of the same place: Lever's location search
 * answers "Pittsburgh, Pennsylvania, USA" while the stored answer says "United
 * States". Without this the two share only the city and state, score 0.4, and
 * the matcher abstains on a location it actually knows.
 *
 * Applied at comparison time only. The stored keys keep their original wording,
 * so answers already captured in the browser still resolve exactly.
 */
const PHRASE_SYNONYMS = [
  [/\bunited states of america\b/g, 'usa'],
  [/\bunited states\b/g, 'usa'],
  [/\bu s a\b/g, 'usa'],
  // Ashby's current gender-identity choices use "Man" / "Woman" while the
  // approved local answer uses the more specific "Cisgender man" wording.
  [/\bcisgender man\b/g, 'man'],
  [/\bcisgender woman\b/g, 'woman'],
  // Some EEO forms use the noun forms while the locally approved profile uses
  // "Male" / "Female". This is option-label normalization only.
  [/\bmale\b/g, 'man'],
  [/\bfemale\b/g, 'woman'],
];

/**
 * US state names collapsed to their postal abbreviation, for the same reason.
 * Lever answers a search for "Pittsburgh" with "Pittsburgh, PA, USA" while the
 * stored location says "Pennsylvania", and one of the other results is
 * "Pittsburgh, ND, USA" — so the state is exactly the token that has to match.
 *
 * One direction only. Expanding "OR" to "Oregon" would rewrite the word "or" in
 * ordinary questions. Going the other way is safe because a full state name is
 * never anything else.
 *
 * Indiana, Oregon and Maine abbreviate to stopwords, so their state token drops
 * from both sides and two cities differing only by those states tie and abstain
 * rather than resolving. Abstaining is the correct failure here.
 */
const US_STATES = [
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
  ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
  ['district of columbia', 'dc'], ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'],
  ['idaho', 'id'], ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'],
  ['kansas', 'ks'], ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'],
  ['maryland', 'md'], ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'],
  ['mississippi', 'ms'], ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'],
  ['nevada', 'nv'], ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'],
  ['new york', 'ny'], ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'],
  ['oklahoma', 'ok'], ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'],
  ['south carolina', 'sc'], ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'],
  ['utah', 'ut'], ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'],
  ['west virginia', 'wv'], ['wisconsin', 'wi'], ['wyoming', 'wy'],
];

// Longest first so "west virginia" is not consumed by "virginia".
const STATE_SYNONYMS = [...US_STATES]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, abbr]) => [new RegExp(`\\b${name}\\b`, 'g'), abbr]);

/**
 * Single words that mean the same thing in an application question.
 *
 * Boards ask one question ("can you be in the office five days a week?") in as
 * many wordings as there are boards, and Jaccard scores each rewording as a
 * different question: "are you willing to work in the office 5-days a week"
 * against the stored "are you available to go to the office 5 times per week"
 * shares only office/5/week and scores 0.3, so a question the bank answers was
 * left for the user on a live posting.
 *
 * Deliberately tiny, and only for words that cannot change an answer. Nothing
 * here maps a word onto its opposite, and nothing here touches a qualifier
 * ("all", "any", "without") that decides what the question is asking.
 */
const WORD_SYNONYMS = [
  [/\b(?:available|able|willing|comfortable|prepared|open)\b/g, 'willing'],
  [/\b(?:times|day|days)\b/g, 'days'],
  [/\b(?:working|works|work)\b/g, 'work'],
  [/\b(?:onsite|on site|in office|in person|inperson)\b/g, 'office'],
  [/\b(?:weekly|week)\b/g, 'week'],
];

function tokenize(key) {
  let s = key;
  for (const [re, canonical] of PHRASE_SYNONYMS) s = s.replace(re, canonical);
  for (const [re, canonical] of STATE_SYNONYMS) s = s.replace(re, canonical);
  for (const [re, canonical] of WORD_SYNONYMS) s = s.replace(re, canonical);
  // Split on "/" as well as spaces so "hispanic/latino" matches "hispanic or
  // latino". The slash survives in the key itself, which keeps "c#" style
  // tokens and exact canonical lookups like "state/province" intact.
  return new Set(
    s.split(/[\s/]+/).filter(t => t && !STOPWORDS.has(t))
  );
}

/** Jaccard overlap of significant tokens. 0 = nothing shared, 1 = identical. */
export function tokenSetScore(keyA, keyB) {
  const a = tokenize(keyA);
  const b = tokenize(keyB);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const DEFAULT_THRESHOLD = 0.75;

/**
 * Resolve a question key against the stored answers.
 * Exact normalized hit wins; otherwise the best fuzzy match at or above
 * `threshold`. Returns null rather than guessing.
 */
export function findAnswer(normKey, answers, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!normKey || !answers) return null;
  if (isEphemeralApplicationQuestion(normKey)) return null;
  answers = dropEphemeralAnswers(answers);

  const exact = answers[normKey];
  if (exact && exact.answer) return { entry: exact, score: 1, method: 'exact' };

  let best = null;
  for (const key of Object.keys(answers)) {
    const entry = answers[key];
    if (!entry || !entry.answer) continue;
    // Free-text essays are company-specific: exact reuse only.
    if (entry.answerType === 'textarea') continue;
    const score = tokenSetScore(normKey, key);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { entry, score, method: 'fuzzy' };
  }
  if (best) return best;

  return coveredAnswer(normKey, answers) || conceptAnswer(normKey, answers, threshold);
}

/** Words that can invert a question's meaning. */
const NEGATION = /\b(not|never|without|cannot|cant|nor|neither)\b/;

/**
 * Minimum significant tokens before a stored question is specific enough to
 * recognise by containment alone.
 *
 * Four is the floor because "will you now or in the future require sponsorship"
 * (now/future/require/sponsorship) is the whole of what a board is asking when
 * it writes "Do you now or will you in the future require immigration
 * sponsorship by the company for continued work-authorization?", and at five
 * that question went unanswered on a live posting.
 *
 * The case four has to survive is "are you legally authorized to work in the
 * united states" (authorized/work/legally/usa) being contained in the same
 * sentence ending "...without sponsorship?", which has the opposite answer.
 * That is caught before we get here: coveredAnswer refuses any key containing a
 * NEGATION, and "without" is one. Three is measurably too low — it answers "are
 * you an engineer with less than 2 years of experience" from a stored "Yes"
 * belonging to a different question.
 */
const MIN_COVERAGE_TOKENS = 4;

/**
 * Last resort: a stored question whose every significant word appears in the
 * asked one.
 *
 * Jaccard punishes extra words, so a company that appends a parenthetical sinks
 * a match that is really the same question. "Will you now or in the future
 * require sponsorship for employment visa status (e.g. H-1B visa status)?"
 * scores 0.64 against the stored wording of itself and was left blank on five
 * of eleven Lever postings, which is the one field on a US application that
 * must not be guessed at by the applicant later.
 *
 * Kept safe by three conditions: the stored question must be long enough to be
 * self-identifying, neither side may contain a negation that could flip the
 * answer, and exactly one stored question may qualify.
 */
function coveredAnswer(normKey, answers) {
  if (NEGATION.test(normKey)) return null;
  const asked = tokenize(normKey);
  if (asked.size === 0) return null;

  const hits = [];
  for (const key of Object.keys(answers)) {
    const entry = answers[key];
    if (!entry || !entry.answer) continue;
    if (entry.answerType === 'textarea') continue;
    if (NEGATION.test(key)) continue;
    const stored = tokenize(key);
    if (stored.size < MIN_COVERAGE_TOKENS) continue;
    let covered = true;
    for (const t of stored) if (!asked.has(t)) { covered = false; break; }
    if (covered) hits.push({ entry, score: stored.size / asked.size, method: 'covered', size: stored.size });
  }

  if (hits.length === 0) return null;
  // The most specific wording wins; a tie means the bank holds two equally good
  // readings of the question. That is only a reason to abstain when the two
  // readings disagree. The bank stores the sponsorship question in a dozen
  // wordings that all answer "Yes", and treating their agreement as ambiguity
  // left the single most important field on a US application blank.
  hits.sort((a, b) => b.size - a.size);
  if (hits.length > 1 && hits[0].size === hits[1].size) {
    const tied = hits.filter(h => h.size === hits[0].size);
    const distinct = new Set(tied.map(h => String(h.entry.answer).trim().toLowerCase()));
    if (distinct.size > 1) return null;
  }
  return hits[0];
}

/**
 * The two questions every US application asks, recognised by concept rather
 * than by wording.
 *
 * The answer bank is a wording index, and these two are asked in unlimited
 * wordings, so it can never keep up. Rocket asks "Are you legally authorized to
 * begin immediate employment in the United States?" against a stored "are you
 * legally authorized to work in the united states": Jaccard scores that 0.43
 * against a 0.75 threshold, and `coveredAnswer` needs every stored token to
 * appear, which "work" does not. Both fell through and the single most
 * important pair of fields on a US application was left blank. This is the same
 * move the EEO block already made for gender and race, and for the same reason:
 * list the wordings and you only ever catch the one you already met.
 *
 * A question belongs to a concept only if it matches ONE of these. That is what
 * makes the compound form safe: "are you authorized to work in the US WITHOUT
 * sponsorship" matches both, resolves to no concept, and is left for the user.
 * Those have the opposite answer, so guessing there is how you tell an employer
 * you need no visa.
 *
 * `sponsorship` deliberately does not key off "visa" alone. The bank holds "No"
 * for "are you currently on a TN visa" and "F-1 (OPT)" for others, so a bare
 * /visa/ would drag unrelated questions into the concept and either poison the
 * agreement check or answer with a status string.
 */
const CONCEPTS = [
  {
    id: 'work-authorization',
    // Greenhouse also asks "eligible to work legally". The sponsorship and
    // unrestricted-work vetoes below still prevent an unsafe legal attestation.
    match: /\bauthoriz|\b(?:eligible|eligibility)\b.*\b(?:work|employment)\b|\b(?:work|employment)\b.*\b(?:eligible|eligibility)\b/,
    // "for ALL employers" / "unrestricted" / "permanent" is a different
    // question with a different honest answer on F-1 or OPT, where the
    // authorization is tied to a sponsor and a field of study. It is also a
    // legal attestation, so it stays with the user. `guards` pins this.
    veto: /\bsponsor|\bimmigration|\ball employers?\b|\bany employer\b|\bunrestricted\b|\bpermanent/,
  },
  { id: 'sponsorship', match: /\bsponsor|\bimmigration/, veto: /\bauthoriz|\b(?:eligible|eligibility)\b.*\b(?:work|employment)\b|\b(?:work|employment)\b.*\b(?:eligible|eligibility)\b/ },
  // These answer only an explicit willingness/availability question. They do
  // not infer a location, a preferred workplace, or a response to a negation.
  { id: 'relocation', match: /\brelocat|\bcommuting distance\b/, veto: /\bnot willing|\bnot able/ },
  {
    id: 'office-availability',
    match: /\b(?:able|willing|available|interested|comfortable|prepared|report to)\b.{0,100}\b(?:office|onsite|on[ -]?site|headquarters|\bhq\b|hybrid|working out of)\b|\b(?:office|onsite|on[ -]?site|headquarters|\bhq\b|working out of|hybrid)\b.{0,100}\b(?:able|willing|available|interested|comfortable|prepared|does that work)\b/,
    veto: /\b(?:where|which|prefer|select all|relocat|commuting distance)\b/,
  },
  { id: 'sexual-orientation', match: /\bsexual orientation\b/, veto: /\bnot|\bdecline/ },
  // A candidate-approved no may be reused only for an explicit non-compete,
  // non-solicitation, or current/former-employer restriction question.
  // "Agreement" by itself is too broad and could be privacy or arbitration.
  { id: 'non-compete', match: /\bnon[ -]?(?:compete|solicit)|(?:agreement|restriction).{0,120}(?:current|former) employer.{0,80}\brestrict|\brestrict your ability to accept/, veto: /\bnot applicable\b|\bprivacy\b|\barbitrat/ },
  { id: 'employer-relatives', match: /\b(?:relatives?|family members?|close relationships?)\b.{0,120}\b(?:employ|employed|work(?:ing)? (?:at|for|with)|who work)/, veto: /\bemergency contact\b|\breference\b/ },
  {
    id: 'essential-functions',
    match: /\b(?:can|able)\b.{0,100}\bessential (?:functions?|duties|job duties)\b|\bessential (?:functions?|duties|job duties)\b.{0,100}\b(?:can|able|perform)/,
    veto: /\bdescribe\b|\bplease explain\b|\bwhat accommodation|\blist\b/,
  },
  // A stored No may map onto Greenhouse "None of the above" / "Not applicable"
  // sanctions options. Yes or mixed bank readings stay fail-closed.
  { id: 'restricted-country', match: /\bcuba\b.*\biran\b|\bsanctions\b|\bexport controls?\b/, veto: /\bnot applicable\b|\bprior question\b/ },
];

/** The single concept a question is about, or null if none or more than one. */
export function conceptOf(normKey) {
  const hits = CONCEPTS.filter(c => c.match.test(normKey) && !c.veto.test(normKey));
  return hits.length === 1 ? hits[0].id : null;
}

const YES_NO = /^(yes|no)$/;

/**
 * Answer by concept, once every wording-based route has failed.
 *
 * Only the plain yes/no readings of a concept get a vote: the bank also stores
 * "F-1 (OPT)" and a sentence about renewals under sponsorship-shaped questions,
 * and those answer a different question than "do you need it". If the voters
 * disagree the bank holds two readings and this abstains, exactly as
 * `coveredAnswer` does.
 */
function conceptAnswer(normKey, answers, threshold) {
  // A caller that raises the threshold is asking for tighter matching, and this
  // is the loosest route there is, so it opts out along with fuzzy.
  if (threshold > DEFAULT_THRESHOLD) return null;
  if (NEGATION.test(normKey)) return null;
  const concept = conceptOf(normKey);
  if (!concept) return null;

  const distinct = new Set();
  let first = null;
  for (const key of Object.keys(answers)) {
    const entry = answers[key];
    if (!entry || !entry.answer) continue;
    if (entry.answerType === 'textarea') continue;
    if (NEGATION.test(key)) continue;
    if (conceptOf(key) !== concept) continue;
    const answer = String(entry.answer).trim().toLowerCase();
    if (concept !== 'sexual-orientation' && !YES_NO.test(answer)) continue;
    distinct.add(answer);
    if (!first) first = entry;
  }
  if (!first || distinct.size !== 1) return null;
  return { entry: first, score: 0.9, method: 'concept' };
}

/**
 * Map a stored answer ("Yes") onto one of THIS form's options
 * ("Yes, I will require sponsorship"). Abstains on ambiguity.
 */
export function matchOption(answerText, options) {
  if (!answerText || !Array.isArray(options) || options.length === 0) return null;
  const target = normalizeKey(answerText);
  if (!target) return null;

  const normed = options.map(o => ({ option: o, key: normalizeKey(optionText(o)) }));

  const exact = normed.filter(n => n.key === target);
  if (exact.length === 1) return exact[0].option;
  if (exact.length > 1) return exact[0].option;

  const gpaBand = matchGpaBand(answerText, options);
  if (gpaBand) return gpaBand;
  const gpaTenth = matchGpaTenth(answerText, options);
  if (gpaTenth) return gpaTenth;
  const salaryBand = matchSalaryBand(answerText, options);
  if (salaryBand) return salaryBand;

  // Yes/No: a stored "Yes" should land on "Yes, I am authorized to work".
  // Approved demographic answers can likewise be a full controlled sentence
  // beginning "No" while a portal offers just "No". Keep the leading answer
  // only when it is uniquely represented on this form. If several options
  // qualify it ("Yes, in the future" vs "Yes, now"), abstain rather than turn
  // a profile fact into an unsafe legal claim.
  const leadingYesNo = /^(yes|no)\b/.exec(target)?.[1] || null;
  if (leadingYesNo) {
    const starts = normed.filter(n => n.key === leadingYesNo || n.key.startsWith(leadingYesNo + ' '));
    return starts.length === 1 ? starts[0].option : null;
  }

  if (/^(n\/a|na|none|not applicable)$/.test(target)) {
    const none = normed.filter(n => /^(n\/a|na|none|not applicable)\b/.test(n.key));
    return none.length === 1 ? none[0].option : null;
  }

  // Take the option that contains every significant token of the stored answer,
  // but only when exactly one does. This is what lands "Asian" on "Asian
  // (United States of America)" and "Yes I will require sponsorship in the
  // future" on its matching option. Several matches means the options differ in
  // a way the stored answer doesn't resolve, so fall through and let the
  // scoring gate abstain. Token containment, not substring, so "Asian" never
  // matches "Caucasian".
  const targetTokens = [...tokenize(target)];
  if (targetTokens.length > 0) {
    const contains = normed.filter(n => {
      const optionTokens = tokenize(n.key);
      return targetTokens.every(t => optionTokens.has(t));
    });
    if (contains.length === 1) return contains[0].option;
    // Several options mention the answer, so prefer one that leads with it.
    // EEO race lists do this: "Asian (not Hispanic or Latino) - ..." is the
    // answer, while "Two or More Races ... Asian; or American Indian ..."
    // merely lists it. Still abstain when leading with it is not decisive.
    if (contains.length > 1) {
      const leads = contains.filter(n => n.key === target || n.key.startsWith(target + ' '));
      if (leads.length === 1) return leads[0].option;
    }
  }

  // US EEO forms normally use the broad controlled category "Asian", while
  // the candidate's locally stored self-description is more specific.  This
  // is a one-way, exact fallback: it never maps the broad category onto a
  // different specific identity, and it still requires a single unambiguous
  // option on the form.
  if (target === 'south asian') {
    const asian = normed.filter(n => n.key === 'asian' || n.key.startsWith('asian '));
    if (asian.length === 1) return asian[0].option;
  }

  const scored = normed
    .map(n => ({ option: n.option, score: tokenSetScore(target, n.key) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < 0.6) return null;
  // Too close to call: leave it for the human.
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.1) return null;
  return scored[0].option;
}

const RESTRICTED_COUNTRY = /\bcuba\b.*\biran\b|\biran\b.*\bnorth korea\b|\bnorth korea\b.*\bsyria\b/;
const SANCTIONS_EXPORT = /\bsanctions\b|\bexport controls?\b/;

function optionText(option) {
  if (typeof option === 'string') return option;
  return String(option?.text || option?.value || '');
}

export function sanctionsPolarity(answer) {
  const key = normalizeKey(answer);
  if (!key) return 'ambiguous';
  if (key === 'none of the above' || /^(no)\b/.test(key)) return 'no';
  if (/^(yes)\b/.test(key)) return 'yes';
  return 'ambiguous';
}

export function isSanctionsFollowUp(question = '') {
  return /selected a response to the prior question|other than.{0,80}(?:none of the above|none\s*\/?\s*not applicable)|checked any of the boxes above other than|immigration and residency status/i.test(question);
}

export function restrictedCountryStoredAnswer(answers = {}) {
  const hits = [];
  for (const [key, entry] of Object.entries(answers)) {
    if (!entry?.answer || entry.answerType === 'textarea') continue;
    const norm = normalizeKey(key);
    if (!RESTRICTED_COUNTRY.test(norm) && !SANCTIONS_EXPORT.test(norm)) continue;
    hits.push(entry);
  }
  const polarities = new Set(hits.map(item => sanctionsPolarity(item.answer)));
  if (polarities.size !== 1 || !polarities.has('no')) return null;
  return hits[0];
}

function uniqueOption(options, predicate) {
  const hits = (Array.isArray(options) ? options : []).filter(option => predicate(optionText(option)));
  return hits.length === 1 ? optionText(hits[0]) : null;
}

function uniqueNoneLikeOption(options) {
  return uniqueOption(options, text => {
    const key = normalizeKey(text);
    if (!key) return false;
    if (key === 'none of the above' || key === 'none not applicable' || key === 'none/not applicable') return true;
    return /^none\b/.test(key) && /\bnot applicable\b/.test(key) && key.length < 48;
  });
}

const EMBARGOED_CITIZENSHIP = /\bcuba\b|\biran\b|\bnorth korea\b|\bsyria\b|\bcrimea\b|\bdonetsk\b|\bluhansk\b/;

/**
 * Map a stored restricted-country No onto Greenhouse select-all options.
 * Yes, missing, or mixed bank readings return null.
 */
export function mapSanctionsChoice(question, options, storedAnswer, profile = {}) {
  if (sanctionsPolarity(storedAnswer) !== 'no' || !Array.isArray(options) || options.length === 0) return null;
  const q = String(question || '');
  if (isSanctionsFollowUp(q)) {
    const citizenship = String(profile.identity?.citizenship || profile.citizenship || '').trim();
    if (citizenship && !EMBARGOED_CITIZENSHIP.test(normalizeKey(citizenship))) {
      const otherCountry = uniqueOption(options, text =>
        /citizen or legal permanent resident of a different country/i.test(text));
      if (otherCountry) return otherCountry;
    }
    const priorNone = uniqueOption(options, text =>
      /not applicable/i.test(text) && /none of the above|prior question/i.test(text));
    if (priorNone) return priorNone;
    return uniqueOption(options, text => /^not applicable\b/i.test(text.trim()));
  }
  const blob = normalizeKey([q, ...options.map(optionText)].join(' '));
  if (!RESTRICTED_COUNTRY.test(blob) && !SANCTIONS_EXPORT.test(blob)) return null;
  return uniqueNoneLikeOption(options);
}

/** Fill the export-control country box once the embargoed-list answer is No. */
export function exportControlCountryAnswer(question = '', { citizenship = '', storedRestrictedNo = false } = {}) {
  if (!storedRestrictedNo) return null;
  const q = String(question || '');
  if (!/indicate the applicable country|type n\/a if not applicable/i.test(q)) return null;
  if (!/citizen or legal permanent resident of a different country|reside in a different country/i.test(q)) return null;
  const country = String(citizenship || '').trim();
  if (country && !EMBARGOED_CITIZENSHIP.test(normalizeKey(country))) return country;
  return 'N/A';
}

/**
 * ITAR / EAR "U.S. Person" is citizenship, green card, or asylee/refugee.
 * It is not the Cuba/Iran sanctions checkbox.
 */
export function usPersonExportAnswer(question = '', options = [], { usPerson = false } = {}) {
  const q = String(question || '');
  if (/\bexplain\b|\bplease describe\b|\badditional (?:information|comments)\b/i.test(q)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  const blob = `${q}\n${items.join('\n')}`;
  if (!/export compliance|u\.?s\.? person|united states person|\bitar\b/i.test(blob)) return null;
  const yes = items.filter(text => /\bi am currently a\b/i.test(text) && /u\.?s\.? person/i.test(text) && !/\bnot a\b/i.test(text));
  const no = items.filter(text => /\bnot a\b/i.test(text) && /u\.?s\.? person/i.test(text));
  if (usPerson) {
    if (yes.length === 1) return yes[0];
    return items.length ? null : 'Yes';
  }
  if (no.length === 1) return no[0];
  return items.length ? null : 'No';
}

function storedConceptPolarity(answers = {}, conceptId) {
  const distinct = new Set();
  let first = null;
  for (const [key, entry] of Object.entries(answers || {})) {
    if (!entry?.answer || entry.answerType === 'textarea') continue;
    if (conceptOf(key) !== conceptId) continue;
    const answer = String(entry.answer).trim().toLowerCase();
    if (!YES_NO.test(answer)) continue;
    distinct.add(answer);
    if (!first) first = answer;
  }
  return distinct.size === 1 ? first : null;
}

/**
 * SpaceX-style status lists are not Yes/No. A stored authorized-Yes must never
 * land on "any employer"; F-1 plus sponsorship-Yes is "I require sponsorship".
 */
export function workAuthorizationStatusAnswer(question = '', options = [], answers = {}, { usPerson = false } = {}) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (/\bwithout sponsorship\b/.test(key)) return null;
  if (/\bexplain\b|\bplease describe\b/.test(key)) return null;
  if (!/\bauthoriz|\beligible to work|\blegally (?:work|authorized)/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const anyEmployer = items.filter(text => /\b(?:any|all) employers?\b/i.test(text) && /\bauthoriz/i.test(text));
  const sponsorship = items.filter(text => /\brequire sponsorship\b/i.test(text));
  if (!anyEmployer.length && !sponsorship.length) return null;
  const needsSponsorship = storedConceptPolarity(answers, 'sponsorship') === 'yes';
  if (usPerson && !needsSponsorship && anyEmployer.length === 1) return anyEmployer[0];
  if (needsSponsorship && sponsorship.length === 1) return sponsorship[0];
  return null;
}

/**
 * ITAR "Citizenship Status" is citizen / LPR / asylee / Other, not a country.
 * Indian citizenship and usPerson No map onto the unique Other option.
 */
export function citizenshipStatusAnswer(question = '', options = [], { citizenship = '', usPerson = false } = {}) {
  const key = normalizeKey(question);
  if (!key || /\bcountry of citizenship\b/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const looksLikeStatus = items.some(text => /u\.?s\.? citizen|lawful permanent resident|asylee|refugee|\bdaca\b/i.test(text));
  if (!looksLikeStatus) return null;
  if (!/\bcitizenship\b/.test(key) && !/\bcitizen or national\b/.test(key)) return null;
  if (usPerson) {
    return uniqueOption(items, text => /u\.?s\.? citizen or national/i.test(text)
      || (/u\.?s\.? citizen/i.test(text) && !/permanent resident/i.test(text)));
  }
  const country = normalizeKey(citizenship);
  if (country && /united states|u s a|usa/.test(country)) {
    return uniqueOption(items, text => /u\.?s\.? citizen/i.test(text) && !/permanent resident/i.test(text));
  }
  return uniqueOption(items, text => /\bother\b/i.test(text)
    && !/u\.?s\.? citizen|permanent resident|asylee|refugee|\bdaca\b/i.test(text));
}

/** Short fact for an ITAR "Other, please explain" follow-up. */
export function citizenshipOtherExplainAnswer(question = '', { citizenship = '', usPerson = false } = {}) {
  const key = normalizeKey(question);
  if (!key || usPerson) return null;
  if (!/\bexplain\b/.test(key) && !/\bplease specify\b/.test(key)) return null;
  if (!/\bother\b/.test(key) && !/\bcitizenship\b/.test(key)) return null;
  const country = String(citizenship || '').trim();
  if (!country) return null;
  return `${country} citizen, F-1 student visa`;
}

/** Never held a US clearance. Do not pick "do not wish to disclose" when never-held exists. */
export function securityClearanceAnswer(question = '', options = []) {
  const key = normalizeKey(question);
  if (!/\b(?:security )?clearance/.test(key)) return null;
  if (/\bexplain\b|\bplease describe\b/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const neverHeld = uniqueOption(items, text => {
    const optionKey = normalizeKey(text);
    if (/\bwish to disclose\b/.test(optionKey)) return false;
    if (/\b(?:top secret|secret|confidential|polygraph|public trust|doe level|ts\/sci)\b/.test(optionKey)
        && !/\bnever\b/.test(optionKey)) {
      return false;
    }
    return /\bnever held\b/.test(optionKey) || /\bno clearance\b/.test(optionKey);
  });
  if (neverHeld) return neverHeld;
  return uniqueOption(items, text => /^(?:none|no|n\/a|not applicable)$/.test(normalizeKey(text)));
}

/**
 * "SpaceX & SpaceXAI Employment History" and similar named-employer prompts.
 * Inventing employment at the named company is not allowed.
 */
export function namedEmployerHistoryAnswer(question = '', options = [], work = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\bemployment history\b/.test(key) && !/\bpreviously worked\b/.test(key) && !/\bworked for\b/.test(key)) {
    return null;
  }
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const haystack = normalizeKey([question, ...items].join(' '));
  const employers = (Array.isArray(work) ? work : [])
    .map(entry => normalizeKey(typeof entry === 'string' ? entry : entry?.company))
    .filter(Boolean);
  const overlap = employers.some((employer) => {
    const tokens = [...tokenize(employer)].filter(token => token.length >= 4);
    return tokens.some(token => haystack.includes(token));
  });
  if (overlap) return null;
  return uniqueOption(items, text => {
    const optionKey = normalizeKey(text);
    return /\bnever worked\b/.test(optionKey) || /\bhave never\b/.test(optionKey);
  });
}

function namedOrgTokensOverlap(question, work = []) {
  const haystack = normalizeKey(question);
  const employers = (Array.isArray(work) ? work : [])
    .map(entry => normalizeKey(typeof entry === 'string' ? entry : entry?.company))
    .filter(Boolean);
  return employers.some((employer) => {
    const tokens = [...tokenize(employer)].filter(token => token.length >= 4);
    return tokens.some(token => haystack.includes(token));
  });
}

/**
 * "Are you currently employed at an NISC Member site?" is not generic
 * employment status. Inventing a Yes for a named employer is not allowed.
 */
export function currentlyEmployedAtNamedOrgAnswer(question = '', options = [], work = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\bcurrently (?:employed|working|work)\b/.test(key) && !/\bcurrent employee\b/.test(key)) return null;
  if (!/\b(?:at|for|with|of)\b/.test(key) && !/\bmember site\b/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  if (namedOrgTokensOverlap(question, work)) return null;
  return uniqueOption(items, text => /^(no)\b/.test(normalizeKey(text)));
}

function workHistoryBlob(work = []) {
  return (Array.isArray(work) ? work : [])
    .map(entry => (typeof entry === 'string' ? entry : `${entry?.company || ''} ${entry?.title || ''}`))
    .join(' ');
}

function workLooksUsGovernmental(work = []) {
  const key = normalizeKey(workHistoryBlob(work));
  if (!key) return false;
  return /\b(?:united states|u s )?(?:government|congress|military|army|navy|air force|marine corps|space force|coast guard|national guard|amtrak|postal service|usaid)\b/.test(key)
    || /\bdepartment of (?:defense|energy|state|justice|homeland|commerce|labor|education|veterans)\b/.test(key);
}

function workLooksUsMilitaryService(work = []) {
  const key = normalizeKey(workHistoryBlob(work));
  if (!key) return false;
  return /\b(?:united states|u s )?(?:military|army|navy|air force|marine corps|space force|coast guard|national guard)\b/.test(key)
    || /\b(?:army|navy|air force|marine) reserves?\b/.test(key);
}

/**
 * US Reserves / National Guard service while employed. Never invent Yes.
 */
export function militaryReserveOrGuardAnswer(question = '', options = [], work = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  const namedService = /\bnational guard\b/.test(key)
    || (/\breserves?\b/.test(key) && /\b(?:military|national guard|enlisted|armed forces|serving)\b/.test(key))
    || (/\benlisted personnel\b/.test(key) && /\b(?:reserve|guard|military)\b/.test(key));
  if (!namedService) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  if (workLooksUsMilitaryService(work)) return null;
  return uniqueOption(items, text => /^(no)\b/.test(normalizeKey(text)));
}

/**
 * Current or past US / state / local government employment. Never invent Yes.
 */
export function usGovernmentEmploymentAnswer(question = '', options = [], work = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (/\bnational guard\b/.test(key) || (/\breserves?\b/.test(key) && /\benlisted\b/.test(key))) return null;
  if (!/\b(?:u s |united states |federal |state or local )?government\b/.test(key)
      && !/\b(?:u s |united states )?congress\b/.test(key)) {
    return null;
  }
  if (!/\b(?:employee|employed|employment|worked for)\b/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  if (workLooksUsGovernmental(work)) return null;
  return uniqueOption(items, text => /^(no)\b/.test(normalizeKey(text)));
}

/**
 * Relatives or close relationships who work at the named employer. Stored No
 * is reused; Yes is never invented.
 */
export function relativesAtNamedOrgAnswer(question = '', options = [], answers = {}) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\b(?:relatives?|family members?|close relationships?)\b/.test(key)) return null;
  if (!/\b(?:employ|employed|work(?:ing)? (?:at|for|with)|who work)\b/.test(key)) return null;
  if (/\bemergency contact\b/.test(key) || /\breference\b/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const stored = findAnswer(key, answers)?.entry?.answer
    || findAnswer(
      normalizeKey('Do you have any relatives or family members currently employed at this company?'),
      answers,
    )?.entry?.answer;
  if (stored && /^(yes)\b/.test(normalizeKey(stored))) {
    const yes = matchOption(stored, items);
    return yes ? optionText(yes) : null;
  }
  return uniqueOption(items, text => /^(no)\b/.test(normalizeKey(text)));
}

/**
 * Required accuracy attestation ("Affirmation" / I certify the application)
 * and ordinary recruiting privacy-notice acknowledgements. Unique I agree /
 * I certify / Acknowledged only. Marketing consent stays untouched.
 */
export function applicationAffirmationAnswer(question = '', options = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (/(?:marketing|talent community|job alerts?|newsletters?|sms|text message|contact you about job opportunit)/.test(key)) return null;
  if (isOtpVerificationQuestion(question)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const privacyNotice = /\bprivacy notice\b/.test(key)
    || (/\b(?:handle|process(?:ing)?)\b/.test(key) && /\b(?:data|personal information)\b/.test(key) && /\brecruit/.test(key));
  if (privacyNotice) {
    return uniqueOption(items, text => /^(?:acknowledged|i acknowledge|i agree|agree)$/.test(normalizeKey(text)));
  }
  const labeled = /^(?:affirmation|acknowledgement|acknowledgment)$/.test(key)
    || (
      /\b(?:i (?:certify|affirm|attest|acknowledge)|certify that|affirm that)\b/.test(key)
      && /\b(?:information|application|accuracy|foregoing|true and complete|above is true)\b/.test(key)
    );
  if (!labeled) return null;
  return uniqueOption(items, text => /^(?:i (?:agree|certify|acknowledge|attest)|agree|yes|acknowledged)$/.test(normalizeKey(text)));
}

function educationRank(entry = {}) {
  const blob = `${entry.degree || ''} ${entry.degreeRaw || ''} ${entry.degreeOption || ''}`.toLowerCase();
  if (/ph\.?d|doctor/.test(blob)) return 5;
  if (/master/.test(blob)) return 4;
  if (/bachelor|b\.?\s*tech|\bb\.s\b/.test(blob)) return 3;
  if (/associate/.test(blob)) return 2;
  if (/high school/.test(blob)) return 1;
  return 0;
}

/**
 * Highest completed credential, never an in-progress degree. A current master's
 * therefore maps onto the finished bachelor's option, including "Masters's".
 */
export function completedEducationLevelAnswer(question = '', options = [], education = []) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\beducation\b/.test(key) && !/\bdegree\b/.test(key)) return null;
  if (!/\b(?:most recently completed|completed form of education|highest (?:completed )?(?:level|form) of education|highest degree (?:earned|completed|obtained)|highest completed)\b/.test(key)
      && !(/\bmost recent/.test(key) && /\bcompleted\b/.test(key))) {
    return null;
  }
  const completed = (Array.isArray(education) ? education : [])
    .filter(entry => entry && entry.current !== true);
  if (!completed.length) return null;
  const top = [...completed].sort((left, right) => educationRank(right) - educationRank(left))[0];
  const label = String(top.degreeOption || `${top.degree || ''} Degree`).trim();
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return label || null;
  const matched = matchOption(label, items) || matchOption(top.degree, items);
  if (matched) return optionText(matched);
  const blob = `${top.degree || ''} ${top.degreeRaw || ''} ${top.degreeOption || ''}`.toLowerCase();
  const degreeWord = /master/.test(blob) ? /masters?/
    : /bachelor|b\.?\s*tech|\bb\.s\b/.test(blob) ? /bachelors?/
      : /associate/.test(blob) ? /associates?/
        : /high school/.test(blob) ? /high school/
          : null;
  if (!degreeWord) return null;
  return uniqueOption(items, text => degreeWord.test(normalizeKey(text)));
}

function willRelocateFromAnswer(relocateAnswer) {
  const polar = normalizeKey(relocateAnswer);
  return /^yes\b/.test(polar) || /\bwilling to relocate\b/.test(polar);
}

function officeLocationOptions(options = []) {
  return (Array.isArray(options) ? options : []).map(option => {
    const text = optionText(option);
    return { option, text, key: normalizeKey(text) };
  }).filter(item => item.text && /,\s*[A-Z]{2}\s*$/.test(item.text));
}

function remoteLocationOptions(options = []) {
  return (Array.isArray(options) ? options : []).map(option => {
    const text = optionText(option);
    return { option, text, key: normalizeKey(text) };
  }).filter(item => item.text && /\bremot/.test(item.key) && !/\boffice\b/.test(item.key));
}

function relocationChoiceKind(text) {
  const raw = String(text || '').trim();
  const key = normalizeKey(raw);
  if (!key) return 'other';
  if (/^(no)\b/.test(key) && /\bremote\b/.test(key)) return 'remote-no';
  if (/^(no)\b/.test(key)) return 'no';
  if (/^(yes)\b/.test(key)) return 'yes';
  if (/\bremote\b/.test(key) && !/,\s*[A-Z]{2}\s*$/.test(raw)) return 'remote';
  return 'office';
}

/**
 * "Are you open to relocation?" can be Yes/No or a list of offices plus No.
 * Relocate-yes selects every named office. Polar Yes is used only when that
 * is the unique option. Remote-only / No stay unselected.
 */
export function relocationPreferenceAnswer(question = '', options = [], { relocateAnswer } = {}) {
  const key = normalizeKey(question);
  if (!key || !/\brelocat/.test(key)) return null;
  if (/\bcommuting distance\b/.test(key) || /\blocal to\b/.test(key)) return null;
  const willRelocate = willRelocateFromAnswer(relocateAnswer);
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const offices = items.filter(text => relocationChoiceKind(text) === 'office');
  if (offices.length) {
    if (!willRelocate) return uniqueOption(items, text => relocationChoiceKind(text) === 'no');
    return joinMulti(offices);
  }
  if (willRelocate) return uniqueOption(items, text => relocationChoiceKind(text) === 'yes');
  return uniqueOption(items, text => relocationChoiceKind(text) === 'no');
}

/**
 * Required future-opportunity / marketing prompts may be completed with unique
 * No. Voluntary opt-ins stay blank.
 */
export function futureOpportunityDeclineAnswer(question = '', options = []) {
  const blob = `${question} ${(Array.isArray(options) ? options : []).map(option => optionText(option)).join(' ')}`;
  if (!/(?:marketing|talent (?:community|network|pool)|future (?:job|career|employment|opportunit)|future opportunit|job alerts?|newsletters?|promotional|keep (?:me )?informed)/i.test(blob)) {
    return null;
  }
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return 'No';
  return uniqueOption(items, text => {
    const optionKey = normalizeKey(text);
    return /^(no)\b/.test(optionKey) && !/\b(?:yes|keep me informed|job alerts?|sign me up|subscribe)\b/.test(optionKey);
  });
}

/**
 * Office-or-remote "select all that apply" lists. Relocate-yes selects every
 * named office. Remote is only chosen when no office applies.
 */
export function workLocationInterestAnswer(question = '', options = [], { location = {}, relocateAnswer } = {}) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\blocations? (?:are you interested|would you (?:like|prefer) to work|interested in working)\b/.test(key)
      && !(/\bselect all that apply\b/.test(key) && /\b(?:location|office|working from|work from)\b/.test(key))
      && !/\bwhere (?:would|do) you (?:like|prefer|want) to work\b/.test(key)) {
    return null;
  }
  const offices = officeLocationOptions(options);
  const remote = remoteLocationOptions(options);
  if (!offices.length && !remote.length) return null;
  const localOffices = offices.filter(item => livesNearNamedHubs(location, item.text));
  const relocate = willRelocateFromAnswer(relocateAnswer);
  let selected = [];
  if (localOffices.length) selected = localOffices;
  else if (relocate && offices.length) selected = offices;
  else if (remote.length === 1) selected = remote;
  if (!selected.length) return null;
  return joinMulti(selected.map(item => item.text));
}

/**
 * Follow-up to a remote checkbox. Relocate-yes plus an office-intent option
 * means the candidate will work from an employer office, not a US state.
 */
export function remoteWorkStateAnswer(question = '', options = [], { location = {}, relocateAnswer } = {}) {
  const key = normalizeKey(question);
  if (!key || !/\bstate\b/.test(key) || !/\bremot/.test(key)) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return null;
  const officeIntent = uniqueOption(items, text =>
    /\bwork in (?:an? )?(?:\w+ )?office\b/i.test(text) || /\bnot remote\b/i.test(text));
  if (officeIntent && willRelocateFromAnswer(relocateAnswer)) return officeIntent;
  const stateHit = matchOption(location.state, items) || matchOption(location.stateAbbr, items);
  if (stateHit) return optionText(stateHit);
  return uniqueOption(items, text => /\bnot located in the united states\b/.test(normalizeKey(text)));
}

/** Stored travel-percentage band. Interview-travel Yes is a different question. */
export function travelPercentageAnswer(question = '', options = [], answers = {}) {
  const key = normalizeKey(question);
  if (!key || /\binterview\b/.test(key)) return null;
  if (!/\bpercent/.test(key) && !(/\bwilling to travel\b/.test(key) && /\btime\b/.test(key))) return null;
  const stored = findAnswer(key, answers)?.entry?.answer;
  if (!stored) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return stored;
  const matched = matchOption(stored, items);
  return matched ? optionText(matched) : null;
}

/** First-day / operational SMS opt-in. OTP codes stay ephemeral. */
export function operationalSmsOptInAnswer(question = '', options = [], answers = {}) {
  const key = normalizeKey(question);
  if (!key || isOtpVerificationQuestion(question)) return null;
  if (!/\b(?:sms|text message)\b/.test(key)) return null;
  const stored = findAnswer(key, answers)?.entry?.answer
    || findAnswer(normalizeKey('Would you like to receive information via text message/SMS?'), answers)?.entry?.answer;
  if (!stored) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (!items.length) return stored;
  const matched = matchOption(stored, items);
  return matched ? optionText(matched) : null;
}

function salaryAmounts(text) {
  const raw = String(text || '');
  const amounts = [];
  for (const match of raw.matchAll(/\$?\s*(\d{1,3}(?:,\d{3}){1,2}|\d{4,7})(?:\.\d{2})?/g)) {
    amounts.push(Number(match[1].replace(/,/g, '')));
  }
  for (const match of raw.matchAll(/\b(\d{2,3})\s*k\b/gi)) {
    amounts.push(Number(match[1]) * 1000);
  }
  return [...new Set(amounts.filter(number => Number.isFinite(number) && number > 0))];
}

function parseSalaryBand(text) {
  const compact = String(text || '').toLowerCase().replace(/[$,\s]/g, '');
  if (!compact) return null;
  const less = compact.match(/^(?:lessthan|under|below|upto)(\d+)k$/);
  if (less) return { min: 0, max: Number(less[1]) * 1000 };
  const plus = compact.match(/^(\d+)k(?:\+|ormore|andabove)$/);
  if (plus) return { min: Number(plus[1]) * 1000, max: Number.POSITIVE_INFINITY };
  const range = compact.match(/^(\d+)-(\d+)k$/);
  if (range) {
    const min = Number(range[1]) * 1000;
    const max = Number(range[2]) * 1000;
    if (min <= max) return { min, max };
  }
  return null;
}

/** Map $125,000 onto the unique "121-130K" band. Abstain when two bands fit. */
export function matchSalaryBand(answerText, options = []) {
  const amounts = salaryAmounts(answerText);
  if (!amounts.length) return null;
  const value = amounts.length >= 2 ? (amounts[0] + amounts[1]) / 2 : amounts[0];
  const hits = (Array.isArray(options) ? options : []).filter(option => {
    const band = parseSalaryBand(optionText(option));
    return Boolean(band) && value >= band.min && value <= band.max;
  });
  return hits.length === 1 ? hits[0] : null;
}

export function alignSalaryAnswerToOptions(value, options = []) {
  const text = String(value || '').trim();
  if (!text || !Array.isArray(options) || !options.length) return text;
  const mapped = matchOption(text, options);
  return mapped ? optionText(mapped) : text;
}

/** True when a committed widget still holds the value we asked it to keep. */
export function filledValueMatches(actual, requested) {
  const shown = String(actual || '').trim();
  const wanted = String(requested || '').trim();
  if (!shown || !wanted) return false;
  if (shown === wanted) return true;
  if (normalizeKey(shown) === normalizeKey(wanted)) return true;
  if (matchOption(wanted, [shown]) || matchOption(shown, [wanted])) return true;
  const shownBand = parseSalaryBand(shown);
  const wantedBand = parseSalaryBand(wanted);
  if (shownBand && wantedBand && shownBand.min === wantedBand.min && shownBand.max === wantedBand.max) {
    return true;
  }
  return Boolean(matchSalaryBand(wanted, [shown]) || matchSalaryBand(shown, [wanted]));
}

function gpaQuestionLevel(question = '') {
  const key = normalizeKey(question);
  if (!/\b(?:gpa|cgpa|grade point average)\b/.test(key)) return null;
  if (/\b(?:high school|secondary)\b/.test(key)) return 'high-school';
  if (/\b(?:doctorate|doctoral|phd|ph d)\b/.test(key)) return 'doctorate';
  if (/\b(?:undergrad|undergraduate|bachelor|bachelors)\b/.test(key)) return 'bachelor';
  if (/\b(?:graduate|masters?)\b/.test(key)) return 'master';
  return null;
}

function educationForGpaLevel(education = [], level) {
  const entries = Array.isArray(education) ? education : [];
  const blob = entry => `${entry?.degree || ''} ${entry?.degreeRaw || ''} ${entry?.degreeOption || ''}`;
  if (level === 'bachelor') return entries.find(entry => /bachelor|b\.?\s*tech|b\.s/i.test(blob(entry))) || null;
  if (level === 'master') return entries.find(entry => /master|m\.s|mism/i.test(blob(entry))) || null;
  if (level === 'doctorate') return entries.find(entry => /ph\.?d|doctor/i.test(blob(entry))) || null;
  return null;
}

function uniqueNotApplicableScore(options) {
  return uniqueOption(options, text => {
    const key = normalizeKey(text);
    return /\bnot applicable\b/.test(key) || /\bdo not recall\b/.test(key);
  });
}

function uniqueDidNotTakeOption(options) {
  const hits = (Array.isArray(options) ? options : [])
    .map(option => optionText(option))
    .filter((text) => {
      const key = normalizeKey(text);
      if (/\bout of\b/.test(key)) return false;
      return /\bdid not take\b/.test(key) || /\bdo not recall\b/.test(key) || /\bnot applicable\b/.test(key);
    });
  if (hits.length === 1) return hits[0];
  const primary = hits.filter(text => !/\bother\b/.test(normalizeKey(text)));
  return primary.length === 1 ? primary[0] : null;
}

/**
 * Degree-scoped GPA. Undergraduate uses the bachelor's record, graduate the
 * master's, doctorate N/A when no PhD exists. Never copies the current GPA
 * onto a different degree.
 */
export function degreeGpaAnswer(question = '', options = [], education = []) {
  const level = gpaQuestionLevel(question);
  if (!level || level === 'high-school') return null;
  const items = Array.isArray(options) ? options : [];
  const entry = educationForGpaLevel(education, level);
  if (!entry?.gpa) {
    return level === 'doctorate' || !entry ? uniqueNotApplicableScore(items) : null;
  }
  if (!items.length) return String(entry.gpa);
  const tenth = matchGpaTenth(entry.gpa, items);
  if (tenth) return optionText(tenth);
  const band = matchGpaBand(entry.gpa, items);
  return band ? optionText(band) : null;
}

/** SAT / ACT / GRE / GMAT. No stored score means the unique did-not-take option. */
export function standardizedTestAnswer(question = '', options = []) {
  const key = normalizeKey(question);
  if (!/^(?:sat|act|gre|gmat)(?: score)?$/.test(key) && !/\b(?:sat|act|gre|gmat) score\b/.test(key)) {
    return null;
  }
  return uniqueDidNotTakeOption(options);
}

/**
 * "With or without reasonable accommodations" contains "without", which the
 * concept matcher treats as a negation. Fill from the stored Yes instead.
 */
export function essentialFunctionsAnswer(question = '', options = [], answers = {}) {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\b(?:can|able)\b/.test(key) || !/\bessential (?:functions?|duties|job duties)\b/.test(key)) return null;
  if (/\bdescribe\b|\bplease explain\b|\bwhat accommodation/.test(key)) return null;
  const votes = [];
  for (const [ansKey, entry] of Object.entries(answers || {})) {
    if (!entry?.answer || entry.answerType === 'textarea') continue;
    if (!/\bessential (?:functions?|duties|job duties)\b/.test(ansKey)) continue;
    if (!/\b(?:can|able|perform)\b/.test(ansKey)) continue;
    const answer = String(entry.answer).trim().toLowerCase();
    if (YES_NO.test(answer)) votes.push(answer);
  }
  if (new Set(votes).size !== 1 || votes[0] !== 'yes') return null;
  const wanted = 'Yes';
  if (!Array.isArray(options) || options.length === 0) return wanted;
  const mapped = matchOption(wanted, options);
  return mapped ? optionText(mapped) : wanted;
}

/** Current F-1 OPT/CPT only. "Now or in the future" stays a different question. */
export function f1OptCptCurrentAnswer(question = '', options = [], stored = '') {
  const key = normalizeKey(question);
  if (!key) return null;
  if (!/\bcurrently\b/.test(key)) return null;
  if (/\bin the future\b/.test(key)) return null;
  if (/\bexplain\b|\bplease describe\b|\badditional (?:information|comments)\b/.test(key)) return null;
  if (!/\b(?:f1|f 1)\b/.test(key) || !/\b(?:opt|cpt)\b/.test(key)) return null;
  const polar = normalizeKey(stored);
  if (!/^(yes|no)$/.test(polar)) return null;
  const wanted = polar === 'yes' ? 'Yes' : 'No';
  if (!Array.isArray(options) || options.length === 0) return wanted;
  const mapped = matchOption(wanted, options);
  return mapped ? optionText(mapped) : wanted;
}

const NAMED_SCHOOL_AFFILIATION = /(?:currently attending or (?:a )?recent graduate of|currently attending|enrolled at|student (?:at|of)|(?:a )?recent graduate of|graduate of|alumni of|alumnus of|alum of)\s+(.+)$/i;
const GENERIC_SCHOOL = /^(?:a |an |the )?(?:college|university|school|institution|high school)\??$/i;
const SCHOOL_STOPWORDS = new Set(['university', 'college', 'institute', 'institution', 'technology', 'the', 'and']);
const SCHOOL_ALIASES = Object.freeze({
  'georgia tech': ['georgia institute of technology', 'gatech'],
  'georgia institute of technology': ['georgia tech', 'gatech'],
  cmu: ['carnegie mellon university', 'carnegie mellon'],
  'carnegie mellon': ['carnegie mellon university', 'cmu'],
  'carnegie mellon university': ['cmu', 'carnegie mellon'],
  vit: ['vellore institute of technology'],
  'vellore institute of technology': ['vit'],
});

export function extractNamedSchool(question = '') {
  const text = String(question || '').replace(/[?]+$/g, '').trim();
  const match = NAMED_SCHOOL_AFFILIATION.exec(text);
  if (!match) return null;
  const school = match[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!school || GENERIC_SCHOOL.test(school) || school.length < 3) return null;
  return school;
}

function schoolNameKeys(name) {
  const key = normalizeKey(name);
  return new Set([key, ...(SCHOOL_ALIASES[key] || []).map(normalizeKey)]);
}

function distinctiveSchoolTokens(name) {
  return [...tokenize(normalizeKey(name))].filter(token => !SCHOOL_STOPWORDS.has(token));
}

/**
 * Yes/No for "are you a student/graduate of X". Uses profile education only.
 * A named school that is not on the record is No; inventing attendance is not
 * allowed. Abstains when the question is not this shape or education is empty.
 */
export function namedSchoolAffiliationAnswer(question = '', education = []) {
  const asked = extractNamedSchool(question);
  if (!asked) return null;
  const schools = (Array.isArray(education) ? education : [])
    .map(entry => (typeof entry === 'string' ? entry : entry?.school))
    .filter(Boolean);
  if (!schools.length) return null;
  const askedKey = normalizeKey(asked);
  const attended = schools.some(school => {
    const have = schoolNameKeys(school);
    if (have.has(askedKey)) return true;
    for (const alias of schoolNameKeys(asked)) {
      if (have.has(alias)) return true;
    }
    const askedTokens = distinctiveSchoolTokens(asked);
    const haveTokens = distinctiveSchoolTokens(school);
    if (!askedTokens.length || !haveTokens.length) return false;
    return askedTokens.every(token => haveTokens.includes(token));
  });
  return attended ? 'Yes' : 'No';
}

const CAREER_FAIR_CONTACT = /\bwho did you (?:meet|speak with|talk (?:to|with)|connect with)\b/i;
const CAREER_FAIR_EVENT = /\b(?:career fair|careers? fair|info session|campus event|recruiting event|booth)\b/i;

/** Candidate-authorized default for recruiter-name prompts at a fair or booth. */
export function careerFairContactAnswer(question = '') {
  const text = String(question || '');
  if (!CAREER_FAIR_CONTACT.test(text) || !CAREER_FAIR_EVENT.test(text)) return null;
  return 'N/A';
}

const GRADUATION_SEASON = /\bgraduat(?:ing|e|ion)\b[\s\S]{0,48}\b(spring|summer|fall|autumn|winter)\s+(?:of\s+)?(20\d{2})\b/i;
const GRADUATION_YEAR = /\bgraduat(?:ing|e|ion)\b[\s\S]{0,48}\b(20\d{2})\b/i;
const GRADUATION_DATE_WIDGET = /\b(?:date|month|when)\b/i;
const SEASON_MONTHS = {
  spring: [3, 5],
  summer: [5, 8],
  fall: [9, 11],
  autumn: [9, 11],
  winter: [12, 2],
};

function parseEducationEnd(education = []) {
  const entries = Array.isArray(education) ? education : [];
  const current = entries.find(entry => entry?.current) || entries[0];
  const stamp = String(current?.endMonth || '');
  const match = /^(\d{4})-(\d{2})$/.exec(stamp);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function monthMatchesSeason(month, year, season, askedYear) {
  if (season === 'winter') {
    if (month === 12) return year === askedYear;
    if (month === 1 || month === 2) return year === askedYear;
    return false;
  }
  const range = SEASON_MONTHS[season];
  if (!range) return false;
  return year === askedYear && month >= range[0] && month <= range[1];
}

/**
 * Yes/No for "are you graduating Summer of 2027". Uses the current education
 * end month. Inventing a later cohort to pass a new-grad screen is not allowed.
 */
export function graduationSeasonAnswer(question = '', education = []) {
  const text = String(question || '');
  if (!/\bgraduat(?:ing|e|ion)\b/i.test(text)) return null;
  if (/\bclass of\b|\bcohort\b/i.test(text)) return null;
  const end = parseEducationEnd(education);
  if (!end) return null;
  const seasonHit = GRADUATION_SEASON.exec(text);
  if (seasonHit) {
    return monthMatchesSeason(end.month, end.year, seasonHit[1].toLowerCase(), Number(seasonHit[2]))
      ? 'Yes'
      : 'No';
  }
  if (GRADUATION_DATE_WIDGET.test(text)) return null;
  const yearHit = GRADUATION_YEAR.exec(text);
  if (!yearHit) return null;
  return end.year === Number(yearHit[1]) ? 'Yes' : 'No';
}

export function isGraduationDateQuestion(question = '') {
  const key = normalizeKey(question);
  if (!key) return false;
  if (isStartAvailabilityQuestion(question)) return false;
  if (/\b(?:undergrad|undergraduate|bachelor|high school|secondary)\b/.test(key)
      && !/\b(?:master|current (?:degree|program))\b/.test(key)) {
    return false;
  }
  if (/\bclass of\b|\bcohort\b/.test(key)) return false;
  if (/\b(?:employment|employer|work history|previous employer|prior employer)\b/.test(key)) return false;
  if (!/\bgraduat/.test(key)) return false;
  return /\b(?:date|when|month|term|semester|expected graduation)\b/.test(key);
}

function optionGraduationTerm(text) {
  const key = normalizeKey(text);
  if (!key) return null;
  if (/\balready graduated\b/.test(key)) return { kind: 'already' };
  const season = key.match(/\b(spring|summer|fall|autumn|winter)\s+(20\d{2})\b/);
  if (season) {
    return {
      kind: 'season',
      season: season[1] === 'autumn' ? 'fall' : season[1],
      year: Number(season[2]),
    };
  }
  const dated = parseStartMonth(text);
  if (dated) return { kind: 'month', year: dated.year, month: dated.month };
  const yearOnly = key.match(/^(20\d{2})$/);
  if (yearOnly) return { kind: 'year', year: Number(yearOnly[1]) };
  return null;
}

function scoreGraduationOption(optionLabel, end, now) {
  const term = optionGraduationTerm(optionLabel);
  if (!term || !end) return null;
  const lastDay = new Date(end.year, end.month, 0);
  const graduated = now.getTime() > lastDay.getTime();
  if (term.kind === 'already') return graduated ? 100 : null;
  if (graduated) return null;
  if (term.kind === 'month') return term.year === end.year && term.month === end.month ? 100 : null;
  if (term.kind === 'year') return term.year === end.year ? 60 : null;
  if (term.kind !== 'season') return null;
  if (term.season === 'winter') {
    if (end.month === 12 && end.year === term.year) return 100;
    if ((end.month === 1 || end.month === 2) && end.year === term.year) return 100;
    return null;
  }
  if (term.season === 'fall') {
    if (end.year === term.year && end.month >= 8 && end.month <= 12) return end.month === 12 ? 80 : 100;
    return null;
  }
  if (term.season === 'spring') {
    if (end.year === term.year && end.month >= 1 && end.month <= 5) return 100;
    return null;
  }
  if (term.season === 'summer') {
    if (end.year === term.year && end.month >= 5 && end.month <= 8) return 100;
    return null;
  }
  return null;
}

/**
 * Fill "expected graduation date" from the current education end month.
 * December is Winter when that option exists, otherwise US Fall of that year.
 */
export function graduationDateAnswer(question = '', options = [], education = [], { kind, now = new Date() } = {}) {
  if (!isGraduationDateQuestion(question)) return null;
  const end = parseEducationEnd(education);
  if (!end) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (items.length) {
    const ranked = items
      .map(text => ({ text, score: scoreGraduationOption(text, end, now) }))
      .filter(item => item.score != null)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const top = ranked.filter(item => item.score === ranked[0].score);
    return top.length === 1 ? top[0].text : null;
  }
  if (kind === 'date' || kind === 'date-parts') {
    return `${end.year}-${String(end.month).padStart(2, '0')}-01`;
  }
  if (kind === 'month') return `${end.year}-${String(end.month).padStart(2, '0')}`;
  return `${MONTH_NUM_TO_NAME[end.month - 1]} ${end.year}`;
}

function parseGpaNumber(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*4(?:\.0+)?)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  return value;
}

function optionGpaRange(text) {
  const raw = String(text || '');
  if (!/\d+\.\d+/.test(raw)) return null;
  let match = raw.match(/(\d+(?:\.\d+)?)\s*(?:or higher|\+|and above|or above|or greater)/i);
  if (match) return { min: Number(match[1]), max: Infinity };
  match = raw.match(/(\d+(?:\.\d+)?)\s*(?:or below|or less|and below)/i);
  if (match) return { min: -Infinity, max: Number(match[1]) };
  match = raw.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return { min: Math.min(first, second), max: Math.max(first, second) };
}

/** Map 3.75 onto a unique GPA band such as "3.5 - 3.99". */
export function matchGpaBand(answerText, options) {
  const gpa = parseGpaNumber(answerText);
  if (gpa == null || !Array.isArray(options) || options.length === 0) return null;
  const hits = options.filter(option => {
    const range = optionGpaRange(optionText(option));
    return range && gpa >= range.min && gpa <= range.max;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Map 3.75 onto a unique tenth such as "3.8 out of 4.0". */
export function matchGpaTenth(answerText, options) {
  const gpa = parseGpaNumber(answerText);
  if (gpa == null || !Array.isArray(options) || options.length === 0) return null;
  const tenth = Math.round(gpa * 10) / 10;
  const hits = options.filter((option) => {
    const raw = optionText(option).trim();
    const below = /below\s+(\d+(?:\.\d+)?)\s+out of/i.exec(raw);
    if (below) return tenth < Number(below[1]);
    const exact = /^(\d+(?:\.\d+)?)\s+out of\s+(\d+(?:\.\d+)?)$/i.exec(raw);
    if (!exact) return false;
    return Number(exact[2]) === 4 && Math.abs(Number(exact[1]) - tenth) < 1e-9;
  });
  return hits.length === 1 ? hits[0] : null;
}

function locationBlob(location = {}) {
  return normalizeKey([
    location.city,
    location.state,
    location.stateAbbr,
    location.raw,
  ].filter(Boolean).join(' '));
}

function livesNearNamedHubs(location, question) {
  const here = locationBlob(location);
  if (!here) return false;
  const named = String(question || '').match(/[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*, [A-Z]{2}/g) || [];
  return named.some(place => {
    const city = normalizeKey(String(place).split(',')[0] || '');
    return city.length >= 4 && here.includes(city);
  });
}

/**
 * "Do you live within commuting distance, or are you willing to relocate?"
 * often has two Yes sentences. Pittsburgh is not Mountain View or McLean, so
 * a stored relocate Yes must land on the relocate sentence, never the commute
 * sentence.
 */
export function commuteOrRelocateOption(question = '', options = [], { location = {}, relocateAnswer } = {}) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const text = String(question || '');
  if (!/\brelocat/i.test(text) || !/\bcommuting distance\b/i.test(text)) return null;
  const items = options.map(option => {
    const optionLabel = optionText(option);
    return { option, text: optionLabel, key: normalizeKey(optionLabel) };
  }).filter(item => item.key);
  const commute = items.filter(item =>
    /\bcurrently live within commuting distance\b/.test(item.key)
    && !/\bdo not currently live\b/.test(item.key));
  const relocate = items.filter(item =>
    /\bwilling to relocate\b/.test(item.key) && /\bdo not currently live\b/.test(item.key));
  const no = items.filter(item => /^(no)\b/.test(item.key));
  if (commute.length !== 1 || relocate.length !== 1) return null;
  if (livesNearNamedHubs(location, text)) return commute[0].text;
  const polar = normalizeKey(relocateAnswer);
  if (/^yes\b/.test(polar) || /\bwilling to relocate\b/.test(polar)) return relocate[0].text;
  if (/^no\b/.test(polar) && no.length === 1) return no[0].text;
  return null;
}

/**
 * "Are you local to Ann Arbor, MI?" is not a relocate question. Pittsburgh is
 * not Ann Arbor. A stored relocate-Yes may only land on an option that actually
 * says relocate; otherwise the honest answer is No.
 */
export function localOrRelocateAnswer(question = '', options = [], { location = {}, relocateAnswer } = {}) {
  const text = String(question || '');
  const named = text.match(/[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*, [A-Z]{2}/g) || [];
  if (!/\blocal to\b/i.test(text) || named.length === 0) return null;
  const items = (Array.isArray(options) ? options : []).map(option => {
    const optionLabel = optionText(option);
    return { text: optionLabel, key: normalizeKey(optionLabel) };
  }).filter(item => item.key);
  const local = livesNearNamedHubs(location, text);
  const yes = items.filter(item => /^(yes)\b/.test(item.key) && !/\brelocat\b/.test(item.key));
  const no = items.filter(item => /^(no)\b/.test(item.key) && !/\brelocat\b/.test(item.key));
  const relocate = items.filter(item =>
    /\brelocat\b/.test(item.key) && !/^(no)\b/.test(item.key));
  if (local) {
    if (yes.length === 1) return yes[0].text;
    return items.length ? null : 'Yes';
  }
  const polar = normalizeKey(relocateAnswer);
  const willRelocate = /^yes\b/.test(polar) || /\bwilling to relocate\b/.test(polar);
  if (willRelocate && relocate.length === 1) return relocate[0].text;
  if (no.length === 1) return no[0].text;
  return items.length ? null : 'No';
}

const MONTH_NAME_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NUM_TO_NAME = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Earliest-start / how-soon questions. Never employment-history date parts. */
export function isStartAvailabilityQuestion(question = '') {
  const key = normalizeKey(question);
  if (!key) return false;
  if (/\b(?:end date|previous|prior employer|employment history|start date month|start date year|notice period)\b/.test(key)) {
    return false;
  }
  if (/\bhow soon\b/.test(key) && /\b(?:start|begin)\b/.test(key)) return true;
  if (/\b(?:able|available) to start\b/.test(key)) return true;
  if (/\bwhen (?:can|would|will|are) you\b/.test(key) && /\bstart\b/.test(key)) return true;
  if (/\bearliest start\b/.test(key) || /\bdesired start date\b/.test(key) || /\bavailable start date\b/.test(key)) return true;
  if (/\blook to start\b/.test(key)) return true;
  return false;
}

export function parseStartMonth(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;
  const named = s.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
  if (named) {
    return { year: Number(named[2]), month: MONTH_NAME_TO_NUM[named[1].toLowerCase()], day: 1 };
  }
  const iso = s.match(/\b(20\d{2})-(\d{2})(?:-(\d{2}))?\b/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: iso[3] ? Number(iso[3]) : 1 };
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (us) return { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) };
  const usMonth = s.match(/\b(\d{1,2})\/(20\d{2})\b/);
  if (usMonth) return { year: Number(usMonth[2]), month: Number(usMonth[1]), day: 1 };
  return null;
}

function durationToWeeks(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (String(unit).startsWith('day')) return n / 7;
  if (String(unit).startsWith('week')) return n;
  if (String(unit).startsWith('month')) return n * 4.345;
  return null;
}

function optionStartWindow(optionLabel) {
  const key = normalizeKey(optionLabel);
  const dated = parseStartMonth(optionLabel);
  if (dated) return { kind: 'date', year: dated.year, month: dated.month };
  if (/^(immediately|asap|right away|now)\b/.test(key) || /\bimmediately available\b/.test(key)) {
    return { kind: 'weeks', min: 0, max: 1 };
  }
  if (/\bafter graduation\b|\bpost[- ]?grad/.test(key)) return { kind: 'graduation' };
  const more = /\+|or more|more than|greater than|at least|\bover\b/.test(key);
  const range = key.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(days?|weeks?|months?)/);
  if (range) {
    const lo = durationToWeeks(range[1], range[3]);
    const hi = durationToWeeks(range[2], range[3]);
    if (lo == null || hi == null) return null;
    return { kind: 'weeks', min: Math.min(lo, hi), max: Math.max(lo, hi) };
  }
  const single = key.match(/(\d+)\s*(days?|weeks?|months?)/);
  if (!single) return null;
  const weeks = durationToWeeks(single[1], single[2]);
  if (weeks == null) return null;
  return more ? { kind: 'weeks', min: weeks, max: Infinity } : { kind: 'weeks', min: 0, max: weeks };
}

function scoreStartOption(optionLabel, month, now) {
  const window = optionStartWindow(optionLabel);
  if (!window) return null;
  if (window.kind === 'date') {
    return window.year === month.year && window.month === month.month ? 100 : null;
  }
  const target = new Date(month.year, month.month - 1, month.day || 1);
  const weeks = (target.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000);
  if (window.kind === 'graduation') return weeks > 4 ? 70 : null;
  if (window.kind === 'weeks') {
    if (weeks + 0.01 < window.min || weeks - 0.01 > window.max) return null;
    const span = window.max - window.min;
    return 80 - Math.min(30, span === Infinity ? 30 : span);
  }
  return null;
}

function storedStartMonth(answers = {}) {
  const parsed = [];
  for (const [key, entry] of Object.entries(answers || {})) {
    if (!isStartAvailabilityQuestion(key) && !isStartAvailabilityQuestion(entry?.key || '')) continue;
    const month = parseStartMonth(entry?.answer);
    if (month) parsed.push({ ...month, text: String(entry.answer).trim() });
  }
  if (!parsed.length) return null;
  const stamp = item => `${item.year}-${item.month}`;
  if (new Set(parsed.map(stamp)).size !== 1) return null;
  return parsed.find(item => /^available\b/i.test(item.text)) || parsed[0];
}

/**
 * Fill "how soon can you start" from the stored January-2027 availability.
 * Select options are mapped only when exactly one window covers that date.
 */
export function startAvailabilityAnswer(question = '', options = [], answers = {}, { now = new Date(), kind } = {}) {
  if (!isStartAvailabilityQuestion(question)) return null;
  const month = storedStartMonth(answers);
  if (!month) return null;
  const items = (Array.isArray(options) ? options : []).map(option => optionText(option)).filter(Boolean);
  if (items.length) {
    const ranked = items
      .map(text => ({ text, score: scoreStartOption(text, month, now) }))
      .filter(item => item.score != null)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const top = ranked.filter(item => item.score === ranked[0].score);
    return top.length === 1 ? top[0].text : null;
  }
  if (kind === 'date') {
    return `${month.year}-${String(month.month).padStart(2, '0')}-${String(month.day || 1).padStart(2, '0')}`;
  }
  if (kind === 'month') return `${month.year}-${String(month.month).padStart(2, '0')}`;
  const preferred = month.text && /^available\b/i.test(month.text) ? month.text : null;
  if (preferred) return preferred;
  const first = storedStartMonth(answers)?.text;
  return first || `Available ${MONTH_NUM_TO_NAME[month.month - 1]} ${month.year}`;
}

const NONE_LIKE = /^(none|n\/a|not applicable|never|i (?:do not|don't|have not)|0)\b/i;

function isTwitchNoneLikeOption(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (NONE_LIKE.test(raw)) return true;
  const key = normalizeKey(raw);
  if (/\bnon[ -]?user\b/.test(key) && /\b(?:do not have|no personal|never)\b/.test(key)) return true;
  if (/\bdo not have any (?:personal )?twitch experience\b/.test(key)) return true;
  if (/\bno (?:personal )?twitch experience\b/.test(key)) return true;
  return false;
}

/** Stored None maps onto the unique none-like option of Twitch experience prompts. */
export function mapNoneLikeChoice(question, options, storedAnswer) {
  if (normalizeKey(storedAnswer) !== 'none') return null;
  if (!/experience with twitch|active on the platform|creator economy/i.test(String(question || ''))) return null;
  if (!Array.isArray(options) || options.length === 0) return null;
  const hits = options.filter(option => isTwitchNoneLikeOption(optionText(option)));
  return hits.length === 1 ? optionText(hits[0]) : null;
}

/**
 * Synonym table: question key -> dotted path into `profile`.
 * `kind` disambiguates overloaded words ("website" as a URL vs free text).
 */
const CANONICAL = [
  ['name.first', ['first name', 'legal first name', 'given name', 'first', 'forename', 'preferred first name']],
  ['name.last', ['last name', 'legal last name', 'family name', 'surname', 'last']],
  ['name.full', ['full name', 'name', 'legal name', 'full legal name', 'your name', 'candidate name', 'legal first and last name', 'first and last name']],
  ['email', ['email', 'email address', 'e mail', 'e mail address', 'personal email', 'contact email']],
  ['phone.raw', ['phone', 'phone number', 'mobile', 'mobile number', 'mobile phone', 'cell phone', 'telephone', 'contact number', 'primary phone']],
  ['phone.countryCode', ['country phone code', 'phone country code', 'country code', 'phone code', 'dial code']],
  ['links.linkedin', ['linkedin', 'linkedin profile', 'linkedin url', 'linkedin profile url', 'linkedin link']],
  ['links.github', ['github', 'github url', 'github profile', 'github username', 'git hub']],
  ['links.portfolio', ['portfolio', 'portfolio url', 'personal website', 'website', 'personal site', 'personal site url', 'portfolio link', 'other website', 'portfolio website', 'website url', 'personal portfolio', 'portfolio site']],
  ['location.city', ['city', 'current city', 'city of residence', 'current location city', 'address city', 'contact information city', 'personal information city', 'what city do you live in', 'city state']],
  ['location.state', ['state', 'province', 'state province', 'state or province', 'region', 'state territory', 'home state/province', 'state not required', 'address state']],
  ['location.country', ['country', 'country of residence', 'current country', 'home country', 'country/region of residence', 'contact information country', 'personal information country', 'address country', 'where do you currently reside', 'country where you currently reside']],
  ['location.raw', ['location', 'current location', 'where are you located', 'where are you currently located', 'current city and state', 'location city', 'what is your physical location', 'what is your current location']],

  ['address.line1', ['address', 'street address', 'address line', 'address line 1', 'home address', 'current address', 'personal information address line 1', 'mailing address']],
  ['address.postalCode', ['zip', 'zip code', 'postal code', 'zip/postal code', 'address postal code', 'postcode']],

  ['emails.school', ['school email', 'university email', 'academic email', 'student email', 'edu email']],

  ['identity.citizenship', ['country of citizenship', 'citizenship', 'nationality', 'citizenship country']],
  ['identity.dob', ['date of birth', 'birth date', 'dob', 'birthday']],
  ['identity.primaryLanguage', ['primary language', 'native language', 'first language']],
  ['identity.secondaryLanguage', ['secondary language', 'second language', 'other language']],
  ['identity.highSchool', ['high school', 'high school name', 'secondary school', 'high school attended']],

  ['demographics.gender', ['gender', 'gender identity', 'what is your gender', 'please select your gender']],
  // Only the exact controlled-label prompt belongs to this field. Longer
  // self-description prompts can mean something else and use the answer bank.
  ['demographics.genderIdentity', ['i identify as']],
  ['demographics.race', ['race', 'ethnicity', 'ethnic identity', 'racial identity', 'race ethnicity', 'race/ethnicity', 'what is your race or ethnicity', 'please select the race category that most accurately describes how you identify yourself', 'please select the ethnicity which most accurately describes how you identify yourself']],
  ['demographics.hispanicLatino', ['hispanic or latino', 'are you hispanic or latino', 'hispanic/latino']],
  ['demographics.veteran', ['veteran status', 'are you a veteran', 'protected veteran status', 'please select the veteran status which most accurately describes how you identify yourself', 'please select the veteran status which most accurately describes your status']],
  ['demographics.disability', ['disability status', 'do you have a disability', 'voluntary self identification of disability']],
  ['education[0].school', ['school', 'university', 'college', 'most recent school', 'school name', 'institution']],
  ['education[0].degreeRaw', ['degree', 'highest degree', 'degree type', 'level of education']],
  ['education[0].field', ['discipline', 'field of study', 'major', 'area of study']],
  ['education[0].gpa', ['gpa', 'cgpa', 'grade point average']],
  ['work[0].company', ['current company', 'most recent company', 'current employer', 'employer', 'company']],
  ['work[0].title', ['current title', 'current job title', 'most recent title', 'job title', 'current role']],
];

const CANONICAL_INDEX = (() => {
  const idx = new Map();
  for (const [path, keys] of CANONICAL) {
    for (const k of keys) if (!idx.has(k)) idx.set(k, path);
  }
  return idx;
})();

/**
 * Gender and race matched by pattern rather than by exact wording.
 *
 * The synonym table above is exact-match, and every board words these its own
 * way. Ashby's self-identification block asks in phrasings the table has never
 * seen, so gender and ethnicity resolved to nothing and were left for the user
 * on a form whose answers the profile already held. Listing each new sentence
 * as it turns up is what the table has been doing, and it only ever catches the
 * wording already met once.
 *
 * These three. "hispanic or latino" and "veteran status" are worded
 * consistently enough across boards that the exact table resolves them. A
 * short disability self-identification question has the same controlled
 * approved response, while "transgender", "pronouns" and "sexual orientation"
 * have no profile field to answer from — the panel should keep asking the user
 * about those.
 *
 * Nothing here can put a wrong answer on a form on its own: a matched question
 * only offers the profile value as a candidate, and matchOption still has to
 * land it on one of this form's options or abstain.
 */
const DEMOGRAPHIC_PATTERNS = [
  // \b keeps "transgender" out: there is no word boundary inside it.
  [/\bgender\b/, 'demographics.gender'],
  [/\b(?:race|races|racial|ethnic|ethnicity|ethnicities)\b/, 'demographics.race'],
  [/\bdisabilit(?:y|ies)\b/, 'demographics.disability'],
];

/**
 * Above this many significant words the text is prose that mentions these
 * words, not a question about the applicant. The equal-opportunity
 * acknowledgement every board ships ("...without regard to race, color,
 * religion, sex, gender identity...") is a statement to agree with, and its
 * checkbox must not be offered the applicant's race as an answer.
 */
const DEMOGRAPHIC_MAX_TOKENS = 8;

/**
 * GPA, for the same reason and with the same guards.
 *
 * The exact-wording table answers "gpa" and "grade point average" and nothing
 * else, so "What is your current GPA? Please specify on a 4 point scale." was
 * left for the user on a live posting while the profile held 3.75. The
 * boilerplate stripper cannot reach it either: "please specify" is only removed
 * as a prefix, and here it is the second sentence.
 */
const GPA_PATTERN = /\b(?:gpa|cgpa|grade point average)\b/;
const YOUR_GPA = /(?:\b(?:your|applicant(?:'s)?)\b[\s\S]{0,40}\b(?:gpa|cgpa|grade point average)\b|^(?:gpa|cgpa|grade point average)\b)/;

/**
 * A GPA belongs to one degree, and the profile's is the current one. When the
 * question names a different level, the number we hold is the wrong number, so
 * abstain rather than report a bachelor's GPA off the master's record.
 */
const OTHER_DEGREE_GPA = /\b(?:undergrad|undergraduate|bachelor|bachelors|high school|secondary|previous|prior|doctorate|doctoral|phd|ph d)\b/;

/**
 * Links and state of residence, matched by pattern for the same reason as the
 * demographics above: the exact table only ever catches a wording already met.
 *
 * "Please share a link to your LinkedIn account." is the whole normalized key,
 * so the table's `linkedin` entry never fires, and the profile held the URL
 * while the field was left for the user on a live Greenhouse posting. Every
 * board words this its own way, so listing sentences cannot keep up.
 *
 * Both halves are required: the platform name AND a word saying a link is what
 * is being asked for. "Which of our engineers do you know on LinkedIn?" names
 * the platform but is not asking for the URL.
 */
const LINK_PATTERNS = [
  [/\blinkedin\b/, 'links.linkedin'],
  [/\b(?:github|git hub)\b/, 'links.github'],
];
const LINK_NOUN = /\b(?:link|links|url|urls|profile|account|page|handle)\b/;

/**
 * The state the applicant lives in.
 *
 * Narrow on purpose. "State" is also a verb on application forms ("please
 * state the employee's name"), so the word alone cannot be the trigger: the
 * key has to ask for *a* state AND name residence, and must not be asking
 * about somebody else's state (a school's, an employer's, a birthplace).
 *
 * `\bstate\b` does not match "states", which keeps the "do you reside in any
 * of the following states: DE HI IA..." question out — that one is a yes/no
 * the bank already answers, not a request for Pennsylvania.
 */
const STATE_QUESTION = /\b(?:what|which|your|current|home)\s+state\b/;
const RESIDENCE_CONTEXT = /\b(?:reside|resides|residing|residence|live|living|located|location|based)\b/;
const OTHER_PARTY_LOCATION = /\b(?:school|university|college|campus|employer|company|office|birth|born|incorporated|previous|prior)\b/;

/**
 * Profile paths reachable by phrasing rather than by exact wording.
 * Returns null on anything ambiguous — a form asking for two different links
 * at once has no single right answer here, and blank beats half of one.
 */
function phrasedFieldFor(normKey, kind) {
  // These controlled employment questions vary only in surrounding wording on
  // Greenhouse. They are profile facts, not prose generation prompts.
  if (/\bcurrent country of residence\b/.test(normKey)) return 'location.country';
  if (/\blocated in (?:the )?us or canada\b/.test(normKey)) return 'application.usOrCanada';
  if (/\bsubject to any employment agreements?\b|\bpost employment restrictions?\b/.test(normKey)
      || (/\bagreement\b/.test(normKey) && /\b(?:current|former) employer\b/.test(normKey) && /\brestrict\b/.test(normKey))) {
    return 'application.employmentRestrictions';
  }
  if (/\b(?:relatives?|family members?|close relationships?)\b/.test(normKey)
      && /\b(?:employ|employed|work(?:ing)? (?:at|for|with)|who work)\b/.test(normKey)) {
    return 'application.relativesAtEmployer';
  }
  if (/\bhow did you (?:first )?(?:hear|learn|find) about\b/.test(normKey)
      || /\blist the site.{0,40}event.{0,40}person\b/.test(normKey)) {
    return 'application.heardAbout';
  }
  if (/\brequire sponsorship for a visa to remain in (?:your )?current location\b/.test(normKey)) {
    return 'application.sponsorshipCurrentLocation';
  }
  if (/\bpreviously applied\b/.test(normKey) && /\bamazon\b/.test(normKey)) {
    return 'application.previouslyAppliedAmazon';
  }
  if (/\b(?:sms|text message)\b/.test(normKey) && /\b(?:number|cell|phone)\b/.test(normKey)) {
    return 'phone.raw';
  }
  if (/\bpreviously worked\b|\bworked (?:for|at) .{0,60} in the past\b|\bconsulted for\b/.test(normKey)) {
    return 'application.previouslyWorkedHere';
  }
  if (/\bcurrent employee\b|\bcurrently a\b.{0,40}\bemployee\b|\bemployee with\b.{0,40}\b(?:amazon|subsidiary|twitch)\b/.test(normKey)) {
    return 'application.currentCompanyEmployee';
  }
  if (/\bh\s*1b\b/.test(normKey) && /\b(?:held|petition|approved on your behalf|preceding \d+ years)\b/.test(normKey)
      && !/\bsponsor|\brequire|\bneed\b/.test(normKey)) {
    return 'application.h1bPetitionLastSixYears';
  }
  if (/\bpermanent resident\b/.test(normKey) && /\b(?:afterwards|any other country|other country)\b/.test(normKey)) {
    return 'application.laterPermanentResident';
  }
  if (/\bexport licens/.test(normKey) && /\b(?:citizenship|permanent residence)\b/.test(normKey)) {
    return 'identity.citizenship';
  }
  if (/\bcurrently\b/.test(normKey) && /\b(?:f1|f 1)\b/.test(normKey) && /\b(?:opt|cpt)\b/.test(normKey)
      && !/\bfuture\b/.test(normKey)) {
    return 'application.currentlyOnF1OptCpt';
  }
  if (/\bexport compliance\b/.test(normKey)
      || (/\bu s person\b/.test(normKey) && !/\bcuba|iran|north korea|syria\b/.test(normKey))) {
    return 'application.usPerson';
  }
  if (/\bcitizenship\b/.test(normKey) && !/\bpermanent resident\b/.test(normKey) && !/\bauthorized\b/.test(normKey)
      && !/\bcitizenship status\b/.test(normKey)) {
    return 'identity.citizenship';
  }
  if (/\bexperience with twitch\b/.test(normKey)) return 'application.twitchExperience';
  if (/\byears have you been active on the platform\b/.test(normKey)) return 'application.twitchYearsActive';
  if (/\bcreator economy\b/.test(normKey)) return 'application.creatorEconomyBeyondTwitch';
  if (/\b(?:links? of )?any open source projects?\b/.test(normKey)) return 'application.openSourceLinks';
  if (/\bprimary programming language and(?:\/?or)? framework\b/.test(normKey)) return 'application.primaryProgramming';
  // A free-text box asking for links is a question in its own right ("list any
  // public technical work"), answered from the bank as prose, not from a
  // single profile field. Source-attribution still maps above for textarea.
  if (kind === 'textarea') return null;

  const links = LINK_PATTERNS.filter(([pattern]) => pattern.test(normKey));
  if (links.length === 1 && LINK_NOUN.test(normKey)) return links[0][1];

  if (STATE_QUESTION.test(normKey) && RESIDENCE_CONTEXT.test(normKey)
      && !OTHER_PARTY_LOCATION.test(normKey)) {
    return 'location.state';
  }
  // Source attribution is a stable candidate preference, even though boards
  // interpolate their company name into the question. Handled above so a
  // "list the site" textarea can still use the stored LinkedIn answer.
  return null;
}

function demographicFieldFor(normKey, kind) {
  // A free-text box asking about these is a question in its own right.
  if (kind === 'textarea') return null;
  // Explicit candidate-approved consent for demographic surveys is distinct
  // from agreeing to terms, privacy policies, or any other contract. Require
  // a checkbox plus both consent language and a demographic-data reference.
  if (kind === 'checkbox' && /\bconsent\b/.test(normKey)
      && /\b(?:demographic|eeo|race|ethnic|gender|veteran|disabilit|hispanic|latin)\b/.test(normKey)) {
    return 'demographics.demographicSurveyConsent';
  }
  // Other consent statements remain deliberate review actions.
  if (/\b(?:consent|survey|collect|store|process)\b/.test(normKey)) return null;
  // "What is your cumulative GPA" is a profile fact even when a board wraps it
  // in extra sentences that blow the demographic token cap.
  if (YOUR_GPA.test(normKey) && !OTHER_DEGREE_GPA.test(normKey)) return 'education[0].gpa';
  if (tokenize(normKey).size > DEMOGRAPHIC_MAX_TOKENS) return null;
  for (const [pattern, path] of DEMOGRAPHIC_PATTERNS) {
    if (pattern.test(normKey)) return path;
  }
  if (GPA_PATTERN.test(normKey) && !OTHER_DEGREE_GPA.test(normKey)) return 'education[0].gpa';
  return null;
}

/** Map a normalized question key to a profile path, or null. */
export function canonicalFieldFor(normKey, kind) {
  if (!normKey) return null;
  const stripped = String(normKey).replace(/^(?:what is your|what s your|whats your|what is the)\s+/, '');
  const hit = CANONICAL_INDEX.get(normKey)
    || (stripped !== normKey ? CANONICAL_INDEX.get(stripped) : null)
    || demographicFieldFor(normKey, kind)
    || phrasedFieldFor(normKey, kind);
  if (!hit) return null;
  if (kind === 'textarea' && (hit === 'application.usPerson' || hit === 'application.currentlyOnF1OptCpt')) return null;

  // Boards increasingly render these as comboboxes rather than plain inputs,
  // so a combobox is allowed anywhere a text input is.
  const TEXTISH = ['text', 'combobox-input', 'combobox'];
  // "Website" on a URL input is the portfolio; on a textarea it is a question.
  if (hit.startsWith('links.') && kind && ![...TEXTISH, 'url', 'email'].includes(kind)) return null;
  if (hit === 'email' && kind && ![...TEXTISH, 'email'].includes(kind)) return null;
  if (hit === 'phone.raw' && kind && ![...TEXTISH, 'tel', 'number'].includes(kind)) return null;
  // "Company" as a plain dropdown is almost never "your current employer".
  if (hit.startsWith('work[0]') && kind && !TEXTISH.includes(kind)) return null;
  // Greenhouse custom questions are native selects or react-select comboboxes.
  // GPA, school, and degree still have to land on one option via matchOption.
  if (hit.startsWith('education[0]') && kind && ![...TEXTISH, 'number', 'select', 'radio'].includes(kind)) return null;
  return hit;
}

/**
 * Separator for a field that holds several answers at once: a skills picker, a
 * "check all that apply" group, a multi-select of preferred locations.
 *
 * A pipe rather than a comma or semicolon, because option text is full of both
 * ("Yes, I will require sponsorship", "Asian; not Hispanic"). Splitting on
 * those would tear single answers into pieces.
 */
export const MULTI_SEP = ' | ';

export function joinMulti(values) {
  const seen = new Set();
  for (const value of values || []) {
    const v = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (v) seen.add(v);
  }
  return [...seen].join(MULTI_SEP);
}

export function splitMulti(value) {
  return String(value ?? '')
    .split('|')
    .map(v => v.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Can a control of this kind physically hold this value?
 *
 * The same question is a dropdown on one board and a number box on the next, so
 * an answer learned as "2-5 years" can reach an input[type=number] that
 * discards it. Writing it produces a reported failure the user then goes
 * hunting for, when nothing is broken: the answer simply does not fit. Better
 * to leave the field flagged for them.
 */
export function fitsKind(kind, value) {
  const v = String(value ?? '').trim();
  if (kind === 'number') return /^-?\d+(\.\d+)?$/.test(v);
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (kind === 'month') return /^\d{4}-\d{2}$/.test(v);
  return true;
}

/** True for a rotating verification or security-code prompt. */
export function isOtpVerificationQuestion(text) {
  return OTP_VERIFICATION_QUESTION.test(String(text || ''));
}

/** True for a rotating code, salary prompt, cover letter, or other answer that cannot be reused. */
export function isEphemeralApplicationQuestion(text) {
  return NEVER_STORE_QUESTION.test(String(text || ''));
}

export function isEphemeralAnswerEntry(entry) {
  const parts = [entry?.key, ...(entry?.questions || []), entry?.rawQuestion];
  return parts.some(part => isEphemeralApplicationQuestion(part));
}

export function dropEphemeralAnswers(answers = {}) {
  return Object.fromEntries(Object.entries(answers).filter(([, entry]) => !isEphemeralAnswerEntry(entry)));
}

/** True for questions we never want to seed or fuzzy-reuse across companies. */
export function isVolatileQuestion(normKey) {
  return VOLATILE_PATTERNS.test(normKey);
}

/**
 * True for a value that is a widget's internal identifier rather than an
 * answer. Workday radios carry a 32-char hex GUID in their `value` attribute,
 * and storing that as the answer produces an entry that is both meaningless to
 * read and useless to refill. Never save one.
 */
export function looksOpaqueId(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;                       // real answers have spaces or are short words
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;          // hex blob, e.g. Workday GUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(s)) return true; // UUID
  if (/^\d{10,}$/.test(s)) return true;                 // long numeric id
  if (s.length > 24 && !/[aeiou]/i.test(s)) return true; // unpronounceable token
  return false;
}

/** EEO / demographic heuristic — used only to group entries in the review UI. */
export function isSensitiveQuestion(text) {
  return EEO_PATTERN.test(String(text || ''));
}

/** Read a dotted/indexed path like "education[0].school" out of an object. */
export function readPath(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of path.split('.')) {
    const m = /^([a-zA-Z0-9_]+)\[(\d+)\]$/.exec(part);
    if (m) {
      cur = cur?.[m[1]]?.[Number(m[2])];
    } else {
      cur = cur?.[part];
    }
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}
