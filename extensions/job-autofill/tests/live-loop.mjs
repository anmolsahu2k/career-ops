#!/usr/bin/env node

/**
 * live-loop.mjs — prove the learning loop on a REAL posting, end to end.
 *
 *   fill -> answer what it could not -> reload -> fill again
 *
 * The fixture in e2e.mjs proves the loop in miniature. This proves it on the
 * markup boards actually ship, which is where every real defect has come from:
 * a value that looks stored but was never captured, or one captured under a key
 * that never matches the same question again.
 *
 * Usage:
 *   node extensions/job-autofill/tests/live-loop.mjs <application-url> [--headed] [--keep]
 *
 * SAFETY: this fills fields, answers them, and reloads. It NEVER clicks a
 * submit, apply, or continue control, and it only ever clicks option elements
 * inside a dropdown it opened. Nothing is sent to the employer. Do not add a
 * click on a submit control to this file.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { normalizeKey } from '../content/matcher.js';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(EXT, 'data', 'answers.json');
const URL_ARG = process.argv[2];
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

if (!URL_ARG || URL_ARG.startsWith('--')) {
  console.error('\n  usage: node extensions/job-autofill/tests/live-loop.mjs <application-url>\n');
  process.exit(1);
}
if (!existsSync(SEED)) {
  console.error('\n  Missing data/answers.json. Run `npm run autofill:seed` first.\n');
  process.exit(1);
}

/** Free-text answers used to teach the form. Deliberately innocuous. */
const TEXT_ANSWER = 'N/A';
const TEXT_ANSWERS = {
  number: '3',
  date: '2027-01-15',
  month: '2027-01',
  tel: '+1-412-555-0100',
  email: 'test@example.com',
  url: 'https://example.com',
};

let failures = 0;
const ok = m => console.log(`  ok    ${m}`);
const no = m => { console.log(`  FAIL  ${m}`); failures++; };

const dir = mkdtempSync(join(tmpdir(), 'job-autofill-loop-'));
const ctx = await chromium.launchPersistentContext(dir, {
  headless: !HEADED,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 1400 },
});

/**
 * Text of the summary panel. It lives in a shadow root (page CSS was breaking
 * its layout), and innerText does not cross that boundary.
 */
async function panelText(page) {
  return page.evaluate(() => {
    const host = document.getElementById('job-autofill-panel');
    return host?.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }).catch(() => '');
}

