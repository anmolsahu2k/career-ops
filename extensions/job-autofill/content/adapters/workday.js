/**
 * workday.js — *.myworkdayjobs.com / *.myworkdaysite.com
 *
 * Multi-step SPA. Inputs carry stable data-automation-id attributes; dropdowns
 * are button+listbox widgets whose options mount in a detached container, so
 * they need the click sequence in filler.fillListbox rather than a value set.
 */

import { isGenericLabel, nearestQuestionText } from '../engine.js';

const AUTOMATION_MAP = {
  legalNameSection_firstName: 'name.first',
  legalNameSection_lastName: 'name.last',
  email: 'email',
  'phone-number': 'phone.raw',
  phoneNumber: 'phone.raw',
  addressSection_addressLine1: 'location.raw',
  addressSection_city: 'location.city',
  addressSection_countryRegion: 'location.state',
  addressSection_postalCode: null,
  'formField-linkedInAccount': 'links.linkedin',
  'formField-webSite': 'links.portfolio',
};

/** Steps where filling is meaningless or actively harmful. */
const SKIP_URL_PATTERNS = [
  /\/login/i,
  /\/register/i,
  /createAccount/i,
  /forgotPassword/i,
];

export default {
  id: 'workday',
  label: 'Workday',
  matches(url) {
    const h = new URL(url).hostname;
    return h.includes('myworkdayjobs.com') || h.includes('myworkdaysite.com');
  },
  isMultiStep: true,
  canonicalMap: AUTOMATION_MAP,

  canonicalAttr(el) {
    // A repeated block always wins: its own entry is the only thing that can be
    // right, and the generic map would hand every work block the candidate's
    // home address as the job's Location.
    const indexed = blockPath(el);
    if (indexed) return indexed;
    const id = el.getAttribute('data-automation-id');
    return id && AUTOMATION_MAP[id] ? AUTOMATION_MAP[id] : null;
  },

  /**
   * Never fill the account gate. Workday shows Create Account / Sign In at the
   * same /apply URL as the application itself, so a URL test alone misses it.
   * Detect it from the page: a password confirmation field or the create
   * account checkbox only ever appear on that screen.
   *
   * This matters beyond tidiness. The gate carries a hidden honeypot input
   * (data-automation-id="beecatcher"); writing to it marks the submission as a
   * bot, which would taint every application through this tenant.
   */
  skipPage(url) {
    if (SKIP_URL_PATTERNS.some(re => re.test(url))) return true;
    return Boolean(document.querySelector(
      '[data-automation-id="verifyPassword"], [data-automation-id="createAccountCheckbox"], [data-automation-id="beecatcher"]'
    ));
  },

  labelOverride(el) {
    const block = BLOCK_ID.exec(el.getAttribute('id') || '');
    if (block && BLOCK_LABELS[block[3]]) return BLOCK_LABELS[block[3]];

    // A questionnaire control's question always wins. This is the path that
    // reaches the date group ("When would you be available to start full-time
    // employment?"), whose own container holds no <legend>, so the group walk
    // fell back to the spinbutton's aria-label and keyed the answer as "Month".
    const question = questionnaireQuestion(el);
    if (question) return question;

    // Workday often labels via a sibling <label> the engine already finds;
    // this only covers the automation-id-only controls.
    const id = el.getAttribute('data-automation-id');
    if (!id) return null;
    if (id === 'legalNameSection_firstName') return 'First Name';
    if (id === 'legalNameSection_lastName') return 'Last Name';
    if (id === 'phone-number' || id === 'phoneNumber') return 'Phone Number';
    if (id === 'addressSection_city') return 'City';
    if (id === 'addressSection_postalCode') return 'Postal Code';
    return null;
  },

  /**
   * Open one block per profile entry in each repeated section, so there is
   * something to fill at all. Returns what it opened, for the caller to log.
   *
   * Only ever expands a section that is completely empty. Re-running a fill is
   * normal (the panel has a "Fill this step" button), and appending another
   * copy of the same job every time would be far worse than filling nothing.
   */
  async expandSections(profile, { click = el => el.click(), wait } = {}) {
    const opened = [];
    const pause = wait || (ms => new Promise(r => setTimeout(r, ms)));
    for (const { button, section } of addButtons()) {
      const spec = REPEATED_SECTIONS.find(s => s.heading.test(section));
      if (!spec) continue;
      const entries = Array.isArray(profile?.[spec.path]) ? profile[spec.path] : [];
      if (entries.length === 0) continue;
      if (!sectionIsEmpty(button)) continue;
      for (let i = 0; i < entries.length; i++) {
        click(button);
        // Workday mounts the block asynchronously and moves the Add button
        // below it, so each click needs the previous render to have landed.
        await pause(600);
      }
      opened.push({ section, blocks: entries.length });
    }
    return opened;
  },

  /**
   * The button+listbox dropdowns are invisible to a querySelectorAll over
   * input/select/textarea, so they are surfaced here as extra fields.
   */
  detectExtraFields(root) {
    const out = [];
    const triggers = root.querySelectorAll(
      'button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]'
    );
    for (const trigger of triggers) {
      if (trigger.closest('#job-autofill-panel')) continue;
      const rawLabel = labelForTrigger(trigger);
      if (!rawLabel) continue;
      out.push({
        control: trigger,
        kind: 'combobox',
        rawLabel,
        options: [],
        members: [trigger],
      });
    }
    return out;
  },
};

