import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeKey,
  tokenSetScore,
  findAnswer,
  matchOption,
  canonicalFieldFor,
  isSensitiveQuestion,
  conceptOf,
  looksOpaqueId,
  readPath,
} from '../content/matcher.js';

// ── normalizeKey ───────────────────────────────────────────────────

test('normalizeKey collapses required markers and punctuation', () => {
  assert.equal(normalizeKey('Phone Number *'), 'phone number');
  assert.equal(normalizeKey('phone number?'), 'phone number');
  assert.equal(normalizeKey('  Phone   Number (required) '), 'phone number');
  assert.equal(normalizeKey('First Name*'), 'first name');
});

test('normalizeKey treats en/em dashes as separators', () => {
  assert.equal(normalizeKey('Start date — earliest'), 'start date earliest');
  assert.equal(normalizeKey('Start date – earliest'), 'start date earliest');
});

test('normalizeKey strips boilerplate prefixes', () => {
  assert.equal(normalizeKey('Please select your country'), 'your country');
  assert.equal(normalizeKey('Select one: relocation'), 'relocation');
});

test('normalizeKey keeps technical characters', () => {
  assert.equal(normalizeKey('Years of C++ experience'), 'years of c++ experience');
  assert.equal(normalizeKey('State/Province'), 'state/province');
});

test('normalizeKey handles empty input', () => {
  assert.equal(normalizeKey(''), '');
  assert.equal(normalizeKey(null), '');
  assert.equal(normalizeKey(undefined), '');
});

// ── tokenSetScore ──────────────────────────────────────────────────

test('tokenSetScore ignores stopwords', () => {
  assert.equal(tokenSetScore('are you authorized to work', 'authorized work'), 1);
});

test('tokenSetScore returns 0 for disjoint keys', () => {
  assert.equal(tokenSetScore('phone number', 'favorite color'), 0);
});

test('tokenSetScore returns 0 when a key is all stopwords', () => {
  assert.equal(tokenSetScore('are you', 'phone number'), 0);
});

// ── findAnswer ─────────────────────────────────────────────────────

const ANSWERS = {
  'will you now or in the future require sponsorship for employment visa status': {
    key: 'will you now or in the future require sponsorship for employment visa status',
    answer: 'Yes',
    answerType: 'select',
  },
  'why do you want to work here': {
    key: 'why do you want to work here',
    answer: 'A long company-specific essay.',
    answerType: 'textarea',
  },
  'are you willing to relocate': {
    key: 'are you willing to relocate',
    answer: 'Yes',
    answerType: 'select',
  },
};

test('findAnswer prefers an exact normalized hit', () => {
  const hit = findAnswer('are you willing to relocate', ANSWERS);
  assert.equal(hit.method, 'exact');
  assert.equal(hit.answer ?? hit.entry.answer, 'Yes');
});

test('findAnswer falls back to fuzzy above the threshold', () => {
  const hit = findAnswer('willing to relocate', ANSWERS);
  assert.equal(hit.method, 'fuzzy');
  assert.equal(hit.entry.answer, 'Yes');
});

test('findAnswer uses an approved local answer for equivalent relocation and office questions', () => {
  const bank = {
    'are you willing to relocate': { answer: 'Yes', answerType: 'select' },
    'are you available to go to the office 5 times per week': { answer: 'Yes', answerType: 'select' },
  };
  assert.equal(findAnswer(normalizeKey('Are you located in the area or planning to relocate within commuting distance?'), bank)?.entry.answer, 'Yes');
  assert.equal(findAnswer(normalizeKey('Most employees are in office 3+ days a week. Does that work for you?'), bank)?.entry.answer, 'Yes');
});

test('approved sexual-orientation wording maps to the portal option without a model', () => {
  const bank = { 'how would you describe your sexual orientation': { answer: 'Heterosexual', answerType: 'select' } };
  const hit = findAnswer(normalizeKey('How do you identify your sexual orientation? Please select all that apply.'), bank);
  assert.equal(hit?.entry.answer, 'Heterosexual');
  assert.equal(matchOption(hit?.entry.answer, opt('Bisexual', 'Heterosexual / straight', 'I prefer not to answer')).text, 'Heterosexual / straight');
});

test('cisgender approved wording maps to Ashby man option', () => {
  assert.equal(matchOption('Cisgender man', opt('Man', 'Woman', 'I prefer not to answer')).text, 'Man');
});

test('findAnswer returns null below the threshold', () => {
  assert.equal(findAnswer('what is your favorite programming language', ANSWERS), null);
});

