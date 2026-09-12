// tests/liveness-classify.test.mjs — what counts as evidence a posting is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness } from '../liveness-core.mjs';

// The 2026-08-12 regression. Meta req 4425382174 was CLOSED ("No longer
// accepting applications" in the logged-in view) and still classified `active`,
// so it reached the tracker as row 3422 at 4.2/5. LinkedIn serves a logged-out
// scraper an auth wall whose buttons include "Continue with google", which
// matched the generic /\bcontinue\b/ apply pattern. Every LinkedIn URL renders
// that wall, so the gate had no discriminating power on the whole source.
test('a LinkedIn auth wall is not evidence that a posting is open', () => {
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.linkedin.com/jobs/view/4425382174',
    bodyText: 'Data Engineer, Product Analytics (University Grad)\n'.repeat(30),
    applyControls: ['Dismiss', 'Continue with google', 'Sign in with Email', 'Join now', 'User Agreement'],
  });
  assert.notEqual(r.result, 'active', `auth wall must not read as active: ${JSON.stringify(r)}`);
  assert.equal(r.result, 'uncertain');
});

test('a real apply control still reads as active on any host', () => {
  for (const ctrl of ['Apply now', 'Easy Apply', 'Submit application', 'I’m interested']) {
    const r = classifyLiveness({
      status: 200,
      finalUrl: 'https://www.linkedin.com/jobs/view/1',
      bodyText: 'x'.repeat(600),
      applyControls: [ctrl],
    });
    assert.equal(r.result, 'active', `${ctrl} should read as active`);
  }
});

// The weak CTAs exist for Workday/iCIMS, which hide the apply button behind a
// sign-in step. They must keep working there, and only there.
test('generic CTAs still vote on ATS hosts but not on general hosts', () => {
  const ats = classifyLiveness({
    status: 200,
    finalUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/X',
    bodyText: 'x'.repeat(600),
    applyControls: ['Autofill with Resume', 'Get Started'],
  });
  assert.equal(ats.result, 'active');

  const generic = classifyLiveness({
    status: 200,
    finalUrl: 'https://example.test/careers/1',
    bodyText: 'x'.repeat(600),
    applyControls: ['Get Started', 'Create account'],
  });
  assert.equal(generic.result, 'uncertain', 'generic CTAs alone must not prove a posting is open');
});

test('"Continue with Google" is authentication even on an ATS host', () => {
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/X',
    bodyText: 'x'.repeat(600),
    applyControls: ['Continue with Google', 'Sign in with Email'],
  });
  assert.equal(r.result, 'uncertain');
});

test('an explicit closed banner still wins over any control', () => {
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.linkedin.com/jobs/view/1',
    bodyText: 'No longer accepting applications',
    applyControls: ['Apply now'],
  });
  assert.equal(r.result, 'expired');
});
