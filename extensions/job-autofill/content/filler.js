/**
 * filler.js — value-setting primitives.
 *
 * React (Workday, Ashby, new Greenhouse) installs a per-node value tracker in
 * the MAIN world. Because content scripts run in an isolated world with their
 * own copy of the DOM prototypes, assigning through the native prototype setter
 * here bypasses that tracker, and the dispatched input/change events still
 * cross world boundaries so React re-reads the node and accepts the value.
 */

import { readValue } from './engine.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function setNativeValue(el, value) {
  // The node's OWN prototype first, so a textarea, an input, or some exotic
  // element subclass all resolve without a type test, with the two concrete
  // prototypes as the fallback for a stand-in that has no useful chain.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) ?? {}, 'value')?.set
    || Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Type a value the way a keyboard would.
 *
 * `insertText` produces the same beforeinput/input pair the browser generates
 * for real typing, so a framework that listens for those (rather than reading
 * .value) sees a genuine edit. The native setter alone leaves some masked and
 * validated inputs holding text their own handler never processed, which is how
 * a field ends up looking filled and still failing validation on submit.
 *
 * Returns false when the command is unavailable or refused, so the caller can
 * fall back rather than assume it worked.
 */
function insertTextValue(el, value) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  try {
    el.focus();
    el.select?.();
    document.execCommand('selectAll', false, null);
    const ok = document.execCommand('insertText', false, value);
    return ok && acceptedValue(el.value, value);
  } catch {
    return false;
  }
}

