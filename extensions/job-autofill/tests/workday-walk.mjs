#!/usr/bin/env node

/**
 * workday-walk.mjs — walk every step of a Workday apply flow and report what
 * the extension sees on each one.
 *
 * live.mjs tests a single page. Workday's application is seven steps behind a
 * mandatory account gate, and the README's own note that the questionnaire
 * steps are "unverified, since reaching the widget needs a live login" is the
 * gap this closes: the steps that were never seen are exactly the ones after
 * the one live.mjs can reach.
 *
 * Usage:
 *   node extensions/job-autofill/tests/workday-walk.mjs <apply-url> [--headed]
 *
 * SAFETY: this clicks "Save and Continue" to advance, which is what walking a
 * multi-step form means. It stops dead at the Review step and NEVER clicks
 * Submit, so no application is ever sent. Do not add such a click to this file.
 * It uses the persistent profile from live.mjs --wait-for-form, so sign in
 * there first.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(EXT, 'data', 'answers.json');
const URL_ARG = process.argv[2];
const HEADED = process.argv.includes('--headed');
const PROFILE = join(homedir(), '.cache', 'job-autofill-chrome');
const GATE_WAIT_MIN = 20;
/**
 * Workday's candidate session is a session cookie, so a persistent profile does
 * not survive the browser closing and every run would demand a fresh sign-in.
 * Playwright's storageState does capture session cookies, so one sign-in is
 * saved here and replayed. It holds a live session, so it lives in the user
 * cache, never in the repo.
 */
const STATE = join(homedir(), '.cache', 'job-autofill-workday-state.json');
const SHOTS = process.argv.includes('--shots')
  ? resolve(process.argv[process.argv.indexOf('--shots') + 1])
  : null;

if (!URL_ARG || URL_ARG.startsWith('--')) {
  console.error('\n  usage: node extensions/job-autofill/tests/workday-walk.mjs <apply-url> [--headed]\n');
  process.exit(1);
}
if (!existsSync(SEED)) {
  console.error('\n  Missing data/answers.json. Run `npm run autofill:seed` first.\n');
  process.exit(1);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CONTROLS = 'input:not([type=hidden]):not([type=submit]):not([type=file]), select, textarea';
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !HEADED,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 1400 },
});

function sendToPage(driver, message) {
  return driver.evaluate(async msg => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url?.startsWith('http')) || tabs[tabs.length - 1];
    if (!tab) return { ok: false, error: 'no page tab found' };
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return { ok: false, error: `no content script responded: ${e.message}` };
    }
  }, message);
}

/** Wait until the control count stops changing: Workday mounts a step in stages. */
async function settle(page, { min = 1, tries = 20 } = {}) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(1500);
    const n = await page.evaluate(sel => document.querySelectorAll(sel).length, CONTROLS)
      .catch(() => 0);
    if (n >= min && n === last) return n;
    last = n;
  }
  return last;
}

