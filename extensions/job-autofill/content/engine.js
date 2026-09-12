/**
 * engine.js — board-agnostic form field detection and label resolution.
 *
 * Produces FieldInfo objects the fill/capture flows operate on:
 *   { id, control, kind, rawLabel, normKey, labelSource, options, required, members }
 */

import { normalizeKey, joinMulti } from './matcher.js';

const TEXT_INPUT_TYPES = new Set([
  'text', 'email', 'tel', 'url', 'number', 'date', 'month', 'search', '',
]);

// 'file' is deliberately absent: a resume input is a field we can now fill,
// so it has to reach the field list. Callers that must not touch one still
// check `kind === 'file'`.
const SKIP_INPUT_TYPES = new Set([
  'password', 'hidden', 'submit', 'button', 'reset', 'image',
]);

/**
 * Bot-trap inputs. Forms plant a field a human never sees and reject any
 * submission that fills it. Workday calls its one "beecatcher". Writing to one
 * would silently mark real applications as automated, so these are excluded
 * before visibility is even considered.
 */
const HONEYPOT_RE = /beecatcher|honey ?pot|bot ?trap|(^|[-_])hp([-_]|$)|leave.?(this|it).?blank/i;

export function isHoneypot(el) {
  const signals = [
    el.getAttribute('data-automation-id'),
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.className,
    el.getAttribute('autocomplete'),
  ].filter(Boolean).join(' ');
  if (HONEYPOT_RE.test(signals)) return true;
  // Parked off-canvas (left:-9999px) is the classic trap layout. Compare in
  // DOCUMENT coordinates: getBoundingClientRect is viewport-relative, so a
  // normal field scrolled above the fold also reports negative offsets, and
  // testing those would suppress real fields on any long form.
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    const docLeft = rect.left + window.scrollX;
    const docTop = rect.top + window.scrollY;
    if (docLeft + rect.width < 0 || docTop + rect.height < 0) return true;
  }
  return false;
}

/**
 * A board's own search and filter controls, which are not application fields.
 *
 * An expired posting redirects to the company's job list, where the only inputs
 * are Search / Department / Office. Nothing there should ever be filled, and
 * more importantly the capture loop would otherwise learn a job search someone
 * typed ("data engineer") as the stored answer to a question called "Search".
 */
// Requiring a boundary before the word is what keeps "research-interests" and
// "searchable-skills" out of it; the camel pattern catches names like
// Workday's "searchText".
const FILTER_CONTROL_RE = /(^|[-_])(search|keyword)([-_]|$)|[-_]filter$/i;
const CAMEL_FILTER_RE = /(^|[-_])(search|keyword)[A-Z]/;

function looksLikeFilter(value) {
  return FILTER_CONTROL_RE.test(value) || CAMEL_FILTER_RE.test(value);
}

export function isSearchControl(el) {
  if ((el.getAttribute('type') || '').toLowerCase() === 'search') return true;
  if (looksLikeFilter(el.getAttribute('id') || '')) return true;
  if (looksLikeFilter(el.getAttribute('name') || '')) return true;
  return Boolean(el.closest('[role="search"]'));
}

/**
 * A radio or checkbox whose native input is hidden under a visible custom
 * control. Real and fillable: clicking the input still checks it.
 */
function isStyledChoice(el) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type !== 'radio' && type !== 'checkbox') return false;
  const shell = el.closest('label') || el.parentElement;
  if (!shell) return false;
  const style = getComputedStyle(shell);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = shell.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * A file input hidden behind its own drop zone.
 *
 * Modern uploads never expose the native control: Workday renders a "Drop files
 * here / Select files" zone and hides the real `<input type="file">` behind it,
 * so `isVisible` threw the field away and the resume was never attached on any
 * Workday application. The page's own diagnostics reported `fieldCount: 1` on a
 * step that plainly shows a Resume/CV box.
 *
 * Judged by the shell rendered in its place, exactly as `isStyledChoice` does
 * for an opacity-0 radio. The shell must actually look like an upload widget,
 * or every hidden input inside a visible section would qualify.
 */
function isStyledUpload(el) {
  if (el.tagName !== 'INPUT') return false;
  if ((el.getAttribute('type') || '').toLowerCase() !== 'file') return false;
  let node = el.parentElement;
  for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (node.matches?.('[data-automation-id*="ileUpload"], [data-automation-id*="file-upload"]')) return true;
    if (UPLOAD_SHELL_PATTERN.test((node.textContent || '').slice(0, 200))) return true;
  }
  return false;
}

