import test from 'node:test';
import assert from 'node:assert/strict';

import lever from '../content/adapters/lever.js';
import { matchOption } from '../content/matcher.js';

const opt = (...t) => t.map(x => ({ value: x, text: x }));

// Lever's location search answers with "City, ST, USA" while the stored answer
// is written out in full. Every token has to reconcile or the field abstains.
test('the stored location resolves against Lever-style results', () => {
  const options = opt(
    'Pittsburgh, PA, USA',
    'Pitt, OH, USA',
    'Pittsburgh, ND, USA',
    'Pitts, AR, USA'
  );
  assert.equal(
    matchOption('Pittsburgh, Pennsylvania, United States', options).text,
    'Pittsburgh, PA, USA'
  );
});

test('a same-named city in another state is not chosen', () => {
  // Only North Dakota is on offer, so the Pennsylvania answer must abstain
  // rather than settle for the city name alone.
  const options = opt('Pittsburgh, ND, USA', 'Pitts, AR, USA');
  assert.equal(matchOption('Pittsburgh, Pennsylvania, United States', options), null);
});

test('country spellings reconcile', () => {
  assert.equal(matchOption('United States', opt('USA', 'Canada')).text, 'USA');
  assert.equal(matchOption('USA', opt('United States of America', 'Mexico')).text,
    'United States of America');
});

test('state abbreviation matching does not cross states', () => {
  const options = opt('Austin, TX, USA', 'Boston, MA, USA');
  assert.equal(matchOption('Boston, Massachusetts, United States', options).text, 'Boston, MA, USA');
  assert.equal(matchOption('Springfield, Illinois, United States', options), null);
});

// The EU tenant serves the same markup, and went unrecognised entirely until
// the host pattern was widened.
test('both Lever tenants are recognised', () => {
  assert.ok(lever.matches('https://jobs.lever.co/palantir/abc/apply'));
  assert.ok(lever.matches('https://jobs.eu.lever.co/cirrus/abc/apply'));
  assert.ok(!lever.matches('https://jobs.ashbyhq.com/kayak/abc/application'));
  assert.ok(!lever.matches('https://notlever.co/x'));
});

// One .application-question block is one question. The pronoun block ends with
// a "Custom" checkbox carrying no name, so grouping by the name attribute made
// it a separate question called "Custom".
test('a question block is the group, not the name attribute', () => {
  const block = { tag: 'li.application-question' };
  const inBlock = { closest: sel => (/application-question/.test(sel) ? block : null) };
  assert.equal(lever.groupContainer(inBlock), block);

  const loose = { closest: () => null };
  assert.equal(lever.groupContainer(loose), null);
  // Buttons and widgets reach this with no closest() at all.
  assert.equal(lever.groupContainer({}), null);
});

test('the location field is driven silently', () => {
  // Announcing the write opens the dropdown, and Lever's blur handler then
  // erases both the input and the hidden field the form submits.
  assert.equal(lever.typeahead.announceInput, false);
  const control = { getAttribute: name => (name === 'name' ? 'location' : null) };
  assert.ok(lever.needsTyping({ control }));
  const other = { getAttribute: name => (name === 'name' ? 'org' : null) };
  assert.ok(!lever.needsTyping({ control: other }));
});
