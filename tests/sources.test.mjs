// tests/sources.test.mjs — discovery-source taxonomy + SRC token round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSource, sourceFromUrl, normalizeUrlKey, readSrcToken, withSrcToken,
  groupOf, CANONICAL_SOURCES,
} from '../lib/sources.mjs';

test('canonical ids pass through unchanged', () => {
  for (const s of CANONICAL_SOURCES) assert.equal(normalizeSource(s), s);
});

test('aliases resolve to canonical ids', () => {
  assert.equal(normalizeSource('greenhouse'), 'greenhouse-api');
  assert.equal(normalizeSource('hnhiring'), 'hn-hiring');
  assert.equal(normalizeSource('Hiring-Cafe'), 'hiringcafe');
  assert.equal(normalizeSource('gmail'), 'gmail-sweep');
});

test('repo slugs resolve to the right feed', () => {
  assert.equal(normalizeSource('jobright-ai/Data-Analysis-New-Grad'), 'jobright-newgrad-data-analysis');
  assert.equal(normalizeSource('jobright-newgrad-engineering'), 'jobright-newgrad-engineering');
  assert.equal(normalizeSource('jobright-h1b'), 'jobright-h1b');
  assert.equal(normalizeSource('SpeedyApply/AI-NewGrad'), 'speedyapply-ai-newgrad');
  // scan-spa.mjs emits playwright-{provider} per portals.yml entry.
  assert.equal(normalizeSource('playwright-workable'), 'playwright-spa');
  assert.equal(normalizeSource('playwright-generic'), 'playwright-spa');
  assert.equal(normalizeSource('SimplifyJobs/New-Grad-Positions'), 'simplifyjobs-newgrad');
});

test('"aggregator" is a non-answer so callers fall through', () => {
  // It names the engine, not the feed. Returning a value here short-circuits
  // the resolution chain and mislabels rows as unknown.
  assert.equal(normalizeSource('aggregator'), null);
  assert.equal(normalizeSource('aggregator-unknown'), null);
});

test('jobspy board names keep their board identity', () => {
  // jobspy-ingest.py passes row["site"], so the raw value is the board itself.
  assert.equal(normalizeSource('linkedin'), 'jobspy-linkedin');
  assert.equal(normalizeSource('indeed'), 'jobspy-indeed');
  assert.equal(normalizeSource('zip_recruiter'), 'jobspy-ziprecruiter');
  assert.equal(groupOf('jobspy-linkedin'), 'board');
});

test('dates and empties are not sources', () => {
  assert.equal(normalizeSource('2026-07-22'), null);
  assert.equal(normalizeSource(''), null);
  assert.equal(normalizeSource(null), null);
  assert.equal(normalizeSource('Baseten'), null);          // company name, not a source
  assert.equal(normalizeSource('deep learning engineer'), null); // search phrase
});

test('host mapping identifies the ATS', () => {
  assert.equal(sourceFromUrl('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse-api');
  assert.equal(sourceFromUrl('https://jobs.ashbyhq.com/acme/abc'), 'ashby-api');
  assert.equal(sourceFromUrl('https://jobs.lever.co/acme/xyz'), 'lever-api');
  assert.equal(sourceFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/x/job/y_R1'), 'workday-api');
  assert.equal(sourceFromUrl('https://simplify.jobs/c/Humana'), 'simplifyjobs-newgrad');
  assert.equal(sourceFromUrl('not a url'), null);
});

test('requisition params identify an embedded board', () => {
  assert.equal(sourceFromUrl('https://www.precisely.com/careers/job/47106?gh_jid=47106'), 'greenhouse-api');
  assert.equal(sourceFromUrl('https://acme.com/careers'), null);
});

test('url keys join across query-param noise', () => {
  const a = normalizeUrlKey('https://boards.greenhouse.io/acme/jobs/7?utm_source=x&gh_jid=7');
  const b = normalizeUrlKey('http://www.boards.greenhouse.io/acme/jobs/7?gh_jid=7&ref=y');
  assert.equal(a, b);
});

test('workday urls collapse to tenant + requisition', () => {
  const a = normalizeUrlKey('https://poet.wd1.myworkdayjobs.com/en-US/poet/job/Sioux-Falls/Developer-I_R101525');
  const b = normalizeUrlKey('https://poet.wd1.myworkdayjobs.com/en-US/other/job/Austin/Developer-I_R101525');
  assert.equal(a, b);
});

test('SRC token round trips and stays single', () => {
  const notes = 'Submit SDE resume. TRUE-AGE: 4d.';
  const once = withSrcToken(notes, 'ashby-api');
  assert.equal(readSrcToken(once), 'ashby-api');
  // Re-stamping must replace, never duplicate.
  const twice = withSrcToken(once, 'lever-api');
  assert.equal(readSrcToken(twice), 'lever-api');
  assert.equal(twice.match(/SRC:/g).length, 1);
});

test('SRC token appends cleanly to unpunctuated and empty notes', () => {
  assert.equal(withSrcToken('no trailing period', 'manual'), 'no trailing period. SRC: manual.');
  assert.equal(withSrcToken('', 'manual'), 'SRC: manual.');
  assert.equal(withSrcToken(null, 'unknown'), 'SRC: unknown.');
});

test('every canonical source has a group', () => {
  for (const s of CANONICAL_SOURCES) {
    assert.ok(['direct-ats', 'aggregator', 'external', 'board', 'manual'].includes(groupOf(s)), s);
  }
});