export const UPLOAD_SHELL_PATTERN = /\b(drop files|select files?|upload a file|choose file|browse|attach)\b/i;

export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.disabled) return false;
  if (isHoneypot(el)) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  // Two widget shapes deliberately hide the control the browser submits and put
  // a styled stand-in where the user looks: a radio or checkbox at opacity 0
  // under a custom box (Ashby's EEO block), and a file input behind a drop zone
  // (Workday's Resume/CV). Both are judged by that stand-in instead.
  const hasVisibleProxy = isStyledChoice(el) || isStyledUpload(el);
  if ((style.visibility === 'hidden' || style.display === 'none') && !hasVisibleProxy) return false;
  if (style.opacity === '0' && !hasVisibleProxy) return false;
  const rect = el.getBoundingClientRect();
  // Select2/legacy widgets hide the native control but still submit it, so a
  // zero-size element is only disqualified when it also has no offsetParent.
  if (rect.width === 0 && rect.height === 0 && !el.offsetParent && !hasVisibleProxy) return false;
  return true;
}

/**
 * A sign-in or account-creation screen, which must never be filled or learned
 * from.
 *
 * Recognising these by URL only works for boards we know: SuccessFactors turns
 * out to gate its applications behind a login served from whatever host the
 * employer branded, so there is nothing in the address to match. A visible
 * password box is the dependable signal, because an application form never has
 * one, and it also stops the capture loop storing a username as the answer to
 * "Email" or "User Name".
 */
export function isCredentialScreen(root = document) {
  return [...root.querySelectorAll('input[type="password"]')].some(isVisible);
}

/**
 * Placeholders that describe the widget rather than the question. These repeat
 * across every control on a page, so treating one as a label collapses several
 * distinct questions onto a single key.
 */
const GENERIC_PLACEHOLDER_RE =
  /^(start typing|type to search|search|select|choose|please select|pick one|e\.?g\.?\b|enter|begin typing|--)/i;

function isGenericPlaceholder(text) {
  const t = String(text || '').trim();
  return !t || t.length < 3 || GENERIC_PLACEHOLDER_RE.test(t);
}

/**
 * The widget describing its own state rather than asking anything: "Select
 * One", "Select One Required", "Start typing...".
 *
 * Matched whole, not as a prefix, because this also guards accessible names and
 * "Select your country" is a real question. A name like this must never become
 * a key: on a Workday questionnaire step every unanswered dropdown reads
 * "Select One Required", so four different questions collapse onto one stored
 * answer that then fills whichever of them comes next.
 */
const GENERIC_LABEL_RE =
  /^(start typing|type to search|search|select|select one|choose|please select|pick one|enter|begin typing|--)\s*(required|optional)?[.…\s]*$/i;

export function isGenericLabel(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return !t || t.length < 3 || GENERIC_LABEL_RE.test(t);
}

/**
 * A widget showing its placeholder rather than holding an answer.
 *
 * Deliberately NOT `isGenericLabel`, which also rejects anything shorter than
 * three characters. That rule is right for a question and catastrophic for an
 * answer: it silently threw away every **"No"**, so changing an answer from Yes
 * to No left the old Yes stored, and no board could ever be taught a No. The
 * same went for "US", "PA" and any two-digit number.
 */
export function isPlaceholderValue(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return !t || GENERIC_LABEL_RE.test(t);
}

function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[*✱∗]\s*$/, '')
    .trim();
}

const NON_LABEL_TAGS = new Set([
  'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SVG', 'SCRIPT', 'STYLE', 'OPTION',
]);

/**
 * Status text a widget keeps parked in the DOM: error messages, "Loading",
 * live regions. Lever wraps its location input in a <label> that also contains
 * the autocomplete's hidden "No location found. Try entering a different
 * location" and "Loading" nodes, so reading the label whole produces the
 * question "Current location No location found. Try entering a different
 * locationLoading" — which matches no stored answer and is unreadable in the
 * review UI.
 */
function isStatusNode(el) {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('aria-live')) return true;
  const role = el.getAttribute('role');
  if (role === 'status' || role === 'alert' || role === 'log') return true;
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

/**
 * Visible text of a label, walking the live DOM rather than a clone: whether a
 * node is displayed is a computed style, and a detached clone has none.
 */