export function fillText(field, value) {
  const el = field.control;
  el.focus();
  // Typing first, assignment second. Both end with input/change dispatched, so
  // a framework reading either path still sees the value.
  if (!insertTextValue(el, value)) setNativeValue(el, value);
  else {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  el.blur();
  return acceptedValue(el.value, value) && !rejectedByWidget(el);
}

/**
 * Did the widget itself flag what we wrote?
 *
 * A masked or validated input can hold exactly the right characters and still
 * be marked invalid: a date box that wants a different order, a phone field
 * that wants no country code. Reporting those as filled sends the user to
 * submit a form that will bounce, so the widget's own verdict is read back and
 * a flagged field is reported as needing them instead.
 */
function rejectedByWidget(el) {
  return el.getAttribute?.('aria-invalid') === 'true';
}

/**
 * Did the control accept what we wrote?
 *
 * Not string equality. Masked inputs rewrite as they accept: a phone widget
 * turns "+1-412-689-3928" into "+1 412-689-3928", which is a success, and
 * calling it a failure sends the user hunting for a field that is already
 * correct. Compare on alphanumerics so formatting is ignored, while a control
 * that cleared, truncated, or replaced the value still reads as a failure.
 */
function acceptedValue(actual, intended) {
  const a = String(actual ?? '');
  if (!a.trim()) return false;
  if (a === intended) return true;
  const bare = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return bare(a) === bare(intended);
}

export function fillNativeSelect(field, option) {
  const el = field.control;
  el.focus();
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return el.value === option.value;
}

export function fillRadio(field, option) {
  option.el.click();
  // Same fallback as fillCheckbox, for a board whose own handler undoes ours.
  if (!option.el.checked) {
    option.el.checked = true;
    option.el.dispatchEvent(new Event('input', { bubbles: true }));
    option.el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return option.el.checked;
}

export function fillCheckbox(field, option, checked = true) {
  const target = option?.el || field.control;
  if (target.checked !== checked) target.click();
  // A board that runs its own handler on the label toggles the box a SECOND
  // time, so the click lands back where it started. Spotify's consent box on
  // Lever does exactly that: `change` fires with checked true, then the box
  // goes back to false, and the fill was reported as failed. Radios are immune
  // (a second activation leaves one set), checkboxes are not.
  // A plain assignment is correct HERE, and only here: this runs in the
  // extension's isolated world, which has its own wrapper for the node, so a
  // framework's value tracker (an own property installed on the page's wrapper)
  // is not in the path at all. Verified by emulating React's tracker in the
  // fixture: it reports the write as a change either way. That also means the
  // hazard cannot be reproduced from a page fixture, so there is no test here.
  if (target.checked !== checked) {
    target.checked = checked;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return target.checked === checked;
}

/**
 * Attach a file to an `<input type=file>`.
 *
 * The README used to say this was impossible. It is not, and every comparable
 * extension does it: the user-gesture rule governs OPENING the picker, while
 * `.files` is writable through a DataTransfer. What an extension cannot do is
 * conjure the bytes, which is why the resume is stored first and rebuilt here.
 *
 * A board that already holds an upload gets it cleared first, or Workday ends
 * up with the same resume attached twice. Modern Greenhouse job-boards are
 * skipped here: their S3 uploader is created only by the Attach file chooser,
 * and a synthetic change event renders `uploadFile` as a Resume-slot error.
 *
 * @param {{control: Element}} field
 * @param {{name: string, type: string, base64: string}} resume
 */
export function fillFileInput(field, resume) {
  // job-boards.greenhouse.io owns an S3 uploader that is created only after
  // the visible Attach control opens the file chooser. Assigning `.files` and
  // dispatching `change` from the isolated world calls that handler before the
  // uploader exists, and Greenhouse renders
  // `Cannot read properties of undefined (reading 'uploadFile')` on the Resume
  // slot. The headed runner attaches through that Attach chooser instead.
  if (isModernGreenhouseHost()) return false;

  const el = field.control;
  if (typeof DataTransfer === 'undefined') return false;

  const file = fileFromBase64(resume);
  if (!file) return false;

  try {
    for (const remove of existingUploadRemovers(el)) remove.click();

    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    return el.files?.length === 1 && el.files[0].name === resume.name;
  } catch {
    return false;
  }
}

function isModernGreenhouseHost() {
  try {
    return /^job-boards\.greenhouse\.io$/i.test(location.hostname);
  } catch {
    return false;
  }
}

/** Buttons a board offers for discarding the file it already has. */
function existingUploadRemovers(el) {
  const scope = el.closest('.file-upload, .field-wrapper, [data-automation-id]')
    || el.parentElement
    || document;
  return [...scope.querySelectorAll(
    '[data-automation-id="delete-file"], .dz-remove[data-dz-remove]'
  )];
}

/**
 * Words that name the upload slot a stored resume belongs in, and the ones that
 * name a slot it must never be dropped into.
 *
 * Greenhouse renders Resume/CV and Cover Letter as the same control: both are
 * labelled "Attach", both accept the same file types, and only the id and the
 * surrounding heading say which is which. Filling every file input therefore
 * submitted the resume as the cover letter as well, which is not a display
 * glitch - that file goes to the employer.
 */
const RESUME_SLOT = /\b(?:resume|resum|cv|curriculum\s*vitae)\b/i;
const NOT_RESUME_SLOT =
  /\b(?:cover[\s_-]*letter|transcript|portfolio|writing[\s_-]*sample|photo|passport|certificate|reference|other)\b/i;

/**
 * Is this file input the one the stored resume belongs in?
 *
 * Reads the identifiers first, because they are the only part a board is
 * consistent about, then falls back to the nearest text that names the slot.
 * Unnamed and ambiguous inputs answer false: leaving an upload for the user is
 * a small cost, and attaching the wrong document to an application is not.
 */
export function isResumeInput(el, resolvedLabel = '') {
  // Underscores and hyphens become spaces before matching. `\b` treats an
  // underscore as a word character, so NOT_RESUME_SLOT never matched an id like
  // "cover_letter_attach" — there is no word boundary between "letter" and "_".
  // The veto silently did not fire on exactly the naming style boards use.
  const ids = [el.id, el.name, el.getAttribute('aria-label'),
    el.getAttribute('data-automation-id')].filter(Boolean).join(' ')
    .replace(/[_-]+/g, ' ');
  if (NOT_RESUME_SLOT.test(ids)) return false;
  if (RESUME_SLOT.test(ids)) return true;

  // The label the engine already resolved, which can see things this function
  // cannot. Workday's upload carries no id, name or aria-label at all
  // (`data-automation-id="file-upload-input-ref"`), points aria-labelledby at a
  // node outside the ancestor chain, and puts "Upload a file (5MB max)" on the
  // nearest label — so the walk below never met the word "Resume" and the
  // resume was silently never attached on any Workday application.
  //
  // Checked after the id signals, never before: on Greenhouse both uploads are
  // labelled "Attach" and only the id separates them, and a NOT_RESUME_SLOT id
  // must keep winning so the resume cannot land in the cover-letter slot.
  if (resolvedLabel) {
    if (NOT_RESUME_SLOT.test(resolvedLabel)) return false;
    if (RESUME_SLOT.test(resolvedLabel)) return true;
  }

  // No usable identifier: read outward until some container names the slot.
  // The label itself is no help - Greenhouse writes "Attach" on both.
  let node = el.parentElement;
  for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (text.length > 200) break;
    if (NOT_RESUME_SLOT.test(text)) return false;
    if (RESUME_SLOT.test(text)) return true;
  }
  return false;
}

function fileFromBase64({ base64, name, type }) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: type || 'application/pdf' });
  } catch {
    return null;
  }
}

