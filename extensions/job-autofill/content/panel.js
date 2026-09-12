/**
 * panel.js — on-page feedback: field outlines and the summary panel.
 */

import { normalizeKey } from './matcher.js';
import { commonAncestor } from './engine.js';

const STYLE_ID = 'job-autofill-styles';
const PANEL_ID = 'job-autofill-panel';

/**
 * Outlines live on the page's own controls, so this has to go in the document.
 * Every rule is !important: it is competing with the board's stylesheet.
 */
const OUTLINE_CSS = `
.ja-filled { outline: 2px solid #2e9e4f !important; outline-offset: 1px !important; }
.ja-unknown { outline: 2px solid #e08b00 !important; outline-offset: 1px !important; }
.ja-failed { outline: 2px dashed #d14343 !important; outline-offset: 1px !important; }
.ja-flash { animation: ja-flash 1s ease-out 2; }
@keyframes ja-flash { 0%,100% { box-shadow: none } 50% { box-shadow: 0 0 0 4px rgba(224,139,0,.45) } }
`;

/**
 * The panel's own styles, which live inside a shadow root.
 *
 * Ashby sets `line-height: 0` on divs, which collapsed every line of the panel
 * to 4px and stacked the text on top of itself. Chasing that property by
 * property loses to the next board, so the panel is isolated instead: page CSS
 * cannot cross a shadow boundary, and `all: initial` on the host stops
 * inherited properties (line-height among them) leaking in.
 */
const PANEL_CSS = `
:host { all: initial; }
.ja-panel {
  box-sizing: border-box;
  width: 280px; max-height: 60vh; overflow: auto;
  background: #ffffff; color: #1c1c1c;
  border: 1px solid #d5d5d5; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 12px 14px;
  text-align: left;
}
.ja-panel * { box-sizing: border-box; line-height: 1.45; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.ja-close { cursor: pointer; border: 0; background: none; font-size: 16px; line-height: 1; color: #777; padding: 0 2px; }
.ja-counts { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.ja-chip { padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
.ja-chip.ok { background: #e6f4ea; color: #17632f; }
.ja-chip.warn { background: #fdf1dd; color: #8a5a00; }
.ja-chip.err { background: #fce8e8; color: #a12626; }
ul { margin: 4px 0 8px; padding-left: 16px; list-style: disc; }
li { cursor: pointer; margin-bottom: 3px; }
li:hover .ja-label { text-decoration: underline; }
/* Carried rows have no control to jump to, so they must not offer to. */
li.ja-static { cursor: default; }
li.ja-static:hover .ja-label { text-decoration: none; }
ul.ja-rev li { color: #a12626; }
.ja-val { display: block; font-size: 12px; margin-top: 1px; word-break: break-word; }
li.ja-learned .ja-label, li.ja-learned .ja-val { color: #17632f; }
li.ja-noted .ja-val { color: #777; font-style: italic; }
.ja-note { background: #f3f4f6; border-radius: 6px; padding: 7px 9px; font-size: 12px; color: #444; margin-bottom: 8px; }
button.ja-action {
  width: 100%; padding: 7px; border-radius: 6px; border: 1px solid #c9c9c9;
  background: #f7f7f7; cursor: pointer; font-size: 13px; color: #1c1c1c;
}
button.ja-action:hover { background: #efefef; }
@media (prefers-color-scheme: dark) {
  .ja-panel { background: #1e1f22; color: #e8e8e8; border-color: #3a3b3f; }
  .ja-note { background: #2a2b2f; color: #c8c8c8; }
  button.ja-action { background: #2a2b2f; border-color: #45464a; color: #e8e8e8; }
  li.ja-learned .ja-label, li.ja-learned .ja-val { color: #6cc48c; }
  li.ja-noted .ja-val { color: #9a9a9a; }
}
`;

/** Placement of the shadow host, which carries no appearance of its own. */
const HOST_STYLE = [
  'all: initial !important',
  'position: fixed !important',
  'right: 16px !important',
  'bottom: 16px !important',
  'z-index: 2147483646 !important',
  'display: block !important',
].join('; ');

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = OUTLINE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