function textOf(el) {
  if (!el) return '';
  const parts = [];
  const walk = node => {
    if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (NON_LABEL_TAGS.has(node.tagName)) return;
    if (isStatusNode(node)) return;
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return cleanText(parts.join(' '));
}

/**
 * Resolve the question text for a control.
 * Ordered so the most explicit association wins; the DOM-proximity fallbacks
 * only run when the page gave us no accessible name at all.
 */
export function resolveLabel(el, adapter) {
  const override = adapter?.labelOverride?.(el);
  if (override) return { text: cleanText(override), source: 'adapter' };

  const id = el.getAttribute('id');
  if (id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const t = textOf(forLabel);
    if (t) return { text: t, source: 'label-for' };
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    // A wrapping <label> can hold the widget's own chrome as well as the
    // question. Lever's location label contains the autocomplete's dropdown,
    // and its "Loading" node is on screen while the search runs, so reading the
    // label whole made the question read "Current location Loading" for exactly
    // as long as it took to answer it. The fill pass and the capture that
    // followed then keyed the same field differently: the panel could not match
    // them up, and "current location loading" went into the bank as a question.
    // A dedicated label element inside it is the question; the rest is chrome.
    const inner = labelWithinContainer(wrapping, [el], () => false, LABELISH_TAGS);
    const t = inner || textOf(wrapping);
    if (t) return { text: t, source: 'wrapping-label' };
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = cleanText(
      labelledBy
        .split(/\s+/)
        .map(rid => textOf(document.getElementById(rid)))
        .filter(Boolean)
        .join(' ')
    );
    if (t) return { text: t, source: 'aria-labelledby' };
  }

  // An accessible name that only says "Select One" is the widget's state, not
  // the question, which on Workday's questionnaire steps is rendered above it.
  const ariaLabel = cleanText(el.getAttribute('aria-label'));
  if (ariaLabel && !isGenericLabel(ariaLabel)) return { text: ariaLabel, source: 'aria-label' };

  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const t = textOf(fieldset.querySelector('legend'));
    if (t) return { text: t, source: 'legend' };
  }

  const group = el.closest('[role="group"], [role="radiogroup"]');
  if (group) {
    const gLabelledBy = group.getAttribute('aria-labelledby');
    if (gLabelledBy) {
      const t = cleanText(
        gLabelledBy.split(/\s+/).map(rid => textOf(document.getElementById(rid))).filter(Boolean).join(' ')
      );
      if (t) return { text: t, source: 'aria-labelledby' };
    }
    const gAria = cleanText(group.getAttribute('aria-label'));
    if (gAria) return { text: gAria, source: 'aria-label' };
  }

  // A placeholder is only a label when it says something. Ashby's comboboxes
  // carry "Start typing...", which would key every one of them identically and
  // hide the real question sitting just above.
  const placeholder = cleanText(el.getAttribute('placeholder'));
  if (placeholder && !isGenericPlaceholder(placeholder)) {
    return { text: placeholder, source: 'placeholder' };
  }

  const nearby = nearestQuestionText(el);
  if (nearby) return { text: nearby, source: 'nearest-heading' };

  // Better a weak label than none: without one the field is invisible to us.
  if (placeholder) return { text: placeholder, source: 'placeholder' };

  return { text: '', source: 'none' };
}

/**
 * Bounded walk up to 4 ancestors looking for the nearest preceding text node
 * that reads like a question. Deliberately capped: an unbounded walk on a
 * Workday step happily returns the entire page heading.
 */
export function nearestQuestionText(el) {
  let node = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (!sibling.matches('input, select, textarea, button, script, style')) {
        const t = textOf(sibling);
        if (t && t.length <= 200) return t;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
    if (node && (node.tagName === 'FORM' || node.tagName === 'BODY')) break;
  }
  return '';
}

/**
 * A text input that is really a dropdown: react-select (Greenhouse's current
 * board), Ashby's comboboxes, and anything else following the ARIA combobox
 * pattern. These must be filled by picking an option, never by typing, because
 * the widget discards free text on blur.
 */
export function isComboboxInput(el) {
  if (el.tagName !== 'INPUT') return false;
  if (el.getAttribute('role') === 'combobox') return true;
  if (el.getAttribute('aria-autocomplete') === 'list') return true;
  // Workday's prompt widgets are inputs that open a listbox. Its multiselect
  // ("How Did You Hear About Us?", "Country Phone Code") advertises nothing on
  // the input itself: the only signal is the container it sits in.
  if (el.getAttribute('aria-haspopup') === 'listbox') return true;
  if (el.closest('[data-automation-id="multiselectInputContainer"]')) return true;
  return typeof el.className === 'string' && /select__input/.test(el.className);
}

/** Kinds we would normally type into. */
export const TEXTISH_KINDS = new Set([
  'text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month',
]);