/**
 * A date split across separate month/day/year boxes (Workday).
 *
 * The parts carry no question of their own: their accessible names are "Month",
 * "Day" and "Year", so filling them individually both misses the real question
 * and teaches the answer bank three junk keys. They are filled as one field.
 *
 * Each part is written and dispatched separately because the widget validates
 * per box and rebuilds its combined value from all three.
 *
 * @param {{members: Element[]}} field  parts in [month, day, year] order
 * @param {string} value  any date the store holds, e.g. "12/20/2026"
 */
export function fillDateParts(field, value) {
  const parts = parseDate(value);
  if (!parts) return false;

  const boxes = field.members;
  // Three boxes are month/day/year; two are month/year, which is what Workday's
  // work history asks for. `datePartMembers` builds the list in that order, so
  // dropping the middle entry is what a two-box widget wants.
  if (boxes.length < 2 || boxes.length > 3) return false;
  const wanted = boxes.length === 3 ? parts : [parts[0], parts[2]];
  // A three-box widget needs a real day, and a year-month value has none.
  if (wanted.some(part => String(part ?? '').trim() === '')) return false;

  for (const [i, box] of boxes.entries()) {
    box.focus();
    setNativeValue(box, wanted[i]);
    box.blur();
  }
  // Trailing zeros are the widget's business: Workday renders "08" back as "8".
  // Comparing numerically keeps that from reading as a failed write.
  return boxes.every((box, i) => Number(box.value) === Number(wanted[i]))
    && !boxes.some(rejectedByWidget);
}

/**
 * Split a stored date into [month, day, year].
 *
 * Only unambiguous forms are accepted. A bare "01/02/2027" is a real ambiguity
 * between January 2nd and February 1st, and guessing it wrong puts a wrong
 * start date in front of an employer, so the US order is assumed ONLY because
 * these are US boards and that is what the widget itself renders (MM/DD/YYYY).
 * Anything that does not parse cleanly returns null and the field is left for
 * the user.
 */
export function parseDate(value) {
  const raw = String(value ?? '').trim();

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return [iso[2], iso[3], iso[1]];

  // Year-month, which is how a work history is stored ("2026-05"): there is no
  // day, and inventing one would put a precise start date in front of an
  // employer that the profile never claimed. Only a month+year widget can use
  // this, and fillDateParts refuses it for a three-box date.
  const month = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (month) return [month[2], '', month[1]];

  const slashed = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashed) {
    const [, m, d, y] = slashed;
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return [m, d, y];
  }
  return null;
}

/**
 * Generic ARIA combobox/listbox: click the trigger, wait for the options to
 * render (they often mount in a detached container at the end of <body>),
 * click the matching option.
 */