function outlineTarget(field) {
  if (field.kind !== 'radio' && field.kind !== 'checkbox' && field.kind !== 'buttongroup') {
    return field.control;
  }
  const group = field.control.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (group) return group;

  // Grouping by the name attribute alone, with no fieldset and no ARIA, is
  // ordinary HTML: Lever's "Language Skill(s) (Check all that apply)" is 33
  // checkboxes sharing one name. Without a container to mark, the outline
  // landed on the first checkbox, so a question that had been read whole
  // looked like only its first option had been recognised.
  const members = field.members || [];
  if (members.length > 1) {
    const shared = commonAncestor(members);
    // Only when the shared ancestor really is this question's box. Another
    // choice input inside it is still part of the same question (Lever's
    // pronoun list ends with an unnamed "Custom" box), but a text field or a
    // dropdown means this is a section, or the form, and outlining it would
    // claim fields we never touched.
    const foreign = shared
      ? [...shared.querySelectorAll('input, select, textarea')].filter(el => {
          if (members.includes(el)) return false;
          const type = (el.getAttribute('type') || '').toLowerCase();
          return type !== 'checkbox' && type !== 'radio';
        })
      : [];
    if (shared && foreign.length === 0) return shared;
  }

  // Ashby's Yes/No pairs sit in a plain div, so without this the outline (and
  // the class that carries it) lands on the "Yes" button alone, which both
  // looks wrong and made that button read as the selected answer.
  if (field.kind === 'buttongroup') return field.control.parentElement || field.control;
  return field.control;
}

/**
 * Controls the user answered after we flagged them, so their green outline
 * survives a later pass. A pass can now run without being asked for, and it
 * counts neither their value (it is the user's, not ours) nor their row, so
 * clearing the marks took the confirmation away from answers we did store.
 */
const learnedControls = new Set();

export function clearMarks() {
  document.querySelectorAll('.ja-filled, .ja-unknown, .ja-failed').forEach(el => {
    el.classList.remove('ja-filled', 'ja-unknown', 'ja-failed');
  });
  for (const el of learnedControls) {
    if (el.isConnected) el.classList.add('ja-filled');
    else learnedControls.delete(el);
  }
}

export function markFilled(field) {
  ensureStyles();
  const el = outlineTarget(field);
  el.classList.remove('ja-unknown', 'ja-failed');
  el.classList.add('ja-filled');
}

export function markUnknown(field) {
  ensureStyles();
  outlineTarget(field).classList.add('ja-unknown');
}

export function markFailed(field) {
  ensureStyles();
  const el = outlineTarget(field);
  el.classList.remove('ja-filled');
  el.classList.add('ja-failed');
}

/** Drop every mark from one field, and stop re-applying it on later passes. */
export function clearMark(field) {
  const el = outlineTarget(field);
  el.classList.remove('ja-filled', 'ja-unknown', 'ja-failed');
  learnedControls.delete(el);
}

/** Called when the user answers a field we flagged orange. */
export function markLearned(field) {
  const el = outlineTarget(field);
  el.classList.remove('ja-unknown');
  el.classList.add('ja-filled');
  learnedControls.add(el);
}

/**
 * Panel rows keyed by the normalized question, not by the control.
 *
 * React boards replace their DOM nodes when a value changes: clicking an Ashby
 * Yes/No pair swaps the buttons for new ones, so a row keyed by the element it
 * was built from can never be found again, which is exactly when there is
 * something to report about it.
 */
const rowsByKey = new Map();
/**
 * Questions already counted. Capture listens on both `change` and `focusout`,
 * so one answer arrives twice and a naive counter reads "2 saved" for a single
 * field.
 */
const savedKeys = new Set();

/**
 * Show what the learning loop took from a field the user just answered.
 *
 * A green outline said something was captured but never what, so there was no
 * way to tell a stored answer from a mis-read one without opening the review
 * page. `noted` covers the opposite case: identity fields are deliberately
 * never learned, and a row that stayed silent read as a failure to capture.
 */
/**
 * Every answer captured on this page, so a later render can put it back.
 *
 * The panel is rebuilt from scratch on each pass, and a pass can now happen
 * without the user asking (a form revealing a new section triggers one). That
 * wiped every "saved:" line the moment it happened, which reads as the learning
 * loop having failed on answers it had in fact stored.
 */
const capturedByKey = new Map();

export function showCaptured(key, text, { learned = true } = {}) {
  const li = rowsByKey.get(key);
  // Keep the question's wording as the panel showed it, so the row can be
  // rebuilt on a later pass that no longer lists it.
  const label = li?.querySelector('.ja-label')?.textContent || capturedByKey.get(key)?.label;
  if (label) capturedByKey.set(key, { text, learned, label });
  if (!li) return;
  const slot = li.querySelector('.ja-val');
  if (!slot) return;

  slot.textContent = learned ? `saved: ${truncate(text, 90)}` : String(text);
  li.classList.remove('ja-learned', 'ja-noted');
  li.classList.add(learned ? 'ja-learned' : 'ja-noted');

  if (!learned) return;
  savedKeys.add(key);
  const chip = panelRoot?.querySelector('.ja-chip.saved');
  if (!chip) return;
  chip.textContent = `${savedKeys.size} saved`;
  chip.removeAttribute('hidden');
}

