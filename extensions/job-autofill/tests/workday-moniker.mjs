#!/usr/bin/env node

/**
 * workday-moniker.mjs — drives the real fillCombobox against a fixture that
 * reproduces Workday's moniker search box.
 *
 * The unit tests in workday.test.mjs prove Enter is dispatched. They cannot
 * prove it makes the widget produce options, because there is no DOM behind
 * them. This runs the actual filler in a real page and asserts the option was
 * committed.
 *
 * Usage:  node extensions/job-autofill/tests/workday-moniker.mjs [--headed]
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
const PORT = 8124;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

// The filler is an ES module importing nothing, so the page can load it
// straight from disk over this server.
const server = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = rel === '/' ? '/fixtures/workday-moniker.html' : rel;
  try {
    const body = readFileSync(join(EXT, file));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failures++;
};

await new Promise(r => server.listen(PORT, r));
const browser = await chromium.launch({ headless: !HEADED });

try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`);

  // Baseline: confirm the fixture really is the trap it claims to be, so a
  // passing result below cannot come from a fixture that searches on input.
  await page.fill('#skills--skills', 'Python');
  await page.waitForTimeout(300);
  const afterTyping = await page.textContent('#menu');
  check('typing alone renders no options', !afterTyping.includes('Programming'));

  await page.click('[data-automation-id="promptSearchButton"]');
  await page.waitForTimeout(300);
  const afterButton = await page.textContent('#menu');
  check('the magnifier searches an empty term', afterButton.includes('No Items.'));

  // Now the real thing.
  const committed = await page.evaluate(async () => {
    const { fillCombobox } = await import('/content/filler.js');
    const el = document.getElementById('skills--skills');
    el.value = '';
    const result = await fillCombobox(
      { control: el },
      'Python (Programming Language)',
      options => options.find(o => o.text === 'Python (Programming Language)') || null
    );
    return { result, selected: window.__selected.slice() };
  });

  check('fillCombobox reports filled', committed.result === 'filled');
  check(
    'the option was committed',
    committed.selected.includes('Python (Programming Language)')
  );

  // ---- upload + split date -------------------------------------------
  const page2 = await browser.newPage();
  await page2.goto(`http://localhost:${PORT}/fixtures/workday-upload-date.html`);

  const upload = await page2.evaluate(async () => {
    const { fillFileInput } = await import('/content/filler.js');
    const el = document.getElementById('resume-upload');
    // "%PDF-1.4" as base64, enough to prove the bytes survive the round trip.
    const ok = fillFileInput({ control: el }, {
      name: 'Anmol_Sahu_Resume.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQ=',
    });
    return { ok, state: document.getElementById('uploadState').textContent };
  });
  check('fillFileInput attaches the resume', upload.ok === true);
  check('the page sees a real file', upload.state.includes('Anmol_Sahu_Resume.pdf'));

  const dates = await page2.evaluate(async () => {
    const { detectFields } = await import('/content/engine.js');
    const { fillDateParts } = await import('/content/filler.js');
    const fields = detectFields(document, null).filter(f => f.kind === 'date-parts');
    const start = fields.find(f => /desired start date/i.test(f.rawLabel));
    const filled = start ? fillDateParts(start, '12/20/2026') : false;
    return {
      count: fields.length,
      labels: fields.map(f => f.rawLabel),
      filled,
      month: document.getElementById('primaryQuestionnaire--q1-dateSectionMonth-input').value,
      day: document.getElementById('primaryQuestionnaire--q1-dateSectionDay-input').value,
      year: document.getElementById('primaryQuestionnaire--q1-dateSectionYear-input').value,
      // The signature date must be untouched: two dates on one step are two fields.
      sigMonth: document.getElementById('selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input').value,
    };
  });
  check('both dates detected as one field each', dates.count === 2);
  check('the question is the label, not "Month"', dates.labels.some(l => /desired start date/i.test(l)));
  check('no part is a field of its own', !dates.labels.includes('Month'));
  check('fillDateParts reports filled', dates.filled === true);
  check('date written across all three boxes',
    dates.month === '12' && dates.day === '20' && dates.year === '2026');
  check('the other date on the step is untouched', dates.sigMonth === '');
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