/**
 * Index of a repeated block, or null.
 *
 * Education and employment sections repeat, and every entry reuses the same
 * label: three "Start date year" fields on one page. A single global answer
 * cannot represent all of them, and letting one try produces confidently wrong
 * history (a bachelor's start year against a master's entry). Boards number
 * these controls, so the index is recoverable: Greenhouse uses "school--0" and
 * "start-year--1", Workday "--1" suffixes and section containers.
 */
export function groupIndexOf(el) {
  for (const attr of ['id', 'name', 'data-automation-id']) {
    const value = el.getAttribute(attr);
    // Greenhouse writes "school--0"; Workday writes "workExperience-6--jobTitle",
    // putting the counter BEFORE the separator. Matching only the first shape
    // left groupIndex null on every Workday block, so the answer-bank refusal
    // below never fired and both education blocks were filled with the same
    // school out of the shared bank.
    const m = value && (/--(\d+)\b/.exec(value) || /-(\d+)--/.exec(value));
    if (m) return Number(m[1]);
  }
  return null;
}

function kindOf(el) {
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'SELECT') return 'select';
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'file') return 'file';
    if (isComboboxInput(el)) return 'combobox-input';
    return TEXT_INPUT_TYPES.has(type) ? type || 'text' : 'text';
  }
  return 'text';
}

/**
 * Every value currently chosen in a multi-select, read from the chips it shows.
 *
 * Boards render these differently (react-select multi-value labels, Workday
 * selected items, a list of removable pills), so several shapes are matched.
 * The remove glyph is stripped: the chip's text is the answer, "x" is not.
 */
const CHIP_SELECTORS = [
  '[class*="multi-value__label"]',
  '[data-automation-id="selectedItem"]',
  '[data-automation-id="pill"]',
  'li:has(button[aria-label*="elete" i])',
  'li:has(button[aria-label*="emove" i])',
  '[class*="chip"]:has(button)',
  '[class*="tag"]:has(button)',
].join(', ');