test('findAnswer never fuzzy-matches a textarea answer', () => {
  // Would score well on token overlap, but essays must not leak across companies.
  assert.equal(findAnswer('why do you want to work at this company', ANSWERS), null);
});

test('findAnswer still returns a textarea answer on an exact hit', () => {
  const hit = findAnswer('why do you want to work here', ANSWERS);
  assert.equal(hit.method, 'exact');
  assert.equal(hit.entry.answerType, 'textarea');
});

test('findAnswer respects a stricter threshold', () => {
  // Drops one significant token, so it scores ~0.86: matched by default, not at 0.99.
  const partial = 'will you now or in the future require sponsorship for employment visa';
  assert.equal(findAnswer(partial, ANSWERS).method, 'fuzzy');
  assert.equal(findAnswer(partial, ANSWERS, { threshold: 0.99 }), null);
});

test('findAnswer ignores entries with an empty answer', () => {
  assert.equal(findAnswer('blank one', { 'blank one': { key: 'blank one', answer: '' } }), null);
});

// ── matchOption ────────────────────────────────────────────────────

const opt = (...texts) => texts.map(t => ({ value: t, text: t }));

test('matchOption maps a bare Yes onto a qualified option', () => {
  const options = opt('Please select', 'Yes, I am authorized to work in the US', 'No');
  assert.equal(matchOption('Yes', options).text, 'Yes, I am authorized to work in the US');
});

test('matchOption takes a bare Yes option over a qualified one', () => {
  const options = opt('Yes', 'Yes, with conditions', 'No');
  assert.equal(matchOption('Yes', options).text, 'Yes');
});

test('matchOption maps an approved full No sentence onto one unqualified No option', () => {
  assert.equal(matchOption('No, I do not have a disability and have not had one in the past', opt('Yes', 'No', 'I prefer not to answer')).text, 'No');
});

test('matchOption abstains when several options qualify Yes differently', () => {
  // The real sponsorship dropdown. A stored bare "Yes" does not say which,
  // and picking "now" over "in the future" is a costly wrong answer.
  const options = opt(
    'No, I do not require sponsorship',
    'Yes, I will require sponsorship in the future',
    'Yes, I require sponsorship now'
  );
  assert.equal(matchOption('Yes', options), null);
});

test('matchOption uses qualifier tokens to disambiguate', () => {
  const options = opt(
    'No, I do not require sponsorship',
    'Yes, I will require sponsorship in the future',
    'Yes, I require sponsorship now'
  );
  assert.equal(
    matchOption('Yes I will require sponsorship in the future', options).text,
    'Yes, I will require sponsorship in the future'
  );
});

test('matchOption lands a short answer on a parenthesised option', () => {
  const options = opt('Please select', 'Asian (United States of America)', 'White (United States of America)');
  assert.equal(matchOption('Asian', options).text, 'Asian (United States of America)');
});

test('matchOption maps the stored South Asian self-description to one controlled Asian category', () => {
  const options = opt('Asian', 'Black or African American', 'White');
  assert.equal(matchOption('South Asian', options).text, 'Asian');
});

test('matchOption matches whole tokens, not substrings', () => {
  // "Asian" must not be pulled into "Caucasian".
  const options = opt('Caucasian', 'Native Hawaiian');
  assert.equal(matchOption('Asian', options), null);
});

test('matchOption picks the not-a-veteran option from a long EEO list', () => {
  const options = opt(
    'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN',
    'I AM NOT A VETERAN',
    'I DECLINE TO SELF-IDENTIFY'
  );
  assert.equal(matchOption('I am not a protected veteran', options).text, 'I AM NOT A VETERAN');
});

test('matchOption returns an exact text match', () => {
  const options = opt('LinkedIn', 'Indeed', 'Referral');
  assert.equal(matchOption('LinkedIn', options).text, 'LinkedIn');
});

test('matchOption abstains when no option is close enough', () => {
  const options = opt('Red', 'Green', 'Blue');
  assert.equal(matchOption('Pittsburgh', options), null);
});

test('matchOption abstains when the top two options tie', () => {
  const options = opt('San Francisco CA', 'San Francisco Bay');
  assert.equal(matchOption('San Francisco', options), null);
});

test('matchOption abstains when several options extend the answer differently', () => {
  // Both contain every stored token, so the stored answer does not pick between them.
  const options = opt('Engineering Manager', 'Engineering Director');
  assert.equal(matchOption('Engineering', options), null);
});

