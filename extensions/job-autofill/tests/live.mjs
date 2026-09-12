#!/usr/bin/env node

/**
 * live.mjs — run the extension against a real job posting and report what it
 * would fill. This is the per-board smoke check from the README.
 *
 * Usage:
 *   node extensions/job-autofill/tests/live.mjs <application-url> [--headed] [--keep]
 *
 * SAFETY: this fills fields and reads them back. It never clicks a submit,
 * apply, or continue button, so nothing is ever sent to the employer. Do not
 * add a click on a submit control to this file.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(EXT, 'data', 'answers.json');
const URL_ARG = process.argv[2];
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
/**
 * Wait for a human to reach the real form before testing. Workday hides the
 * application behind a sign-in, so the browser opens visibly, you log in and
 * navigate, and the run continues once enough fields appear.
 */
const WAIT_FOR_FORM = process.argv.includes('--wait-for-form');
const WAIT_MINUTES = 20;

/**
 * Browser profile. A throwaway profile means signing in again on every run,
 * and boards behind a login (Workday) make that untenable. --wait-for-form
 * therefore uses a persistent profile outside the repo, so you sign in once
 * and later runs reuse the session. It holds real session cookies, so it lives
 * in the user cache rather than anywhere the backup script would archive it.
 */
const profileFlag = process.argv.indexOf('--profile');
const PERSISTENT_PROFILE = profileFlag !== -1 && process.argv[profileFlag + 1]
  ? resolve(process.argv[profileFlag + 1])
  : join(homedir(), '.cache', 'job-autofill-chrome');

if (!URL_ARG || URL_ARG.startsWith('--')) {
  console.error('\n  usage: node extensions/job-autofill/tests/live.mjs <application-url> [--headed] [--keep]\n');
  process.exit(1);
}
if (!existsSync(SEED)) {
  console.error('\n  Missing data/answers.json. Run `npm run autofill:seed` first.\n');
  process.exit(1);
}

let userDataDir;
if (WAIT_FOR_FORM) {
  userDataDir = PERSISTENT_PROFILE;
  mkdirSync(userDataDir, { recursive: true });
  console.log(`\n  using persistent browser profile: ${userDataDir}`);
  console.log('  (sign in once here and later runs stay signed in)');
} else {
  userDataDir = mkdtempSync(join(tmpdir(), 'job-autofill-live-'));
}
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: !HEADED && !WAIT_FOR_FORM,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 1400 },
});

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

/**
 * Message the page tab.
 * tab.url is only visible for hosts the extension has permission for, so a
 * company careers page that merely embeds a board reads back as undefined.
 * Pick anything that is not our own options page instead.
 */
function sendToPage(driver, message) {
  return driver.evaluate(async msg => {
    const tabs = await chrome.tabs.query({});
    // Without the "tabs" permission, tab.url is only populated for hosts the
    // extension has permission for, so the options page and a careers page we
    // hold no permission for can both read back as undefined. Prefer a visible
    // http tab; otherwise fall back to the most recently opened one, which is
    // the page under test.
    const tab = tabs.find(t => t.url?.startsWith('http')) || tabs[tabs.length - 1];
    if (!tab) return { ok: false, error: 'no page tab found' };
    try {
      const res = await chrome.tabs.sendMessage(tab.id, msg);
      return { ...res, _tab: tab.url || '(url hidden)' };
    } catch (e) {
      return { ok: false, error: `no content script responded: ${e.message}`, _tab: tab.url || '(url hidden)' };
    }
  }, message);
}

const CONTROLS = 'input:not([type=hidden]):not([type=submit]):not([type=file]), select, textarea';

/**
 * Dismiss the cookie consent overlay. A real applicant clicks it away, and
 * while it is up it swallows pointer events, so leaving it makes every click
 * in this harness time out and the run unrepresentative.
 */
async function dismissCookieBanner(page) {
  const targets = [
    '[data-automation-id="legalNoticeAcceptButton"]',
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept All")',
  ];
  for (const sel of targets) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    console.log('  dismissed a cookie banner');
    return;
  }
}
let TIMED_OUT = false;
let DETECTED_FIELDS = [];