export function selectedChips(container) {
  if (!container?.querySelectorAll) return [];
  const seen = new Set();
  const out = [];
  for (const chip of container.querySelectorAll(CHIP_SELECTORS)) {
    // Skip a chip nested inside another match, so one value is not counted twice.
    if (out.some(({ el }) => el.contains(chip))) continue;
    const clone = chip.cloneNode(true);
    clone.querySelectorAll('button, svg').forEach(n => n.remove());
    const text = cleanText(clone.textContent).replace(/^[×✕✖x]\s*/i, '').replace(/\s*[×✕✖]$/, '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ el: chip, text });
  }
  return out.map(c => c.text);
}

/**
 * Which button of a segmented group is chosen.
 *
 * Ashby's Yes/No pairs carry no ARIA state at all: the selection shows up only
 * as an extra class on the chosen button, and the class name is hashed per
 * build (`_active_1svni_57`). So check ARIA first for boards that do it
 * properly, then the class, then fall back to structure: if exactly one button
 * carries a class its siblings do not, that is the selection. The structural
 * check is what survives Ashby renaming its stylesheet.
 */
export function selectedButton(buttons = []) {
  const list = [...buttons];
  if (list.length === 0) return null;

  const aria = list.find(b =>
    b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true');
  if (aria) return aria;

  const named = list.filter(b => /(^|[-_\s])(active|selected|checked)([-_\d]|$)/i.test(b.className || ''));
  if (named.length === 1) return named[0];

  // Our own outline classes must not count. `markUnknown` lands `ja-unknown` on
  // the first button of a group, which made that button the odd one out and so
  // read as the selected answer: an untouched Yes/No group reported "Yes".
  const classesOf = b => new Set(
    String(b.className || '').split(/\s+/).filter(c => c && !c.startsWith('ja-'))
  );
  const distinct = list.filter(b => {
    const own = classesOf(b);
    return list.some(other => other !== b
      && [...own].some(c => !classesOf(other).has(c)));
  });
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * What the control currently shows to the user.
 * A committed react-select selection lives in a rendered label, not in
 * input.value, so reading .value would say "empty" for a filled dropdown.
 */
export function readValue(field) {
  const el = field.control;
  // Segmented buttons have no `.checked` to read, so the verification pass used
  // to see every one of them as empty and report a good fill as failed.
  if (field.kind === 'buttongroup') {
    const chosen = selectedButton(field.members || []);
    return chosen ? cleanText(chosen.textContent) : '';
  }
  if (field.kind === 'radio' || field.kind === 'checkbox') {
    // A "check all that apply" group holds several answers at once. Reading
    // only the first meant a skills picker was stored as whichever box was
    // ticked last, losing the rest.
    const ticked = (field.options || []).filter(o => o.el?.checked);
    if (ticked.length > 1) return joinMulti(ticked.map(o => o.text || o.value));
    if (ticked.length === 1) return cleanText(ticked[0].text || ticked[0].value) || 'checked';
    const checked = (field.members || []).find(m => m.checked);
    return checked ? (checked.value || 'checked') : '';
  }
  if (field.kind === 'select') {
    const opt = el.selectedOptions?.[0];
    const text = cleanText(opt?.textContent);
    return /^(please select|select|choose|--)/i.test(text) ? '' : (el.value || '');
  }
  if (field.kind === 'combobox-input' || field.kind === 'combobox') {
    // Must be the control, not the inner input-container: a committed
    // react-select value renders as a sibling of the input's own wrapper.
    const container = el.closest('[class*="select__control"]')
      || el.closest('[data-automation-id="multiselectInputContainer"]')
      || el.closest('[role="combobox"]')?.parentElement
      || el.parentElement?.parentElement;
    // Chips first: a multi-select shows every choice, and reading one of them
    // stores a skills list as a single skill.
    const chips = selectedChips(container);
    if (chips.length) return joinMulti(chips);
    const rendered = container?.querySelector('[class*="single-value"], [class*="multi-value__label"]');
    if (rendered) return cleanText(rendered.textContent);
    const dataValue = container?.getAttribute?.('data-value');
    if (dataValue) return dataValue;
    // A widget whose trigger is a <button> keeps its answer in its own text
    // (Workday's dropdowns). HTMLButtonElement.value is '', so this read said
    // "empty" for every one of them: the fill loop could not tell an answered
    // dropdown from an untouched one and would re-pick one the user had set by
    // hand, and the rescan filter treated them as permanently unanswered.
    // capture.js has always special-cased this; the fill path had not.
    if (el.tagName === 'BUTTON') {
      const shown = cleanText(el.textContent);
      return isPlaceholderValue(shown) ? '' : shown;
    }
    return cleanText(el.value);
  }
  return typeof el.value === 'string' ? el.value.trim() : '';
}

function isRequired(el, labelText) {
  if (el.required || el.getAttribute('aria-required') === 'true') return true;
  return /[*✱∗]\s*$/.test(String(labelText || '')) || /\brequired\b/i.test(String(labelText || ''));
}

function nativeSelectOptions(select) {
  return [...select.options]
    .filter(o => o.value !== '' || o.textContent.trim() !== '')
    .map(o => ({ el: o, value: o.value, text: cleanText(o.textContent) }));
}

function radioLabel(input) {
  const id = input.getAttribute('id');
  if (id) {
    const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const t = textOf(l);
    if (t) return t;
  }
  const wrapping = input.closest('label');
  if (wrapping) {
    const t = textOf(wrapping);
    if (t) return t;
  }
  return cleanText(input.getAttribute('aria-label') || input.value);
}

/**
 * Every input belonging to the same choice group as this one.
 *
 * Capture handles one input at a time, so a "check all that apply" answer was
 * stored as whichever box was ticked last. The group is what holds the answer.
 */
export function groupMembers(el, adapter = null) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  // A board that says "this block is one question" outranks the name attribute:
  // Lever's pronoun list ends with a "Custom" box carrying no name at all,
  // which by name alone became a separate question called "Custom".
  const hinted = adapter?.groupContainer?.(el);
  if (hinted) {
    const found = [...hinted.querySelectorAll(`input[type="${type}"]`)];
    if (found.length) return found;
  }
  const name = el.getAttribute('name');
  if (name) {
    const found = [...document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)];
    if (found.length) return found;
  }
  const container = el.closest('fieldset, [role="radiogroup"], [role="group"]');
  return container ? [...container.querySelectorAll(`input[type="${type}"]`)] : [el];
}

/**
 * The element that holds a whole choice group.
 *
 * A fieldset or an ARIA group when the page provides one, and otherwise the
 * nearest ancestor shared by every member. Grouping by the `name` attribute
 * alone is ordinary HTML — Lever's pronoun list is nine checkboxes sharing
 * name="pronouns" with no fieldset and no ARIA anywhere — and with no container
 * to ask, the question fell back to the first member's own label, so the whole
 * group keyed as "He/him".
 */
export function groupContainerFor(el, adapter = null) {
  const hinted = adapter?.groupContainer?.(el);
  if (hinted) return hinted;
  const explicit = el.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (explicit && explicit !== el) return explicit;
  const members = groupMembers(el, adapter);
  return members.length > 1 ? commonAncestor(members) : null;
}

/** Nearest ancestor containing every element, stopping short of the document. */
export function commonAncestor(els) {
  let node = els[0].parentElement;
  while (node && !els.every(e => node.contains(e))) node = node.parentElement;
  if (!node || node.tagName === 'BODY' || node.tagName === 'HTML') return null;
  return node;
}

/**
 * Radio/checkbox groups collapse into ONE field with options, so a stored
 * "Yes" answers the whole group instead of one arbitrary member.
 */
/**
 * Workday splits a date into three inputs that share one id stem:
 *   ...-dateSectionMonth-input, ...-dateSectionDay-input, ...-dateSectionYear-input
 * The stem is the group key, which keeps two dates on one step (a start date
 * and a signature date) from collapsing into each other.
 */
const DATE_PART_RE = /^(.*)-dateSection(Month|Day|Year)-input$/;

export function datePartOf(el) {
  const m = (el?.id || '').match(DATE_PART_RE);
  return m ? { stem: m[1], part: m[2] } : null;
}

/**
 * The parts of one date box, in month/day/year order.
 *
 * Two or three of them. Workday's questionnaire dates are month/day/year, but
 * its work-history "From" and "To" are month and year only, and requiring all
 * three dropped every employment date on the page without a word — they never
 * even reached the panel as something needing the user.
 */
function datePartMembers(stem, root) {
  return ['Month', 'Day', 'Year']
    .map(p => root.querySelector(`[id="${CSS.escape(stem)}-dateSection${p}-input"]`))
    .filter(Boolean);
}

function groupKeyFor(input, adapter = null) {
  const hinted = adapter?.groupContainer?.(input);
  if (hinted) return `container:${containerId(hinted)}`;
  if (input.name) return `name:${input.name}`;
  const container = input.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (container) return `container:${containerId(container)}`;
  return null;
}

function containerId(container) {
  if (!container.__jaGroupId) container.__jaGroupId = `grp-${Math.random().toString(36).slice(2, 9)}`;
  return container.__jaGroupId;
}

/**
 * Walk the document (or a subtree) and return every fillable field.
 * Always call fresh — SPA steps replace the DOM under you.
 */
export function detectFields(root = document, adapter = null) {
  // Some hosts keep unrelated global controls mounted beside an application
  // modal. An adapter can provide the exact form container; no container means
  // abstain, never permission to scan the rest of the page.
  if (adapter?.formRoot) {
    root = adapter.formRoot(root);
    if (!root) return [];
  }
  const fields = [];
  const seenGroups = new Map();
  let counter = 0;

  const controls = [...root.querySelectorAll('input, select, textarea')];

  for (const el of controls) {
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP_INPUT_TYPES.has(type)) continue;
    }
    if (el.closest('#job-autofill-panel')) continue;
    if (el.readOnly && el.tagName !== 'SELECT') continue;
    if (isSearchControl(el)) continue;
    if (!isVisible(el)) continue;

    const kind = kindOf(el);

    if (kind === 'radio' || kind === 'checkbox') {
      const gkey = groupKeyFor(el, adapter);
      if (gkey && seenGroups.has(gkey)) {
        const existing = seenGroups.get(gkey);
        existing.members.push(el);
        existing.options.push({ el, value: el.value, text: radioLabel(el) });
        continue;
      }
      // For a group, the question lives on the container, not the input.
      const container = groupContainerFor(el, adapter);
      const groupLabel = container
        ? resolveLabelForGroup(container, el, adapter)
        : resolveLabel(el, adapter);
      const field = {
        id: `f${counter++}`,
        control: el,
        kind: kind === 'radio' ? 'radio' : 'checkbox',
        rawLabel: groupLabel.text,
        normKey: normalizeKey(groupLabel.text),
        labelSource: groupLabel.source,
        options: [{ el, value: el.value, text: radioLabel(el) }],
        required: isRequired(el, groupLabel.text),
        members: [el],
      };
      fields.push(field);
      if (gkey) seenGroups.set(gkey, field);
      continue;
    }

    // A date's three boxes are one question. Grouped before the generic path so
    // "Month"/"Day"/"Year" never reach the field list as questions of their own.
    const datePart = datePartOf(el);
    if (datePart) {
      const gkey = `date:${datePart.stem}`;
      if (seenGroups.has(gkey)) continue;
      const members = datePartMembers(datePart.stem, root);
      // Month+year (Workday work history) or month/day/year. One part alone is
      // not a date, it is a stray spinbutton.
      if (members.length < 2) continue;
      const container = commonAncestor(members);
      const dateLabel = container
        ? resolveLabelForGroup(container, el, adapter)
        : { text: '', source: null };
      // No question found means no safe key to store the answer under, so it is
      // left for the user rather than guessed at.
      if (!dateLabel.text) continue;
      const field = {
        id: `f${counter++}`,
        control: members[0],
        kind: 'date-parts',
        rawLabel: dateLabel.text,
        normKey: normalizeKey(dateLabel.text),
        labelSource: dateLabel.source,
        options: [],
        required: members.some(m => isRequired(m, dateLabel.text)),
        members,
      };
      fields.push(field);
      seenGroups.set(gkey, field);
      continue;
    }

    const { text, source } = resolveLabel(el, adapter);
    if (!text) continue;

    fields.push({
      id: `f${counter++}`,
      control: el,
      kind,
      rawLabel: text,
      normKey: normalizeKey(text),
      labelSource: source,
      options: kind === 'select' ? nativeSelectOptions(el) : [],
      required: isRequired(el, text),
      members: [el],
      groupIndex: groupIndexOf(el),
    });
  }

  if (adapter?.detectExtraFields) {
    for (const extra of adapter.detectExtraFields(root) || []) {
      if (!extra.rawLabel) continue;
      fields.push({
        id: `f${counter++}`,
        normKey: normalizeKey(extra.rawLabel),
        labelSource: 'adapter',
        options: [],
        required: false,
        members: [extra.control],
        // Same as the generic branch above. Without it a dropdown inside a
        // repeated block was not marked indexed, so `resolveCandidates` fell
        // through to the shared answer bank and answered BOTH education blocks
        // "Bachelors" — reporting a master's degree as a bachelor's.
        groupIndex: groupIndexOf(extra.control),
        ...extra,
      });
    }
  }

  // A field with no question is unactionable, and surfacing one is worse than
  // dropping it: `findAnswer` needs a key so it can never be filled, `capture`
  // refuses an empty key so it can never be learned, and the panel renders it
  // as a bullet with no text. A user looking at eight blank rows reads the
  // whole extension as broken, which is exactly what happened on Workday's
  // "My Experience" step.
  //
  // Every other branch above already guards this individually (`if (!text)
  // continue`, `if (!dateLabel.text) continue`, and the adapter's own
  // `if (!rawLabel) continue`); the radio/checkbox branch does not, and
  // `resolveLabelForGroup` can return {text: '', source: 'none'} outright. One
  // guard here covers every producer, present and future.
  //
  // File inputs are exempt: an unlabelled upload is still worth prompting for,
  // because the user can see which box it is and we cannot fill it for them.
  return fields.filter(f => f.kind === 'file' || (f.rawLabel || '').trim() !== '');
}