/** The panel's shadow root, so later updates can find its contents. */
let panelRoot = null;

export function showPanel(report, { onFillAgain, presentKeys } = {}) {
  ensureStyles();
  document.getElementById(PANEL_ID)?.remove();

  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = HOST_STYLE;
  const root = host.attachShadow({ mode: 'open' });
  panelRoot = root;

  const panel = document.createElement('div');
  panel.className = 'ja-panel';

  // Each row carries an empty value slot, filled in later by showCaptured once
  // the user answers that field.
  const row = (attr, i, label) =>
    `<li data-${attr}="${i}"><span class="ja-label">${escapeHtml(truncate(label, 70))}</span>` +
    '<span class="ja-val"></span></li>';

  const unknownItems = report.unknowns.map((u, i) => row('idx', i, u.rawLabel)).join('');
  const revertedItems = (report.reverted || []).map((u, i) => row('rev', i, u.rawLabel)).join('');

  // Questions answered earlier on this page keep their row. A later pass does
  // not list them (they hold a value now), so without this the record of what
  // the learning loop stored disappeared the moment a form revealed a section.
  const listed = new Set([...report.unknowns, ...(report.reverted || [])]
    .map(u => normalizeKey(u.rawLabel || '')));
  // Only for questions still on the page. Workday is one long-lived document,
  // so without this every question answered on step 1 would sit in the list
  // for the rest of the application.
  const carried = [...capturedByKey.entries()]
    .filter(([key]) => !listed.has(key) && (!presentKeys || presentKeys.has(key)));
  const carriedItems = carried
    .map(([, v], i) => `<li data-carried="${i}" class="ja-static">` +
      `<span class="ja-label">${escapeHtml(truncate(v.label, 70))}</span>` +
      '<span class="ja-val"></span></li>')
    .join('');

  panel.innerHTML = `
    <h4>Job Autofill <button class="ja-close" title="Dismiss">&times;</button></h4>
    <div class="ja-counts">
      <span class="ja-chip ok">${report.filled} filled</span>
      ${report.unknown ? `<span class="ja-chip warn">${report.unknown} unknown</span>` : ''}
      ${report.failed ? `<span class="ja-chip err">${report.failed} failed</span>` : ''}
      <span class="ja-chip ok saved" hidden></span>
    </div>
    ${unknownItems || carriedItems ? `<div>Needs you:</div><ul>${unknownItems}${carriedItems}</ul>` : ''}
    ${revertedItems ? `<div>Did not stick, fill by hand:</div><ul class="ja-rev">${revertedItems}</ul>` : ''}
    ${report.resumeNote ? `<div class="ja-note">${escapeHtml(report.resumeNote)}</div>` : ''}
    ${report.multiStep ? '<button class="ja-action">Fill this step</button>' : ''}
  `;

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  root.append(style, panel);
  document.body.appendChild(host);

  panel.querySelector('.ja-close').addEventListener('click', () => host.remove());

  const jumpTo = target => {
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('ja-flash');
    setTimeout(() => target.classList.remove('ja-flash'), 2100);
  };

  rowsByKey.clear();
  savedKeys.clear();

  const wire = (attr, source) => panel.querySelectorAll(`li[data-${attr}]`).forEach(li => {
    const entry = source[Number(li.dataset[attr])];
    if (entry?.rawLabel) rowsByKey.set(normalizeKey(entry.rawLabel), li);
    li.addEventListener('click', () => jumpTo(entry?.el));
  });
  wire('idx', report.unknowns);
  wire('rev', report.reverted || []);
  panel.querySelectorAll('li[data-carried]').forEach(li => {
    const entry = carried[Number(li.dataset.carried)];
    if (entry) rowsByKey.set(entry[0], li);
  });

  // Put back what was already learned on this page. Re-showing through the same
  // path keeps the saved count and the green rows consistent with a first pass.
  for (const [key, { text, learned }] of capturedByKey) {
    if (rowsByKey.has(key)) showCaptured(key, text, { learned });
  }

  panel.querySelector('.ja-action')?.addEventListener('click', () => onFillAgain?.());
}

/** Cut on a word boundary so a label does not end mid-word. */
function truncate(text, max) {
  const s = String(text).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
