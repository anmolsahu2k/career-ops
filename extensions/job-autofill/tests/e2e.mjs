#!/usr/bin/env node

/**
 * e2e.mjs — loads the unpacked extension in Chromium, seeds it, fills the
 * fixture form, and asserts on the real DOM. This is the README smoke
 * checklist, automated.
 *
 * Usage:  node extensions/job-autofill/tests/e2e.mjs [--headed]
 *
 * Needs data/answers.json to exist (run `npm run autofill:seed` first).
 * Not part of test-all.mjs: it launches a browser and takes ~15s.
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(EXT, 'fixtures');
const SEED = join(EXT, 'data', 'answers.json');
const HEADED = process.argv.includes('--headed');
const PORT = 8123;

if (!existsSync(SEED)) {
  console.error('\n  Missing extensions/job-autofill/data/answers.json.');
  console.error('  Run `npm run autofill:seed` first.\n');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = m => { console.log(`  ok    ${m}`); pass++; };
const no = m => { console.log(`  FAIL  ${m}`); fail++; };

const server = createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\//, '') || 'greenhouse.html';
  const file = join(FIXTURES, rel);
  if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': extname(file) === '.html' ? 'text/html' : 'text/plain' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(PORT, r));

const userDataDir = mkdtempSync(join(tmpdir(), 'job-autofill-e2e-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: !HEADED,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

/** Drive a fill the same way the popup does. */
async function fillViaMessage(driver) {
  return driver.evaluate(async port => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    return chrome.tabs.sendMessage(tab.id, { type: 'fill' });
  }, PORT);
}

/** Read one learned answer by key. Extension pages ban eval, so pass a key, not a function. */
async function readAnswer(driver, key) {
  return driver.evaluate(async k => {
    const { loadAll } = await import('../content/store.js');
    return (await loadAll()).answers[k] || null;
  }, key);
}

/** Essay answers are deliberately URL-scoped, so a tailored response from one
 * application can never silently populate another employer's form. */