try {
  for (const p of ctx.pages()) await p.close();

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  const optionsPage = await ctx.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options/options.html`);
  const seeded = await optionsPage.evaluate(async json => {
    const { importData, loadAll } = await import('../content/store.js');
    await importData(json, { replaceAll: true });
    return Object.keys((await loadAll()).answers).length;
  }, JSON.parse(readFileSync(SEED, 'utf-8')));
  console.log(`\n  seeded ${seeded} answers`);

  if (existsSync(STATE)) {
    const saved = JSON.parse(readFileSync(STATE, 'utf-8'));
    await ctx.addCookies(saved.cookies || []).catch(() => {});
    console.log(`  restored a saved session (${(saved.cookies || []).length} cookies)`);
  }

  const page = await ctx.newPage();
  console.log(`  opening ${URL_ARG}\n`);
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  let lastStepTitle = '';
  for (let step = 1; step <= 10; step++) {
    const controls = await settle(page, { min: 1 });

    const where = await page.evaluate(() => {
      const active = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      const heading = document.querySelector('h2, [data-automation-id="jobTitleHeading"]');
      return {
        step: (active?.textContent || '').replace(/\s+/g, ' ').trim(),
        heading: (heading?.textContent || '').replace(/\s+/g, ' ').trim(),
        // Workday serves TWO gate variants at the same /apply URL: Create
        // Account (verifyPassword + the consent checkbox) and Sign In, which
        // has neither. Matching only the first let a Sign In screen read as
        // "already past the gate", so the walk quit instead of waiting. A
        // visible password box is the signal that covers both, and it is the
        // same one engine.isCredentialScreen() uses.
        gate: Boolean(document.querySelector(
          '[data-automation-id="verifyPassword"], [data-automation-id="createAccountCheckbox"]'
        )) || [...document.querySelectorAll('input[type="password"]')]
          .some(el => el.offsetParent !== null),
        url: location.href,
      };
    });

    console.log('  ' + '='.repeat(70));
    console.log(`  STEP ${step}: ${where.step || where.heading || '(unknown)'}   [${controls} controls]`);
    console.log('  ' + '='.repeat(70));

    if (where.gate) {
      // Workday's candidate session lives in a session cookie, which dies with
      // the browser, so a persistent profile does NOT keep you signed in. The
      // walk therefore has to be able to pause for a human exactly once.
      if (!HEADED) {
        console.log('  account gate — re-run with --headed and sign in when the window opens.\n');
        break;
      }
      console.log('\n  ' + '-'.repeat(66));
      console.log('  Sign in in the browser window. Do NOT submit anything.');
      console.log(`  The walk continues by itself once the gate clears (up to ${GATE_WAIT_MIN} min).`);
      console.log('  ' + '-'.repeat(66) + '\n');
      const deadline = Date.now() + GATE_WAIT_MIN * 60_000;
      let cleared = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const stillGated = await page.evaluate(() => Boolean(document.querySelector(
          '[data-automation-id="verifyPassword"], [data-automation-id="createAccountCheckbox"]'
        )) || [...document.querySelectorAll('input[type="password"]')]
          .some(el => el.offsetParent !== null)).catch(() => true);
        if (!stillGated) { cleared = true; break; }
      }
      if (!cleared) {
        console.log('  timed out waiting for sign-in.\n');
        break;
      }
      writeFileSync(STATE, JSON.stringify(await ctx.storageState(), null, 2));
      console.log(`  signed in. session saved to ${STATE}\n`);
      step--; // The gate was not one of the seven steps.
      continue;
    }

    const detected = await sendToPage(optionsPage, { type: 'detect', verbose: true });
    if (!detected?.ok) {
      console.log(`  detect failed: ${JSON.stringify(detected)}\n`);
    } else {
      console.log(`  board=${detected.board} fields=${detected.fieldCount} skipped=${detected.skipped}\n`);
      console.log(`  ${pad('LABEL', 46)} ${pad('KIND', 13)} ${pad('RESOLVED FROM', 24)} VALUE`);
      console.log(`  ${'-'.repeat(46)} ${'-'.repeat(13)} ${'-'.repeat(24)} -----`);
      for (const f of detected.fields || []) {
        console.log(`  ${pad(f.rawLabel, 46)} ${pad(f.kind, 13)} ${pad(f.resolvedFrom || '-- NO ANSWER --', 24)} ${String(f.value || '').slice(0, 30)}`);
      }
      const unresolved = (detected.fields || []).filter(f => !f.resolvedFrom);
      if (unresolved.length) {
        console.log('\n  DOM detail for unresolved fields:');
        for (const f of unresolved) {
          const d = f.debug || {};
          console.log(`    "${f.rawLabel}"  key="${f.normKey}"  labelSource=${f.labelSource || '-'}`);
          console.log(`      ${d.tag}${d.type ? '[' + d.type + ']' : ''} role=${d.role || '-'} haspopup=${d.hasPopup || '-'} aid=${d.automationId || '-'} parentAid=${d.parentAutomationId || '-'}`);
          console.log(`      aria-label=${JSON.stringify(d.ariaLabel)} labelledBy=${JSON.stringify(d.labelledByTexts)}`);
        }
      }
    }

    const report = await sendToPage(optionsPage, { type: 'fill' });
    console.log(`\n  FILL: ${report.filled} filled / ${report.unknown} needs-you / ${report.failed} failed  (skipped=${report.skipped === true})`);
    if (report.unknowns?.length) {
      console.log('  needs you: ' + report.unknowns.map(u => u.rawLabel).join(' | '));
    }
    if (report.reverted?.length) {
      console.log('  did NOT stick: ' + report.reverted.map(r => r.rawLabel).join(' | '));
    }
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, `step-${step}.png`), fullPage: true }).catch(() => {});
      // The markup matters more than the picture: a step reachable only behind
      // a login has to become an offline fixture or every fix costs a sign-in.
      const html = await page.evaluate(() => document.body.innerHTML).catch(() => '');
      if (html) writeFileSync(join(SHOTS, `step-${step}.html`), html);
    }

    // Advance. Workday labels the forward control "Save and Continue" on every
    // step and "Submit" only on Review, so matching the text is what keeps this
    // harness from sending an application.
    const nav = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a[role="button"]')];
      return buttons
        .filter(b => b.offsetParent !== null)
        .map(b => (b.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    });
    const hasSubmit = nav.some(t => /^submit\b/i.test(t));
    if (hasSubmit) {
      console.log(`\n  Review step reached (a Submit control is present). STOPPING.`);
      console.log(`  Nothing was submitted.\n`);
      break;
    }

    const nextText = nav.find(t => /save and continue|^continue$|^next$/i.test(t));
    if (!nextText) {
      console.log(`\n  no forward control found. Buttons: ${nav.slice(0, 12).join(' | ')}\n`);
      break;
    }

    if (where.step && where.step === lastStepTitle) {
      console.log(`\n  step did not advance (required fields still empty). STOPPING.\n`);
      break;
    }
    lastStepTitle = where.step;

    console.log(`\n  -> clicking "${nextText}"\n`);
    const before = page.url();
    await page.getByRole('button', { name: nextText, exact: false }).first()
      .click({ timeout: 10000 })
      .catch(async e => {
        console.log(`  click failed: ${e.message.split('\n')[0].slice(0, 90)}`);
      });
    await page.waitForTimeout(5000);
    if (page.url() === before) {
      const errors = await page.evaluate(() => [...document.querySelectorAll(
        '[data-automation-id="errorMessage"], [role="alert"]'
      )].map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6));
      if (errors.length) console.log(`  page reported: ${errors.join(' | ')}`);
    }
  }
} finally {
  await ctx.close();
}
