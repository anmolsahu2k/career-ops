import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldDescriptors, navigationState, riskCategory, mapFutureOpportunityChoice } from '../content/application-descriptors.js';

test('application descriptor risk keeps legal fields deterministic and blocks risky prompts', () => {
  assert.equal(riskCategory('Are you authorized to work in the United States?'), 'DETERMINISTIC_ONLY');
  assert.equal(riskCategory('I identify as:', ['Cisgender', 'Transgender']), 'DETERMINISTIC_ONLY');
  assert.equal(riskCategory('I identify as:'), 'DETERMINISTIC_ONLY');
  assert.equal(riskCategory('What are your salary expectations?'), 'SALARY');
  assert.equal(riskCategory('What is your current compensation?'), 'CURRENT_COMPENSATION');
  assert.equal(riskCategory('What is your current annual bonus?'), 'CURRENT_COMPENSATION');
  assert.equal(riskCategory('What is your total compensation expectation?'), 'SALARY');
  assert.equal(riskCategory('What annual equity grant do you expect?'), 'SALARY');
  assert.equal(riskCategory('Security code'), 'EPHEMERAL');
  assert.equal(riskCategory('A verification code was sent. Enter the 8-character code to confirm you are a human.'), 'EPHEMERAL');
  assert.equal(riskCategory('Cover letter'), 'CUSTOM_PROSE');
  assert.equal(riskCategory('I certify that the information I provided is accurate'), 'LOW');
  assert.equal(riskCategory('I agree to the terms and privacy policy'), 'LOW');
  assert.equal(riskCategory('Keep me informed about future job opportunities'), 'OPTIONAL_CONSENT');
  assert.equal(riskCategory('Did you use generative AI to complete this application?'), 'LOW');
  assert.equal(riskCategory('Describe a project you are proud of'), 'CUSTOM_PROSE');
  assert.equal(riskCategory('First name'), 'LOW');
  assert.equal(riskCategory('Active Security Clearance(s)'), 'LOW');
  assert.equal(riskCategory('Active Security Clearance(s)?'), 'LOW');
});

test('future-opportunity prompts map onto a single No option', () => {
  assert.equal(mapFutureOpportunityChoice('Would you like to be considered for future opportunities at Twitch when you apply?', [
    { text: 'Yes' }, { text: 'No' },
  ]), 'No');
  assert.equal(mapFutureOpportunityChoice('Keep me informed about future job opportunities', []), 'No');
  assert.equal(mapFutureOpportunityChoice('First name', [{ text: 'No' }]), null);
  assert.equal(mapFutureOpportunityChoice('Contact me about future opportunities', [
    { text: 'Yes, keep me informed' },
  ]), null);
});

function page({ text = '', frames = [], controls = [], headings = [], password = false, file = false, inputs = [] } = {}) {
  return {
    body: { innerText: text }, documentElement: { innerText: text },
    querySelectorAll(selector) {
      if (selector.startsWith('iframe')) return frames;
      if (selector.startsWith('button')) return controls;
      if (selector.startsWith('h1')) return headings;
      if (selector.startsWith('input')) return inputs;
      return [];
    },
    querySelector(selector) {
      if (selector.includes('password') && password) return {};
      if (selector.includes('type="file"') && file) return {};
      return null;
    },
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
  };
}

test('CAPTCHA detection ignores provider badges but blocks interactive challenges', () => {
  const badge = { src: 'https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible', getBoundingClientRect: () => ({ width: 256, height: 60 }) };
  const challenge = { getBoundingClientRect: () => ({ width: 304, height: 78 }) };
  assert.equal(navigationState(page({ text: 'Privacy - Terms', frames: [badge] })).captcha, false);
  assert.equal(navigationState(page({ text: 'Please verify you are human' })).captcha, true);
  assert.equal(navigationState(page({ frames: [challenge] })).captcha, true);
});

test('account creation detection requires a real sign-up surface, not job-description prose', () => {
  assert.equal(navigationState(page({ text: 'More than 50 million registered users collaborate and co-create.' })).accountCreation, false);
  assert.equal(navigationState(page({ controls: [{ textContent: 'Create an account', value: '' }] })).accountCreation, true);
  assert.equal(navigationState(page({ text: 'Register to continue', password: true })).accountCreation, true);
});