try {
  // The launcher leaves an about:blank tab behind, which the tab lookup below
  // would otherwise match before the real page.
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

  const page = await ctx.newPage();
  console.log(`  opening ${URL_ARG}`);
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await dismissCookieBanner(page);

  if (WAIT_FOR_FORM) {
    console.log('\n  ' + '='.repeat(66));
    console.log('  A browser window is open. Sign in and navigate to the application');
    console.log('  form. Do NOT submit anything. This will continue automatically once');
    console.log('  it sees a real form, then fill it and report.');
    console.log(`  Waiting up to ${WAIT_MINUTES} minutes.`);
    console.log('  ' + '='.repeat(66) + '\n');

    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let seen = 0;
    let settledAt = -1;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      let best = 0;
      let where = '';
      for (const frame of page.frames()) {
        try {
          const n = await frame.evaluate(sel => document.querySelectorAll(sel).length, CONTROLS);
          if (n > best) { best = n; where = frame.url(); }
        } catch { /* frame navigating */ }
      }
      // Credential screens have a handful of inputs; a real Workday step has many.
      const onGate = await page.evaluate(() => Boolean(document.querySelector(
        '[data-automation-id="verifyPassword"], [data-automation-id="createAccountCheckbox"]'
      ))).catch(() => false);
      if (best !== seen) {
        seen = best;
        console.log(`  ...${best} controls visible${onGate ? ' (account gate, keep going)' : ''}  ${where.slice(0, 70)}`);
      }
      // Wait for the count to settle. Workday mounts a step in stages, and
      // breaking on the first sighting of 6 controls reported a "My
      // Information" step as 7 address fields, hiding name, phone and every
      // dropdown behind them. Two identical polls means the step is done.
      if (best >= 6 && !onGate) {
        if (best === settledAt) {
          console.log(`\n  form detected (${best} controls, settled). Continuing.\n`);
          break;
        }
        settledAt = best;
      }
    }
    if (Date.now() >= deadline) {
      console.log('\n  timed out waiting for a form.');
      console.log('  The browser stays open and the profile is saved, so if you are');
      console.log('  part-way through signing in, finish, then re-run this command.\n');
      TIMED_OUT = true;
    }
  }

  // The application form is often in an embedded iframe (Greenhouse embeds,
  // SuccessFactors). Report where the real form lives.
  const frames = [];
  for (const frame of page.frames()) {
    let count = 0;
    try {
      count = await frame.evaluate(sel => document.querySelectorAll(sel).length, CONTROLS);
    } catch { /* cross-origin frame we cannot inspect */ }
    if (count > 0) frames.push({ frame, url: frame.url(), count });
  }
  frames.sort((a, b) => b.count - a.count);
  console.log('\n  frames containing form controls:');
  for (const f of frames) console.log(`    ${String(f.count).padStart(3)} controls  ${f.url.slice(0, 96)}`);
  if (frames.length === 0) console.log('    none (the page may gate the form behind an Apply button)');
  let target = frames[0]?.frame || page.mainFrame();

  // Retry: a slow page (or several runs sharing a machine) can still be loading
  // its content script when the first message goes out, and a single attempt
  // then reports "no content script" for a board that works fine.
  let detected = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    detected = await sendToPage(optionsPage, { type: 'detect', verbose: true });
    if (detected?.ok) break;
    await page.waitForTimeout(2500);
  }

  // Embedded board in an iframe on a host we have no permission for. The popup
  // handles this with activeTab after the user's click; the harness has no
  // gesture, so it re-opens the embedded board directly instead.
  if (!detected?.ok && frames.length) {
    const embed = frames.find(f => f.url !== page.url() && /greenhouse|lever|ashby|myworkday|successfactors/.test(f.url));
    if (embed) {
      console.log(`\n  no content script in the host page; reopening the embedded board directly`);
      await page.goto(embed.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      target = page.mainFrame();
      const landed = await page.evaluate(sel => ({
        url: location.href.slice(0, 90),
        controls: document.querySelectorAll(sel).length,
        text: document.body.innerText.slice(0, 100).replace(/\s+/g, ' '),
      }), CONTROLS);
      console.log(`    landed on: ${landed.url}`);
      console.log(`    controls:  ${landed.controls}   "${landed.text}"`);
      detected = await sendToPage(optionsPage, { type: 'detect', verbose: true });
    }
  }

  if (!detected?.ok) {
    console.log(`\n  detect failed: ${JSON.stringify(detected)}`);
  } else {
    console.log(`\n  board: ${detected.boardLabel} (${detected.board})`);
    console.log(`  responding frame: ${detected.url.slice(0, 100)}`);
    console.log(`  fields detected: ${detected.fieldCount}\n`);
    console.log(`  ${pad('LABEL', 44)} ${pad('KIND', 15)} ${pad('RESOLVED FROM', 24)} VALUE`);
    console.log(`  ${'-'.repeat(44)} ${'-'.repeat(15)} ${'-'.repeat(24)} -----`);
    for (const f of detected.fields || []) {
      console.log(`  ${pad(f.rawLabel, 44)} ${pad(f.kind, 15)} ${pad(f.resolvedFrom || '-- NO ANSWER --', 24)} ${f.value || ''}`);
    }

    // Anything unresolved gets its DOM identity dumped, so a login-walled board
    // only has to be visited once to gather what a fix needs.
    DETECTED_FIELDS = detected.fields || [];
    const unresolved = DETECTED_FIELDS.filter(f => !f.resolvedFrom);
    if (unresolved.length) {
      console.log('\n  DOM detail for unresolved fields:');
      for (const f of unresolved) {
        const d = f.debug || {};
        console.log(`    "${f.rawLabel}"  key="${f.normKey}"`);
        console.log(`      ${d.tag}${d.type ? '[' + d.type + ']' : ''} role=${d.role || '-'} haspopup=${d.hasPopup || '-'} id=${d.id || '-'} aid=${d.automationId || '-'} parentAid=${d.parentAutomationId || '-'}`);
        console.log(`      aria-label=${JSON.stringify(d.ariaLabel)} labelledBy=${JSON.stringify(d.labelledByTexts)}`);
      }
    }
  }

  const report = await sendToPage(optionsPage, { type: 'fill' });

  console.log(`\n  FILL: ${report.filled} filled / ${report.unknown} needs-you / ${report.failed} failed`);
  if (report.unknowns?.length) {
    console.log('\n  needs you:');
    for (const u of report.unknowns) console.log(`    - ${u.rawLabel}`);
  }
  const revertedLabels = new Set((report.reverted || []).map(r => r.rawLabel));
  const otherFailures = (report.failures || []).filter(f => !revertedLabels.has(f.rawLabel));
  if (otherFailures.length) {
    console.log('\n  write attempted but rejected by the control:');
    for (const f of otherFailures) console.log(`    - ${f.rawLabel}`);
  }
  if (report.reverted?.length) {
    console.log('\n  written but did NOT stick (reported as failed, not filled):');
    for (const r of report.reverted) {
      console.log(`    - ${r.rawLabel.slice(0, 100)}`);
      // These are the hardest to diagnose, so print their DOM identity too.
      const f = DETECTED_FIELDS.find(x => x.rawLabel === r.rawLabel);
      const d = f?.debug;
      if (d) {
        console.log(`      ${d.tag}${d.type ? '[' + d.type + ']' : ''} role=${d.role || '-'} haspopup=${d.hasPopup || '-'} id=${d.id || '-'} aid=${d.automationId || '-'} parentAid=${d.parentAutomationId || '-'}`);
        console.log(`      aria-label=${JSON.stringify(d.ariaLabel)} labelledBy=${JSON.stringify(d.labelledByTexts)}`);
      }
    }
  }
  if (report.resumeNote) console.log(`\n  resume reminder: ${report.resumeNote}`);

  // Widget probe. When a dropdown ends up unfilled, the question is whether the
  // popup refuses to open at all or opens with options we failed to match.
  // Playwright's click produces trusted pointer+mouse events; ours are
  // synthetic. Comparing the two says exactly which layer is at fault.
  const stuckCombos = (report.unknowns || [])
    .map(u => DETECTED_FIELDS.find(f => f.rawLabel === u.rawLabel))
    .filter(f => f && /combobox/.test(f.kind));
  if (stuckCombos.length) {
    console.log('\n  probing unfilled dropdowns with a real user click:');
    for (const f of stuckCombos) {
      const d = f.debug || {};
      // Attribute selectors, not #id: CSS.escape is a browser API and this is Node.
      const q = s => String(s).replace(/"/g, '\\"');
      const sel = d.id ? `[id="${q(d.id)}"]`
        : d.automationId ? `[data-automation-id="${q(d.automationId)}"]`
        : d.parentAutomationId ? `[data-automation-id="${q(d.parentAutomationId)}"] input`
        : d.domPath || null;
      const handle = sel ? await target.$(sel).catch(() => null) : null;
      if (!handle) { console.log(`    "${f.rawLabel}": could not locate the control`); continue; }
      // force: skip actionability checks; leftover overlays are not the subject here.
      await handle.click({ timeout: 5000, force: true })
        .catch(e => console.log(`      click failed: ${e.message.split('\n')[0].slice(0, 70)}`));
      await page.waitForTimeout(1200);

      const countOptions = () => target.evaluate(() => {
        const nodes = [...document.querySelectorAll(
          '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"], [class*="select__option"]'
        )].filter(o => o.offsetParent !== null);
        return {
          count: nodes.length,
          sample: nodes.slice(0, 6).map(o => (o.getAttribute('data-automation-label') || o.textContent).trim().slice(0, 40)),
          containers: [...new Set(nodes.map(o => o.closest('[data-automation-id]')?.getAttribute('data-automation-id') || '?'))].slice(0, 3),
        };
      });

      let popup = await countOptions();
      console.log(`    "${f.rawLabel}" after a real click -> ${popup.count} options ${JSON.stringify(popup.sample)}`);

      // A type-to-search widget shows nothing until it has a query, so a bare
      // click proves little. Type a prefix of the intended value and look again.
      if (popup.count === 0 && f.value) {
        const prefix = String(f.value).split(',')[0].slice(0, 12);
        await handle.type(prefix, { delay: 60 }).catch(() => {});
        await page.waitForTimeout(2000);
        popup = await countOptions();
        console.log(`      after typing ${JSON.stringify(prefix)} -> ${popup.count} options ${JSON.stringify(popup.sample)}`);
      }
      if (popup.count) console.log(`      option containers: ${JSON.stringify(popup.containers)}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // Read the values back out of the form's own frame.
  const values = await target.evaluate(sel =>
    [...document.querySelectorAll(sel)]
      .map(el => {
        // A committed react-select value lives in a rendered label, not .value.
        const control = el.closest('[class*="select__control"]');
        const rendered = control?.querySelector('[class*="single-value"]')?.textContent?.trim();
        return {
          id: el.id || el.name || el.getAttribute('data-automation-id') || el.tagName,
          value: (rendered || String(el.value || '')).slice(0, 60),
          filled: el.classList.contains('ja-filled'),
        };
      })
      .filter(v => v.value), CONTROLS);
  console.log('\n  values present in the DOM after fill:');
  for (const v of values) console.log(`    ${v.filled ? 'GREEN' : '  -  '} ${pad(v.id, 40)} ${v.value}`);

  // Blur-survival check. Compare actual values before and after, keyed by the
  // control's stable id: Workday re-renders inputs after a write, which drops
  // our outline classes even though the value is fine, so a class-based check
  // reports phantom losses.
  const snapshot = () => target.evaluate(sel => {
    const out = {};
    for (const el of document.querySelectorAll(sel)) {
      // Prefer a stable key. Workday regenerates DOM ids on every re-render
      // ("arbc4" one pass, "qnlr4" the next), so keying on id alone reports a
      // field as reverted when it merely got a new id.
      const key = el.getAttribute('data-automation-id') || el.name || el.id;
      if (!key) continue;
      if (!el.getAttribute('data-automation-id') && !el.name && /^[a-z]{2,5}\d/i.test(key)) continue;
      const control = el.closest('[class*="select__control"]');
      out[key] = (control?.querySelector('[class*="single-value"]')?.textContent?.trim())
        || String(el.value || '');
    }
    return out;
  }, CONTROLS);

  const before = values.length ? await snapshot() : {};
  await target.evaluate(() => document.body.click());
  await page.waitForTimeout(1200);
  const afterBlur = await snapshot();

  const lost = Object.keys(before).filter(k => before[k] && !afterBlur[k]);
  const kept = Object.keys(before).filter(k => before[k] && afterBlur[k]).length;
  console.log(
    lost.length === 0
      ? `\n  blur check: all ${kept} non-empty values survived`
      : `\n  blur check: ${lost.length} value(s) REVERTED after blur: ${lost.join(', ')}`
  );

  const shot = join(tmpdir(), 'job-autofill-live.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n  screenshot: ${shot}`);
  console.log('  no submit control was clicked; nothing was sent to the employer.\n');

  if (KEEP) {
    console.log('  --keep: browser stays open, ctrl-c to exit');
    await new Promise(() => {});
  }
} catch (err) {
  console.error(`\n  live run threw: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 6).join('\n'));
} finally {
  // Never delete a persistent profile, and never yank the browser away from
  // someone who is mid-signin.
  const keepOpen = KEEP || (WAIT_FOR_FORM && TIMED_OUT);
  if (!keepOpen) await ctx.close();
  if (!WAIT_FOR_FORM) rmSync(userDataDir, { recursive: true, force: true });
  if (keepOpen) {
    console.log('  browser left open. Close it yourself when done.\n');
    await new Promise(() => {});
  }
}