export async function fillListbox(field, matchOptionFn, { openDelay = 200, timeout = 2500 } = {}) {
  const trigger = field.control;
  trigger.click();

  const deadline = Date.now() + timeout;
  let listbox = null;
  while (Date.now() < deadline) {
    await sleep(80);
    const candidates = [...document.querySelectorAll('[role="listbox"], [role="menu"]')]
      .filter(l => l.offsetParent !== null || l.getBoundingClientRect().height > 0);
    if (candidates.length) {
      listbox = candidates[candidates.length - 1];
      if (listbox.querySelector('[role="option"], [role="menuitem"]')) break;
    }
  }
  if (!listbox) return false;

  await sleep(openDelay);
  const optionEls = [...listbox.querySelectorAll('[role="option"], [role="menuitem"]')];
  const options = optionEls.map(el => ({
    el,
    value: el.getAttribute('data-value') || el.textContent.trim(),
    text: el.textContent.replace(/\s+/g, ' ').trim(),
  }));

  const chosen = matchOptionFn(options);
  if (!chosen) {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  chosen.el.click();
  await sleep(150);
  return true;
}

/**
 * Is this value already one of the widget's chips?
 *
 * Re-adding it is at best a no-op and at worst a duplicate, and on a re-run of
 * "Fill this step" every skill would be attempted again for nothing. Both
 * Simplify and Jobright gate their whole multiselect sequence on this.
 */
export function alreadySelected(chips, value) {
  const want = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return false;
  return chips.some(text => {
    const have = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return have === want || have.startsWith(want + ' ') || have.startsWith(want + ',');
  });
}

/**
 * Close the menu and take focus off the widget.
 *
 * Workday leaves its popup open after a commit, so without this the search
 * results sat over the rest of the form. Escape closes it. Click-away is
 * Workday-only (`applyFlowPage`); Greenhouse `main` clicks can collapse
 * custom questions and clear committed react-select values.
 */
function dismissPopup(el, { clickAway = true } = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
  }));
  el.blur?.();
  if (!clickAway) return;
  // Workday needs a click outside the listbox to close it. Never click
  // Greenhouse `main` / #mainContent: that click can collapse custom
  // questions and clear committed react-select values.
  const away = document.querySelector('[data-automation-id="applyFlowPage"]');
  if (away) fireMouse(away);
}

export const REQUIRED_COMBOBOX_SNAPSHOT_LIMIT = 12;

export function shouldSnapshotRequiredCombobox(adapter, field, read = readValue) {
  if (adapter?.id !== 'greenhouse' || adapter.needsInspectOptionSnapshot?.(field) !== true) return false;
  // Opening a filled react-select and sending Escape clears the committed
  // option. Inspect only needs options on still-empty widgets.
  if (!field?.control) return true;
  try {
    if (read(field)) return false;
  } catch { /* Snapshot the empty widget anyway. */ }
  return true;
}

/**
 * Open a required Greenhouse react-select, copy visible options, dismiss.
 * Never clicks an option and never types a filter, so inspect cannot commit
 * an answer. Optional comboboxes stay lazy until fill.
 */
export async function snapshotComboboxOptions(field, { timeout = 1200 } = {}) {
  const el = field?.control;
  if (!el) return [];
  const preexisting = optionSnapshot();
  const control = el.closest('[class*="select__control"]')
    || el.closest('[data-automation-id="multiselectInputContainer"]')
    || el.parentElement?.parentElement
    || el;
  const beforeValue = el.value;
  el.focus();
  fireMouse(control);
  if (control !== el) fireMouse(el);
  const options = await waitForOptions(el, timeout, preexisting);
  dismissPopup(el, { clickAway: false });
  if (el.value !== beforeValue) setNativeValue(el, beforeValue);
  return options.map(option => ({
    text: option.text,
    value: option.value || option.text,
  }));
}