test('matchOption abstains on a yes with no yes-like option', () => {
  assert.equal(matchOption('Yes', opt('Maybe', 'Later')), null);
});

test('matchOption handles empty inputs', () => {
  assert.equal(matchOption('', opt('Yes')), null);
  assert.equal(matchOption('Yes', []), null);
});

// ── canonicalFieldFor ──────────────────────────────────────────────

test('canonicalFieldFor maps identity synonyms', () => {
  assert.equal(canonicalFieldFor('first name', 'text'), 'name.first');
  assert.equal(canonicalFieldFor('legal first name', 'text'), 'name.first');
  assert.equal(canonicalFieldFor('email address', 'email'), 'email');
  assert.equal(canonicalFieldFor('linkedin profile url', 'url'), 'links.linkedin');
  assert.equal(canonicalFieldFor('mobile number', 'tel'), 'phone.raw');
});

test('canonicalFieldFor maps company-specific source-attribution wording to the stored preference', () => {
  assert.equal(canonicalFieldFor('how did you hear about Twilio', 'checkbox'), 'application.heardAbout');
  assert.equal(canonicalFieldFor('how did you learn about Acme', 'select'), 'application.heardAbout');
});

test('canonicalFieldFor maps the controlled GitLab application wording to profile facts', () => {
  assert.equal(canonicalFieldFor('what is your current country of residence', 'combobox-input'), 'location.country');
  assert.equal(canonicalFieldFor('are you located in the us or canada', 'combobox-input'), 'application.usOrCanada');
  assert.equal(canonicalFieldFor('are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer', 'combobox-input'), 'application.employmentRestrictions');
  assert.equal(canonicalFieldFor('will you now or in the future require sponsorship for a visa to remain in your current location', 'combobox-input'), 'application.sponsorshipCurrentLocation');
  assert.equal(canonicalFieldFor('have you previously worked at or consulted for GitLab', 'combobox-input'), 'application.previouslyWorkedAtGitLab');
  assert.equal(canonicalFieldFor('please share links of any open source projects you own or have made contributions to', 'textarea'), 'application.openSourceLinks');
  assert.equal(canonicalFieldFor('what is your primary programming language and/or framework', 'text'), 'application.primaryProgramming');
});

test('canonicalFieldFor returns null for unknown questions', () => {
  assert.equal(canonicalFieldFor('why this company', 'textarea'), null);
});

test('canonicalFieldFor maps gender and race however the board words them', () => {
  // Ashby's self-identification block, which the exact synonym table missed.
  assert.equal(canonicalFieldFor('how do you identify your gender', 'radio'), 'demographics.gender');
  assert.equal(canonicalFieldFor('how do you identify your ethnicity', 'checkbox'), 'demographics.race');
  assert.equal(canonicalFieldFor('how would you describe your gender identity', 'select'), 'demographics.gender');
  assert.equal(canonicalFieldFor('how would you describe your racial/ethnic background', 'select'), 'demographics.race');
  assert.equal(canonicalFieldFor('what is your ethnicity', 'select'), 'demographics.race');
  assert.equal(canonicalFieldFor('race', 'radio'), 'demographics.race');
});

test('canonicalFieldFor maps a link question however the board words it', () => {
  // Live Greenhouse posting: the profile held the URL and the field was left
  // for the user because the whole sentence is the key.
  assert.equal(canonicalFieldFor('please share a link to your linkedin account', 'text'), 'links.linkedin');
  assert.equal(canonicalFieldFor('a link to your github profile', 'text'), 'links.github');
  assert.equal(canonicalFieldFor('linkedin page', 'combobox-input'), 'links.linkedin');
});

test('canonicalFieldFor abstains on link questions with no single answer', () => {
  // Two platforms, one box: neither profile field is the answer on its own.
  assert.equal(canonicalFieldFor('please provide links to your linkedin and github profiles', 'text'), null);
  // Names the platform, is not asking for the URL.
  assert.equal(canonicalFieldFor('which of our engineers do you know on linkedin', 'text'), null);
  // Prose about public work, answered from the bank rather than one field.
  assert.equal(canonicalFieldFor('a link to your github profile', 'textarea'), null);
});

test('canonicalFieldFor maps the state the applicant lives in', () => {
  assert.equal(canonicalFieldFor('what state do you currently reside in', 'combobox-input'), 'location.state');
  assert.equal(canonicalFieldFor('which state do you live in', 'select'), 'location.state');
});