/**
 * The question a control answers, resolved the way `detectFields` does it.
 *
 * A radio or checkbox carries its OPTION text as a label ("San Francisco, CA"),
 * while the question lives on the enclosing group. Capture used the member's
 * own label and so stored "Select all locations you would be open to" under the
 * key "san francisco ca": the real question stayed unlearned, and a junk key
 * went into the bank.
 */
export function resolveFieldLabel(el, adapter) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'radio' || type === 'checkbox') {
    const container = groupContainerFor(el, adapter);
    if (container) return resolveLabelForGroup(container, el, adapter);
  }
  return resolveLabel(el, adapter);
}

/** Question text for a radio/checkbox group container. */
/**
 * The text of an explicit `<label for=...>` pointing at this control, if any.
 * Deliberately only the explicit association: a wrapping label or an ancestor's
 * aria-labelledby is exactly the weak evidence this is meant to outrank.
 */
function ownLabelFor(el) {
  const id = el.getAttribute('id');
  if (!id) return '';
  return textOf(document.querySelector(`label[for="${CSS.escape(id)}"]`));
}

function resolveLabelForGroup(container, member, adapter) {
  const members = groupMembers(member, adapter);

  // A group's question is never one of its own options. Applied only to real
  // groups: a lone consent checkbox ("Spotify has my consent to contact me
  // about future job opportunities.") IS its own question, and rejecting that
  // would send the walk hunting through the previous question's text.
  const lone = members.length <= 1;
  const options = lone
    ? new Set()
    : new Set(members.map(m => normalizeKey(radioLabel(m))).filter(Boolean));
  const isOption = text => options.has(normalizeKey(text));

  const take = (text, source) => {
    const t = cleanText(text);
    return t && !isOption(t) ? { text: t, source } : null;
  };

  // Adapter first, exactly as in resolveLabel. Consulting it last meant the
  // DOM walk below got there first and handed the race group the entire gender
  // block as its question.
  const found =
    take(adapter?.labelOverride?.(member), 'adapter') ||
    // The current Greenhouse application rewrite provides its group question
    // verbatim on every checkbox as `description`.  The visual label then
    // says only "Acknowledge", which loses the policy being accepted and
    // makes two different acknowledgements indistinguishable.
    take(member.getAttribute('description'), 'description') ||
    // A lone control carrying an explicit <label for> already has its question
    // stated by the page author, and that beats anything the surrounding block
    // says about itself. Workday's "I have a preferred name" checkbox sits in a
    // role=group labelled "Legal Name", so the block won and the checkbox was
    // keyed as "legal name" — the same key three name inputs answer to. Ticking
    // it would have taught the bank that "Legal Name" is answered "yes".
    // Restricted to `lone` because a real group's members are its OPTIONS, and
    // there a member's own label ("Yes - I consent...") is never the question.
    (lone ? take(ownLabelFor(member), 'label-for') : null) ||
    take(textOf(container.querySelector('legend')), 'legend') ||
    take(idsText(container.getAttribute('aria-labelledby')), 'aria-labelledby') ||
    take(container.getAttribute('aria-label'), 'aria-label') ||
    // The question often sits inside the block that holds the options, above
    // them, described by nothing: Lever renders <div class="application-label">
    // Pronouns</div> as a plain sibling of the checkbox list.
    //
    // Only for a real group. A lone checkbox's own label IS its question, and
    // preferring the block's text over it gave Spotify's marketing-consent box
    // the privacy paragraph printed above it as its question.
    (lone ? null : take(labelWithinContainer(container, members, isOption), 'container-label')) ||
    (lone ? null : take(nearestQuestionText(container), 'nearest-heading'));
  if (found) return found;

  const own = resolveLabel(member, adapter);
  return isOption(own.text) ? { text: '', source: 'none' } : own;
}

