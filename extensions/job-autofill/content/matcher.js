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
  { id: 'office-availability', match: /\b(?:office|onsite|on site)\b/, veto: /\b(?:where|which|preference|location)\b/ },
  { id: 'sexual-orientation', match: /\bsexual orientation\b/, veto: /\bnot|\bdecline/ },
  // A candidate-approved no may be reused only for an explicit non-compete or
  // non-solicitation question. "Agreement" by itself is too broad and could
  // be a contract, privacy, or arbitration question.
  { id: 'non-compete', match: /\bnon[ -]?(?:compete|solicit)/, veto: /\bnot applicable\b/ },
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

  const normed = options.map(o => ({ option: o, key: normalizeKey(o.text || o.value || '') }));

  const exact = normed.filter(n => n.key === target);
  if (exact.length === 1) return exact[0].option;
  if (exact.length > 1) return exact[0].option;

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

/**
 * A GPA belongs to one degree, and the profile's is the current one. When the
 * question names a different level, the number we hold is the wrong number, so
 * abstain rather than report a bachelor's GPA off the master's record.
 */
const OTHER_DEGREE_GPA = /\b(?:undergrad|undergraduate|bachelor|bachelors|high school|secondary|previous|prior)\b/;

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
  if (/\bsubject to any employment agreements?\b|\bpost employment restrictions?\b/.test(normKey)) {
    return 'application.employmentRestrictions';
  }
  if (/\brequire sponsorship for a visa to remain in (?:your )?current location\b/.test(normKey)) {
    return 'application.sponsorshipCurrentLocation';
  }
  if (/\bpreviously worked at or consulted for gitlab\b/i.test(normKey)) return 'application.previouslyWorkedAtGitLab';
  if (/\b(?:links? of )?any open source projects?\b/.test(normKey)) return 'application.openSourceLinks';
  if (/\bprimary programming language and(?:\/?or)? framework\b/.test(normKey)) return 'application.primaryProgramming';
  // A free-text box asking for links is a question in its own right ("list any
  // public technical work"), answered from the bank as prose, not from a
  // single profile field.
  if (kind === 'textarea') return null;

  const links = LINK_PATTERNS.filter(([pattern]) => pattern.test(normKey));
  if (links.length === 1 && LINK_NOUN.test(normKey)) return links[0][1];

  if (STATE_QUESTION.test(normKey) && RESIDENCE_CONTEXT.test(normKey)
      && !OTHER_PARTY_LOCATION.test(normKey)) {
    return 'location.state';
  }
  // Source attribution is a stable candidate preference, even though boards
  // interpolate their company name into the question.
  if (kind !== 'textarea' && /\bhow did you (?:hear|learn|find) about\b/.test(normKey)) {
    return 'application.heardAbout';
  }
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
  const hit = CANONICAL_INDEX.get(normKey)
    || demographicFieldFor(normKey, kind)
    || phrasedFieldFor(normKey, kind);
  if (!hit) return null;

  // Boards increasingly render these as comboboxes rather than plain inputs,
  // so a combobox is allowed anywhere a text input is.
  const TEXTISH = ['text', 'combobox-input'];
  // "Website" on a URL input is the portfolio; on a textarea it is a question.
  if (hit.startsWith('links.') && kind && ![...TEXTISH, 'url', 'email'].includes(kind)) return null;
  if (hit === 'email' && kind && ![...TEXTISH, 'email'].includes(kind)) return null;
  if (hit === 'phone.raw' && kind && ![...TEXTISH, 'tel', 'number'].includes(kind)) return null;
  // "Company" as a plain dropdown is almost never "your current employer".
  if (hit.startsWith('work[0]') && kind && !TEXTISH.includes(kind)) return null;
  if (hit.startsWith('education[0]') && kind && ![...TEXTISH, 'number'].includes(kind)) return null;
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
