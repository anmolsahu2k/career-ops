import test from 'node:test';
import assert from 'node:assert/strict';

import { questionFromAriaLabel } from '../content/adapters/workday.js';
import workday from '../content/adapters/workday.js';
import { normalizeKey, canonicalFieldFor } from '../content/matcher.js';
import { applySearchText, parseDate } from '../content/filler.js';
import { datePartOf } from '../content/engine.js';

// Real aria-labels captured from a CrowdStrike Workday application step.

test('strips the selected value and the Required marker', () => {
  assert.equal(questionFromAriaLabel('Country India Required', 'India'), 'Country');
});

test('strips a Select One placeholder', () => {
  assert.equal(
    questionFromAriaLabel('Phone Device Type Select One Required', 'Select One'),
    'Phone Device Type'
  );
});

test('handles an unselected dropdown with no trigger text', () => {
  assert.equal(questionFromAriaLabel('Country Required', ''), 'Country');
});

test('leaves a plain label alone', () => {
  assert.equal(questionFromAriaLabel('Phone Number', ''), 'Phone Number');
});

// It used to fall back to the raw aria-label here. On a questionnaire step
// every unanswered dropdown's accessible name is "Select One Required", so that
// fallback labelled four different questions identically, which both hid the
// real questions and would have merged four answers into one stored entry.
// Returning nothing lets the adapter look for the question in the DOM, which is
// where Workday actually renders it.
test('returns nothing when the accessible name is pure state', () => {
  assert.equal(questionFromAriaLabel('Select One Required', 'Select One'), '');
  assert.equal(questionFromAriaLabel('Required', 'Required'), '');
  assert.equal(questionFromAriaLabel('India', 'India'), '');
});

test('resolved questions map onto the profile', () => {
  const country = questionFromAriaLabel('Country India Required', 'India');
  assert.equal(canonicalFieldFor(normalizeKey(country), 'combobox'), 'location.country');
});

// Workday serves Create Account from the same /apply URL as the application,
// so the gate has to be recognised by URL *and* by content.
test('skipPage catches credential URLs', () => {
  const doc = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    assert.ok(workday.skipPage('https://x.wd5.myworkdayjobs.com/en-US/careers/login'));
    assert.ok(workday.skipPage('https://x.wd5.myworkdayjobs.com/createAccount'));
    assert.ok(!workday.skipPage('https://x.wd5.myworkdayjobs.com/en-US/careers/job/A/apply'));
  } finally {
    globalThis.document = doc;
  }
});

test('skipPage catches the account gate served at the apply URL', () => {
  const doc = globalThis.document;
  // Stand in for a page carrying the create-account markup and its honeypot.
  globalThis.document = {
    querySelector: sel => (sel.includes('verifyPassword') ? {} : null),
  };
  try {
    assert.ok(workday.skipPage('https://x.wd5.myworkdayjobs.com/en-US/careers/job/A/apply'));
  } finally {
    globalThis.document = doc;
  }
});

test('matches only Workday hosts', () => {
  assert.ok(workday.matches('https://crowdstrike.wd5.myworkdayjobs.com/en-US/x/job/y'));
  assert.ok(workday.matches('https://acme.wd1.myworkdaysite.com/en-US/x'));
  assert.ok(!workday.matches('https://job-boards.greenhouse.io/acme/jobs/1'));
});

test('canonicalAttr maps Workday automation ids to the profile', () => {
  const el = { getAttribute: n => (n === 'data-automation-id' ? 'legalNameSection_firstName' : null) };
  assert.equal(workday.canonicalAttr(el), 'name.first');
});

// Workday's skills and field-of-study prompts are moniker search boxes: they do
// not filter as you type. Writing the value fires no request at all, so the
// options never render and the field looks like an empty taxonomy. Observed on
// the Exelixis tenant, where `skillsearch` returned [] until the search was
// actually submitted. Enter is the submit.

/** Minimal input stand-in: records what gets dispatched at it. */
function stubInput({ workday }) {
  const events = [];
  return {
    value: '',
    events,
    dispatchEvent(e) { events.push(e); return true; },
    closest(selector) {
      const isWorkdaySelector = selector.includes('multiSelectContainer');
      return workday && isWorkdaySelector ? {} : null;
    },
  };
}