/** Concatenated text of an id list, for aria-labelledby. */
function idsText(ids) {
  if (!ids) return '';
  return cleanText(
    ids.split(/\s+/).map(rid => textOf(document.getElementById(rid))).filter(Boolean).join(' ')
  );
}

/**
 * The first text inside a group's container that is not one of its options:
 * the question, for the many boards that render it as a plain sibling of the
 * choices with no `for`, no legend and no ARIA tying the two together.
 */
function labelWithinContainer(container, members, isOption, selector = CONTAINER_LABEL_TAGS) {
  for (const node of container.querySelectorAll(selector)) {
    if (members.some(m => node.contains(m))) continue;
    // An option's text sits in the same <label> as its control, in a <span>
    // that holds no control itself. Lever's "Custom" box is written that way,
    // and its label read as the question for the whole pronoun list.
    //
    // But a board may also wrap a WHOLE question in one <label>: Lever's EEO
    // blocks are <label><div class="application-label">Race</div><ul>...one
    // label per option...</ul></label>. Skipping everything inside a
    // control-bearing label threw "Race" away and the walk then took the
    // PREVIOUS question's heading, so the race group asked "Gender" and both
    // stored under one key. An option's label holds no nested <label>; a
    // wrapper's does. The container itself is never treated as an option.
    const owningLabel = node.closest('label');
    const isOptionLabel = owningLabel
      && owningLabel !== container
      && owningLabel.querySelector('input, select, textarea')
      && !owningLabel.querySelector('label');
    if (isOptionLabel) continue;
    const t = textOf(node);
    if (!t || t.length > 200 || isGenericLabel(t) || isMarkerText(t) || isOption(t)) continue;
    return t;
  }
  return '';
}

const CONTAINER_LABEL_TAGS =
  'legend, label, [class*="label"], h1, h2, h3, h4, h5, h6, p, div, span, td, th';

/**
 * Elements that name a question, as opposed to any element that happens to
 * hold text. Used when reading a wrapping <label>, where the broad list above
 * would return a required marker or a hint before the question: on
 * `<label>Phone Number<span class="required">Required</span><input></label>`
 * it gave the key "required", which stopped the phone filling and would file a
 * typed phone number under a key any other board could match.
 */
const LABELISH_TAGS =
  'legend, [class*="label"], [class*="Label"], h1, h2, h3, h4, h5, h6';

/** A required marker or a widget hint, never a question. */
function isMarkerText(text) {
  return /^(required|optional|\(?\s*(numeric|number|text|date)\s*\)?|[*✱∗•·\-–—]+)$/i
    .test(String(text).trim());
}

/** True when the control already holds a user-entered value we must not clobber. */
export function hasUserValue(field) {
  return readValue(field) !== '';
}
