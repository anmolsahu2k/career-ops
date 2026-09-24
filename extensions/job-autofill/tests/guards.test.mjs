import test from 'node:test';
import assert from 'node:assert/strict';

import { isSearchControl, isGenericLabel, isPlaceholderValue, selectedButton, isVisible } from '../content/engine.js';
import { canonicalFieldFor, fitsKind, joinMulti, splitMulti } from '../content/matcher.js';

/** Minimal stand-in for an element: these guards read attributes only. */
const el = (attrs = {}, ancestors = '') => ({
  getAttribute: name => attrs[name] ?? null,
  closest: sel => (ancestors.includes(sel) ? {} : null),
});

// An expired posting redirects to the board's job list, whose only inputs are
// Search / Department / Office. Filling those is wrong, and capturing them
// would store a job search as the answer to a question called "Search".
test('board search and filter controls are not application fields', () => {
  assert.ok(isSearchControl(el({ id: 'keyword-filter' })));
  assert.ok(isSearchControl(el({ id: 'department-filter' })));
  assert.ok(isSearchControl(el({ id: 'office-filter' })));
  assert.ok(isSearchControl(el({ type: 'search' })));
  assert.ok(isSearchControl(el({ name: 'searchText' })));
  assert.ok(isSearchControl(el({ id: 'x' }, '[role="search"]')));
});

test('real application fields are left alone', () => {
  for (const attrs of [
    { id: 'first_name' },
    { id: 'job_application_answers_attributes_3_text_value' },
    { name: 'urls[LinkedIn]' },
    { name: 'location' },
    { id: 'candidate-research-interests' },
    { id: 'filterable-preferences' },
  ]) {
    assert.equal(isSearchControl(el(attrs)), false, JSON.stringify(attrs));
  }
});

// A stored answer must fit the control that is asking. "2-5 years", learned
// from a dropdown on one board, reached an input[type=number] on another,
// which discarded it and made a type mismatch look like a bug.
test('an answer that cannot fit a number box is not attempted', () => {
  assert.equal(fitsKind('number', '2-5 years'), false);
  assert.equal(fitsKind('number', 'Two'), false);
  assert.equal(fitsKind('number', '3'), true);
  assert.equal(fitsKind('number', '3.75'), true);
});

test('date and month inputs only take the format they parse', () => {
  assert.equal(fitsKind('date', 'January 2027'), false);
  assert.equal(fitsKind('date', '2027-01-15'), true);
  assert.equal(fitsKind('month', '2027-01'), true);
  assert.equal(fitsKind('month', 'Jan 2027'), false);
});

test('every other control still accepts free text', () => {
  for (const kind of ['text', 'textarea', 'select', 'radio', 'combobox-input', 'tel']) {
    assert.equal(fitsKind(kind, '2-5 years'), true, kind);
  }
});

test('canonical name synonyms cover the legal-name wording', () => {
  assert.equal(canonicalFieldFor('legal first and last name', 'text'), 'name.full');
  assert.equal(canonicalFieldFor('first and last name', 'text'), 'name.full');
});

// A widget describing its own state is not a question. Four Workday dropdowns
// all reading "Select One Required" would otherwise share one stored answer,
// which would then fill whichever of them came next.
test('widget state text is never mistaken for a question', () => {
  for (const text of [
    'Select One', 'Select One Required', 'select one required', 'Select',
    'Start typing...', 'Search', 'Choose', 'Please select', '--', '',
  ]) {
    assert.equal(isGenericLabel(text), true, JSON.stringify(text));
  }
});

test('a real question that merely begins with "select" is kept', () => {
  for (const text of [
    'Select your country of citizenship',
    'Select One Required for each location you are willing to work in',
    'Have you ever worked for Mastercard?',
    'Desired Salary?',
    'GPA',
  ]) {
    assert.equal(isGenericLabel(text), false, JSON.stringify(text));
  }
});

// Ashby's Yes/No pairs carry no ARIA state: the choice shows up only as a
// hashed class on the chosen button.
const button = (text, className = '') => ({
  textContent: text,
  className,
  getAttribute: name => (name === 'class' ? className : null),
});

test('the active button of a segmented group is recognised', () => {
  const yes = button('Yes', '_container_pjyt6_1 _option_1svni_32 _active_1svni_57');
  const no = button('No', '_container_pjyt6_1 _option_1svni_32 ');
  assert.equal(selectedButton([yes, no]), yes);
  assert.equal(selectedButton([no, yes]), yes);
});