try {
  for (const p of ctx.pages()) await p.close();
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  const optionsPage = await ctx.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options/options.html`);
  const seedJson = JSON.parse(readFileSync(SEED, 'utf-8'));
  await optionsPage.evaluate(async json => {
    const { importData } = await import('../content/store.js');
    await importData(json, { replaceAll: true });
  }, seedJson);

  const page = await ctx.newPage();

  // Errors thrown by our own content script. A ReferenceError at arm time
  // surfaced only in chrome://extensions and every check here still passed,
  // because an unhandled rejection kills one scan silently. Watch for them.
  const scriptErrors = [];
  // Ours only. Boards throw plenty of their own errors (an unauthenticated
  // API call, a failed analytics beacon) and none of that is our business.
  const isOurs = text => /chrome-extension:\/\/|content\/(main|capture|engine|filler|panel|store)\.js|job-autofill/.test(text);
  page.on('pageerror', e => {
    const text = `${e}\n${e.stack || ''}`;
    if (isOurs(text)) scriptErrors.push(String(e).slice(0, 160));
  });
  page.on('console', m => {
    if (m.type() === 'error' && isOurs(m.text())) scriptErrors.push(m.text().slice(0, 160));
  });

  // --debug forwards the content script's own logging, which is the only way
  // to see why a capture decision went the way it did.
  if (process.argv.includes('--debug')) {
    page.on('console', m => { if (/^ja-/.test(m.text())) console.log(`    ${m.text().slice(0, 200)}`); });
  }
  const send = msg => optionsPage.evaluate(async m => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url?.startsWith('http')) || tabs[tabs.length - 1];
    try {
      return await chrome.tabs.sendMessage(tab.id, m);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, msg);

  const capturedKeys = () => optionsPage.evaluate(async () => {
    const { loadAll } = await import('../content/store.js');
    const all = await loadAll();
    return Object.values(all.answers)
      .filter(a => a.source === 'captured')
      .map(a => ({ key: a.key, answer: a.answer }));
  });

  const load = async () => {
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")']) {
      const el = await page.$(sel).catch(() => null);
      if (el) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(700); break; }
    }
  };

  const fill = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const report = await send({ type: 'fill' });
      if (report?.ok) return report;
      await page.waitForTimeout(2500);
    }
    return null;
  };

  console.log(`\n  ${URL_ARG}\n`);
  await load();

  const first = await fill();
  if (!first) { no('no content script responded'); throw new Error('fill failed'); }
  console.log(`  PASS 1: ${first.filled} filled / ${first.unknown} needs-you / ${first.failed} failed`);
  if (first.failed > 0) no(`${first.failed} field(s) failed: ${first.failures.map(f => f.rawLabel).join(' | ').slice(0, 200)}`);
  else ok('pass 1 had no failures');

  // ── answer what it could not ──────────────────────────────────────
  // Take the field list from the extension rather than re-deriving labels
  // here: a radio group's question lives on the fieldset, and reading the
  // clicked input's own label reports the question as "Yes".
  const detected = await send({ type: 'detect', verbose: true });
  const unknownLabels = new Set((first.unknowns || []).map(u => u.rawLabel));
  const targets = (detected?.fields || []).filter(f => unknownLabels.has(f.rawLabel));

  // Only controls the extension flagged, so nothing else on the page is
  // touched, and only option elements inside a menu we opened get clicked.
  const answered = await answerUnknowns(page, targets);
  console.log(`\n  answered by hand: ${answered.length}`);
  for (const a of answered) console.log(`    ${a.kind.padEnd(15)} ${a.label.slice(0, 52).padEnd(54)} <- ${a.value}`);
  await page.waitForTimeout(1500);

  const captured = await capturedKeys();
  console.log(`\n  captured into the answer bank: ${captured.length}`);
  for (const c of captured) console.log(`    ${c.key.slice(0, 56).padEnd(58)} = ${String(c.answer).slice(0, 40)}`);

  // Anything captured that the user did not type is the extension learning its
  // own fill. Harmless when it agrees with the profile, but it would also make
  // a wrong pick permanent and outrank the profile next time.
  const selfTaught = captured.filter(c => !answered.some(a => sameQuestion(c.key, a.label)));
  selfTaught.length === 0
    ? ok('nothing was learned from our own fills')
    : no(`${selfTaught.length} answer(s) learned from our own fill: ${selfTaught.map(c => c.key.slice(0, 34)).join(' | ').slice(0, 200)}`);

  const missing = answered.filter(a => !captured.some(c => sameQuestion(c.key, a.label)));
  if (answered.length === 0) {
    console.log('  (nothing was left unanswered, so there is nothing to learn here)');
  } else if (missing.length === 0) {
    ok(`all ${answered.length} hand-answered field(s) were captured`);
  } else {
    no(`${missing.length} of ${answered.length} not captured: ${missing.map(m => m.label.slice(0, 40)).join(' | ').slice(0, 240)}`);
  }

  // The panel must show what it stored, not merely that something happened.
  const panelSummary = await panelText(page);
  if (answered.length) {
    panelSummary.includes('saved:')
      ? ok('panel reported the captured answers')
      : no('panel showed no "saved:" line after answering');
  }

  // ── reload and refill ─────────────────────────────────────────────
  await load();
  const second = await fill();
  if (!second) { no('no content script responded after reload'); throw new Error('refill failed'); }
  console.log(`\n  PASS 2: ${second.filled} filled / ${second.unknown} needs-you / ${second.failed} failed`);

  if (second.failed > 0) {
    no(`${second.failed} field(s) failed on pass 2: ${second.failures.map(f => f.rawLabel).join(' | ').slice(0, 200)}`);
  } else {
    ok('pass 2 had no failures');
  }

  if (answered.length === 0) {
    ok('nothing to relearn');
  } else if (second.filled > first.filled) {
    ok(`LEARNING LOOP CLOSED: ${first.filled} filled -> ${second.filled} filled`);
  } else {
    no(`learning loop did not close: ${first.filled} filled -> ${second.filled} filled`);
  }

  // Which specific questions came back, and which did not.
  const stillUnknown = (second.unknowns || []).map(u => u.rawLabel);
  const relearned = answered.filter(a => !stillUnknown.some(s => sameQuestion(s, a.label)));
  const notRelearned = answered.filter(a => stillUnknown.some(s => sameQuestion(s, a.label)));
  console.log(`\n  taught ${answered.length}, refilled ${relearned.length} on the next pass`);
  for (const n of notRelearned) console.log(`    NOT refilled: ${n.kind} "${n.label.slice(0, 60)}"`);

  const uniqueErrors = [...new Set(scriptErrors)];
  uniqueErrors.length === 0
    ? ok('the content script threw nothing')
    : no(`content script errors: ${uniqueErrors.join(' | ').slice(0, 300)}`);

  console.log(`\n  ${failures === 0 ? 'PASSED' : `${failures} FAILURE(S)`}\n`);
  if (KEEP) { console.log('  --keep: browser stays open'); await new Promise(() => {}); }
} catch (err) {
  console.error(`\n  loop run threw: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  failures++;
} finally {
  if (!KEEP) await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Compare a stored key against a raw question the way the extension does.
 *
 * Using its own `normalizeKey` matters: it strips boilerplate openers, so
 * "Please indicate your most recent GPA" is stored as "your most recent gpa".
 * A naive string compare reported four perfectly good captures as misses.
 */
function sameQuestion(a, b) {
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y.slice(0, 30)) || y.startsWith(x.slice(0, 30));
}

