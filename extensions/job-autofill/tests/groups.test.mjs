import test from 'node:test';
import assert from 'node:assert/strict';

import { educationPath } from '../content/adapters/greenhouse.js';
import { readPath } from '../content/matcher.js';

// Repeated blocks reuse one label ("Start date year") per entry. Routing them
// by index is what stops a bachelor's dates landing on a master's entry.

test('education controls route to their own index', () => {
  assert.equal(educationPath('school--0'), 'education[0].school');
  assert.equal(educationPath('start-year--0'), 'education[0].startYear');
  assert.equal(educationPath('end-year--1'), 'education[1].endYear');
  assert.equal(educationPath('discipline--1'), 'education[1].fieldOption');
});

test('non-education controls are left alone', () => {
  assert.equal(educationPath('first_name'), null);
  assert.equal(educationPath('email'), null);
  assert.equal(educationPath(''), null);
  assert.equal(educationPath('school'), null);
});

test('the second block never resolves to the first entry', () => {
  const profile = {
    education: [
      { school: 'Carnegie Mellon University', startYear: '2025', endYear: '2026' },
      { school: 'Vellore Institute of Technology', startYear: '2019', endYear: '2023' },
    ],
  };
  // The exact regression from the screenshot: CMU shown as 2019 to 2023.
  assert.equal(readPath(profile, educationPath('start-year--0')), '2025');
  assert.equal(readPath(profile, educationPath('end-year--0')), '2026');
  assert.equal(readPath(profile, educationPath('start-year--1')), '2019');
  assert.equal(readPath(profile, educationPath('end-year--1')), '2023');
});

test('an absent third block yields nothing rather than the first', () => {
  const profile = { education: [{ school: 'CMU', startYear: '2025' }] };
  assert.equal(readPath(profile, educationPath('start-year--2')), undefined);
});