/**
 * Fields inside a repeated block, mapped onto the profile entry that block
 * stands for.
 *
 * `degreeOption` and `fieldOption` rather than the truthful `degree`/`field`,
 * because these are dropdowns offering a board's own vocabulary ("Master's
 * Degree", "Information Systems").
 */
const BLOCK_FIELDS = {
  workExperience: {
    path: 'work',
    fields: {
      jobTitle: 'title',
      companyName: 'company',
      location: 'location',
      currentlyWorkHere: 'current',
      startDate: 'startMonth',
      endDate: 'endMonth',
    },
  },
  education: {
    path: 'education',
    fields: {
      school: 'school',
      degree: 'degreeOption',
      fieldOfStudy: 'fieldOption',
      gradeAverage: 'gpa',
      firstYearAttended: 'startYear',
      lastYearAttended: 'endYear',
    },
  },
};

const BLOCK_ID = /^(workExperience|education)-(\d+)--(.+)$/;

/**
 * Questions inside a repeated block that the DOM walk gets wrong.
 *
 * "I currently work here" sits inside the From/To date fieldset, so the group
 * walk took that fieldset's <legend> and called the checkbox "From". It fills
 * correctly either way (the adapter routes it by id), but the label is what the
 * panel shows and what any captured answer would be keyed under, and "from" is
 * both wrong and a collision waiting to happen with a real date question.
 */
const BLOCK_LABELS = {
  currentlyWorkHere: 'I currently work here',
};

/**
 * Which profile entry a repeated block stands for.
 *
 * Workday numbers its blocks with an arbitrary running counter, NOT an ordinal:
 * two work blocks opened back to back came back as `workExperience-6--` and
 * `workExperience-15--`, and two education blocks as `-28--` and `-37--`. Taking
 * that number as the index sent every block to entry 0, which put the same job
 * in both work blocks and would have overwritten a real employment history with
 * one duplicated role.
 *
 * Document order is the only thing that maps a block to an entry, and it is
 * reliable because the blocks are appended in the order they were opened.
 */
export function blockOrdinal(el, root = document) {
  const parsed = BLOCK_ID.exec(el?.getAttribute?.('id') || '');
  if (!parsed) return null;
  const [, kind, counter] = parsed;
  const seen = [];
  for (const node of root.querySelectorAll(`[id^="${kind}-"]`)) {
    const m = BLOCK_ID.exec(node.getAttribute('id') || '');
    if (m && m[1] === kind && !seen.includes(m[2])) seen.push(m[2]);
  }
  const index = seen.indexOf(counter);
  return index === -1 ? null : { kind, index };
}