test('security-code prompts are treated as MFA, not a submission confirmation', () => {
  const state = navigationState(page({ text: 'We sent a security code to your email. Enter the code to continue.' }));
  assert.equal(state.mfa, true);
  assert.equal(state.success, false);
});

test('an application form that includes a security code is not a dedicated MFA surface', () => {
  const state = navigationState(page({
    text: 'A verification code was sent. Enter the 8-character code. Security code. First name.',
    file: true,
    inputs: [{ type: 'text' }, { type: 'email' }, { type: 'file' }],
  }));
  assert.equal(state.mfa, false);
});

test('submission rejection is distinguished from a successful confirmation', () => {
  const rejected = navigationState(page({ text: "We couldn't submit your application. Your application submission was flagged as possible spam." }));
  assert.equal(rejected.submissionRejected, true);
  assert.equal(rejected.success, false);
  assert.equal(navigationState(page({ text: 'Thank you for applying. Your application has been received.' })).submissionRejected, false);
});

test('a generic Greenhouse Attach label carries the locally resolved resume slot role', () => {
  // Legacy path: even if the question text is still the picker verb "Attach",
  // the input id must keep file_role=resume so the runner never treats a
  // successful resume upload as missing.
  const control = {
    id: 'resume', name: '', value: '', required: true,
    getAttribute: name => ({ 'aria-label': null, 'data-automation-id': null, minlength: null, maxlength: null, pattern: null, accept: '.pdf' }[name] ?? null),
    parentElement: { textContent: 'Attach', parentElement: null },
  };
  const [descriptor] = fieldDescriptors([{ control, kind: 'file', rawLabel: 'Attach', required: true, options: [] }]);
  assert.equal(descriptor.question, 'Attach');
  assert.equal(descriptor.file_role, 'resume');
  assert.equal(descriptor.constraints.accepts, '.pdf');
});

test('a resolved Resume/CV label keeps the resume file role', () => {
  const control = {
    id: 'resume', name: '', value: '', required: true,
    getAttribute: name => ({ 'aria-label': null, 'data-automation-id': null, minlength: null, maxlength: null, pattern: null, accept: '.pdf' }[name] ?? null),
    parentElement: { textContent: 'Resume/CV*', parentElement: null },
  };
  const [descriptor] = fieldDescriptors([{ control, kind: 'file', rawLabel: 'Resume/CV*', required: true, options: [] }]);
  assert.equal(descriptor.question, 'Resume/CV*');
  assert.equal(descriptor.file_role, 'resume');
});

test('a Cover Letter Attach leftover is never classified as the resume slot', () => {
  const control = {
    id: 'cover_letter', name: '', value: '', required: false,
    getAttribute: name => ({ 'aria-label': null, 'data-automation-id': null, minlength: null, maxlength: null, pattern: null, accept: '.pdf' }[name] ?? null),
    parentElement: { textContent: 'Cover Letter Attach', parentElement: null },
  };
  const [descriptor] = fieldDescriptors([{ control, kind: 'file', rawLabel: 'Cover Letter', required: false, options: [] }]);
  assert.equal(descriptor.question, 'Cover Letter');
  assert.equal(descriptor.file_role, 'other');
});

test('a select-one combobox is never treated as a free-prose prompt', () => {
  const control = {
    value: '', required: true,
    getAttribute: () => null,
    closest: () => null,
    parentElement: null,
  };
  const [descriptor] = fieldDescriptors([{
    control,
    kind: 'combobox-input',
    rawLabel: 'How would you describe your experience with Twitch? (Select one)',
    required: true,
    options: [],
  }]);
  assert.equal(descriptor.risk, 'LOW');
});

test('custom prose readback retains a complete cover letter', () => {
  const value = 'I build product systems. '.repeat(45).trim();
  const control = {
    tagName: 'TEXTAREA', value, required: false,
    getAttribute: name => name === 'id' ? 'cover_letter_text' : null,
    closest: () => null, parentElement: null,
  };
  const [descriptor] = fieldDescriptors([{
    control, kind: 'textarea', rawLabel: 'Cover Letter', required: false, options: [],
  }]);
  assert.equal(descriptor.risk, 'CUSTOM_PROSE');
  assert.equal(descriptor.current_value, value);
  assert.ok(descriptor.current_value.length > 500);
});