test('canonicalFieldFor leaves other uses of the word state alone', () => {
  // "State" as a verb.
  assert.equal(canonicalFieldFor('please state the employee s name', 'text'), null);
  // Somebody else's state.
  assert.equal(canonicalFieldFor('what state is your university located in', 'text'), null);
  // A yes/no the bank answers; filling it with "Pennsylvania" would be wrong.
  assert.equal(
    canonicalFieldFor('do you currently reside in any of the following states de hi ia ky ms ne nm sd vt wv wy', 'select'),
    null,
  );
});

test('canonicalFieldFor leaves the neighbouring EEO questions alone', () => {
  // No profile field answers these, so they must stay in the panel's hands.
  assert.equal(canonicalFieldFor('do you identify as transgender', 'radio'), null);
  assert.equal(canonicalFieldFor('how do you identify your sexual orientation', 'checkbox'), null);
  assert.equal(canonicalFieldFor('what are your pronouns', 'text'), null);
  // These have their own profile fields and must not be answered with a race.
  assert.equal(canonicalFieldFor('are you hispanic or latino', 'radio'), 'demographics.hispanicLatino');
  assert.equal(canonicalFieldFor('veteran status', 'radio'), 'demographics.veteran');
});

test('canonicalFieldFor ignores prose that merely mentions race or gender', () => {
  // The acknowledgement checkbox every board ships. Agreeing to it is not
  // stating your race.
  const ack = 'acme is an equal opportunity employer and considers all qualified '
    + 'applicants without regard to race color religion sex sexual orientation '
    + 'gender identity or national origin';
  assert.equal(canonicalFieldFor(ack, 'checkbox'), null);
  // A free-text box asking about these is its own question.
  assert.equal(canonicalFieldFor('what does gender equity at work mean to you', 'textarea'), null);
});

test('canonicalFieldFor rejects a kind mismatch', () => {
  // "Website" as a dropdown is not the portfolio URL field.
  assert.equal(canonicalFieldFor('website', 'select'), null);
  assert.equal(canonicalFieldFor('company', 'select'), null);
});

// ── helpers ────────────────────────────────────────────────────────

test('isSensitiveQuestion flags EEO wording', () => {
  assert.ok(isSensitiveQuestion('What is your gender?'));
  assert.ok(isSensitiveQuestion('Veteran status'));
  assert.ok(isSensitiveQuestion('Voluntary Self-Identification of Disability'));
  assert.ok(!isSensitiveQuestion('What is your expected salary?'));
});

test('looksOpaqueId rejects widget identifiers', () => {
  // Real Workday values seen on a CrowdStrike posting.
  assert.ok(looksOpaqueId('0189e38acb3f0183ab6873effd013717'));
  assert.ok(looksOpaqueId('00d03f3ecfbc10010eba8bf0f1020000'));
  assert.ok(looksOpaqueId('f47ac10b-58cc-4372-a567-0e02b2c3d479'));
  assert.ok(looksOpaqueId('123456789012345'));
});

test('looksOpaqueId keeps real answers', () => {
  assert.ok(!looksOpaqueId('Yes'));
  assert.ok(!looksOpaqueId('No'));
  assert.ok(!looksOpaqueId('Male'));
  assert.ok(!looksOpaqueId('Available January 2027'));
  assert.ok(!looksOpaqueId('Carnegie Mellon University'));
  assert.ok(!looksOpaqueId('anmolsahu2k@gmail.com'));
  assert.ok(!looksOpaqueId('https://linkedin.com/in/anmolsahu2k'));
  assert.ok(!looksOpaqueId(''));
  assert.ok(!looksOpaqueId('Decline To Self Identify'));
});

test('readPath resolves dotted and indexed paths', () => {
  const profile = { name: { first: 'Anmol' }, education: [{ school: 'CMU' }] };
  assert.equal(readPath(profile, 'name.first'), 'Anmol');
  assert.equal(readPath(profile, 'education[0].school'), 'CMU');
  assert.equal(readPath(profile, 'education[3].school'), undefined);
  assert.equal(readPath(profile, 'missing.path'), undefined);
});

// ── regressions from a live Greenhouse posting (job-boards/cssmerge) ─
//
// Every label below is the exact question text as that form renders it. All
// four were left orange on a real run while the answer bank or the profile
// already held the answer, except the first, which must stay orange.