async function readJobAnswer(driver, url, question) {
  return driver.evaluate(async ({ url: jobUrl, question: rawQuestion }) => {
    const { normalizeKey } = await import('../content/matcher.js');
    const { jobAnswers = {} } = await chrome.storage.local.get('jobAnswers');
    return jobAnswers[`${jobUrl.split('#')[0]}::${normalizeKey(rawQuestion)}`] || null;
  }, { url, question });
}

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
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  ok(`extension loaded (${extId})`);

  // ── seed through the real import path ────────────────────────────
  const optionsPage = await ctx.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options/options.html`);
  const seedJson = JSON.parse(readFileSync(SEED, 'utf-8'));
  const imported = await optionsPage.evaluate(async json => {
    const { importData, loadAll } = await import('../content/store.js');
    await importData(json, { replaceAll: true });
    const after = await loadAll();
    const all = Object.values(after.answers);
    return {
      answers: all.length,
      sensitive: all.filter(a => a.sensitive).length,
      email: after.profile.email,
    };
  }, seedJson);
  imported.answers > 0
    ? ok(`imported ${imported.answers} answers (${imported.sensitive} EEO) for ${imported.email}`)
    : no('import produced no answers');

  await optionsPage.reload();
  await optionsPage.waitForTimeout(400);
  const visible = imported.answers - imported.sensitive;
  const rows = await optionsPage.locator('#answers tbody tr').count();
  rows === visible
    ? ok(`options page lists ${rows} answers, hiding ${imported.sensitive} EEO by default`)
    : no(`options shows ${rows}, expected ${visible} with EEO hidden`);

  await optionsPage.locator('#showSensitive').check();
  await optionsPage.waitForTimeout(200);
  const allRows = await optionsPage.locator('#answers tbody tr').count();
  allRows === imported.answers
    ? ok('EEO answers appear when the checkbox is ticked')
    : no(`showing EEO gives ${allRows}, expected ${imported.answers}`);
  await optionsPage.locator('#showSensitive').uncheck();

  // ── first fill ───────────────────────────────────────────────────
  const page = await ctx.newPage();

  // Anything our own content script throws. A ReferenceError at arm time was
  // invisible to every other check here, because an unhandled rejection only
  // loses the one scan it happened in.
  const scriptErrors = [];
  const isOurs = text => /chrome-extension:\/\/|content\/(main|capture|engine|filler|panel|store)\.js/.test(text);
  page.on('pageerror', e => { if (isOurs(`${e}\n${e.stack || ''}`)) scriptErrors.push(String(e).slice(0, 160)); });
  page.on('console', m => {
    if (m.type() === 'error' && isOurs(m.text())) scriptErrors.push(m.text().slice(0, 160));
  });

  await page.goto(`http://localhost:${PORT}/greenhouse.html`);
  await page.waitForTimeout(700);

  // The mount flag lives in the isolated world, invisible to page.evaluate,
  // so ask the content script directly the way the popup does.
  const detected = await optionsPage.evaluate(async port => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    return chrome.tabs.sendMessage(tab.id, { type: 'detect' });
  }, PORT);
  detected?.ok && detected.fieldCount > 0
    ? ok(`content script responding: ${detected.fieldCount} fields detected`)
    : no(`detect failed: ${JSON.stringify(detected)}`);

  const report = await fillViaMessage(optionsPage);
  console.log(`\n  fill 1: ${report.filled} filled / ${report.unknown} unknown / ${report.failed} failed`);
  console.log(`  unknown: ${report.unknowns.map(u => u.rawLabel).join(' | ')}\n`);

  const val = sel => page.inputValue(sel);

  // A section revealed BY our own fill (Lever unhides its US EEO survey once a
  // location is chosen). It arrives after the field scan, so it needs a second
  // pass to be seen at all. Nobody clicks Fill again for it.
  await page.waitForTimeout(2200);
  (await val('#late_linkedin')).includes('linkedin.com/in/')
    ? ok('a section revealed by our own fill is filled without another click')
    : no(`late-revealed field = "${await val('#late_linkedin')}"`);

  // The outline for a name-grouped question must wrap the whole group. With no
  // fieldset to mark, it landed on the first checkbox, so a question that had
  // been read whole looked like only its first option was recognised.
  const outlineScope = await page.evaluate(() => {
    const marked = [...document.querySelectorAll('.ja-unknown, .ja-filled')]
      .find(el => el.querySelector('input[name=pronouns]'));
    if (!marked) return null;
    const boxes = [...document.querySelectorAll('input[name=pronouns]')];
    return { tag: marked.tagName, covers: boxes.every(b => marked.contains(b)), isInput: marked.tagName === 'INPUT' };
  });
  outlineScope?.covers && !outlineScope.isInput
    ? ok(`the group outline wraps every option (<${outlineScope.tag.toLowerCase()}>)`)
    : no(`group outline scope: ${JSON.stringify(outlineScope)}`);

  await val('#first_name') === 'Anmol' ? ok('first name') : no(`first name = "${await val('#first_name')}"`);
  await val('#last_name') === 'Sahu' ? ok('last name') : no(`last name = "${await val('#last_name')}"`);
  await val('#email') === 'anmolsahu2k@gmail.com' ? ok('email') : no(`email = "${await val('#email')}"`);
  (await val('#phone')).includes('412') ? ok('phone') : no(`phone = "${await val('#phone')}"`);
  (await val('#q_linkedin')).includes('linkedin.com/in/') ? ok('linkedin') : no(`linkedin = "${await val('#q_linkedin')}"`);
  (await val('#q_github')).includes('github.com/') ? ok('github') : no(`github = "${await val('#q_github')}"`);
  (await val('#q_website')).startsWith('https://') ? ok('website') : no(`website = "${await val('#q_website')}"`);

  await val('#q_auth') === 'Yes, I am authorized to work in the US'
    ? ok('bare "Yes" mapped onto the qualified work-auth option')
    : no(`work auth = "${await val('#q_auth')}"`);
  // Two options qualify a Yes in opposite directions ("in the future" vs
  // "now"), so a stored bare Yes must abstain rather than pick one.
  await val('#q_sponsor') === ''
    ? ok('sponsorship abstained (two Yes options, stored answer does not choose)')
    : no(`sponsorship guessed "${await val('#q_sponsor')}" instead of abstaining`);
  report.unknowns.some(u => u.rawLabel.toLowerCase().includes('sponsorship'))
    ? ok('abstained field reported as "needs you", not as a failure')
    : no('abstained sponsorship field missing from the unknowns list');
  report.failed === 0 ? ok('no spurious failures on the fixture') : no(`${report.failed} field(s) reported failed`);
  await val('#q_start') === 'Available January 2027' ? ok('start date') : no(`start = "${await val('#q_start')}"`);
  await val('#q_heard') === 'LinkedIn job search' ? ok('how did you hear') : no(`heard = "${await val('#q_heard')}"`);
  await page.locator('input[name=relocate][value=y]').isChecked()
    ? ok('relocation radio group answered')
    : no('relocation radio not checked');

  // A styled choice control keeps its native input at opacity 0. Treating
  // transparent as hidden skipped every EEO question on Ashby.
  await page.locator('input[name=vet][value="I am not a protected veteran"]').isChecked()
    ? ok('styled radio group (opacity-0 input) detected and answered')
    : no('styled radio group was not filled');

  // Blanks that must stay blank.
  await val('#q_why') === '' ? ok('essay left blank (no exact match)') : no(`essay filled: "${await val('#q_why')}"`);
  await val('#q_notice') === '' ? ok('unknown question left blank') : no('unknown question was guessed');

  // Demographics are seeded now (user-authorized), so this one should fill.
  await val('#q_gender') === 'Male'
    ? ok('EEO question filled from the seeded demographics')
    : no(`gender = "${await val('#q_gender')}"`);

  await page.locator('#q_notice').evaluate(el => el.classList.contains('ja-unknown'))
    ? ok('unknown field outlined orange') : no('missing orange outline');
  await page.locator('#first_name').evaluate(el => el.classList.contains('ja-filled'))
    ? ok('filled field outlined green') : no('missing green outline');
  await page.locator('#job-autofill-panel').isVisible() ? ok('summary panel rendered') : no('no summary panel');
  (await panelText(page)).toLowerCase().includes('resume')
    ? ok('resume reminder shown for the file input') : no('resume reminder missing');

  // ── the learning loop ────────────────────────────────────────────
  await page.fill('#q_notice', 'Two weeks');
  await page.locator('#q_notice').blur();
  await page.waitForTimeout(600);

  const learned = await readAnswer(optionsPage, 'what is your notice period');
  learned?.answer === 'Two weeks'
    ? ok(`captured "${learned.answer}" (source ${learned.source}, boards ${learned.boards})`)
    : no(`capture failed: ${JSON.stringify(learned)}`);
  await page.locator('#q_notice').evaluate(el => el.classList.contains('ja-filled'))
    ? ok('orange flipped green after capture') : no('outline did not flip');

  // The panel must show WHAT was captured. A green outline alone cannot
  // distinguish a stored answer from a mis-read one.
  const panelSummary = await panelText(page);
  panelSummary.includes('saved: Two weeks')
    ? ok('panel shows the captured answer')
    : no(`panel does not show the answer: ${JSON.stringify(panelSummary.slice(0, 160))}`);
  panelSummary.includes('1 saved')
    ? ok('saved count appears on the panel')
    : no('no saved chip on the panel');

  // Answering that question also revealed a new section, which triggers
  // another pass. The panel is rebuilt from scratch each pass, so this is
  // exactly where every "saved:" line used to disappear.
  await page.waitForTimeout(2200);
  const afterRescan = await panelText(page);
  afterRescan.includes('saved: Two weeks') && afterRescan.includes('1 saved')
    ? ok('a learned answer survives the pass a revealed section triggers')
    : no(`rescan wiped the learned row: ${JSON.stringify(afterRescan.slice(-200))}`);
  (await val('#late_github')).includes('github.com/')
    ? ok('the second revealed section is filled too')
    : no(`second late section = "${await val('#late_github')}"`);

  // A blank is an answer. Delete a value we wrote; the pass that the next
  // reveal triggers must not write it back. Submitting a field the user
  // explicitly emptied, wearing a green outline that says it was reviewed, is
  // the worst thing this tool can do.
  await page.fill('#q_website', '');
  await page.locator('#q_website').blur();
  await page.waitForTimeout(300);

  // Typing into this textarea reveals another section on every keystroke. A
  // pass triggered while the caret is still in the box would blur the user
  // mid-sentence and, because a pass learns nothing while it runs, throw away
  // the answer being typed.
  await page.click('#q_why');
  await page.type('#q_why', 'Because the platform work matches what I want to build next.');
  await page.waitForTimeout(2600);
  await page.evaluate(() => document.activeElement?.id) === 'q_why'
    ? ok('an auto pass does not steal focus from a field being typed in')
    : no(`focus moved to "${await page.evaluate(() => document.activeElement?.id)}" while typing`);
  (await val('#q_why')).endsWith('build next.')
    ? ok('the half-typed answer is intact')
    : no(`typed answer was disturbed: "${await val('#q_why')}"`);

  await page.locator('#q_why').blur();
  await page.waitForTimeout(1800);
  const whyLearned = await readJobAnswer(
    optionsPage,
    `http://localhost:${PORT}/greenhouse.html`,
    'Why are you interested in this role?'
  );
  whyLearned?.answer?.endsWith('build next.')
    ? ok('an answer typed while a section appeared is still learned')
    : no(`answer typed during a reveal was lost: ${JSON.stringify(whyLearned?.answer)}`);
  (await val('#late_website')).startsWith('http')
    ? ok('the section revealed while typing fills once the field is left')
    : no(`section revealed while typing = "${await val('#late_website')}"`);

  // That pass demonstrably ran (the line above), so this is a real test.
  await val('#q_website') === ''
    ? ok('a value the user deleted is not written back by an automatic pass')
    : no(`deleted value was restored: "${await val('#q_website')}"`);
  await page.locator('#q_website').evaluate(el => el.classList.contains('ja-filled'))
    ? no('a deleted field still wears the filled outline')
    : ok('the deleted field carries no filled outline');

  // Rescans are capped. A fourth revealed section must be left alone, or a
  // chatty page could keep the extension refilling forever.
  await page.evaluate(() => { document.getElementById('lateSection4').style.display = 'block'; });
  await page.waitForTimeout(2400);
  await val('#late4_linkedin') === ''
    ? ok('the rescan cap holds: a fourth revealed section is not filled')
    : no(`rescan cap exceeded: late4 = "${await val('#late4_linkedin')}"`);

  // A profile-backed question whose options the stored value cannot map onto
  // ("Country Phone Code" is the live example) is abstained on every time.
  // Refusing to learn the user's pick there leaves it manual forever, so an
  // abstained profile field IS learned.
  await page.selectOption('#q_country_code', '+91 (India)');
  await page.waitForTimeout(700);
  const afterProfileField = await panelText(page);
  const learnedProfileField = await readAnswer(optionsPage, 'country phone code');
  learnedProfileField?.answer === '+91 (India)'
    ? ok('an abstained profile field is learned from the user')
    : no(`abstained profile field not learned: ${JSON.stringify(learnedProfileField)}`);
  afterProfileField.includes('saved: +91 (India)')
    ? ok('panel shows the answer learned for it')
    : no('panel did not show the learned profile-field answer');

  // react-select shaped: the value commits into a rendered label and the input
  // goes to opacity 0. Reading el.value gives nothing and a visibility-filtered
  // field scan drops the control, which is how an answered Greenhouse
  // questionnaire saved nothing at all.
  await page.locator('#rs_input').dispatchEvent('mousedown');
  await page.locator('.select__option').filter({ hasText: 'Yes' }).first().dispatchEvent('mousedown');
  await page.waitForTimeout(900);
  const rsLearned = await readAnswer(optionsPage, 'do you have professional experience in javascript');
  rsLearned?.answer === 'Yes'
    ? ok('committed-value dropdown is learned')
    : no(`committed-value dropdown not learned: ${JSON.stringify(rsLearned)}`);

  // Changing an answer must replace the stored one. "No" is two characters,
  // and the placeholder check used to reject anything that short, so a Yes
  // corrected to No left the Yes in the bank.
  await page.locator('#rs_input').dispatchEvent('mousedown');
  await page.locator('.select__option').filter({ hasText: 'No' }).first().dispatchEvent('mousedown');
  await page.waitForTimeout(900);
  const corrected = await readAnswer(optionsPage, 'do you have professional experience in javascript');
  corrected?.answer === 'No'
    ? ok('a corrected answer replaces the stored one, including "No"')
    : no(`correction not stored: ${JSON.stringify(corrected)}`);
  (await panelText(page)).includes('saved: No')
    ? ok('panel shows the corrected answer')
    : no('panel still shows the old answer after a correction');

  // ── multi-value fields ───────────────────────────────────────────
  // A skills picker and a check-all group each hold several answers. Storing
  // only the last one ticked is what the user hit on a Workday skills step.
  await page.check('input[name=langs][value=Python]');
  await page.check('input[name=langs][value=Go]');
  await page.waitForTimeout(800);
  const langs = await readAnswer(optionsPage, 'which languages do you use');
  langs?.answer === 'Python | Go'
    ? ok(`check-all group stored every choice ("${langs.answer}")`)
    : no(`multi checkbox stored: ${JSON.stringify(langs?.answer)}`);

  for (const skill of ['Machine Learning (ML)', 'Writing']) {
    await page.locator('#skills_input').dispatchEvent('mousedown');
    await page.locator('.select__option').filter({ hasText: skill }).first().dispatchEvent('mousedown');
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  // Deliberately NOT "Type to Add Skills": that is Workday's own label and the
  // seed now ships an answer for it, which would fill this control before the
  // capture loop ever got a chance. The control under test is a multi-value
  // picker; the question it asks is beside the point.
  const skills = await readAnswer(optionsPage, 'areas of interest');
  skills?.answer === 'Machine Learning (ML) | Writing'
    ? ok(`chips multi-select stored every choice ("${skills.answer}")`)
    : no(`skills picker stored: ${JSON.stringify(skills?.answer)}`);

  // ── a group's question is never one of its own options ───────────
  // Nine checkboxes sharing name="pronouns", with no fieldset and no ARIA: the
  // question is a plain sibling of the list. Lever's pronoun block, which the
  // panel showed as the question "He/him".
  await page.check('input[name=pronouns][value="He/him"]');
  await page.check('input[name=pronouns][value="They/them"]');
  await page.waitForTimeout(800);
  const pronouns = await readAnswer(optionsPage, 'pronouns');
  pronouns?.answer === 'He/him | They/them'
    ? ok(`name-grouped choices key on the question ("${pronouns.answer}")`)
    : no(`pronoun group stored: ${JSON.stringify(pronouns?.answer)}`);
  await readAnswer(optionsPage, 'he him')
    ? no('an option text was stored as a question of its own')
    : ok('no answer stored under an option-text key');
  (await panelText(page)).includes('Pronouns')
    ? ok('panel names the question, not the option')
    : no('panel does not show the group question');

  // The same rule must leave a lone consent checkbox alone: its own label IS
  // the question, and there is no group for it to be an option of.
  await page.check('input[name=consent]');
  await page.waitForTimeout(700);
  const consent = await readAnswer(
    optionsPage, 'contoso has my consent to contact me about future job opportunities'
  );
  consent?.answer
    ? ok(`a lone checkbox keeps its own sentence as the question ("${consent.answer}")`)
    : no('lone consent checkbox was not learned under its own label');

  // A checkbox whose page handler undoes a click-driven toggle. Teach it here;
  // the fill on pass 2 has to land it checked anyway, which a click alone
  // cannot do. Spotify's consent box on Lever behaves exactly this way.
  await page.evaluate(() => {
    const box = document.querySelector('input[name=fighty]');
    box.checked = true;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  const fighty = await readAnswer(optionsPage, 'contoso may keep my details on file for two years');
  fighty?.answer
    ? ok(`a click-resistant checkbox is learned ("${String(fighty.answer).slice(0, 32)}")`)
    : no('click-resistant checkbox was not learned');

  // Workday-shaped dropdowns: a button with its options in a detached popup.
  // Answering one fires no change event on any input, so none of it was learned.
  await page.click('#wq1');
  await page.locator('[data-automation-id="promptOption"]').filter({ hasText: 'Yes' }).first().click();
  await page.waitForTimeout(900);
  const widgetLearned = await readAnswer(optionsPage, 'have you ever worked for contoso');
  widgetLearned?.answer === 'Yes'
    ? ok('widget dropdown answered by hand is learned')
    : no(`widget dropdown not learned: ${JSON.stringify(widgetLearned)}`);
  await readAnswer(optionsPage, 'select one')
    ? no('a widget was stored under the placeholder key "select one"')
    : ok('no answer stored under a placeholder key');

  // Teaching the abstained sponsorship question once should stick.
  await page.selectOption('#q_sponsor', 'Yes, I will require sponsorship in the future');
  await page.waitForTimeout(500);
  const sponsorLearned = await readAnswer(
    optionsPage, 'will you now or in the future require sponsorship for employment visa status'
  );
  sponsorLearned?.answer === 'Yes, I will require sponsorship in the future' && sponsorLearned.source === 'captured'
    ? ok('user correction overwrote the seeded sponsorship answer')
    : no(`sponsorship not relearned: ${JSON.stringify(sponsorLearned)}`);

  // Seeded EEO answers must carry the sensitive flag so the review page can
  // keep them off screen by default.
  const eeo = await readAnswer(optionsPage, 'what is your race or ethnicity');
  eeo?.sensitive === true
    ? ok(`seeded EEO answer flagged sensitive ("${eeo.answer}")`)
    : no(`EEO answer not flagged sensitive: ${JSON.stringify(eeo)}`);

  // The other half of that rule: a profile field we DID fill stays out of the
  // answer bank even when the user edits it, so an old address or phone number
  // cannot end up stored in two places.
  await page.fill('#email', 'typed@example.com');
  await page.locator('#email').blur();
  await page.waitForTimeout(500);
  await readAnswer(optionsPage, 'email') === null
    ? ok('identity field never enters the answer bank')
    : no('email leaked into the answer bank');

  // ── second pass proves the loop closed ───────────────────────────
  await page.reload();
  await page.waitForTimeout(700);
  const report2 = await fillViaMessage(optionsPage);
  console.log(`\n  fill 2: ${report2.filled} filled / ${report2.unknown} unknown / ${report2.failed} failed\n`);

  await val('#q_notice') === 'Two weeks'
    ? ok('LEARNING LOOP: the once-unknown question now autofills')
    : no(`notice period = "${await val('#q_notice')}" on pass 2`);
  await val('#q_sponsor') === 'Yes, I will require sponsorship in the future'
    ? ok('LEARNING LOOP: the abstained sponsorship question now autofills correctly')
    : no(`sponsorship = "${await val('#q_sponsor')}" on pass 2`);
  report2.filled > report.filled
    ? ok(`fill count improved ${report.filled} -> ${report2.filled}`)
    : no(`fill count flat (${report.filled} -> ${report2.filled})`);

  // Both multi-value fields must come back whole, and only with what was
  // stored: refilling one value of a skills list is the bug this closes.
  const langsBack = await Promise.all(['Python', 'Go', 'Java'].map(v =>
    page.locator(`input[name=langs][value=${v}]`).isChecked()));
  langsBack[0] && langsBack[1] && !langsBack[2]
    ? ok('LEARNING LOOP: check-all group refilled every stored value, and only those')
    : no(`check-all refilled Python=${langsBack[0]} Go=${langsBack[1]} Java=${langsBack[2]}`);

  // A click alone leaves this one where it started, so filling it proves the
  // filler falls back to setting the state rather than reporting a failure.
  await page.locator('input[name=fighty]').isChecked()
    ? ok('LEARNING LOOP: a checkbox that undoes clicks is still filled')
    : no('click-resistant checkbox was not filled on pass 2');

  const pronounsBack = await Promise.all(['He/him', 'They/them', 'She/her'].map(v =>
    page.locator(`input[name=pronouns][value="${v}"]`).isChecked()));
  pronounsBack[0] && pronounsBack[1] && !pronounsBack[2]
    ? ok('LEARNING LOOP: the name-grouped question refilled from its own key')
    : no(`pronouns refilled He/him=${pronounsBack[0]} They/them=${pronounsBack[1]} She/her=${pronounsBack[2]}`);

  const chipsBack = await page.evaluate(() =>
    [...document.querySelectorAll('#skills_chips .select__multi-value__label')].map(c => c.textContent));
  chipsBack.includes('Machine Learning (ML)') && chipsBack.includes('Writing')
    ? ok(`LEARNING LOOP: chips multi-select refilled every stored value (${chipsBack.join(', ')})`)
    : no(`chips refilled as ${JSON.stringify(chipsBack)}`);

  // ── never clobber the user ───────────────────────────────────────
  await page.reload();
  await page.waitForTimeout(600);
  await page.fill('#first_name', 'DoNotOverwrite');
  await fillViaMessage(optionsPage);
  await val('#first_name') === 'DoNotOverwrite'
    ? ok('user-entered value survives a fill pass')
    : no(`user value clobbered: "${await val('#first_name')}"`);

  // ── fill on load (opt-in) ────────────────────────────────────────
  // Off by default, so nothing above this point was filled without a message.
  const setAutoFill = on => optionsPage.evaluate(async value => {
    const { updateSettings } = await import('../content/store.js');
    return (await updateSettings({ autoFillOnLoad: value })).autoFillOnLoad;
  }, on);

  await setAutoFill(true);
  const auto = await ctx.newPage();

  /** Poll for a value rather than sleeping: the pass waits for the form to settle. */
  const waitForValue = async (selector, ms = 12000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = await auto.inputValue(selector).catch(() => '');
      if (v) return v;
      await auto.waitForTimeout(300);
    }
    return '';
  };

  await auto.goto(`http://localhost:${PORT}/greenhouse.html`);
  await waitForValue('#first_name') === 'Anmol'
    ? ok('AUTO: the form filled on load, with no click and no fill message')
    : no(`auto-fill on load left first name = "${await auto.inputValue('#first_name')}"`);
  // An unasked pass must still say what it did: the panel is the only place a
  // fill nobody clicked for is visible before the form is submitted. Polled,
  // because the value above lands mid-pass and the panel renders at the end.
  let autoPanel = '';
  for (let i = 0; i < 20 && !autoPanel.includes('filled'); i++) {
    autoPanel = await panelText(auto);
    if (!autoPanel.includes('filled')) await auto.waitForTimeout(300);
  }
  autoPanel.includes('filled')
    ? ok('AUTO: the summary panel reports the unasked pass')
    : no(`auto pass rendered no panel: "${autoPanel.slice(0, 80)}"`);

  await setAutoFill(false);
  await auto.reload();
  await auto.waitForTimeout(4000);
  (await auto.inputValue('#first_name')) === ''
    ? ok('AUTO: turning the toggle off stops the on-load pass')
    : no(`fields still filled on load with the toggle off: "${await auto.inputValue('#first_name')}"`);
  await auto.close();

  // ── the page must not be able to break the panel ──────────────────
  // Ashby sets line-height: 0 on divs, which collapsed the panel's text onto
  // itself. The panel lives in a shadow root so page CSS cannot reach it.
  // Two overlapping fill requests. Passes are serialized, because `filling` is
  // one boolean cleared at one place: whichever pass finished first used to
  // clear it while the other was still writing, which is exactly when capture
  // starts recording our own writes as the user's answers.
  const [rA, rB] = await Promise.all([fillViaMessage(optionsPage), fillViaMessage(optionsPage)]);
  await page.waitForTimeout(500);
  rA?.ok && rB?.ok && rA.failed === 0 && rB.failed === 0
    ? ok('two overlapping fill requests both complete cleanly')
    : no(`overlapping fills: ${JSON.stringify([rA?.failed, rB?.failed])}`);
  const chipCount = await page.evaluate(() =>
    document.querySelectorAll('#skills_chips .select__multi-value__label').length);
  chipCount === 2
    ? ok('overlapping fills did not double-apply a multi-value field')
    : no(`chips after overlapping fills: ${chipCount}`);

  const hostile = await ctx.newPage();
  await hostile.goto(`http://localhost:${PORT}/hostile-css.html`);
  await hostile.waitForTimeout(700);
  await optionsPage.evaluate(async port => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/hostile-css.html` });
    return chrome.tabs.sendMessage(tab.id, { type: 'fill' });
  }, PORT);
  await hostile.waitForTimeout(600);

  const panelStyle = await hostile.evaluate(() => {
    const host = document.getElementById('job-autofill-panel');
    const panel = host?.shadowRoot?.querySelector('.ja-panel');
    if (!panel) return null;
    const s = getComputedStyle(panel);
    return {
      lineHeight: parseFloat(s.lineHeight),
      fontSize: parseFloat(s.fontSize),
      height: Math.round(panel.getBoundingClientRect().height),
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
    };
  });
  if (!panelStyle) {
    no('panel did not render on the hostile page');
  } else {
    panelStyle.lineHeight > 12
      ? ok(`panel keeps its line-height under hostile CSS (${panelStyle.lineHeight}px)`)
      : no(`page CSS collapsed the panel's line-height to ${panelStyle.lineHeight}px`);
    panelStyle.fontSize <= 14
      ? ok(`panel keeps its font-size (${panelStyle.fontSize}px)`)
      : no(`page CSS forced the panel font to ${panelStyle.fontSize}px`);
    panelStyle.textTransform === 'none' && panelStyle.letterSpacing === 'normal'
      ? ok('panel resists inherited text-transform and letter-spacing')
      : no(`panel inherited ${panelStyle.textTransform} / ${panelStyle.letterSpacing}`);
    panelStyle.height > 40
      ? ok(`panel renders at a usable height (${panelStyle.height}px)`)
      : no(`panel collapsed to ${panelStyle.height}px`);
  }
  await hostile.close();

  // ── a stored resume must not take the pass down with it ──────────
  //
  // Every check above runs with no resume stored, so the file input always
  // took the "you attach it yourself" path and the attach path was never
  // executed. It threw: the success branch pushed a bare field onto the
  // re-read queue, whose entries are {field, value} pairs, so the destructure
  // hit undefined. The fields still filled, then the pass died before it could
  // answer, so the popup got nothing and the panel never rendered - the whole
  // Needs-you list disappeared on the one setup that has a resume stored.
  {
    await optionsPage.evaluate(async () => {
      const { setResume } = await import('../content/store.js');
      await setResume({ name: 'resume.pdf', type: 'application/pdf',
        base64: btoa('%PDF-1.4 fixture resume') });
    });
    // A distinct URL, so this pass is addressed to THIS tab. The fixture page
    // from the checks above is still open, and tabs.query returns it first:
    // aiming at "the localhost tab" filled the old one and then asserted on
    // this one, which reads as the resume never attaching.
    const withResume = await ctx.newPage();
    await withResume.goto(`http://localhost:${PORT}/greenhouse.html?resume=1`);
    await withResume.waitForTimeout(500);
    const report = await optionsPage.evaluate(async port => {
      const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*resume=1*` });
      return chrome.tabs.sendMessage(tab.id, { type: 'fill' });
    }, PORT).catch(() => null);

    if (report && report.ok) ok('fill still reports back with a resume stored');
    else no('fill returned nothing with a resume stored (the pass threw)');

    if (report && typeof report.filled === 'number' && report.filled > 0) {
      ok(`resume-stored pass filled ${report.filled} field(s)`);
    } else {
      no('resume-stored pass reported no filled count');
    }

    // The header count and the list it heads must agree, or the panel says
    // "1 needs you" over three rows.
    if (report && report.unknown === (report.unknowns || []).length) {
      ok(`needs-you count matches its list (${report.unknown})`);
    } else {
      no(`needs-you count ${report?.unknown} does not match list length ${(report?.unknowns || []).length}`);
    }

    const files = await withResume.evaluate(() => ({
      resume: document.getElementById('resume')?.files.length ?? -1,
      coverLetter: document.getElementById('cover_letter')?.files.length ?? -1,
    }));
    files.resume === 1 ? ok('the stored resume was attached to the resume input')
      : no(`resume input holds ${files.resume} file(s)`);

    // Greenhouse labels both uploads "Attach" and gives them the same accept
    // list, so filling every file input put the resume in the Cover Letter
    // slot too. That one goes out with the application.
    files.coverLetter === 0 ? ok('the cover-letter upload was left alone')
      : no(`the resume was attached to the cover-letter input (${files.coverLetter} file(s))`);

    (report.unknowns || []).some(u => /cover/i.test(u.rawLabel))
      ? ok('the cover-letter upload is reported under Needs you')
      : no('the cover-letter upload was neither filled nor reported');

    await withResume.close();
    await optionsPage.evaluate(async () => {
      const { clearResume } = await import('../content/store.js');
      await clearResume();
    });
  }

  const uniqueErrors = [...new Set(scriptErrors)];
  uniqueErrors.length === 0
    ? ok('the content script threw nothing')
    : no(`content script errors: ${uniqueErrors.join(' | ').slice(0, 300)}`);

} catch (err) {
  no(`harness threw: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 8).join('\n'));
} finally {
  await ctx.close();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