export async function attachRequiredComboboxOptions(fields, adapter, snapshot = snapshotComboboxOptions) {
  if (!Array.isArray(fields) || adapter?.id !== 'greenhouse') return fields;
  let used = 0;
  for (const field of fields) {
    if (used >= REQUIRED_COMBOBOX_SNAPSHOT_LIMIT) break;
    if (!shouldSnapshotRequiredCombobox(adapter, field)) continue;
    used += 1;
    try {
      const options = await snapshot(field, { timeout: 1200 });
      if (options.length) field.options = options;
    } catch { /* Keep inspecting the rest of the form. */ }
  }
  return fields;
}

/**
 * Combobox text inputs (react-select on the current Greenhouse board, Ashby).
 * Typing filters the menu but commits nothing: the widget throws the text away
 * on blur unless an option is clicked. So type to filter, match against what
 * actually rendered, click it, and clear the box if nothing matches rather
 * than leaving stray text behind.
 *
 * @returns {Promise<'filled'|'unmapped'|'failed'>}
 */
export async function fillCombobox(field, value, pickOption, { timeout = 3000 } = {}) {
  const el = field.control;
  // Anything already on screen is not this widget's menu.
  const preexisting = optionSnapshot();
  // Workday commits the highlighted item on the same Enter that runs its
  // search, so what the widget holds before we touch it is the only baseline
  // that distinguishes our pick from its guess.
  const chipsBefore = multiselectChips(el).map(c => c.text);
  // Nothing to do if the widget already holds this value.
  if (alreadySelected(chipsBefore, value)) return 'filled';
  const control = el.closest('[class*="select__control"]')
    || el.closest('[data-automation-id="multiselectInputContainer"]')
    || el.parentElement?.parentElement
    || el;

  el.focus();
  fireMouse(control);
  // Workday opens its prompt from the input itself, react-select from the
  // surrounding control. Poking both costs nothing and covers both.
  if (control !== el) fireMouse(el);

  let options = await waitForOptions(el, timeout, preexisting);

  // Long or async-backed lists (country, school, city) render nothing until
  // filtered. Search on a PREFIX, not the whole answer: Ashby's location
  // search returns nothing for "Pittsburgh, Pennsylvania, United States" but
  // everything for "Pittsburgh". The full value is still what gets matched
  // against the results.
  if (!options.length) {
    applySearchText(el, searchQuery(value));
    options = await waitForOptions(el, 2000, preexisting);
  }
  if (!options.length) return abandon(el);

  let chosen = pickOption(options);

  // The answer may be further down a list that only filtering will surface.
  if (!chosen) {
    applySearchText(el, searchQuery(value));
    const filtered = await waitForOptions(el, 2000, preexisting);
    if (filtered.length) chosen = pickOption(filtered);
  }
  if (!chosen) {
    // Nothing matched, so any chip the search's Enter committed is pure noise.
    dropUnchosen(el, chipsBefore, '');
    dismissPopup(el);
    return abandon(el);
  }

  const chosenText = String(chosen.text || chosen.el?.textContent || '').replace(/\s+/g, ' ').trim();
  fireMouse(chosen.el);
  await sleep(250);
  dropUnchosen(el, chipsBefore, chosenText);
  dismissPopup(el);
  // Whether it truly committed is confirmed by the verification pass in main.js.
  return 'filled';
}

/**
 * The chips a Workday multiselect currently holds.
 *
 * Each is `[data-automation-id="selectedItem"]` carrying an aria-label of
 * "<value>, press delete to clear value." and a DELETE_charm that removes it.
 */
