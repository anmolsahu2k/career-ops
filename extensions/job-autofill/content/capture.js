/**
 * capture.js — the learning loop.
 *
 * Armed on every board page at load, not only after a fill, so answers typed
 * during a fully manual application are still learned. Capture is silent; the
 * options page is where the user reviews what was saved.
 */

import {
  detectFields, resolveLabel, resolveFieldLabel, isHoneypot, groupIndexOf, isCredentialScreen,
  isSearchControl, isGenericLabel, isPlaceholderValue, readValue, groupMembers, datePartOf,
} from './engine.js';
import { normalizeKey, canonicalFieldFor, looksOpaqueId, joinMulti } from './matcher.js';
import { upsertAnswer, upsertJobScopedAnswer } from './store.js';
import { detectCompany } from './adapters/index.js';

const SKIP_TYPES = new Set(['password', 'hidden', 'file', 'submit', 'button']);

/**
 * @param {object} opts
 * @param {object} opts.adapter        active board adapter
 * @param {Function} opts.weWrote      (control, value) => boolean, true when we put that value there
 * @param {Function} opts.onLearned    (control, entry) => void
 * @param {Function} opts.onProfileField (control) => void, for a field that is
 *   deliberately not learned because it belongs to the profile
 * @param {Function} opts.wasUnresolved (control) => boolean, true when the fill
 *   pass could not answer this field
 * @param {Function} opts.isFilling  () => boolean, true while a fill is running
 */
export function armCapture({ adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling }) {
  const handler = event => {
    const el = event.target;
    if (!el || !el.tagName) return;
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    if (SKIP_TYPES.has((el.getAttribute('type') || '').toLowerCase())) return;
    if (blockedControl(el, adapter)) return;

    void captureFrom(el, { adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling });
  };

  // Capture phase: several boards stopPropagation on their own handlers.
  document.addEventListener('focusout', handler, true);
  document.addEventListener('change', handler, true);

  let pending = null;
  const rescan = () => {
    // Record any field seen for the first time BEFORE the click commits.
    // These boards render their form long after the content script arms, so
    // without this the first sighting of a control is the moment the user
    // answers it: that answer becomes the baseline and is never learned. It
    // cost the sponsorship question on an Ashby form, which is the single
    // answer most worth keeping.
    seedBaselines(adapter);
    // One trailing scan: a click storm should not run this per event. The delay
    // lets the widget commit its choice before it is read back.
    clearTimeout(pending);
    pending = setTimeout(
      () => void captureRendered({ adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling }),
      300
    );
  };
  // mousedown as well as click: these widgets commit their selection on
  // mousedown, and several stop the click that would follow.
  for (const type of WIDGET_EVENTS) document.addEventListener(type, rescan, true);

  // Record what everything shows before anything is touched, so the first
  // answer registers as a change rather than becoming the baseline.
  void captureRendered({ adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling });

  return () => {
    document.removeEventListener('focusout', handler, true);
    document.removeEventListener('change', handler, true);
    for (const type of WIDGET_EVENTS) document.removeEventListener(type, rescan, true);
    clearTimeout(pending);
  };
}

const WIDGET_EVENTS = ['mousedown', 'click', 'keyup'];

/**
 * Last value seen for a question, so only real changes are captured.
 *
 * Keyed by the normalized question rather than the element: clicking an Ashby
 * Yes/No pair replaces the buttons, so an element-keyed baseline treats the new
 * nodes as never-seen and skips the very answer that was just given.
 */
const shownValues = new Map();

/**
 * Note the current value of any field not seen before, without learning from
 * it. Called on mousedown, while the control still shows its previous state.
 */
function seedBaselines(adapter) {
  for (const field of renderedValueFields(adapter)) {
    const key = normalizeKey(field.rawLabel || '');
    if (!key || shownValues.has(key)) continue;
    shownValues.set(key, displayValue(field));
  }
}

/**
 * Guards that apply however a value arrives, by event or by scan.
 *
 * Repeated blocks are excluded because education and employment entries share
 * one label across every entry, so capturing there stores one school's dates
 * under a key that then fills all of them. Sign-in screens are excluded because
 * a login form's username would otherwise be learned as the answer to "Email".
 */
function blockedControl(el, adapter) {
  if (el.closest?.('#job-autofill-panel')) return true;
  if (isHoneypot(el)) return true;
  // A job search typed into a board's filter box is not an answer.
  if (isSearchControl(el)) return true;
  if (adapter?.skipPage?.(location.href)) return true;
  if (adapter?.formRoot) {
    const root = adapter.formRoot(document);
    if (!root || !root.contains(el)) return true;
  }
  if (isCredentialScreen()) return true;
  if (groupIndexOf(el) != null) return true;
  return false;
}