test('an untouched group reports no selection', () => {
  const yes = button('Yes', '_container_pjyt6_1 _option_1svni_32 ');
  const no = button('No', '_container_pjyt6_1 _option_1svni_32 ');
  assert.equal(selectedButton([yes, no]), null);
});

// Our own outline class landed on the first button and made it the odd one
// out, so an unanswered question read as "Yes".
test('our own marker classes are not mistaken for a selection', () => {
  const yes = button('Yes', '_container_pjyt6_1 _option_1svni_32 ja-unknown');
  const no = button('No', '_container_pjyt6_1 _option_1svni_32 ');
  assert.equal(selectedButton([yes, no]), null);
});

test('ARIA state wins when a board provides it', () => {
  const yes = { textContent: 'Yes', className: '', getAttribute: n => (n === 'aria-checked' ? 'true' : null) };
  const no = { textContent: 'No', className: '', getAttribute: () => null };
  assert.equal(selectedButton([yes, no]), yes);
});

test('an odd class on one button still resolves it', () => {
  // Structural fallback, for when the class is renamed by a rebuild.
  const yes = button('Yes', 'opt');
  const no = button('No', 'opt _sel_9f2');
  assert.equal(selectedButton([yes, no]), no);
  assert.equal(selectedButton([]), null);
});

// The label test rejects anything under three characters, which is right for a
// question and catastrophic for an answer: it silently discarded every "No",
// so changing an answer from Yes to No left the old Yes stored.
test('short answers are not mistaken for placeholders', () => {
  for (const value of ['No', 'US', 'PA', '3', 'Yes', 'N/A', '10+ years']) {
    assert.equal(isPlaceholderValue(value), false, JSON.stringify(value));
  }
});

test('a widget showing its placeholder holds no answer', () => {
  for (const value of ['', '   ', 'Select One', 'Select One Required', 'Start typing...', '--']) {
    assert.equal(isPlaceholderValue(value), true, JSON.stringify(value));
  }
});

test('the label test still rejects short text as a question', () => {
  // Both rules are needed: "No" is a fine answer and a useless question key.
  assert.equal(isGenericLabel('No'), true);
  assert.equal(isPlaceholderValue('No'), false);
});

// A skills picker or a check-all group holds several answers at once. Storing
// only the last one ticked lost the rest.
test('multi-values round-trip through one stored answer', () => {
  const stored = joinMulti(['Python', 'Java', 'Go']);
  assert.equal(stored, 'Python | Java | Go');
  assert.deepEqual(splitMulti(stored), ['Python', 'Java', 'Go']);
});

test('the separator survives answers containing commas and semicolons', () => {
  // A pipe, precisely because option text is full of the alternatives.
  const stored = joinMulti(['Yes, I will require sponsorship', 'Asian; not Hispanic']);
  assert.deepEqual(splitMulti(stored), ['Yes, I will require sponsorship', 'Asian; not Hispanic']);
});

test('duplicates and blanks are dropped, and a single value stays single', () => {
  assert.equal(joinMulti(['Go', 'Go', '', '  ', 'Rust']), 'Go | Rust');
  assert.deepEqual(splitMulti('Writing'), ['Writing']);
  assert.deepEqual(splitMulti(''), []);
});

// ---------------------------------------------------------------------------
// Resume slot identification, from the live Rocket Workday tenant 2026-08-11,
// where the resume was silently never attached: Workday's upload has no id,
// name or aria-label (only data-automation-id="file-upload-input-ref"), points
// aria-labelledby at a node outside the ancestor chain, and puts "Upload a file
// (5MB max)" on the nearest label, so nothing isResumeInput inspected ever met
// the word "Resume".
// ---------------------------------------------------------------------------

/** Minimal stand-in: isResumeInput only reads attributes and ancestor text. */
function control(attrs = {}, ancestorText = '') {
  const parent = {
    textContent: ancestorText,
    parentElement: null,
  };
  return {
    id: attrs.id || '',
    name: attrs.name || '',
    getAttribute: n => attrs[n] ?? null,
    parentElement: parent,
  };
}

