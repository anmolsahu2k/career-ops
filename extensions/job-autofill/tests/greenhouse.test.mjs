import test from 'node:test';
import assert from 'node:assert/strict';

import greenhouse, { educationPath } from '../content/adapters/greenhouse.js';

// A taken-down posting redirects to the board's job list, whose only controls
// are its search box and filter dropdowns.
test('the job list is not an application form', () => {
  assert.equal(greenhouse.skipPage('https://job-boards.greenhouse.io/simplisafe?error=true'), true);
  assert.equal(greenhouse.skipPage('https://job-boards.greenhouse.io/stubhubinc'), true);
  assert.equal(greenhouse.skipPage('https://boards.greenhouse.io/cloudflare'), true);
});

test('real postings and embedded forms are still filled', () => {
  const live = [
    'https://job-boards.greenhouse.io/simplisafe/jobs/8049515',
    'https://boards.greenhouse.io/robinhood/jobs/7975529?gh_jid=7975529',
    'https://job-boards.greenhouse.io/celonis/jobs/7725788003',
    // The embed a company careers page puts in an iframe: no /jobs/{id} at all.
    'https://job-boards.greenhouse.io/embed/job_app?for=uareai&jr_id=6a5288909fbdab22fe13bf86',
    'https://boards.greenhouse.io/embed/job_app?token=4036519009',
  ];
  for (const url of live) assert.equal(greenhouse.skipPage(url), false, url);
});

test('does not claim look-alike domains as Greenhouse', () => {
  assert.equal(greenhouse.matches('https://notgreenhouse.io/acme/jobs/1'), false);
  assert.equal(greenhouse.matches('https://notgrnh.se/acme/jobs/1'), false);
  assert.equal(greenhouse.matches('https://job-boards.greenhouse.io/acme/jobs/1'), true);
  assert.equal(greenhouse.matches('https://grnh.se/opaque-short-link'), true);
});

test('education blocks route to their own profile entry', () => {
  assert.equal(educationPath('school--0'), 'education[0].school');
  assert.equal(educationPath('start-year--1'), 'education[1].startYear');
  assert.equal(educationPath('first_name'), null);
});