const LIVE = {
  authorizedAll: 'Are you currently authorized to work for all employers in the country where this job is based?',
  sponsorship: 'Do you now or will you in the future require immigration sponsorship by the company for continued work-authorization?',
  office5: 'Are you willing to work in the office 5-days a week?',
  gpa: 'What is your current GPA? Please specify on a 4 point scale.',
};

/** The sponsorship wordings the seeded bank actually holds. */
const LIVE_ANSWERS = {
  'will you now or in the future require sponsorship': {
    key: 'will you now or in the future require sponsorship', answer: 'Yes',
  },
  'do you require sponsorship now or in the future': {
    key: 'do you require sponsorship now or in the future', answer: 'Yes',
  },
  'are you available to go to the office 5 times per week': {
    key: 'are you available to go to the office 5 times per week', answer: 'Yes',
  },
  'are you legally authorized to work in the united states': {
    key: 'are you legally authorized to work in the united states', answer: 'Yes',
  },
};

test('findAnswer resolves a reworded sponsorship question', () => {
  // Two stored wordings are contained in this one and both say Yes, so there
  // is no ambiguity to abstain over.
  const hit = findAnswer(normalizeKey(LIVE.sponsorship), LIVE_ANSWERS);
  assert.ok(hit, 'sponsorship question went unanswered');
  assert.equal(hit.entry.answer, 'Yes');
});

test('findAnswer resolves an onsite-days question worded another way', () => {
  const hit = findAnswer(normalizeKey(LIVE.office5), LIVE_ANSWERS);
  assert.ok(hit, 'onsite-days question went unanswered');
  assert.equal(hit.entry.answer, 'Yes');
});

test('canonicalFieldFor finds GPA inside a full sentence', () => {
  assert.equal(canonicalFieldFor(normalizeKey(LIVE.gpa), 'text'), 'education[0].gpa');
  assert.equal(canonicalFieldFor('gpa', 'text'), 'education[0].gpa');
  assert.equal(canonicalFieldFor('what is your cumulative gpa', 'text'), 'education[0].gpa');
});

test('canonicalFieldFor abstains on a GPA for a degree other than the current one', () => {
  // education[0] is the master's. Answering "undergraduate GPA" from it reports
  // the wrong number off the wrong degree, which is worse than leaving it blank.
  assert.equal(canonicalFieldFor('what is your undergraduate gpa', 'text'), null);
  assert.equal(canonicalFieldFor('bachelors gpa', 'text'), null);
  assert.equal(canonicalFieldFor('high school gpa', 'text'), null);
});

test('canonicalFieldFor does not read GPA out of prose that merely mentions it', () => {
  // A qualification statement to agree with, not a question about the applicant.
  const blurb = normalizeKey(
    'I confirm that I meet the minimum 3.7 GPA requirement described in the qualifications for this role');
  assert.equal(canonicalFieldFor(blurb, 'checkbox'), null);
  assert.equal(canonicalFieldFor(blurb, 'text'), null);
});

test('a bare "authorized for all employers" question is never auto-answered', () => {
  // "Authorized to work for ALL employers" is not the same question as "are you
  // legally authorized to work in the US". On F-1/OPT the honest answers differ,
  // and this one is a legal attestation. It must stay orange for the user.
  assert.equal(findAnswer(normalizeKey(LIVE.authorizedAll), LIVE_ANSWERS), null);
  assert.equal(canonicalFieldFor(normalizeKey(LIVE.authorizedAll), 'combobox-input'), null);
});

test('a "without sponsorship" question is never answered from a sponsorship Yes', () => {
  const asked = normalizeKey('Are you able to work in the United States without sponsorship?');
  assert.equal(findAnswer(asked, LIVE_ANSWERS), null);
});

test('covered answers still abstain when the tied readings disagree', () => {
  const conflicting = {
    'do you require sponsorship now or in the future': {
      key: 'do you require sponsorship now or in the future', answer: 'Yes',
    },
    'will you now or in the future require sponsorship': {
      key: 'will you now or in the future require sponsorship', answer: 'No',
    },
  };
  assert.equal(findAnswer(normalizeKey(LIVE.sponsorship), conflicting), null);
});

// ---------------------------------------------------------------------------
// Work authorization and sponsorship, matched by concept rather than wording.
// Captured from the live Rocket (quickenloans) Workday tenant, 2026-08-11,
// where both fell through every wording-based route and were left blank.
// ---------------------------------------------------------------------------