/**
 * Answer every field the extension flagged orange, the way a person would.
 *
 * Runs entirely in the page for the value-setting parts that need no menu, and
 * uses real clicks for dropdowns so the widget commits the way it does for a
 * user. Snapshot the elements first: answering one clears its orange class.
 */
async function answerUnknowns(page, targets) {
  const done = [];
  // Controls the harness could not actually set. Reporting these separately
  // keeps "the test could not answer it" from being read as "the extension
  // failed to learn it".
  const unapplied = [];

  for (const field of targets) {
    const d = field.debug || {};
    const selector = d.id ? `[id="${cssQuote(d.id)}"]`
      : d.name ? `[name="${cssQuote(d.name)}"]`
      : d.automationId ? `[data-automation-id="${cssQuote(d.automationId)}"]`
      : d.domPath || null;
    if (!selector) continue;
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;

    const info = {
      tag: d.tag,
      type: (d.type || '').toLowerCase(),
      combo: field.kind === 'combobox-input' || field.kind === 'combobox',
      buttongroup: field.kind === 'buttongroup',
      label: field.rawLabel,
    };

    try {
      if (info.buttongroup) {
        // Locate by question text, not by the positional CSS path: these
        // buttons carry no id or name, and the path resolved to a different
        // group's "Yes", so three postings looked like capture failures when
        // the harness had answered the wrong question.
        const picked = await page.evaluate(label => {
          const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
          const target = norm(label);
          const containers = [...document.querySelectorAll('div, fieldset, li, section')]
            .filter(c => norm(c.textContent).startsWith(target)
              && [...c.querySelectorAll('button')].filter(b => b.textContent.trim()).length >= 2);
          const container = containers[containers.length - 1];
          if (!container) return null;
          const choice = [...container.querySelectorAll('button')].find(b => b.textContent.trim());
          if (!choice) return null;
          choice.click();
          return norm(choice.textContent);
        }, info.label);
        if (!picked) { unapplied.push(info.label); continue; }
        await page.waitForTimeout(400);
        done.push({ kind: 'buttongroup', label: info.label, value: picked });
        continue;
      }
      if (info.tag === 'SELECT') {
        const value = await handle.evaluate(el => {
          const opt = [...el.options].find(o => o.value && !/^(please select|select|choose)/i.test(o.textContent));
          if (!opt) return null;
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.textContent.trim();
        });
        if (value) done.push({ kind: 'select', label: info.label, value });
      } else if (info.type === 'radio' || info.type === 'checkbox') {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        // Toggle in the page, not with the mouse. A real click has to land on
        // the label, because boards style the input away and a click on a
        // hidden input hits the overlay instead; but a label that WRAPS its
        // input toggles twice (Spotify's consent box does), leaving the box
        // unchecked while still firing the change the extension learns from.
        // The harness then read its own double-click as the extension having
        // learned its own fill.
        let state = await handle.evaluate(el => {
          el.click();
          // Spotify's consent box runs its own handler and toggles back, so a
          // single click ends where it started while still firing the change
          // the extension learns from. Land it in the state a user would see.
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { checked: el.checked, value: el.closest('label')?.textContent?.trim() || el.value || 'checked' };
        });
        if (!state.checked) {
          const clickTarget = await handle.evaluateHandle(el => el.closest('label') || el);
          await clickTarget.asElement().click({ timeout: 5000, force: true }).catch(() => {});
          state = await handle.evaluate(el => ({
            checked: el.checked,
            value: el.closest('label')?.textContent?.trim() || el.value || 'checked',
          }));
        }
        if (!state.checked) { unapplied.push(info.label); continue; }
        done.push({ kind: info.type, label: info.label, value: String(state.value).slice(0, 40) });
      } else if (info.combo) {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await handle.click({ timeout: 5000 });
        await page.waitForTimeout(900);
        const picked = await pickVisibleOption(page);
        if (picked) done.push({ kind: 'combobox', label: info.label, value: picked });
        else await page.keyboard.press('Escape').catch(() => {});
      } else if (info.tag === 'TEXTAREA' || info.tag === 'INPUT') {
        // Answer in the control's own type: a number box silently rejects
        // "N/A", which then looks like a capture failure rather than a test
        // that typed the wrong thing.
        const text = TEXT_ANSWERS[info.type] || TEXT_ANSWER;
        const got = await handle.evaluate((el, value) => {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
          Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return el.value;
        }, text);
        if (!got) { unapplied.push(`${info.label} (${info.type || 'text'} rejected "${text}")`); continue; }
        done.push({ kind: info.tag.toLowerCase(), label: info.label, value: got });
      }
    } catch {
      // A control that will not accept a hand answer is not what this is
      // testing; the fill pass already reports those.
    }
    await page.waitForTimeout(450);
  }
  if (unapplied.length) {
    console.log(`  (harness could not set ${unapplied.length}: ${unapplied.map(u => u.slice(0, 40)).join(' | ').slice(0, 160)})`);
  }
  return done;
}

/** Attribute-selector quoting; CSS.escape is a browser API and this is Node. */
function cssQuote(value) {
  return String(value).replace(/"/g, '\\"');
}

/** Click the first visible option of whatever menu is open. */
async function pickVisibleOption(page) {
  const option = await page.evaluateHandle(() => {
    const nodes = [...document.querySelectorAll(
      '[class*="select__option"], [role="option"], [data-automation-id="promptOption"]'
    )].filter(o => o.offsetParent !== null && o.textContent.trim());
    return nodes[0] || null;
  });
  const el = option.asElement();
  if (!el) return null;
  const text = await el.evaluate(o => o.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  await el.click({ timeout: 5000, force: true }).catch(() => {});
  await page.waitForTimeout(600);
  return text;
}
