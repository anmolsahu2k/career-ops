import test from 'node:test';
import assert from 'node:assert/strict';

import { findAnswer, normalizeKey } from '../content/matcher.js';

const bank = (...pairs) => Object.fromEntries(pairs.map(([key, answer, answerType = 'select']) =>
  [key, { key, answer, answerType }]));

const SPONSORSHIP = 'will you now or in the future require sponsorship for employment visa status';
const AUTHORIZED = 'are you legally authorized to work in the united states';

// The real miss this rule exists for: a company appends a parenthetical and
// Jaccard drops the same question below threshold.
test('a question padded with a parenthetical still resolves', () => {
  const answers = bank([SPONSORSHIP, 'Yes']);
  const asked = normalizeKey('Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?');
  const hit = findAnswer(asked, answers);
  assert.equal(hit?.entry.answer, 'Yes');
  assert.equal(hit?.method, 'covered');
});

test('the plain wording still matches exactly, not by coverage', () => {
  const answers = bank([SPONSORSHIP, 'Yes']);
  assert.equal(findAnswer(SPONSORSHIP, answers)?.method, 'exact');
});

// The dangerous inverse: same words, opposite answer.
test('a negated question is never answered by coverage', () => {
  const answers = bank([SPONSORSHIP, 'Yes'], [AUTHORIZED, 'Yes']);
  const asked = normalizeKey('Are you legally authorized to work in the United States without sponsorship?');
  assert.equal(findAnswer(asked, answers), null);
});

test('a short stored question is not specific enough to carry', () => {
  // "degree" appears inside dozens of unrelated questions.
  const answers = bank(['degree', "Master's Degree"], ['what is your current gpa', '3.75']);
  const asked = normalizeKey('Which degree program are you enrolled in at your current university?');
  assert.equal(findAnswer(asked, answers), null);
});

test('two equally specific stored questions abstain rather than guess', () => {
  const answers = bank(
    ['do you require sponsorship for employment visa status now', 'Yes'],
    ['do you require sponsorship for employment visa status later', 'No']
  );
  // Long enough that the fuzzy pass drops below threshold and the question
  // reaches the coverage rule, where both stored wordings fit equally well.
  const asked = normalizeKey(
    'Do you require sponsorship for employment visa status now or later in the future, including any dependent visa category?'
  );
  assert.equal(findAnswer(asked, answers), null);
});

test('coverage never reuses a free-text answer', () => {
  const answers = bank([
    'describe the hardest technical challenge you have faced at work',
    'A long company-specific essay',
    'textarea',
  ]);
  const asked = normalizeKey('Describe the hardest technical challenge you have faced at work in the last two years.');
  assert.equal(findAnswer(asked, answers), null);
});

test('an unrelated question is still unanswered', () => {
  const answers = bank([SPONSORSHIP, 'Yes']);
  assert.equal(findAnswer(normalizeKey('What are your preferred office locations?'), answers), null);
});