/** Dropdowns built as a button plus a detached popup, not as a form control. */
const WIDGET_TRIGGERS =
  'button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]';

/** Text inputs that are really dropdowns, whatever the board calls them. */
const COMBOBOX_INPUTS = [
  'input[role="combobox"]',
  'input[aria-autocomplete="list"]',
  'input[class*="select__input"]',
  '[data-automation-id="multiselectInputContainer"] input',
].join(', ');

/**
 * Controls whose committed value cannot be read from `el.value`.
 *
 * Two shapes, one problem. react-select (current Greenhouse) and Ashby keep the
 * chosen option in a rendered label while the input itself stays empty; Workday
 * builds the control as a button with its options in a detached popup.
 *
 * Deliberately NOT `detectFields`: that applies a visibility test, and
 * react-select drops its input to opacity 0 once a value is committed. That is
 * correct for filling, because nothing should be typed into an invisible box,
 * but it means an answered question disappears from the field list at exactly
 * the moment there is something to learn from it.
 */
function renderedValueFields(adapter) {
  const root = adapter?.formRoot ? adapter.formRoot(document) : document;
  if (!root) return [];
  const out = [];
  const seen = new Set();
  const push = field => {
    if (!field?.control || seen.has(field.control)) return;
    if (field.control.closest?.('#job-autofill-panel')) return;
    seen.add(field.control);
    out.push(field);
  };
  // The adapter first: it knows shapes a selector cannot describe, such as
  // Ashby's Yes/No pairs, which are two <button>s with no control behind them
  // and are how that board asks about work authorization and sponsorship.
  for (const field of adapter?.detectExtraFields?.(root) || []) push(field);

  const add = (el, kind) =>
    push({ control: el, kind, members: [el], rawLabel: resolveLabel(el, adapter).text });
  for (const el of root.querySelectorAll(COMBOBOX_INPUTS)) add(el, 'combobox-input');
  for (const el of root.querySelectorAll(WIDGET_TRIGGERS)) add(el, 'combobox');
  return out;
}

/** What the control shows now: a button's own text, otherwise its rendered value. */
function displayValue(field) {
  const el = field.control;
  // A segmented group's value is whichever button is active, not the first
  // one's text, which never changes.
  if (field.kind === 'buttongroup') return readValue(field);
  if (el.tagName === 'BUTTON') return (el.textContent || '').replace(/\s+/g, ' ').trim();
  return readValue(field);
}

/**
 * Learn from dropdowns that never fire a usable event.
 *
 * Picking a react-select option produces no `change` on the input, and the
 * input's own value stays empty, so answering a Greenhouse questionnaire by
 * hand was recorded as nothing at all. Watching what each control *displays*
 * covers that, Ashby, and Workday's button widgets with one mechanism.
 */
async function captureRendered({ adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling }) {
  // Our own fill clicks trigger this scan. Record what everything shows, so a
  // later user edit still reads as a change, but learn nothing from ourselves.
  const quiet = isFilling?.() === true;
  for (const field of renderedValueFields(adapter)) {
    const el = field.control;
    if (!el?.isConnected) continue;
    if (blockedControl(el, adapter)) continue;

    // Without a real question this would store several answers under one key,
    // and the next form would get whichever was written last.
    const normKey = normalizeKey(field.rawLabel || '');
    if (!normKey || isGenericLabel(field.rawLabel)) continue;

    const shown = displayValue(field);
    const previous = shownValues.get(normKey);
    shownValues.set(normKey, shown);

    if (quiet || previous === undefined || shown === previous) continue;
    // "Select One" is the widget back at its placeholder, not an answer. This
    // must not use the label test, which rejects anything under three
    // characters and so threw away every "No".
    if (isPlaceholderValue(shown) || looksOpaqueId(shown)) continue;
    if (weWrote?.(el, shown)) continue;
    if (canonicalFieldFor(normKey, field.kind) && !wasUnresolved?.(el)) {
      onProfileField?.(el, normKey);
      continue;
    }

    const entry = await upsertAnswer({
      rawQuestion: field.rawLabel,
      answer: shown,
      answerType: 'select',
      board: adapter?.id,
      source: 'captured',
      origin: {
        board: adapter?.id || 'generic',
        company: detectCompany(location.href),
        url: location.href.split('#')[0].slice(0, 300),
        title: document.title.replace(/\s+/g, ' ').trim().slice(0, 120),
      },
    });
    if (entry) onLearned?.(el, entry);
  }
}

