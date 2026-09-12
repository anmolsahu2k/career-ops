#!/usr/bin/env node

/**
 * workday-sections.mjs — repeated sections on Workday's "My Experience".
 *
 * Work Experience, Education, Language Skills and Websites each render as
 * nothing but an "Add" button, so a fill pass found ONE field on a page showing
 * six sections. They have to be opened before there is anything to fill.
 *
 * Every Add button carries the same `data-automation-id="add-button"`, so the
 * only thing telling them apart is the heading of the section they sit in, and
 * that mapping is what this pins against the captured markup.
 *
 * The safety property matters more than the feature: opening a section that
 * already has controls would append a second copy of the same job every time
 * the user pressed "Fill this step". An unbounded work history written into a
 * real application is far worse than filling nothing.
 *
 * Usage:  node extensions/job-autofill/tests/workday-sections.mjs [--headed]
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const PORT = 8134;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const server = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = rel === '/' ? '/fixtures/workday-experience.html' : rel;
  try {
    const body = readFileSync(join(EXT, file));
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
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

const PROFILE = { work: [{}, {}], education: [{}, {}] };

const mapped = await page.evaluate(async () => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  return wd.addButtons().map(({ button, section }) => ({ section, empty: wd.sectionIsEmpty(button) }));
});
check('every Add button resolves to its own section heading',
  JSON.stringify(mapped.map(m => m.section)) ===
  JSON.stringify(['Work Experience', 'Education', 'Language Skills', 'Websites']),
  JSON.stringify(mapped.map(m => m.section)));

const planned = await page.evaluate(async profile => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  const clicks = [];
  await wd.default.expandSections(profile, {
    click: btn => clicks.push(wd.sectionHeadingFor(btn)),
    wait: () => Promise.resolve(),
  });
  return clicks;
}, PROFILE);
check('opens one block per profile entry, in the right sections',
  JSON.stringify(planned) === JSON.stringify(
    ['Work Experience', 'Work Experience', 'Education', 'Education']),
  JSON.stringify(planned));
check('leaves sections the profile cannot fill alone',
  !planned.includes('Language Skills') && !planned.includes('Websites'));

const rerun = await page.evaluate(async profile => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  // Stand in for a section that already holds a block.
  const work = wd.addButtons().find(b => /work experience/i.test(b.section));
  let node = work.button.parentElement;
  while (node && !node.querySelector('h1, h2, h3, h4, h5')) node = node.parentElement;
  const input = document.createElement('input');
  input.type = 'text';
  node.appendChild(input);

  const clicks = [];
  await wd.default.expandSections(profile, {
    click: btn => clicks.push(wd.sectionHeadingFor(btn)),
    wait: () => Promise.resolve(),
  });
  return clicks;
}, PROFILE);
check('NEVER re-opens a section that already has controls',
  !rerun.includes('Work Experience'),
  `clicked: ${JSON.stringify(rerun)}`);
check('other sections still open normally',
  rerun.filter(c => c === 'Education').length === 2, JSON.stringify(rerun));

const noProfile = await page.evaluate(async () => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  const clicks = [];
  await wd.default.expandSections({}, { click: () => clicks.push(1), wait: () => Promise.resolve() });
  return clicks.length;
});
check('opens nothing when the profile has no entries', noProfile === 0);

// ── routing ────────────────────────────────────────────────────────
// The counters below are the ones the LIVE Rocket page produced for two work
// blocks and two education blocks opened back to back. They are a running
// counter, not an ordinal: reading them as an index sent every block to entry 0,
// so both work blocks got the same job and a real employment history would have
// been overwritten with one duplicated role.

const routed = await page.evaluate(async () => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  const eng = await import('/content/engine.js?' + Math.random());
  const host = document.createElement('div');
  host.innerHTML = `
    <input id="workExperience-6--jobTitle"><input id="workExperience-6--companyName">
    <input id="workExperience-6--location"><input type="checkbox" id="workExperience-6--currentlyWorkHere">
    <input id="workExperience-15--jobTitle"><input id="workExperience-15--companyName">
    <input id="education-28--school"><button id="education-28--degree"></button>
    <input id="education-37--school"><button id="education-37--degree"></button>`;
  document.body.appendChild(host);
  return [...host.querySelectorAll('[id]')].map(el => ({
    id: el.id, path: wd.blockPath(el), groupIndex: eng.groupIndexOf(el),
  }));
});
const path = id => routed.find(r => r.id === id)?.path;

check('the first work block is entry 0', path('workExperience-6--jobTitle') === 'work[0].title',
  String(path('workExperience-6--jobTitle')));
check('the SECOND work block is entry 1, not entry 0',
  path('workExperience-15--jobTitle') === 'work[1].title',
  String(path('workExperience-15--jobTitle')));
check('a job Location reads the job, not the home address',
  path('workExperience-6--location') === 'work[0].location');
check('the second education block is entry 1',
  path('education-37--school') === 'education[1].school',
  String(path('education-37--school')));
check('degree routes to the dropdown wording',
  path('education-28--degree') === 'education[0].degreeOption');
check('every block control is marked indexed, so the answer bank is refused',
  routed.every(r => r.groupIndex != null),
  JSON.stringify(routed.filter(r => r.groupIndex == null)));
check('a control outside any block is not routed', await page.evaluate(async () => {
  const wd = await import('/content/adapters/workday.js?' + Math.random());
  const el = document.createElement('input');
  el.id = 'skills--skills';
  return wd.blockPath(el) === null;
}));

// ── skills ─────────────────────────────────────────────────────────
// Workday's Skills box is a taxonomy search, one term at a time. The seed ships
// six terms under Workday's own label so the picker has something to offer;
// they are ANSWERS, not a canonical profile path, so a term the user picks by
// hand later replaces them rather than losing to them.

const skills = await page.evaluate(async () => {
  const { findAnswer, normalizeKey, splitMulti } = await import('/content/matcher.js?' + Math.random());
  const bank = await (await fetch('/data/answers.json')).json();
  const hit = findAnswer(normalizeKey('Type to Add Skills'), bank.answers);
  return {
    method: hit?.method ?? null,
    terms: hit ? splitMulti(hit.entry.answer) : [],
    // The Workday control on the captured page.
    controlPresent: !!document.querySelector('#skills--skills'),
  };
});
check('the Workday skills label resolves to a seeded answer', skills.method === 'exact',
  String(skills.method));
check('it yields several terms to pick one at a time', skills.terms.length === 6,
  JSON.stringify(skills.terms));
check('the terms are taxonomy-shaped, not prose',
  skills.terms.every(t => t.split(/\s+/).length <= 2), JSON.stringify(skills.terms));

await browser.close();
server.close();
console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