test('the resolved label identifies a Workday upload that names nothing itself', async () => {
  const { isResumeInput } = await import('../content/filler.js');
  const el = control({ 'data-automation-id': 'file-upload-input-ref' }, 'Drop files here or Select files');
  assert.equal(isResumeInput(el), false, 'precondition: nothing on the element says resume');
  assert.equal(isResumeInput(el, 'Resume/CV'), true);
});

test('an id naming another slot still beats a resume-ish label', async () => {
  const { isResumeInput } = await import('../content/filler.js');
  // Greenhouse labels both uploads "Attach"; only the id separates them. If a
  // label could override the id, the resume would land in the cover-letter slot
  // and the wrong document would reach the employer.
  const el = control({ id: 'cover_letter_attach' }, '');
  assert.equal(isResumeInput(el, 'Resume/CV'), false);
});

test('a label naming another slot is refused', async () => {
  const { isResumeInput } = await import('../content/filler.js');
  const el = control({ 'data-automation-id': 'file-upload-input-ref' }, '');
  assert.equal(isResumeInput(el, 'Cover Letter'), false);
  assert.equal(isResumeInput(el, 'Transcript'), false);
});

// ---------------------------------------------------------------------------
// A file input hidden behind its own drop zone must still be found, but a bare
// hidden one must not. Workday hides the real <input type="file"> behind
// "Drop files here / Select files", so isVisible discarded it and the resume
// was never attached on any Workday application — the page's own diagnostics
// reported fieldCount: 1 on a step plainly showing a Resume/CV box.
//
// The DOM behaviour is covered by tests/workday-upload.mjs against the captured
// fixture, under all three ways a stylesheet can hide a control. This pins the
// shape-recognition rule that decides it.
// ---------------------------------------------------------------------------

test('an upload shell is recognised by what it says', async () => {
  const { UPLOAD_SHELL_PATTERN } = await import('../content/engine.js');
  for (const text of ['Drop files here', 'or Select files', 'Upload a file (5MB max)',
                      'Choose file', 'Attach', 'Browse']) {
    assert.ok(UPLOAD_SHELL_PATTERN.test(text), `${text} should read as an upload shell`);
  }
});

test('ordinary prose is not an upload shell', async () => {
  const { UPLOAD_SHELL_PATTERN } = await import('../content/engine.js');
  // Otherwise any hidden input inside a visible section would qualify, and a
  // decoy control would be offered to the user as a field.
  for (const text of ['Please list your most recent work experience.',
                      'Add any relevant websites.', 'Language Skills']) {
    assert.ok(!UPLOAD_SHELL_PATTERN.test(text), `${text} should NOT read as an upload shell`);
  }
});

test('a committed react-select input stays visible via its control shell', () => {
  const shell = {
    getBoundingClientRect: () => ({ width: 320, height: 38, left: 10, top: 10 }),
  };
  const input = {
    tagName: 'INPUT',
    isConnected: true,
    disabled: false,
    className: 'select__input',
    offsetParent: shell,
    getAttribute: name => (name === 'role' ? 'combobox' : null),
    closest: sel => (String(sel).includes('select__control') ? shell : null),
    getBoundingClientRect: () => ({ width: 2, height: 16, left: 12, top: 18 }),
  };
  const previousStyle = globalThis.getComputedStyle;
  const previousWindow = globalThis.window;
  globalThis.window = { scrollX: 0, scrollY: 0 };
  globalThis.getComputedStyle = node => (node === input
    ? { visibility: 'visible', display: 'block', opacity: '0' }
    : { visibility: 'visible', display: 'block', opacity: '1' });
  try {
    assert.equal(isVisible(input), true);
  } finally {
    globalThis.getComputedStyle = previousStyle;
    globalThis.window = previousWindow;
  }
});

test('an opacity-0 text input with no combobox shell stays hidden', () => {
  const input = {
    tagName: 'INPUT',
    isConnected: true,
    disabled: false,
    className: '',
    offsetParent: {},
    getAttribute: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 2, height: 16, left: 12, top: 18 }),
  };
  const previousStyle = globalThis.getComputedStyle;
  const previousWindow = globalThis.window;
  globalThis.window = { scrollX: 0, scrollY: 0 };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '0' });
  try {
    assert.equal(isVisible(input), false);
  } finally {
    globalThis.getComputedStyle = previousStyle;
    globalThis.window = previousWindow;
  }
});