const CONCEPT_BANK = {
  'are you legally authorized to work in the united states': { answer: 'Yes' },
  'are you authorized to work in the us': { answer: 'Yes' },
  'will you now or in the future require sponsorship for employment visa status': { answer: 'Yes' },
  'do you require sponsorship now or in the future': { answer: 'Yes' },
  // Not a sponsorship question despite the word "visa"; keying off /visa/ would
  // drag this in and poison the agreement check.
  'required for canadian or mexican citizens only are you currently on a tn visa': { answer: 'No' },
  // A sponsorship-shaped question whose answer is a status, not a yes/no. It
  // answers something else and must not get a vote.
  'if yes please indicate visa status': { answer: 'F-1 (OPT)' },
};

test('answers a work-authorization question worded a way the bank has never seen', () => {
  const key = normalizeKey('Are you legally authorized to begin immediate employment in the United States?');
  const hit = findAnswer(key, CONCEPT_BANK);
  assert.equal(hit?.entry.answer, 'Yes');
  assert.equal(hit?.method, 'concept');
});

test('answers Greenhouse legal-eligibility wording without conflating sponsorship', () => {
  const key = normalizeKey('Are you currently eligible to work legally in the United States of America?');
  const hit = findAnswer(key, CONCEPT_BANK);
  assert.equal(hit?.entry.answer, 'Yes');
  assert.equal(hit?.method, 'concept');
  assert.equal(conceptOf(normalizeKey('Are you eligible to work without sponsorship?')), null);
});

test('maps approved Male wording onto a controlled Man option', () => {
  assert.equal(matchOption('Male', opt('Man', 'Woman', 'I prefer not to answer')).text, 'Man');
});

test('maps a short disability self-identification question to the approved profile field', () => {
  assert.equal(canonicalFieldFor('I have a disability', 'radio'), 'demographics.disability');
  assert.equal(canonicalFieldFor('I consent to demographic surveys about disability', 'checkbox'), 'demographics.demographicSurveyConsent');
  assert.equal(canonicalFieldFor('I consent to the company privacy policy', 'checkbox'), null);
});

test('uses an approved non-compete answer only for explicit non-compete wording', () => {
  const bank = { 'are you subject to a non compete agreement': { answer: 'No' } };
  const hit = findAnswer(normalizeKey('Are you subject to a non-solicitation agreement with a former employer?'), bank);
  assert.equal(hit?.entry.answer, 'No');
  assert.equal(hit?.method, 'concept');
  assert.equal(conceptOf(normalizeKey('Do you agree to these employment terms?')), null);
});

test('maps the exact controlled gender-identity label without generalising self-description prompts', () => {
  assert.equal(canonicalFieldFor(normalizeKey('I identify as:'), 'combobox-input'), 'demographics.genderIdentity');
  assert.equal(canonicalFieldFor(normalizeKey('Please describe how you identify as a professional'), 'textarea'), null);
});

test('answers an immigration-support question that never says "visa" or "require"', () => {
  const key = normalizeKey('Do you now, or will you in the future, need any immigration-related support or sponsorship from the company in order to begin or continue employment?');
  const hit = findAnswer(key, CONCEPT_BANK);
  assert.equal(hit?.entry.answer, 'Yes');
  assert.equal(hit?.method, 'concept');
});

test('abstains on the compound question, whose answer is the opposite', () => {
  // "authorized to work WITHOUT sponsorship" is Yes-to-authorization and
  // No-to-sponsorship at once. Answering it from either concept tells an
  // employer the wrong thing about a visa.
  const key = normalizeKey('Are you authorized to work in the United States without sponsorship?');
  assert.equal(findAnswer(key, CONCEPT_BANK), null);
});

test('a TN-visa question does not vote in the sponsorship concept', () => {
  assert.equal(conceptOf(normalizeKey('required for canadian or mexican citizens only are you currently on a tn visa')), null);
});

test('abstains when the concept votes disagree', () => {
  const split = {
    'are you legally authorized to work in the united states': { answer: 'Yes' },
    'are you authorized to work in the us': { answer: 'No' },
  };
  const key = normalizeKey('Are you legally authorized to begin immediate employment in the United States?');
  assert.equal(findAnswer(key, split), null);
});

test('concept matching never overrides a real wording match', () => {
  const bank = {
    ...CONCEPT_BANK,
    'are you legally authorized to begin immediate employment in the united states': { answer: 'No' },
  };
  const key = normalizeKey('Are you legally authorized to begin immediate employment in the United States?');
  const hit = findAnswer(key, bank);
  assert.equal(hit?.method, 'exact');
  assert.equal(hit?.entry.answer, 'No');
});