function multiselectChips(el) {
  const container = el.closest?.(
    '[data-automation-id="multiSelectContainer"],'
    + '[data-automation-id="multiselectInputContainer"]'
  );
  if (!container) return [];
  return [...container.querySelectorAll('[data-automation-id="selectedItem"]')].map(node => ({
    node,
    text: String(node.getAttribute('aria-label') || node.textContent || '')
      .replace(/,\s*press delete to clear value\.?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

/**
 * Which chips appeared that we did not choose.
 *
 * Workday's skills prompt runs its search on Enter — the value otherwise sits
 * there and no request is ever made — but the SAME Enter commits whatever the
 * widget had highlighted. So searching for "Computer Science" silently added
 * "Finished Products" to a real application, and searching again compounded it.
 * Anything that arrived without us clicking it has to come back off.
 *
 * Pure, so the rule can be tested without a browser.
 */
export function unchosenChips(before, after, chosen) {
  const seen = new Map();
  for (const t of before) seen.set(t, (seen.get(t) || 0) + 1);
  const want = String(chosen || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const extra = [];
  for (const chip of after) {
    const left = seen.get(chip.text) || 0;
    if (left > 0) { seen.set(chip.text, left - 1); continue; }
    // New since we started. Keep it only if it is what we picked.
    if (want && chip.text.toLowerCase() === want) continue;
    extra.push(chip);
  }
  return extra;
}

/**
 * Is this Workday's moniker search box rather than a filter-as-you-type menu?
 *
 * Workday wraps the input in a multiselect container and, once there is text,
 * swaps the plain box for a `monikerSearchBox` with its own submit button. Both
 * markers are checked because the moniker id only appears after the value is
 * written, while the container is there from the start.
 */
function isPromptSearchBox(el) {
  return !!el.closest?.(
    '[data-automation-id="multiSelectContainer"],'
    + '[data-automation-id="multiselectInputContainer"],'
    + '[data-automation-id="monikerSearchBox"]'
  );
}

/** Remove every chip that arrived without us choosing it. */
function dropUnchosen(el, chipsBefore, chosenText) {
  for (const chip of unchosenChips(chipsBefore, multiselectChips(el), chosenText)) {
    chip.node.querySelector('[data-automation-id="DELETE_charm"]')?.click();
  }
}

/**
 * Write a search term and, where the widget demands it, submit it.
 *
 * Most menus filter on `input` alone. Workday's skills and field-of-study
 * prompts do not: the value sits there and no request is ever made, so the
 * options never arrive and the field reads as an empty taxonomy. The search
 * runs on Enter.
 *
 * Enter is NOT sent to every widget. react-select commits its focused option on
 * Enter, so firing it blindly would select whatever happened to be highlighted
 * on Greenhouse and Ashby, which is how you silently answer a question wrong.
 *
 * The widget's own magnifier is deliberately not clicked either. A real click
 * moves focus out of the input, and Workday's blur handler wipes the text
 * before the search reads it, so the request goes out with an empty term.
 * Keeping focus and submitting from the keyboard is what makes it work.
 */
export function applySearchText(el, query) {
  setNativeValue(el, query);
  if (!isPromptSearchBox(el)) return;
  for (const type of ['keydown', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  }
}

/**
 * What to type into a type-to-search dropdown.
 *
 * Its backend matches a prefix, not a full formatted label, so the leading
 * segment is the part that finds anything: "Pittsburgh, Pennsylvania, United
 * States" has to be searched as "Pittsburgh". Matching against the results
 * still uses the complete stored answer, so no precision is lost.
 */
export function searchQuery(value) {
  const full = String(value ?? '').trim();
  // Greenhouse's controlled US EEO menu calls this option simply "Asian".
  // Search for the board's term; `matchOption` retains the exact one-way
  // mapping and will still abstain if the board offers several possibilities.
  if (/^south asian$/i.test(full)) return 'Asian';
  const head = full.split(',')[0].trim();
  const query = head.length >= 2 ? head : full;
  return query.slice(0, 24);
}

/**
 * Open a custom dropdown.
 *
 * react-select opens on mousedown and ignores a bare .click(). Newer widgets
 * (Workday's prompt among them) bind pointer events instead, which mouse
 * events do not trigger, so both families are dispatched in the order a real
 * pointer produces them.
 */
function fireMouse(node) {
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  const pointerOpts = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const seq = [
    ['pointerdown', 'Pointer'], ['mousedown', 'Mouse'],
    ['pointerup', 'Pointer'], ['mouseup', 'Mouse'],
    ['click', 'Mouse'],
  ];
  for (const [type, family] of seq) {
    try {
      const event = family === 'Pointer' && typeof PointerEvent === 'function'
        ? new PointerEvent(type, pointerOpts)
        : new MouseEvent(type, opts);
      node.dispatchEvent(event);
    } catch {
      // A widget that rejects one event type should not stop the rest.
    }
  }
}

/**
 * Options belonging to THIS combobox. Scoped by walking up from the input and
 * taking the nearest ancestor whose subtree holds a menu, because a page can
 * have other option lists permanently in the DOM. The phone widget's country
 * list on Greenhouse is exactly that, and a document-wide query matches it.
 */
/**
 * Options belonging to THIS combobox.
 *
 * @param {Element} el       the combobox input
 * @param {Set<Element>} preexisting options already on the page before we
 *   opened anything. Boards keep option lists permanently mounted (Greenhouse's
 *   phone widget holds every country), so a document-wide search would happily
 *   return the wrong menu. Excluding what was already there means a portal-
 *   rendered menu can be found without that risk.
 */
/**
 * The container of the menu that is open RIGHT NOW.
 *
 * Workday marks it, and saying so beats inferring it: a snapshot diff of every
 * `[role=option]` on the page has to guess which menu a node belongs to, and a
 * board that keeps a list permanently mounted (Greenhouse's phone country list)
 * defeats the guess. Simplify's config scopes every one of its Workday option
 * lookups to exactly these two attributes.
 */
function activePopup(root = document) {
  return root.querySelector(
    '[data-automation-activepopup="true"], [data-automation-id="activeListContainer"]'
  );
}

/**
 * The widget saying it found nothing.
 *
 * Without this a term the taxonomy does not carry costs the full option
 * timeout, several seconds, and a six-skill fill spent most of a minute waiting
 * for menus that were never going to appear. It is also the difference between
 * "still loading" and "answered, and the answer is no".
 */
const NO_RESULTS_RE = /\b(no results|no matches|no items|nothing found|no options)\b/i;

export function saysNoResults(container) {
  if (!container) return false;
  const text = String(container.textContent || '').replace(/\s+/g, ' ').trim();
  // Only when the container has nothing to offer: a real result list can
  // legitimately contain the phrase inside one option's text.
  if (container.querySelector('[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"]')) {
    return false;
  }
  return NO_RESULTS_RE.test(text);
}

function optionsFor(el, preexisting) {
  // The open popup wins over any walk: it is the menu the user can see.
  const popup = activePopup();
  if (popup) {
    const opts = collectOptions(popup.querySelectorAll(
      '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"], [data-automation-id="menuItem"]'
    ), preexisting);
    if (opts.length) return opts;
  }

  let node = el;
  for (let depth = 0; depth < 8 && node; depth++) {
    const menu = node.querySelector?.('[class*="select__menu"], [role="listbox"]');
    if (menu) {
      const opts = collectOptions(menu.querySelectorAll('[role="option"], [class*="select__option"]'), preexisting);
      if (opts.length) return opts;
    }
    node = node.parentElement;
  }

  // Menus rendered into a portal are never an ancestor of the input, so the
  // walk above cannot see them: Workday's prompt popup and Ashby's listbox
  // both live at body level.
  return collectOptions(document.querySelectorAll(
    '[data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], [role="option"]'
  ), preexisting);
}

/** Visible option elements present right now, used as the exclusion baseline. */
function optionSnapshot() {
  return new Set([...document.querySelectorAll(
    '[role="option"], [class*="select__option"], .dropdown-location'
  )]
    .filter(o => o.offsetParent !== null || o.getBoundingClientRect().height > 0));
}

function collectOptions(nodeList, preexisting, requireVisible = true) {
  return [...nodeList]
    .filter(o => !preexisting || !preexisting.has(o))
    // A silently-driven menu renders its results into a container that was
    // never displayed, so on that path presence in the DOM is the only signal
    // available. The preexisting baseline is what keeps stale menus out.
    .filter(o => !requireVisible || o.offsetParent !== null || o.getBoundingClientRect().height > 0)
    .map(o => ({
      el: o,
      value: o.getAttribute('data-value') || o.getAttribute('data-automation-label') || o.textContent.trim(),
      text: (o.getAttribute('data-automation-label') || o.textContent).replace(/\s+/g, ' ').trim(),
    }))
    .filter(o => o.text);
}

async function waitForOptions(el, timeout, preexisting) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(100);
    const options = optionsFor(el, preexisting);
    if (options.length) return options;
    // Answered, and the answer is nothing. Waiting out the rest of the timeout
    // buys no information and is most of what made a multi-value fill slow.
    if (saysNoResults(activePopup())) return [];
  }
  return [];
}

/** Leave no stray text behind in a widget we could not resolve. */
function abandon(el) {
  setNativeValue(el, '');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  el.blur();
  return 'unmapped';
}

const TYPEAHEAD_OPTIONS =
  '.dropdown-location, [role="option"], .aa-suggestion, .dropdown-item, li[data-value]';

/**
 * Server-backed autocomplete inputs (Lever's location field).
 *
 * Lever's own retrieveLocations.js dictates every step here:
 *   - the search runs on `keydown`, debounced 500ms, so a value written through
 *     the native setter alone never queries anything;
 *   - `blur` wipes both the visible input and the hidden #selected-location
 *     unless the dropdown has already been dismissed by a selection, which is
 *     why typing and tabbing away leaves the field empty;
 *   - a result commits on `mousedown` against a `.dropdown-location`, which is
 *     what fills #selected-location with the structured location the form
 *     actually submits.
 *
 * So: type a prefix, fire a key, wait for results, match the FULL stored value
 * against them, and commit by mouse. Never blur first.
 *
 * @returns {Promise<'filled'|'unmapped'>} 'unmapped' when nothing matched, so
 *   the field is reported as needing the user rather than silently wrong.
 */
export async function simulateTyping(
  field, value, pickOption, { timeout = 4000, announceInput = true } = {}
) {
  const el = field.control;
  // Baseline includes hidden options: on the silent path the menu never becomes
  // visible, so a visible-only snapshot would exclude nothing.
  const preexisting = new Set(document.querySelectorAll(TYPEAHEAD_OPTIONS));
  el.focus();

  const query = searchQuery(value);
  if (announceInput) setNativeValue(el, query);
  else writeSilently(el, query);
  fireKey(el, query.slice(-1) || 'a');

  const options = await waitForTypeahead(preexisting, timeout, announceInput);
  // Matching uses the full stored value, not the prefix that was typed: the
  // results are near-identical ("Pittsburgh, Pennsylvania" vs "Pittsburg,
  // Kansas") and picking the first one is how you tell an employer you live in
  // the wrong state.
  const chosen = options.length && pickOption ? pickOption(options) : null;
  if (!chosen) {
    // Clear silently too: an input event here would re-open the dropdown and
    // hand the blur handler a reason to fire.
    writeSilently(el, '');
    return 'unmapped';
  }

  fireMouse(chosen.el);
  await sleep(250);
  return 'filled';
}

/**
 * Set a value without announcing it.
 *
 * Lever shows its location dropdown on `input`, and its blur handler erases
 * both the input and the hidden #selected-location whenever that dropdown is
 * open. Something on the page (the captcha frame) takes focus a moment after
 * the field is touched, so announcing the write reliably destroys it. Staying
 * silent keeps the dropdown closed, which makes the blur handler a no-op, while
 * the keydown below still runs the search.
 */
function writeSilently(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** A real key event, since jQuery-era widgets bind keydown rather than input. */
function fireKey(el, key) {
  for (const type of ['keydown', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }
}

async function waitForTypeahead(preexisting, timeout, requireVisible) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(150);
    const options = collectOptions(
      document.querySelectorAll(TYPEAHEAD_OPTIONS), preexisting, requireVisible
    );
    if (options.length) return options;
  }
  return [];
}