/** The profile path a control inside a repeated block should read from. */
export function blockPath(el, root = document) {
  const parsed = BLOCK_ID.exec(el?.getAttribute?.('id') || '');
  if (!parsed) return null;
  const spec = BLOCK_FIELDS[parsed[1]];
  const key = spec?.fields[parsed[3]];
  if (!key) return null;
  const ordinal = blockOrdinal(el, root);
  if (!ordinal) return null;
  return `${spec.path}[${ordinal.index}].${key}`;
}

/**
 * Sections that repeat and start collapsed behind an "Add" button.
 *
 * Workday renders nothing to fill until Add is pressed: Work Experience,
 * Education, Language Skills and Websites are each just a button, which is why
 * a fill pass on "My Experience" reported one field on a page showing six
 * sections. Every Add button carries the SAME
 * `data-automation-id="add-button"`, so the only thing distinguishing them is
 * the heading of the section they sit in.
 *
 * Language Skills is deliberately absent: the profile has no language data, and
 * opening a block we cannot fill leaves required fields empty and blocks the
 * step. Websites is absent for now because `profile.links` is an object of
 * named links rather than an ordered list.
 */
const REPEATED_SECTIONS = [
  { heading: /^work experience$/i, path: 'work' },
  { heading: /^education$/i, path: 'education' },
];

/**
 * The heading of the section a control sits in.
 *
 * Pure apart from the DOM read, and exported so the mapping from button to
 * section can be tested against the captured markup.
 */
export function sectionHeadingFor(el) {
  let node = el?.parentElement;
  for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
    const heading = node.querySelector?.('h1, h2, h3, h4, h5');
    if (heading) {
      const text = String(heading.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return '';
}

/** Every Add button on the page, paired with the section it belongs to. */
export function addButtons(root = document) {
  return [...root.querySelectorAll('button[data-automation-id="add-button"]')]
    .map(button => ({ button, section: sectionHeadingFor(button) }));
}

/**
 * How many blocks a section already holds.
 *
 * Counted as "does this section contain anything to fill yet", not by looking
 * for a Remove button, because the only state that matters is whether pressing
 * Add would duplicate work. A section that already has controls is left alone
 * entirely: filling twice must never append a second copy of the same job, and
 * a runaway loop here would write an unbounded work history into a real
 * application.
 */
export function sectionIsEmpty(button) {
  let node = button.parentElement;
  for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
    if (node.querySelector?.('h1, h2, h3, h4, h5')) {
      const controls = node.querySelectorAll(
        'input, select, textarea, button[aria-haspopup="listbox"]'
      );
      return controls.length === 0;
    }
  }
  return false;
}

/**
 * The question Workday renders for a questionnaire widget, read from the
 * widget's OWN container.
 *
 * Every questionnaire entry is built as
 *   <div data-automation-id="formField-<id>" data-fkit-id="primaryQuestionnaire--<id>">
 *     <fieldset><legend>...<b>The question</b></legend>  ...the widget...
 * so the question is a DESCENDANT of the control's own container. Nothing read
 * it there: `labelForTrigger` fell through to `nearestQuestionText`, which only
 * ever inspects previous siblings and ancestors, so every dropdown on the step
 * was handed the question belonging to the one above it.
 *
 * That is not a cosmetic mislabel. On Rocket's form it put "Yes" into "Do you
 * have an account with the National Mortgage Licensing System (NMLS)?" while
 * the extension believed it was answering "Are you willing to relocate?" — a
 * wrong answer written into a live application, which is the one outcome this
 * tool must never produce. It also collapsed work authorization and visa
 * sponsorship onto a single stored key.
 *
 * Deliberately scoped to questionnaire containers via `data-fkit-id`. It must
 * NOT reach the My Information step, where First Name, Middle Name and Last
 * Name all sit inside one <legend>Legal Name</legend> and would collapse onto
 * one key — the same damage in the other direction.
 */
export function questionnaireQuestion(el) {
  const field = el?.closest?.('[data-fkit-id*="uestionnaire--"]');
  const legend = field?.querySelector('legend');
  if (!legend) return '';
  // A question may carry a preamble ("Military affiliation self-identification
  // is voluntary and not a requirement..."). Workday bolds the question itself,
  // so prefer the last bold run and fall back to the whole legend when the
  // markup carries no bold at all.
  const bolds = [...legend.querySelectorAll('b, strong')]
    .map(b => tidy(b.textContent))
    .filter(Boolean);
  const text = bolds.length ? bolds[bolds.length - 1] : tidy(legend.textContent);
  return isGenericLabel(text) ? '' : text;
}

/**
 * Collapse whitespace and drop the trailing required marker.
 * The validation error is a sibling of the <legend>, not inside it, so reading
 * the legend alone also keeps "* Error : The field ... is required and must
 * have a value." out of the key — otherwise a question's key changed the moment
 * the form failed validation and everything taught against it stopped matching.
 */
function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[*\u2731\u2217]\s*$/, '').trim();
}