async function captureFrom(el, { adapter, weWrote, onLearned, onProfileField, wasUnresolved, isFilling }) {
  // One box of a split date holds "08", which is not the answer to "What is
  // your desired start date?". Storing it would put a fragment under the real
  // question, or "8" under the key "month", depending on which label won. The
  // fill side treats the three boxes as one field; the learning side declines
  // to guess a whole date from a third of one.
  if (datePartOf(el)) return;

  // Group-aware: a checkbox's own label is the option, not the question.
  const { text: rawLabel } = resolveFieldLabel(el, adapter);
  if (!rawLabel) return;

  // fillText blurs, which fires focusout, so a fill reaches this path too.
  if (isFilling?.() === true) return;

  const normKey = normalizeKey(rawLabel);
  if (!normKey) return;
  // "Start typing" is the widget describing itself. resolveLabel keeps a
  // placeholder as a last resort so the field is still fillable, but storing an
  // answer under that key would merge every such control on the page.
  if (isGenericLabel(rawLabel)) return;

  const type = (el.getAttribute('type') || '').toLowerCase();
  const kind = el.tagName === 'TEXTAREA' ? 'textarea'
    : el.tagName === 'SELECT' ? 'select'
    : type === 'radio' ? 'radio'
    : type === 'checkbox' ? 'checkbox'
    : type || 'text';

  // Identity fields are deterministic: they belong in the profile, edited on
  // the options page, not in the learned Q&A bank. Report the skip so the panel
  // can say so rather than leaving the row blank.
  //
  // Unless the fill pass could not answer it. A profile-backed question whose
  // options the stored value will not map onto ("Do you have a disability?",
  // "Country Phone Code") is abstained on every single time, so refusing to
  // learn what the user picked leaves it manual forever. Name and email never
  // reach this branch, because they fill successfully.
  if (canonicalFieldFor(normKey, kind) && !wasUnresolved?.(el)) {
    onProfileField?.(el, normKey);
    return;
  }

  let answer = '';
  if (kind === 'select') {
    const opt = el.selectedOptions?.[0];
    answer = (opt?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(please select|select|choose|--)/i.test(answer)) return;
  } else if (kind === 'radio' || kind === 'checkbox') {
    if (!el.checked) return;
    // A checkbox group answers with everything ticked, not just the box that
    // fired this event: a skills list is one answer with several values.
    const ticked = kind === 'checkbox' ? groupMembers(el, adapter).filter(m => m.checked) : [el];
    answer = ticked.length > 1 ? joinMulti(ticked.map(optionLabel)) : optionLabel(el);
  } else {
    answer = String(el.value || '').trim();
  }

  if (!answer) return;
  // A widget's internal id is not an answer, whatever path produced it.
  if (looksOpaqueId(answer)) return;
  // Don't re-learn what we just wrote; only genuine user edits should update.
  if (weWrote?.(el, answer)) return;

  const payload = {
    rawQuestion: rawLabel,
    answer,
    answerType: kind === 'textarea' ? 'textarea' : kind,
    board: adapter?.id,
    source: 'captured',
    origin: {
      board: adapter?.id || 'generic',
      company: detectCompany(location.href),
      url: location.href.split('#')[0].slice(0, 300),
      title: document.title.replace(/\s+/g, ' ').trim().slice(0, 120),
    },
  };
  const entry = kind === 'textarea'
    ? await upsertJobScopedAnswer(payload)
    : await upsertAnswer(payload);

  if (entry) onLearned?.(el, entry);
}

/**
 * Human-readable text for a checked radio or checkbox.
 *
 * Falling back to input.value is what stored Workday's internal GUIDs as
 * answers, so the value is only used when it reads like a real answer.
 * Returning '' means "do not capture this", which beats saving garbage.
 */
function optionLabel(input) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

  const id = input.getAttribute('id');
  if (id) {
    const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (clean(l?.textContent)) return clean(l.textContent);
  }

  const wrapping = input.closest('label');
  if (clean(wrapping?.textContent)) return clean(wrapping.textContent);

  const aria = clean(input.getAttribute('aria-label'));
  if (aria) return aria;

  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = clean(
      labelledBy.split(/\s+/).map(rid => document.getElementById(rid)?.textContent || '').join(' ')
    );
    if (text) return text;
  }

  // Workday puts the visible Yes/No text in a sibling of the input.
  const sibling = clean(input.nextElementSibling?.textContent);
  if (sibling && sibling.length <= 80) return sibling;

  const value = clean(input.value);
  return looksOpaqueId(value) ? '' : value;
}

/** Re-export so main.js can refresh field state after a capture. */
export { detectFields };
