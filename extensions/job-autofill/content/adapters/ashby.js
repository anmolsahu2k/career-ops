/**
 * ashby.js — jobs.ashbyhq.com
 *
 * React SPA. Labels wrap their inputs (the engine's wrapping-label step covers
 * that). Yes/No questions render as a pair of <button>s with no form control
 * behind them, so they are surfaced as extra fields here.
 */

import { selectedButton, commonAncestor } from '../engine.js';

/**
 * Ashby ships a stable class beside its hashed CSS-module ones. Keying off a
 * hashed name is what broke this: `._container_ux2kt_1` matched some earlier
 * build and nothing afterwards, so every Yes/No question on the form went
 * undetected, work authorization and sponsorship among them.
 */
const FIELD_ENTRY = '.ashby-application-form-field-entry';

/**
 * Controls that mean an entry is a real input rather than a button group.
 *
 * Checkboxes are excluded on purpose: a Yes/No pair is backed by one hidden
 * checkbox holding the boolean, which is the widget's own storage and not
 * something to fill. Treating it as a blocker is what kept these questions
 * invisible even after the container selector was fixed.
 */
const REAL_INPUT = 'input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), select, textarea';

/**
 * Ashby's EEO controls are named `<uuid>__systemfield_eeoc_<field>`, on the
 * input's `name` and inside its id. These map onto the profile's demographics,
 * so naming them properly is what lets the stored answers fill them.
 */
const EEOC_FIELD = /_systemfield_eeoc_([a-z_]+?)(?:-labeled-radio-\d+)?$/;
const EEOC_LABELS = {
  gender: 'Gender',
  race: 'Race',
  ethnicity: 'Race',
  hispanic_latino: 'Hispanic or Latino',
  veteran_status: 'Veteran Status',
  disability: 'Disability Status',
  disability_status: 'Disability Status',
};

/** The question text of whichever field entry contains this element. */
function entryLabel(el) {
  const entry = el?.closest?.(FIELD_ENTRY);
  const text = entry?.querySelector('label')?.textContent?.replace(/\s+/g, ' ').trim();
  return text || '';
}

export default {
  id: 'ashby',
  label: 'Ashby',
  matches(url) { return new URL(url).hostname.endsWith('ashbyhq.com'); },
  isMultiStep: false,
  canonicalMap: {},
  /**
   * Ashby's applicant data-processing consent is a system field whose visible
   * label is only "I agree". Map it onto the seeded Affirmation acknowledgement
   * so ordinary privacy/data consent can be checked without guessing marketing
   * opt-ins that share the same short wording.
   */
  canonicalAttr(el) {
    const tip = `${el?.id || ''} ${el?.name || ''} ${el?.getAttribute?.('name') || ''}`;
    if (/_systemfield_data_consent_ack\b/i.test(tip)) {
      return 'application.acknowledgements.requiredPrivacyPolicy';
    }
    return null;
  },

  /**
   * One field entry is one question, so every choice inside it is one field.
   *
   * Ashby gives each checkbox in a "select all that apply" block its own name,
   * so grouping by the name attribute split a single question into one field
   * per option: answering "How do you identify your sexual orientation?" left
   * "Bisexual", "Lesbian", "Gay" and "Queer" each listed as a question still
   * needing an answer, and any one of them ticked would have been stored under
   * its own option text as the question.
   */
  groupContainer(el) {
    // Ashby ids its choices `<question-uuid>_<option-uuid>-labeled-checkbox-N`,
    // so the part before `-labeled-` is the question and only the trailing
    // index changes between options. The `name` attribute does not group them,
    // which is why one question arrived as one field per option.
    const id = el.getAttribute?.('id') || '';
    const match = /^(.*)-labeled-(?:checkbox|radio)-\d+$/.exec(id);
    if (match) {
      const siblings = [...document.querySelectorAll(
        `input[id^="${CSS.escape(match[1])}-labeled-"]`
      )];
      if (siblings.length > 1) return commonAncestor(siblings);
    }
    // Otherwise the entry, but only when it is purely a choice. The phone entry
    // holds a tel input AND a consent checkbox, and there "Phone" is the
    // question for the input, not for the consent box, whose own label is the
    // statement being agreed to. Same rule as labelOverride below.
    const entry = el.closest?.(FIELD_ENTRY);
    return entry && !entry.querySelector(REAL_INPUT) ? entry : null;
  },

  /**
   * A checkbox's own label is its option text ("Yes - I consent to receiving
   * text messages"); the question lives on the entry. Without this the option
   * text became the stored question.
   */
  labelOverride(el) {
    // EEO groups live outside the field entries and their fieldset carries no
    // usable legend, so label resolution called the gender group "Male" and
    // gave the race group the entire gender block as its question. Ashby names
    // these system fields semantically, which is the dependable hook.
    const tip = `${el.getAttribute?.('name') || ''} ${el.id || ''}`;
    if (/_systemfield_data_consent_ack\b/i.test(tip)) return 'Affirmation';
    const eeoc = EEOC_FIELD.exec(el.getAttribute?.('name') || el.id || '');
    if (eeoc && EEOC_LABELS[eeoc[1]]) return EEOC_LABELS[eeoc[1]];

    const type = (el.getAttribute?.('type') || '').toLowerCase();
    if (type !== 'checkbox' && type !== 'radio') return null;
    // Only for an entry that is purely a choice. The phone entry holds a tel
    // input AND a consent checkbox, and there "Phone number" is the question
    // for the input, not for the consent box, whose own label is the statement
    // being agreed to.
    const entry = el.closest?.(FIELD_ENTRY);
    if (!entry || entry.querySelector(REAL_INPUT)) return null;
    return entryLabel(el) || null;
  },

  detectExtraFields(root) {
    const out = [];

    // Segmented Yes/No pairs: an entry whose only controls are buttons.
    for (const entry of root.querySelectorAll(FIELD_ENTRY)) {
      // Some Ashby themes render the same segmented choice as native radios
      // underneath its visual buttons. detectFields already owns that group;
      // adding a second buttongroup created two descriptors whose readbacks
      // could disagree on a required legal answer. Extras are only for a
      // genuinely button-only control.
      if (entry.querySelector(`${REAL_INPUT}, input[type="radio"], input[type="checkbox"]`)) continue;
      const buttons = [...entry.querySelectorAll('button')]
        .filter(b => b.textContent.trim() && !/upload/i.test(b.textContent));
      if (buttons.length < 2) continue;
      const rawLabel = entryLabel(buttons[0]);
      if (!rawLabel) continue;
      out.push({
        control: buttons[0],
        kind: 'buttongroup',
        rawLabel,
        options: buttons.map(b => {
          const text = b.textContent.replace(/\s+/g, ' ').trim();
          return { el: b, value: text, text };
        }),
        members: buttons,
      });
    }

    // Comboboxes (country, school, degree).
    for (const combo of root.querySelectorAll('input[role="combobox"]')) {
      if (combo.closest('#job-autofill-panel')) continue;
      const rawLabel = entryLabel(combo) || combo.getAttribute('aria-label') || '';
      if (!rawLabel) continue;
      out.push({
        control: combo,
        kind: 'combobox-input',
        rawLabel,
        options: [],
        members: [combo],
      });
    }

    return out;
  },
};
