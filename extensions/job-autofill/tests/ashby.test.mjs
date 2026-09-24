import test from 'node:test';
import assert from 'node:assert/strict';

import ashby from '../content/adapters/ashby.js';
import { searchQuery } from '../content/filler.js';
import { matchOption, normalizeKey } from '../content/matcher.js';

function fakeControl({ id = '', name = '', type = 'checkbox', label = 'I agree' } = {}) {
  return {
    id,
    name,
    getAttribute(key) {
      if (key === 'type') return type;
      if (key === 'name') return name;
      if (key === 'id') return id;
      return null;
    },
    closest() { return null; },
    labels: [{ textContent: label }],
  };
}

test('Ashby data-consent system field maps to Affirmation / privacy ack', () => {
  const el = fakeControl({
    id: '3f8016f2-2294-44d9-922b-521b6dcca4cd__systemfield_data_consent_ack-labeled-checkbox-0',
    name: 'I agree',
  });
  assert.equal(ashby.labelOverride(el), 'Affirmation');
  assert.equal(ashby.canonicalAttr(el), 'application.acknowledgements.requiredPrivacyPolicy');
});

test('Ashby labelOverride leaves ordinary checkboxes alone when no entry', () => {
  const el = fakeControl({
    id: 'other-labeled-checkbox-0',
    name: 'newsletter',
    label: 'Keep me informed',
  });
  assert.equal(ashby.labelOverride(el), null);
  assert.equal(ashby.canonicalAttr(el), null);
});


// Ashby's location and country fields are type-to-search: the backend matches a
// prefix, so the full formatted answer finds nothing.

test('searchQuery sends only the leading segment', () => {
  assert.equal(searchQuery('Pittsburgh, Pennsylvania, United States'), 'Pittsburgh');
  assert.equal(searchQuery('Pittsburgh'), 'Pittsburgh');
  assert.equal(searchQuery('United States of America'), 'United States of America');
});

test('searchQuery keeps the whole value when the head is too short', () => {
  assert.equal(searchQuery('A, B, C'), 'A, B, C');
});

test('searchQuery is bounded and handles empties', () => {
  assert.ok(searchQuery('x'.repeat(80)).length <= 24);
  assert.equal(searchQuery(''), '');
  assert.equal(searchQuery(null), '');
});

// The results come back near-identical; picking the wrong one is silent damage.
const opt = (...t) => t.map(x => ({ value: x, text: x }));

test('the right Pittsburgh is chosen from near-identical results', () => {
  const options = opt(
    'Pittsburgh, Pennsylvania, United States',
    'Pittsburg, California, United States',
    'Pittsburg, Kansas, United States',
    'Pittsburg, Texas, United States'
  );
  assert.equal(
    matchOption('Pittsburgh, Pennsylvania, United States', options).text,
    'Pittsburgh, Pennsylvania, United States'
  );
});

test('United States of America wins over Minor Outlying Islands', () => {
  const options = opt('UNITED STATES MINOR OUTLYING ISLANDS', 'UNITED STATES OF AMERICA');
  assert.equal(matchOption('United States of America', options).text, 'UNITED STATES OF AMERICA');
});

test('a bare "United States" still resolves to the country, not the islands', () => {
  // Both options lead with the answer, so the leads-with tie-break declines and
  // scoring decides: "of America" adds one stray token, "Minor Outlying
  // Islands" adds three, so the closer match wins. That is the desired answer
  // here, and the seeded value is the fully qualified one regardless.
  const options = opt('UNITED STATES MINOR OUTLYING ISLANDS', 'UNITED STATES OF AMERICA');
  assert.equal(matchOption('United States', options).text, 'UNITED STATES OF AMERICA');
});

// "Start typing..." is the widget describing itself, not the question.
test('generic placeholders must not become the question key', () => {
  assert.equal(normalizeKey('Start typing...'), 'start typing');
  assert.notEqual(normalizeKey('Location'), normalizeKey('Start typing...'));
});
