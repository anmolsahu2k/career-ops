#!/usr/bin/env node

/**
 * workday-questionnaire.mjs — runs the real label resolution and answer
 * matching against Workday's actual "Application Questions" markup.
 *
 * This exists because that step sits behind a mandatory account gate, and for
 * as long as it was only reachable by signing in, it went untested. It was also
 * where the worst defect this extension has had was living: every dropdown was
 * labelled with the question belonging to the widget above it, which put "Yes"
 * into "Do you have an account with the NMLS?" while the extension believed it
 * was answering "Are you willing to relocate?".
 *
 * The unit tests in workday.test.mjs model that structure by hand. This runs
 * the same code over the captured markup, which is the gap that let the bug in.
 *
 * Usage:  node extensions/job-autofill/tests/workday-questionnaire.mjs [--headed]
 *
 * Not part of test-all.mjs: it launches a browser.
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const PORT = 8125;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = rel === '/' ? '/fixtures/workday-questionnaire.html' : rel;
  try {
    const body = readFileSync(join(EXT, file));
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures++;
};

await new Promise(r => server.listen(PORT, r));
const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`);

// The answers the seeded bank actually holds for these two, and nothing else,
// so a pass cannot come from some unrelated entry.
const BANK = {
  'are you legally authorized to work in the united states': { answer: 'Yes' },
  'will you now or in the future require sponsorship for employment visa status': { answer: 'Yes' },
  'are you willing to relocate': { answer: 'Yes' },
};

const result = await page.evaluate(async bank => {
  const wd = await import('/content/adapters/workday.js');
  const { normalizeKey, findAnswer } = await import('/content/matcher.js');
  const adapter = wd.default;

  const fields = adapter.detectExtraFields(document);
  return {
    labels: fields.map(f => ({
      // The question this widget's own container states, i.e. ground truth.
      truth: (f.control.closest('[data-fkit-id]')?.querySelector('legend b, legend strong')?.textContent || '')
        .replace(/\s+/g, ' ').trim().replace(/\*$/, '').trim(),
      resolved: f.rawLabel,
    })),
    answers: fields.map(f => {
      const hit = findAnswer(normalizeKey(f.rawLabel), bank);
      return { label: f.rawLabel, answer: hit?.entry.answer ?? null, method: hit?.method ?? null };
    }),
  };
}, BANK);

console.log(`\n  ${result.labels.length} dropdowns found in the captured markup\n`);

check('every dropdown found a question', result.labels.every(l => l.resolved), '');

for (const { truth, resolved } of result.labels) {
  check(`labelled with its OWN question: "${truth.slice(0, 58)}"`, truth === resolved,
    `resolved to: "${resolved.slice(0, 90)}"`);
}

const keys = result.labels.map(l => l.resolved);
check('no two questions share a label', new Set(keys).size === keys.length,
  `${keys.length} widgets, ${new Set(keys).size} distinct labels`);

const find = re => result.answers.find(a => re.test(a.label));
const auth = find(/legally authorized/i);
const spon = find(/immigration-related/i);
const nmls = find(/National Mortgage/i);

check('work authorization is answered', auth?.answer === 'Yes', `got ${JSON.stringify(auth)}`);
check('sponsorship is answered', spon?.answer === 'Yes', `got ${JSON.stringify(spon)}`);
// The bank knows nothing about NMLS. Answering it is what the bug did.
check('NMLS is left for the user', nmls != null && nmls.answer === null, `got ${JSON.stringify(nmls)}`);

await browser.close();
server.close();

console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
