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
  mapSanctionsChoice,
  restrictedCountryStoredAnswer,
  mapNoneLikeChoice,
  isOtpVerificationQuestion,
  isEphemeralApplicationQuestion,
  dropEphemeralAnswers,
  namedSchoolAffiliationAnswer,
  careerFairContactAnswer,
  graduationSeasonAnswer,
  commuteOrRelocateOption,
  localOrRelocateAnswer,
  exportControlCountryAnswer,
  matchGpaBand,
  startAvailabilityAnswer,
  usPersonExportAnswer,
  f1OptCptCurrentAnswer,
  graduationDateAnswer,
  matchGpaTenth,
  degreeGpaAnswer,
  standardizedTestAnswer,
  securityClearanceAnswer,
  namedEmployerHistoryAnswer,
  workAuthorizationStatusAnswer,
  citizenshipStatusAnswer,
  citizenshipOtherExplainAnswer,
  currentlyEmployedAtNamedOrgAnswer,
  militaryReserveOrGuardAnswer,
  usGovernmentEmploymentAnswer,
  relativesAtNamedOrgAnswer,
  applicationAffirmationAnswer,
  completedEducationLevelAnswer,
  workLocationInterestAnswer,
  remoteWorkStateAnswer,
  relocationPreferenceAnswer,
  futureOpportunityDeclineAnswer,
  travelPercentageAnswer,
  operationalSmsOptInAnswer,
  matchSalaryBand,
  alignSalaryAnswerToOptions,
  filledValueMatches,
  essentialFunctionsAnswer,
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
  const bank = {
    ...ANSWERS,
    'describe a project you are proud of': {
      key: 'describe a project you are proud of',
      answer: 'A long reusable-looking essay.',
      answerType: 'textarea',
    },
  };
  const hit = findAnswer('describe a project you are proud of', bank);
  assert.equal(hit.method, 'exact');
  assert.equal(hit.entry.answerType, 'textarea');
});