function withDomShims(fn) {
  const saved = { ...globalThis };
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLInputElement = class {};
  globalThis.Event = class { constructor(type) { this.type = type; } };
  globalThis.KeyboardEvent = class {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
  try { return fn(); } finally {
    for (const k of ['HTMLTextAreaElement', 'HTMLInputElement', 'Event', 'KeyboardEvent']) {
      if (k in saved) globalThis[k] = saved[k]; else delete globalThis[k];
    }
  }
}

test('submits the search with Enter on a Workday prompt', () => {
  withDomShims(() => {
    const el = stubInput({ workday: true });
    applySearchText(el, 'Python');

    assert.equal(el.value, 'Python');
    const keys = el.events.filter(e => e.key === 'Enter');
    assert.deepEqual(keys.map(e => e.type), ['keydown', 'keyup']);
  });
});

// react-select commits whatever option is currently highlighted when it sees
// Enter, so sending it to every combobox would answer Greenhouse and Ashby
// questions with the wrong value rather than leaving them for the user.
test('does not send Enter to a non-Workday combobox', () => {
  withDomShims(() => {
    const el = stubInput({ workday: false });
    applySearchText(el, 'Python');

    assert.equal(el.value, 'Python');
    assert.equal(el.events.some(e => e.key === 'Enter'), false);
  });
});

test('still announces the value the way React needs', () => {
  withDomShims(() => {
    const el = stubInput({ workday: true });
    applySearchText(el, 'Python');
    assert.deepEqual(
      el.events.filter(e => !e.key).map(e => e.type),
      ['input', 'change']
    );
  });
});

// Workday splits a date into three boxes whose accessible names are "Month",
// "Day" and "Year". Detected individually they add three questions that are not
// questions, and the capture loop learns "month" -> "8". They are one field.

test('recognises the three parts of a Workday date box', () => {
  const stem = 'primaryQuestionnaire--63cce916d0f50100dab3b29d725e0001';
  assert.deepEqual(
    datePartOf({ id: `${stem}-dateSectionMonth-input` }),
    { stem, part: 'Month' }
  );
  assert.deepEqual(
    datePartOf({ id: `${stem}-dateSectionYear-input` }),
    { stem, part: 'Year' }
  );
});

// Two dates on one step (a desired start date and the CC-305 signature date)
// must not collapse into each other, which the id stem is what prevents.
test('keeps two dates on the same step apart', () => {
  const a = datePartOf({ id: 'primaryQuestionnaire--abc-dateSectionMonth-input' });
  const b = datePartOf({ id: 'selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input' });
  assert.notEqual(a.stem, b.stem);
});

test('ignores inputs that are not date parts', () => {
  assert.equal(datePartOf({ id: 'phoneNumber--phoneNumber' }), null);
  assert.equal(datePartOf({ id: '' }), null);
  assert.equal(datePartOf({}), null);
});

test('splits the dates a store actually holds', () => {
  assert.deepEqual(parseDate('12/20/2026'), ['12', '20', '2026']);
  assert.deepEqual(parseDate('1/4/2027'), ['1', '4', '2027']);
  assert.deepEqual(parseDate('2026-12-20'), ['12', '20', '2026']);
});

// A date that cannot be read unambiguously is left for the user: putting the
// wrong start date in front of an employer is worse than leaving a box empty.
test('refuses anything it cannot read as a date', () => {
  assert.equal(parseDate('Available January 2027'), null);
  assert.equal(parseDate('20/12/2026'), null, 'month 20 does not exist');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

// ---------------------------------------------------------------------------
// Questionnaire questions, captured from the live Rocket (quickenloans) tenant,
// "Application Questions 1 of 2", 2026-08-11.
//
// The bug these pin: every listbox on the step was labelled with the question
// belonging to the widget ABOVE it, because labelForTrigger fell through to
// nearestQuestionText, which only inspects previous siblings. On the live form
// that wrote "Yes" into "Do you have an account with the National Mortgage
// Licensing System (NMLS)?" while the extension believed it was answering "Are
// you willing to relocate?".
// ---------------------------------------------------------------------------

/**
 * The smallest node that answers what questionnaireQuestion asks of it. There is
 * no DOM library in this project's dependencies and the existing tests stub
 * `document` the same way, so the structure is spelled out rather than parsed.
 */
function node(tag, { attrs = {}, kids = [], text = '' } = {}) {
  const self = {
    tag: tag.toUpperCase(),
    attrs,
    kids,
    parent: null,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    get textContent() {
      return text + kids.map(k => k.textContent).join('');
    },
    matches(selector) {
      const m = /^\[([^*=\]]+)\*="([^"]+)"\]$/.exec(selector);
      if (m) return String(attrs[m[1]] ?? '').includes(m[2]);
      return self.tag === selector.toUpperCase();
    },
    closest(selector) {
      let n = self;
      while (n) {
        if (n.matches(selector)) return n;
        n = n.parent;
      }
      return null;
    },
    descendants() {
      return kids.flatMap(k => [k, ...k.descendants()]);
    },
    querySelector(selector) {
      return self.descendants().find(k => k.matches(selector)) || null;
    },
    querySelectorAll(selector) {
      const parts = selector.split(',').map(s => s.trim());
      return self.descendants().filter(k => parts.some(p => k.matches(p)));
    },
  };
  for (const k of kids) k.parent = self;
  return self;
}

/** One questionnaire entry, exactly as Workday builds it. */
function questionField(id, questionText, { bold = true, preamble = '' } = {}) {
  const question = bold
    ? node('b', { text: questionText + '*' })
    : node('span', { text: questionText });
  const paras = preamble
    ? [node('p', { text: preamble }), node('p', { kids: [question] })]
    : [node('p', { kids: [question] })];
  const legend = node('legend', { kids: paras });
  const button = node('button', { attrs: { 'aria-haspopup': 'listbox', 'aria-label': ' Select One Required' }, text: 'Select One' });
  const fieldset = node('fieldset', { kids: [legend, node('div', { kids: [button] })] });
  const field = node('div', {
    attrs: { 'data-automation-id': `formField-${id}`, 'data-fkit-id': `primaryQuestionnaire--${id}` },
    kids: [fieldset],
  });
  return { field, button };
}

test('reads a questionnaire question from the widget its own container holds', async () => {
  const { questionnaireQuestion } = await import('../content/adapters/workday.js');
  const { button } = questionField('4f910005',
    'Do you now, or will you in the future, need any immigration-related support or sponsorship from the company in order to begin or continue employment?');
  assert.equal(
    questionnaireQuestion(button),
    'Do you now, or will you in the future, need any immigration-related support or sponsorship from the company in order to begin or continue employment?'
  );
});

test('does not hand a widget the question above it', async () => {
  const { questionnaireQuestion } = await import('../content/adapters/workday.js');
  const relocate = questionField('d70009', 'Are you willing to relocate?');
  const nmls = questionField('b06770007', 'Do you have an account with the National Mortgage Licensing System (NMLS)?');
  // Siblings on the step, in document order.
  node('div', { kids: [relocate.field, nmls.field] });

  assert.equal(questionnaireQuestion(nmls.button),
    'Do you have an account with the National Mortgage Licensing System (NMLS)?');
  assert.notEqual(questionnaireQuestion(nmls.button), 'Are you willing to relocate?');
});

test('prefers the bolded question over its preamble', async () => {
  const { questionnaireQuestion } = await import('../content/adapters/workday.js');
  const { button } = questionField('ae000000',
    'Have you or your spouse ever been affiliated with any branch of the U.S. or Canadian Armed Forces?',
    { preamble: 'Military affiliation self-identification is voluntary and not a requirement for this application.' });
  assert.equal(questionnaireQuestion(button),
    'Have you or your spouse ever been affiliated with any branch of the U.S. or Canadian Armed Forces?');
});

test('ignores containers that are not questionnaire fields', async () => {
  const { questionnaireQuestion } = await import('../content/adapters/workday.js');
  // My Information: First/Middle/Last all share one <legend>Legal Name</legend>.
  // Reading it here would collapse three fields onto one key.
  const input = node('input', { attrs: { id: 'name--legalName--middleName' } });
  const fieldset = node('fieldset', {
    kids: [node('legend', { text: 'Legal Name' }), node('div', { kids: [input] })],
  });
  node('div', { attrs: { 'data-fkit-id': 'name--legalName' }, kids: [fieldset] });

  assert.equal(questionnaireQuestion(input), '');
});

// ---------------------------------------------------------------------------
// Workday's skills multiselect runs its search on Enter and commits whatever it
// had highlighted on that same Enter. Live on the Rocket tenant that turned a
// stored "Computer Science | Systems Management" into the chips "Finished
// Products", "Hindi - Fluent" and "Machine Learning (ML)" on a real
// application. Anything we did not click has to come back off.
// ---------------------------------------------------------------------------

const chip = text => ({ text, node: null });

test('removes a chip the search committed on its own', async () => {
  const { unchosenChips } = await import('../content/filler.js');
  const extra = unchosenChips(['Python'], [chip('Python'), chip('Finished Products')], 'Java');
  assert.deepEqual(extra.map(c => c.text), ['Finished Products']);
});

test('keeps the chip we actually chose', async () => {
  const { unchosenChips } = await import('../content/filler.js');
  const extra = unchosenChips(['Python'], [chip('Python'), chip('Java')], 'Java');
  assert.deepEqual(extra, []);
});

test('never removes a chip the user had before us', async () => {
  const { unchosenChips } = await import('../content/filler.js');
  // Two pre-existing chips and nothing new: we must not touch the user's work.
  const extra = unchosenChips(['Python', 'SQL'], [chip('Python'), chip('SQL')], '');
  assert.deepEqual(extra, []);
});

test('strips everything the search added when nothing matched', async () => {
  const { unchosenChips } = await import('../content/filler.js');
  // The abstain path: no option matched, so every new chip is the widget's
  // guess rather than an answer.
  const extra = unchosenChips([], [chip('Finished Products'), chip('Hindi - Fluent')], '');
  assert.deepEqual(extra.map(c => c.text), ['Finished Products', 'Hindi - Fluent']);
});

test('a duplicate of a pre-existing chip is not mistaken for a new one', async () => {
  const { unchosenChips } = await import('../content/filler.js');
  const extra = unchosenChips(['Python', 'Python'], [chip('Python'), chip('Python')], '');
  assert.deepEqual(extra, []);
});

// Workday's work history asks for From/To as month and year only. Requiring
// three parts dropped every employment date on the page silently — they never
// reached the panel as something needing the user either.
test('parses the year-month a work history is stored as', () => {
  // Leading zeros are kept, exactly as the ISO branch keeps them; the write-back
  // check in fillDateParts compares numerically because Workday renders "08"
  // back as "8".
  assert.deepEqual(parseDate('2026-05'), ['05', '', '2026']);
  assert.deepEqual(parseDate('2023-01'), ['01', '', '2023']);
});

test('still refuses a value that is not a date', () => {
  assert.equal(parseDate('Present'), null);
  assert.equal(parseDate('2026'), null);
  assert.equal(parseDate(''), null);
});

// ---------------------------------------------------------------------------
// Techniques read out of Simplify Copilot's remoteConfig.json and Jobright's
// bundle (2026-08-12). Both gate their whole Workday multiselect sequence on
// "is this already selected", and Simplify's option lookup is scoped to the
// active popup with an explicit "no results" terminal state.
// ---------------------------------------------------------------------------

test('a value already held as a chip is not added again', async () => {
  const { alreadySelected } = await import('../content/filler.js');
  assert.equal(alreadySelected(['Python', 'React'], 'Python'), true);
  assert.equal(alreadySelected(['Python', 'React'], 'python'), true);
  // Workday renders a chip as "<value>, press delete to clear value." elsewhere,
  // and a country chip as "United States of America (+1)".
  assert.equal(alreadySelected(['United States of America (+1)'], 'United States of America'), true);
  assert.equal(alreadySelected(['Python'], 'PyTorch'), false);
  assert.equal(alreadySelected([], 'Python'), false);
  assert.equal(alreadySelected(['Python'], ''), false);
});

test('"no results" is recognised only when there is nothing to offer', async () => {
  const { saysNoResults } = await import('../content/filler.js');
  const stub = (text, hasOption) => ({
    textContent: text,
    querySelector: () => (hasOption ? {} : null),
  });
  assert.equal(saysNoResults(stub('No Results', false)), true);
  assert.equal(saysNoResults(stub('No matches found', false)), true);
  assert.equal(saysNoResults(stub('no items', false)), true);
  // A real list that happens to contain the phrase in an option must not read
  // as empty, or a legitimate menu would be abandoned.
  assert.equal(saysNoResults(stub('No Results Analyst', true)), false);
  assert.equal(saysNoResults(stub('Python\nPyTorch', false)), false);
  assert.equal(saysNoResults(null), false);
});
