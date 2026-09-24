import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/stage-ats-otp.py');

function extract(sample) {
  const result = spawnSync('python', [script, '--extract-from-stdin'], {
    input: sample,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('Greenhouse HTML-split 8-character codes compact to one token', () => {
  const html = [
    'Copy and paste this code into the application form:',
    '<span>A</span> <span>b</span> <span>3</span> <span>D</span>',
    '<span>e</span> <span>F</span> <span>9</span> <span>G</span>',
  ].join(' ');
  assert.equal(extract(html), 'Ab3DeF9G');
});

test('spaced security-code copy still extracts', () => {
  assert.equal(extract('Your security code is: Q W E R T Y 1 2'), 'QWERTY12');
});

test('digit-only verification codes still extract', () => {
  assert.equal(extract('Your verification code is 847291'), '847291');
});

test('unrelated mail does not yield a code', () => {
  assert.equal(extract('Thanks for applying to Databricks. We received your resume.'), '');
});

test('plain preamble plus HTML-split code still extracts', () => {
  const sample = [
    'We sent a security code to your email.',
    'Copy and paste this code into the application form:',
    '<div><span>A</span><span>b</span><span>3</span><span>D</span><span>e</span><span>F</span><span>9</span><span>G</span></div>',
  ].join('\n');
  assert.equal(extract(sample), 'Ab3DeF9G');
});

test('confirm-you-are-a-human wording still extracts', () => {
  assert.equal(extract('Enter this code to confirm you are a human: Ab3DeF9G'), 'Ab3DeF9G');
});

test('8-character wording keeps an eight-character token', () => {
  assert.equal(extract('Enter the 8-character code: Ab3DeF9G extra1'), 'Ab3DeF9G');
});

test('copy-and-paste plus 8-character wording does not keep trailing letters', () => {
  const sample = [
    'This 8-character code confirms you are a human.',
    'Copy and paste this code into the application form:',
    'A b 3 D e F 9 G X Y Z W',
  ].join(' ');
  assert.equal(extract(sample), 'Ab3DeF9G');
});

test('contiguous Greenhouse code does not swallow the next English word', () => {
  const sample = [
    'Copy and paste this code into the security code field on your application:',
    'Ab3DeF9G After you enter the code, Databricks Job Application.',
  ].join(' ');
  assert.equal(extract(sample), 'Ab3DeF9G');
});

test('OTP reader fails closed when the Testing-app Gmail token is older than 7 days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-otp-auth-'));
  const creds = join(dir, 'personal-credentials.json');
  writeFileSync(creds, JSON.stringify({ authorized_at: '2026-01-01T00:00:00+00:00' }));
  const result = spawnSync('python', [script, '--auth-status'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CAREER_OPS_GMAIL_OTP_CREDS: creds },
  });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.error, 'token_expired');
  assert.equal(status.auth.expired, true);
  assert.match(result.stderr, /7-day Testing-app limit/);
  assert.equal(JSON.stringify(status).includes('refresh_token'), false);
  assert.equal(JSON.stringify(status).includes('access_token'), false);
});

test('OTP reader auth status is fresh inside the 7-day Testing window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-otp-auth-'));
  const creds = join(dir, 'personal-credentials.json');
  writeFileSync(creds, JSON.stringify({ authorized_at: new Date().toISOString() }));
  const result = spawnSync('python', [script, '--auth-status'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CAREER_OPS_GMAIL_OTP_CREDS: creds },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.auth.expired, false);
  assert.ok(status.auth.expires_in_seconds > 6 * 24 * 60 * 60);
});