test('findAnswer never reuses rotating codes, salary prompts, or why-this-job answers', () => {
  const verification = 'A verification code was sent to candidate@example.com. To submit your application, enter the 8-character code to confirm you are a human.';
  const bank = {
    'security code': { key: 'security code', answer: 'xxxxxxxx', answerType: 'text', questions: ['Security code'] },
    [normalizeKey(verification)]: { key: normalizeKey(verification), answer: 'xxxxxxxx', answerType: 'text', questions: [verification] },
    'what is your minimum salary expectation for this role': {
      key: 'what is your minimum salary expectation for this role',
      answer: '1',
      answerType: 'text',
      questions: ['What is your minimum salary expectation for this role?'],
    },
    ...ANSWERS,
  };
  assert.equal(isOtpVerificationQuestion('Security code'), true);
  assert.equal(isEphemeralApplicationQuestion(verification), true);
  assert.equal(isEphemeralApplicationQuestion('What is your minimum salary expectation for this role?'), true);
  assert.equal(findAnswer('security code', bank), null);
  assert.equal(findAnswer(normalizeKey(verification), bank), null);
  assert.equal(findAnswer('why do you want to work here', bank), null);
  assert.equal(findAnswer('what is your minimum salary expectation for this role', bank), null);
  assert.equal(isEphemeralApplicationQuestion('What is your expected graduation date?'), false);
  assert.equal(isEphemeralApplicationQuestion('Salary type'), false);
  assert.deepEqual(Object.keys(dropEphemeralAnswers(bank)).sort(), Object.keys(ANSWERS).filter(key => !isEphemeralApplicationQuestion(key)).sort());
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

test('a stored restricted-country No maps onto Greenhouse none-of-the-above options', () => {
  const answers = {
    'citizen or resident of cuba iran north korea syria or crimea region of ukraine': {
      key: 'citizen or resident of cuba iran north korea syria or crimea region of ukraine',
      answer: 'No',
    },
  };
  assert.equal(conceptOf('please confirm sanctions and export controls'), 'restricted-country');
  assert.equal(restrictedCountryStoredAnswer(answers).answer, 'No');
  const first = [
    { text: 'Citizen or permanent resident of Cuba, Iran, North Korea, or Syria' },
    { text: 'None of the above' },
  ];
  const follow = [
    { text: 'U.S. citizen' },
    { text: 'Not applicable (i.e., I selected “none of the above” for the prior question)' },
  ];
  assert.equal(
    mapSanctionsChoice('Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.', first, 'No'),
    'None of the above',
  );
  assert.equal(
    mapSanctionsChoice('If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you.', follow, 'No'),
    'Not applicable (i.e., I selected “none of the above” for the prior question)',
  );
  assert.equal(mapSanctionsChoice('Please confirm sanctions and export controls', first, 'Yes'), null);
  assert.equal(restrictedCountryStoredAnswer({
    ...answers,
    'cuba iran north korea': { key: 'cuba iran north korea', answer: 'Yes' },
  }), null);
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
  assert.equal(canonicalFieldFor('have you previously worked at or consulted for GitLab', 'combobox-input'), 'application.previouslyWorkedHere');
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
  assert.equal(canonicalFieldFor('gpa doctorate', 'combobox-input'), null);
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

test('maps recurring Greenhouse legal and Twitch experience questions onto profile facts', () => {
  assert.equal(canonicalFieldFor(normalizeKey('Do you currently or have you previously worked for Databricks in the past?'), 'combobox-input'), 'application.previouslyWorkedHere');
  assert.equal(canonicalFieldFor(normalizeKey('Are you currently a Twitch employee?'), 'combobox-input'), 'application.currentCompanyEmployee');
  assert.equal(canonicalFieldFor(normalizeKey('Are you a current employee with Amazon or any Amazon subsidiary (outside of Twitch)?'), 'combobox-input'), 'application.currentCompanyEmployee');
  assert.equal(canonicalFieldFor(normalizeKey('Have you previously applied to Amazon or any Amazon subsidiary?'), 'combobox-input'), 'application.previouslyAppliedAmazon');
  assert.equal(canonicalFieldFor(normalizeKey('Have you held H-1B status, or had an H-1B petition approved on your behalf, within the preceding 6 years for an employer?'), 'combobox-input'), 'application.h1bPetitionLastSixYears');
  assert.equal(canonicalFieldFor(normalizeKey('In which country/region do you have citizenship?'), 'combobox-input'), 'identity.citizenship');
  assert.equal(canonicalFieldFor(normalizeKey('Since obtaining your most recent citizenship, did you afterwards become a permanent resident in any other country/region?'), 'combobox-input'), 'application.laterPermanentResident');
  assert.equal(canonicalFieldFor(normalizeKey('For the sole purpose of determining export licensing requirements, please provide your country of citizenship or legal permanent residence'), 'combobox-input'), 'identity.citizenship');
  assert.equal(canonicalFieldFor(normalizeKey('How would you describe your experience with Twitch? (Select one)'), 'combobox-input'), 'application.twitchExperience');
  assert.equal(canonicalFieldFor(normalizeKey('How many years have you been active on the platform?'), 'combobox-input'), 'application.twitchYearsActive');
  assert.equal(canonicalFieldFor(normalizeKey('Do you have experience in the Creator Economy beyond Twitch?'), 'checkbox'), 'application.creatorEconomyBeyondTwitch');
  assert.equal(canonicalFieldFor(normalizeKey('Are you currently employed?'), 'combobox-input'), null);
  assert.equal(canonicalFieldFor(normalizeKey('Have you previously applied to this company?'), 'combobox-input'), null);
});

test('a stored None maps onto the unique Creator Economy none option', () => {
  const options = ['TikTok', 'Meta / Instagram / Facebook', 'WhatNot', 'YouTube', 'Other', 'None'];
  assert.equal(mapNoneLikeChoice('Do you have experience in the Creator Economy beyond Twitch?', options, 'None'), 'None');
  assert.equal(mapNoneLikeChoice('How would you describe your experience with Twitch? (Select one)', ['Viewer', 'Creator', 'None'], 'None'), 'None');
  assert.equal(mapNoneLikeChoice('How would you describe your experience with Twitch? (Select one)', [
    'Viewer - I primarily watch content with minimal chat participation',
    'Chatter - I actively participate in stream chats and/or communities',
    'Affiliate - I\'m a creator who has achieved Affiliate status',
    'Partner - I\'m a creator who has achieved Partner status',
    'Non-User - I do not have any personal Twitch experience',
  ], 'None'), 'Non-User - I do not have any personal Twitch experience');
  assert.equal(mapNoneLikeChoice('First name', options, 'None'), null);
  assert.equal(mapNoneLikeChoice('Do you have experience in the Creator Economy beyond Twitch?', options, 'TikTok'), null);
});

test('open-to-relocation wording reuses the stored relocate Yes', () => {
  const bank = { 'are you willing to relocate': { answer: 'Yes', answerType: 'select' } };
  assert.equal(findAnswer(normalizeKey('Are you open to relocation?'), bank)?.entry.answer, 'Yes');
  assert.equal(
    relocationPreferenceAnswer('Are you open to relocation?', ['Yes', 'No'], { relocateAnswer: 'Yes' }),
    'Yes',
  );
  const twitchOffices = [
    'No',
    "No, but I'm open to a remote position",
    'San Francisco, CA',
    'Irvine, CA',
    'Los Angeles, CA',
    'Seattle, WA',
    'New York, NY',
    'London, UK',
    'Singapore',
  ];
  const picked = relocationPreferenceAnswer('Are you open to relocation?', twitchOffices, { relocateAnswer: 'Yes' });
  assert.match(picked, /San Francisco, CA/);
  assert.match(picked, /London, UK/);
  assert.match(picked, /Singapore/);
  assert.equal(picked.includes('No'), false);
  assert.equal(
    futureOpportunityDeclineAnswer(
      'Would you like to be considered for future opportunities at Twitch when you apply?',
      ['Yes', 'No'],
    ),
    'No',
  );
  assert.equal(futureOpportunityDeclineAnswer('First name', ['Yes', 'No']), null);
});

test('HQ / working-out-of questions reuse stored on-site Yes', () => {
  const bank = { 'are you willing to work on-site': { answer: 'Yes', answerType: 'select' } };
  const key = normalizeKey('Are you interested in working out of our Miami HQ?');
  assert.equal(conceptOf(key), 'office-availability');
  assert.equal(findAnswer(key, bank)?.entry.answer, 'Yes');
  assert.equal(conceptOf(normalizeKey('Which office location do you prefer?')), null);
});

test('hybrid office-location willingness reuses stored on-site Yes', () => {
  const bank = { 'are you willing to work on-site': { answer: 'Yes', answerType: 'select' } };
  const question = 'Are you able and willing to report to the office location listed in the job description, in a hybrid capacity?';
  assert.equal(conceptOf(normalizeKey(question)), 'office-availability');
  assert.equal(findAnswer(normalizeKey(question), bank)?.entry.answer, 'Yes');
  assert.equal(conceptOf(normalizeKey('What is your office location?')), null);
  assert.equal(conceptOf(normalizeKey('What are your preferred office locations?')), null);
});

test('start-availability reuses January 2027 and maps wait buckets', () => {
  const bank = {
    'when can you start': { key: 'when can you start', answer: 'Available January 2027' },
    'start date month': { key: 'start date month', answer: 'August' },
    'start date year': { key: 'start date year', answer: '2025' },
  };
  const question = 'How soon are you able to start a new role?';
  assert.equal(startAvailabilityAnswer(question, [], bank), 'Available January 2027');
  assert.equal(startAvailabilityAnswer(question, [], bank, { kind: 'date' }), '2027-01-01');
  assert.equal(startAvailabilityAnswer(
    question,
    ['Immediately', '2 weeks', '1 month', 'More than 90 days'],
    bank,
    { now: new Date('2026-09-19T12:00:00Z') },
  ), 'More than 90 days');
  assert.equal(startAvailabilityAnswer('Start date month', [], bank), null);
  assert.equal(startAvailabilityAnswer(
    question,
    ['Immediately', '2 weeks', '1 month'],
    bank,
    { now: new Date('2026-09-19T12:00:00Z') },
  ), null);
});

test('named school affiliation uses education history and never invents attendance', () => {
  const education = [
    { school: 'Carnegie Mellon University' },
    { school: 'Vellore Institute of Technology' },
  ];
  assert.equal(namedSchoolAffiliationAnswer('Are you currently attending or a recent graduate of Georgia Tech?', education), 'No');
  assert.equal(namedSchoolAffiliationAnswer('Are you currently attending or a recent graduate of Carnegie Mellon University?', education), 'Yes');
  assert.equal(namedSchoolAffiliationAnswer('Are you a student at CMU?', education), 'Yes');
  assert.equal(namedSchoolAffiliationAnswer('What is your favorite school?', education), null);
  assert.equal(namedSchoolAffiliationAnswer('Are you currently attending or a recent graduate of Georgia Tech?', []), null);
});

test('career fair contact defaults to N/A', () => {
  assert.equal(careerFairContactAnswer('Who did you meet at the career fair?'), 'N/A');
  assert.equal(careerFairContactAnswer('Who did you speak with at our info session?'), 'N/A');
  assert.equal(careerFairContactAnswer('Who is your manager?'), null);
  assert.equal(matchOption('N/A', opt('Alex Chen', 'N/A', 'Jordan Lee'))?.text, 'N/A');
});

const IDME_EDUCATION = [
  {
    school: 'Carnegie Mellon University',
    gpa: '3.75',
    endMonth: '2026-12',
    current: true,
  },
];

const IDME_RELOCATE = 'This role requires working onsite 5 days per week at one of our hub offices (Mountain View, CA or McLean, VA). Do you currently live within commuting distance of one of these locations, or are you willing to relocate?';
const IDME_RELOCATE_OPTIONS = opt(
  'Yes — I currently live within commuting distance of Mountain View, CA or McLean, VA and am willing to work onsite 5 days per week.',
  'Yes — I do not currently live within commuting distance, but I am willing to relocate and work onsite 5 days per week.',
  'No — I do not live within commuting distance, am not willing to relocate, and/or am not willing to work onsite 5 days per week.',
);
const IDME_GPA_OPTIONS = opt(
  '4.0 or higher',
  '3.5 - 3.99',
  '3.49 - 3.0',
  '2.99 or below',
);

test('an onsite commute-or-relocate question is relocation, not a dual-concept abstain', () => {
  const key = normalizeKey(IDME_RELOCATE);
  assert.equal(conceptOf(key), 'relocation');
  const bank = { 'are you willing to relocate': { answer: 'Yes', answerType: 'select' } };
  assert.equal(findAnswer(key, bank)?.entry.answer, 'Yes');
});

test('Pittsburgh plus relocate Yes maps onto the relocate sentence, not the commute sentence', () => {
  const chosen = commuteOrRelocateOption(IDME_RELOCATE, IDME_RELOCATE_OPTIONS, {
    location: { city: 'Pittsburgh', state: 'Pennsylvania', stateAbbr: 'PA' },
    relocateAnswer: 'Yes',
  });
  assert.match(chosen, /willing to relocate/i);
  assert.match(chosen, /do not currently live/i);
  assert.equal(matchOption('Yes', IDME_RELOCATE_OPTIONS), null);
  assert.equal(matchOption(chosen, IDME_RELOCATE_OPTIONS)?.text, chosen);
});

test('a hub-city resident maps onto the commute sentence', () => {
  const chosen = commuteOrRelocateOption(IDME_RELOCATE, IDME_RELOCATE_OPTIONS, {
    location: { city: 'Mountain View', state: 'California', stateAbbr: 'CA' },
    relocateAnswer: 'Yes',
  });
  assert.match(chosen, /currently live within commuting distance/i);
  assert.doesNotMatch(chosen, /do not currently live/i);
});

test('graduation season uses the current education end month and does not invent a later cohort', () => {
  assert.equal(graduationSeasonAnswer('Are you graduating Summer of 2027', IDME_EDUCATION), 'No');
  assert.equal(graduationSeasonAnswer('Are you graduating Winter of 2026?', IDME_EDUCATION), 'Yes');
  assert.equal(graduationSeasonAnswer('Are you graduating in 2026?', IDME_EDUCATION), 'Yes');
  assert.equal(graduationSeasonAnswer('Are you in the class of 2027?', IDME_EDUCATION), null);
  assert.equal(graduationSeasonAnswer('What is your graduation date?', IDME_EDUCATION), null);
  assert.equal(graduationSeasonAnswer('Are you graduating Summer of 2027', []), null);
});

test('expected graduation date maps December 2026 onto Fall when Winter is absent', () => {
  const garner = [
    'Already Graduated', 'Fall 2026', 'Spring 2027', 'Fall 2027', 'Spring 2028',
    'Fall 2028', 'Spring 2029', 'Fall 2029', 'Spring 2030', 'Fall 2030',
  ];
  assert.equal(graduationDateAnswer('When is your expected graduation date?', garner, IDME_EDUCATION), 'Fall 2026');
  assert.equal(graduationDateAnswer('When is your expected graduation date?', [
    'Already Graduated', 'Fall 2026', 'Winter 2026', 'Spring 2027',
  ], IDME_EDUCATION), 'Winter 2026');
  assert.equal(graduationDateAnswer('What is your expected graduation date?', [], IDME_EDUCATION, { kind: 'date' }), '2026-12-01');
  assert.equal(graduationDateAnswer('When is your expected graduation date?', garner, IDME_EDUCATION, {
    now: new Date('2027-01-15T00:00:00Z'),
  }), 'Already Graduated');
  assert.equal(graduationDateAnswer('When is your undergraduate graduation date?', garner, IDME_EDUCATION), null);
  assert.equal(graduationDateAnswer('How soon are you able to start a new role?', garner, IDME_EDUCATION), null);
});

test('GPA combobox and select controls can use the stored current-degree GPA', () => {
  assert.equal(canonicalFieldFor('what is your cumulative gpa', 'combobox'), 'education[0].gpa');
  assert.equal(canonicalFieldFor('what is your cumulative gpa', 'select'), 'education[0].gpa');
  assert.equal(matchOption('3.75', IDME_GPA_OPTIONS)?.text, '3.5 - 3.99');
  assert.equal(matchGpaBand('4.0', IDME_GPA_OPTIONS)?.text, '4.0 or higher');
  assert.equal(matchOption('3.75', opt('3-5 years', '5-7 years')), null);
  assert.equal(matchGpaTenth('3.75', opt('3.7 out of 4.0', '3.8 out of 4.0', '3.9 out of 4.0'))?.text, '3.8 out of 4.0');
  assert.equal(matchGpaTenth('3.87', opt('3.8 out of 4.0', '3.9 out of 4.0'))?.text, '3.9 out of 4.0');
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

test('local-to-city questions stay No unless the profile city matches', () => {
  const question = 'Are you local to Ann Arbor, MI?';
  const location = { city: 'Pittsburgh', state: 'Pennsylvania', stateAbbr: 'PA', raw: 'Pittsburgh, PA' };
  assert.equal(localOrRelocateAnswer(question, [{ text: 'Yes' }, { text: 'No' }], {
    location, relocateAnswer: 'Yes',
  }), 'No');
  assert.equal(localOrRelocateAnswer(question, [
    { text: 'Yes, I live here' },
    { text: 'No, but I am willing to relocate' },
  ], { location, relocateAnswer: 'Yes' }), 'No, but I am willing to relocate');
  assert.equal(localOrRelocateAnswer(question, [{ text: 'Yes' }, { text: 'No' }], {
    location: { city: 'Ann Arbor', stateAbbr: 'MI' }, relocateAnswer: 'Yes',
  }), 'Yes');
});

test('ITAR export compliance maps a non-US-person onto the unique not-a-US-person option', () => {
  const options = [
    'I am currently a “U.S. Person”',
    'I am not a “U.S. Person\"',
  ];
  assert.equal(usPersonExportAnswer('EXPORT COMPLIANCE', options, { usPerson: false }), 'I am not a “U.S. Person\"');
  assert.equal(usPersonExportAnswer('EXPORT COMPLIANCE', options, { usPerson: true }), 'I am currently a “U.S. Person”');
  assert.equal(usPersonExportAnswer('What is your favorite office snack?', ['Pretzel', 'Fruit'], { usPerson: false }), null);
  assert.equal(matchOption('No', options), null);
  assert.equal(canonicalFieldFor(normalizeKey('EXPORT COMPLIANCE'), 'combobox-input'), 'application.usPerson');
  assert.equal(canonicalFieldFor(normalizeKey('EXPORT COMPLIANCE'), 'textarea'), null);
  assert.equal(usPersonExportAnswer('EXPORT COMPLIANCE: please explain', options, { usPerson: false }), null);
});

test('current F-1 OPT/CPT is No and does not answer a now-or-future OPT question', () => {
  assert.equal(f1OptCptCurrentAnswer('Are you currently on an F1 OPT/CPT status?', ['Yes', 'No'], 'No'), 'No');
  assert.equal(f1OptCptCurrentAnswer(
    'Does your authorization to work in the United States now involve CPT or OPT now or in the future?',
    ['Yes', 'No'],
    'No',
  ), null);
  assert.equal(canonicalFieldFor(normalizeKey('Are you currently on an F1 OPT/CPT status?'), 'combobox-input'), 'application.currentlyOnF1OptCpt');
});

test('export-control None / Not applicable maps a stored No, and India fills the country follow-up', () => {
  const answers = {
    'u s export control requirements are you a citizen national or resident of cuba iran north korea syria or the crimea region of ukraine': {
      answer: 'No',
    },
  };
  assert.equal(restrictedCountryStoredAnswer(answers).answer, 'No');
  assert.equal(mapSanctionsChoice(
    'U.S. Export Control Requirements - Are you a citizen, national, or resident of any of the following countries/regions? Check each that apply:',
    [{ text: 'Cuba' }, { text: 'Iran' }, { text: 'None / Not applicable' }],
    'No',
  ), 'None / Not applicable');
  assert.equal(mapSanctionsChoice(
    'If you checked any of the boxes above other than None / Not applicable, then please provide additional information regarding your immigration and residency status. Check each that apply:',
    [
      { text: 'I am a Citizen or Legal Permanent Resident of a different country' },
      { text: 'Not applicable' },
    ],
    'No',
    { identity: { citizenship: 'India' } },
  ), 'I am a Citizen or Legal Permanent Resident of a different country');
  assert.equal(exportControlCountryAnswer(
    "If you checked either 'I am a Citizen or Legal Permanent Resident of a different country' or 'I reside in a different country and have a valid work visa there' please indicate the applicable country or countries. Type N/A if not applicable.",
    { citizenship: 'India', storedRestrictedNo: true },
  ), 'India');
});

test('restrictive employer agreements and relatives reuse stored No answers', () => {
  assert.equal(
    conceptOf(normalizeKey('Do you have an agreement between you and your current or former employer that may restrict your ability to accept this offer of employment with Torc or restrict any work that you may do for Torc?')),
    'non-compete',
  );
  assert.equal(
    conceptOf(normalizeKey('Do you have any relatives or family members currently employed at Torc Robotics?')),
    'employer-relatives',
  );
  assert.equal(
    canonicalFieldFor(normalizeKey('How did you first hear about this job? Please list the site, event, or person that referred you.'), 'textarea'),
    'application.heardAbout',
  );
  assert.equal(
    canonicalFieldFor(normalizeKey('Do you have an agreement between you and your current or former employer that may restrict your ability to accept this offer of employment?'), 'select'),
    'application.employmentRestrictions',
  );
  const bank = {
    'are you subject to a non compete agreement': { answer: 'No' },
    'do you have any relatives employed by this organization': { answer: 'No' },
  };
  assert.equal(findAnswer(normalizeKey('Do you have an agreement between you and your current or former employer that may restrict your ability to accept this offer?'), bank)?.entry.answer, 'No');
  assert.equal(
    findAnswer(normalizeKey('Do you have any relatives or family members currently employed at Torc Robotics?'), bank)?.entry.answer,
    'No',
  );
  assert.equal(
    conceptOf(normalizeKey('Do you have any family members or people you have close relationships with who work for Accenture Federal Services?')),
    'employer-relatives',
  );
  assert.equal(
    canonicalFieldFor(
      normalizeKey('Do you have any family members or people you have close relationships with who work for Accenture Federal Services?'),
      'select',
    ),
    'application.relativesAtEmployer',
  );
  assert.equal(
    findAnswer(
      normalizeKey('Do you have any family members or people you have close relationships with who work for Accenture Federal Services?'),
      bank,
    )?.entry.answer,
    'No',
  );
});

const SPACEX_EDUCATION = [
  { school: 'Carnegie Mellon University', degree: "Master's", gpa: '3.75', current: true },
  { school: 'Vellore Institute of Technology', degree: "Bachelor's", gpa: '3.87', current: false },
];
const SPACEX_GPA = [
  'Not applicable/Do not recall', '4.0 out of 4.0', '3.9 out of 4.0', '3.8 out of 4.0',
  '3.7 out of 4.0', '3.6 out of 4.0', '3.5 out of 4.0', 'Below 3.0 out of 4.0',
];
const SPACEX_GRAD_GPA = ['Other/Not Applicable', ...SPACEX_GPA.slice(1)];
const SPACEX_AUTH = [
  'I am authorized to work in the United States for any employer',
  'I am authorized to work in the United States for my present employer only',
  'I require sponsorship to work in the United States',
  'I am not authorized to work in the United States',
  'My status to work in the United States is unknown',
];
const SPACEX_CITIZEN = [
  '(a) U.S. citizen or national of the United States',
  '(b) U.S. lawful permanent resident',
  '(c) Refugee under 8 U.S.C. 1157',
  '(d) Asylee under 8 U.S.C. 1158',
  '(e) Authorized to work in the United States under the Deferred Action for Childhood Arrivals (DACA) program',
  '(f) Other (please explain)',
];
const SPACEX_HISTORY = [
  'I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter',
  'I am a former SpaceX, SpaceXAI, xAI, X, or Twitter employee',
  'I am a current or former SpaceX, SpaceXAI, xAI, X, or Twitter Intern',
  'I am a current SpaceX employee',
];
const SPACEX_CLEARANCE = [
  'Top Secret SCI with Polygraph', 'Top Secret', 'Secret', 'Expired Clearance',
  'Never held a clearance', 'Do not wish to disclose',
];
const SPACEX_GRE = ['Did not take/Do not recall', 'Other - did not take', '340 out of 340', '320 out of 340'];

test('degree GPA uses bachelor and master records and does not invent a doctorate', () => {
  assert.equal(degreeGpaAnswer('GPA (Undergraduate)', SPACEX_GPA, SPACEX_EDUCATION), '3.9 out of 4.0');
  assert.equal(degreeGpaAnswer('GPA (Graduate)', SPACEX_GRAD_GPA, SPACEX_EDUCATION), '3.8 out of 4.0');
  assert.equal(degreeGpaAnswer('GPA (Doctorate)', SPACEX_GPA, SPACEX_EDUCATION), 'Not applicable/Do not recall');
  assert.equal(degreeGpaAnswer('What is your current GPA?', SPACEX_GPA, SPACEX_EDUCATION), null);
  assert.equal(degreeGpaAnswer('When is your undergraduate graduation date?', SPACEX_GPA, SPACEX_EDUCATION), null);
});

test('SAT ACT GRE pick the unique did-not-take option and prefer it over Other', () => {
  assert.equal(standardizedTestAnswer('SAT Score', ['Did not take/Do not recall', '1600 out of 1600']), 'Did not take/Do not recall');
  assert.equal(standardizedTestAnswer('ACT Score', ['Did not take/Do not recall', '36 out of 36']), 'Did not take/Do not recall');
  assert.equal(standardizedTestAnswer('GRE Score', SPACEX_GRE), 'Did not take/Do not recall');
  assert.equal(standardizedTestAnswer('How soon can you start?', SPACEX_GRE), null);
});

test('security clearance and named employer history use never-held and never-worked', () => {
  assert.equal(securityClearanceAnswer('Active Security Clearance(s)', SPACEX_CLEARANCE), 'Never held a clearance');
  assert.equal(namedEmployerHistoryAnswer('SpaceX & SpaceXAI Employment History', SPACEX_HISTORY, [
    { company: "Byju's" }, { company: 'Mondee (Tabhi)' },
  ]), 'I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter');
  assert.equal(namedEmployerHistoryAnswer('SpaceX & SpaceXAI Employment History', SPACEX_HISTORY, [
    { company: 'Twitter' },
  ]), null);
});

const NISC_LOCATIONS = [
  'Atlanta, GA', 'Cedar Rapids, IA', 'Lake St. Louis, MO', 'Mandan, ND', 'I want to work remotely',
];
const NISC_STATES = [
  'I want to work in an NISC office', 'Pennsylvania', 'N/A - Not Located in the United States',
];
const NISC_COMP = [
  'less than 25k', '111-120k', '121-130K', '141-150K', '171K+',
];
const NISC_EDU = [
  'High School Equivalency', 'High School', "Associate's Degree", "Bachelor's Degree", "Masters's Degree", 'Other',
];

test('preferred first name questions map onto the profile first name', () => {
  assert.equal(canonicalFieldFor(normalizeKey('Preferred First Name'), 'text'), 'name.first');
  assert.equal(canonicalFieldFor(normalizeKey('What is your preferred first name?'), 'text'), 'name.first');
  assert.equal(
    canonicalFieldFor(normalizeKey('If you wish to receive information via text/SMS, please indicate the cell number below.'), 'text'),
    'phone.raw',
  );
});

test('named current-employer, location, education, travel, and SMS helpers stay fail-closed', () => {
  const work = [{ company: "Byju's" }, { company: 'Mondee (Tabhi)' }];
  const location = { city: 'Pittsburgh', state: 'Pennsylvania', stateAbbr: 'PA', raw: 'Pittsburgh, PA, USA' };
  const education = [
    { degree: "Master's", degreeOption: "Master's Degree", current: true },
    { degree: "Bachelor's", degreeOption: "Bachelor's Degree", current: false },
  ];
  assert.equal(
    currentlyEmployedAtNamedOrgAnswer('Are you currently employed at an NISC Member site?', ['Yes', 'No'], work),
    'No',
  );
  assert.equal(currentlyEmployedAtNamedOrgAnswer('Are you currently employed?', ['Yes', 'No'], work), null);
  assert.equal(
    currentlyEmployedAtNamedOrgAnswer('Are you currently employed at an NISC Member site?', ['Yes', 'No'], [{ company: 'NISC' }]),
    null,
  );
  assert.equal(
    workLocationInterestAnswer(
      'What locations are you interested in working from? (Select all that apply)',
      NISC_LOCATIONS,
      { location, relocateAnswer: 'Yes' },
    ),
    'Atlanta, GA | Cedar Rapids, IA | Lake St. Louis, MO | Mandan, ND',
  );
  assert.equal(
    remoteWorkStateAnswer(
      'If you selected working remotely above, which state would you plan to work remotely from?',
      NISC_STATES,
      { location, relocateAnswer: 'Yes' },
    ),
    'I want to work in an NISC office',
  );
  assert.equal(
    remoteWorkStateAnswer(
      'If you selected working remotely above, which state would you plan to work remotely from?',
      NISC_STATES,
      { location, relocateAnswer: 'No' },
    ),
    'Pennsylvania',
  );
  assert.equal(
    completedEducationLevelAnswer('What is your most recently completed form of education?', NISC_EDU, education),
    "Bachelor's Degree",
  );
  assert.equal(
    travelPercentageAnswer('What percentage of the time are you willing to travel?', ['0%', '1-10%', '11-20%'], {
      'what percentage of the time are you willing to travel': { answer: '1-10%' },
    }),
    '1-10%',
  );
  assert.equal(
    travelPercentageAnswer('What percentage of the time are you willing to travel?', ['0%', '1-10%'], {}),
    null,
  );
  assert.equal(
    operationalSmsOptInAnswer(
      'If selected for hire, would you like to receive information regarding your first day via text message/SMS?',
      ['Yes', 'No'],
      { 'would you like to receive information via text message/sms': { answer: 'No' } },
    ),
    'No',
  );
  assert.equal(matchOption('$125,000', NISC_COMP)?.text || matchOption('$125,000', NISC_COMP), '121-130K');
  assert.equal(alignSalaryAnswerToOptions('$125,000', NISC_COMP), '121-130K');
  assert.equal(alignSalaryAnswerToOptions('$20,000', NISC_COMP), 'less than 25k');
  assert.equal(alignSalaryAnswerToOptions('$180,000', NISC_COMP), '171K+');
  assert.equal(matchSalaryBand('$125,000', NISC_COMP)?.text || matchSalaryBand('$125,000', NISC_COMP), '121-130K');
  assert.equal(filledValueMatches('121-130K', '121-130K'), true);
  assert.equal(filledValueMatches('121-130K', '$125,000'), true);
  assert.equal(filledValueMatches('121K to 130K', '121-130K'), true);
  assert.equal(filledValueMatches('', '121-130K'), false);
});

test('work-authorization status lists require sponsorship and never pick any-employer', () => {
  const bank = {
    'are you legally authorized to work in the united states': { answer: 'Yes' },
    'will you now or in the future require sponsorship for employment visa status': { answer: 'Yes' },
  };
  assert.equal(
    workAuthorizationStatusAnswer('Are you legally authorized to work in the United States?', SPACEX_AUTH, bank),
    'I require sponsorship to work in the United States',
  );
  assert.equal(matchOption('Yes', SPACEX_AUTH), null);
  assert.equal(
    workAuthorizationStatusAnswer('Are you able to work in the United States without sponsorship?', SPACEX_AUTH, bank),
    null,
  );
});

test('citizenship status maps a non-US-person onto Other and explains F-1', () => {
  assert.equal(canonicalFieldFor('citizenship status', 'combobox-input'), null);
  assert.equal(
    citizenshipStatusAnswer('Citizenship Status', SPACEX_CITIZEN, { citizenship: 'India', usPerson: false }),
    '(f) Other (please explain)',
  );
  assert.equal(
    citizenshipOtherExplainAnswer('If (f) Other, please explain:', { citizenship: 'India', usPerson: false }),
    'India citizen, F-1 student visa',
  );
  assert.equal(citizenshipOtherExplainAnswer('Please specify', { citizenship: 'India' }), null);
});

test('essential-functions wording reuses stored Yes without a Jaccard hit', () => {
  assert.equal(
    conceptOf(normalizeKey('Can you perform all of the essential functions of this role with or without reasonable accommodations?')),
    'essential-functions',
  );
  const bank = {
    'can you perform the essential functions of this job with or without reasonable accommodation': { answer: 'Yes' },
  };
  assert.equal(
    essentialFunctionsAnswer(
      'Can you perform all of the essential functions of this role with or without reasonable accommodations?',
      ['Yes', 'No'],
      bank,
    ),
    'Yes',
  );
});

const AFS_CLEARANCE = ['None', 'Public Trust', 'Secret', 'Top Secret', 'TS/SCI', 'Other'];
const WORK_PRIVATE = [{ company: "Byju's" }, { company: 'Mondee (Tabhi)' }, { company: 'Carnegie Mellon University' }];

test('clearance None, reserves, US-gov employment, relatives, and affirmation stay fail-closed', () => {
  assert.equal(securityClearanceAnswer('Do you hold a security clearance?', AFS_CLEARANCE), 'None');
  assert.equal(securityClearanceAnswer('Active Security Clearance(s)', SPACEX_CLEARANCE), 'Never held a clearance');
  assert.equal(securityClearanceAnswer('Do you hold a security clearance?', ['Secret', 'Top Secret', 'TS/SCI']), null);
  assert.equal(
    militaryReserveOrGuardAnswer(
      'Will you be serving as enlisted personnel in either the Reserves or the National Guard while working for AFS?',
      ['Yes', 'No'],
      WORK_PRIVATE,
    ),
    'No',
  );
  assert.equal(
    militaryReserveOrGuardAnswer(
      'Will you be serving as enlisted personnel in either the Reserves or the National Guard while working for AFS?',
      ['Yes', 'No'],
      [{ company: 'U.S. Army' }],
    ),
    null,
  );
  assert.equal(militaryReserveOrGuardAnswer('Do you have cash reserves?', ['Yes', 'No'], WORK_PRIVATE), null);
  assert.equal(
    usGovernmentEmploymentAnswer(
      'Were you an employee of the U.S. Government (including U.S. Congress or military) or any state or local government within the past 10 years?',
      ['Yes', 'No'],
      WORK_PRIVATE,
    ),
    'No',
  );
  assert.equal(
    usGovernmentEmploymentAnswer(
      'Are you a current employee of the U.S. Government (including U.S. Congress or military) or any state or local government?',
      ['Yes', 'No'],
      WORK_PRIVATE,
    ),
    'No',
  );
  assert.equal(
    usGovernmentEmploymentAnswer(
      'Were you an employee of the U.S. Government within the past 10 years?',
      ['Yes', 'No'],
      [{ company: 'Amtrak' }],
    ),
    null,
  );
  assert.equal(
    usGovernmentEmploymentAnswer('Do you have experience with government contracts?', ['Yes', 'No'], WORK_PRIVATE),
    null,
  );
  assert.equal(
    relativesAtNamedOrgAnswer(
      'Do you have any family members or people you have close relationships with who work for Accenture Federal Services?',
      ['Yes', 'No'],
      { 'do you have any relatives employed by this organization': { answer: 'No' } },
    ),
    'No',
  );
  assert.equal(applicationAffirmationAnswer('Affirmation', ['I agree']), 'I agree');
  assert.equal(
    applicationAffirmationAnswer(
      'I certify that the information in this application is true and complete',
      ['I certify', 'I do not certify'],
    ),
    'I certify',
  );
  assert.equal(applicationAffirmationAnswer('Do you agree to these employment terms?', ['I agree', 'I do not agree']), null);
  assert.equal(applicationAffirmationAnswer('Join our talent community', ['I agree']), null);
  assert.equal(
    applicationAffirmationAnswer(
      'Learn more about how we handle your data for recruiting purposes in our privacy notice',
      ['Acknowledged'],
    ),
    'Acknowledged',
  );
  assert.equal(
    applicationAffirmationAnswer(
      'Do you agree to allow Handshake to contact you about job opportunities for up to 24 months?',
      ['I agree'],
    ),
    null,
  );
});