/**
 * Recover the question from a Workday dropdown's aria-label, which is built as
 * "<question> <current value> Required" ("Country India Required", "Phone
 * Device Type Select One Required"). Subtracting the trigger's own text (the
 * current value) and the state words leaves the question.
 *
 * Returns '' when nothing is left, because then the accessible name was pure
 * state and the question is elsewhere in the DOM. This used to fall back to the
 * raw aria-label, which is how an unanswered questionnaire step produced four
 * fields all labelled "Select One Required".
 *
 * Pure and exported so it can be tested without a browser.
 */
export function questionFromAriaLabel(ariaLabel, currentValue = '') {
  const aria = String(ariaLabel || '').replace(/\s+/g, ' ').trim();
  if (!aria) return '';
  const current = String(currentValue || '').replace(/\s+/g, ' ').trim();

  // Subtract even when the name IS the value: an accessible name of "India" on
  // a country dropdown carries no question, and saying so lets the caller look
  // for the real one in the DOM instead of keying an answer under "india".
  let question = aria;
  if (current && question.includes(current)) {
    question = question.replace(current, ' ');
  }
  question = question
    .replace(/\bselect one\b/gi, ' ')
    .replace(/\s*\b(required|optional)\b\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return question;
}

function labelForTrigger(trigger) {
  const labelledBy = trigger.getAttribute('aria-labelledby');
  if (labelledBy) {
    // Workday points aria-labelledby at three nodes: the question, the value
    // currently selected, and a "Required" marker. Joining them yields
    // "Country India Required", which matches nothing. Only the question is
    // wanted, and it is not always first, so take the first node that is not
    // the widget describing its own state.
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const text = (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !isGenericLabel(text)) return text;
    }
  }
  // Workday's aria-label on a dropdown is "<question> <current value> Required",
  // e.g. "Country India Required" or "Phone Device Type Select One Required".
  // The trigger's own text is that current value, so subtracting it and the
  // state words leaves the question.
  const aria = (trigger.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const question = aria ? questionFromAriaLabel(aria, trigger.textContent) : '';
  if (question && !isGenericLabel(question)) return question;

  // On the questionnaire steps the accessible name is pure state
  // (" Select One Required"), and the question is inside this widget's own
  // container. Read it there BEFORE looking outside: everything below this
  // point searches previous siblings, which is what produced the off-by-one.
  const own = questionnaireQuestion(trigger);
  if (own) return own;

  // Nothing in the accessible name was the question. On the questionnaire steps
  // it is rendered above the widget instead, and an unanswered dropdown's whole
  // accessible name is "Select One Required", so without this every question on
  // the step keys identically.
  const nearby = nearestQuestionText(trigger.closest('[data-automation-id]') || trigger);
  if (nearby && !isGenericLabel(nearby)) return nearby;

  const group = trigger.closest('[data-automation-id]');
  const label = group?.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
  if (label && !isGenericLabel(label)) return label;

  // Better nothing than "Select One Required": an unusable key is not merely
  // useless, it merges unrelated questions into one stored answer.
  return '';
}
