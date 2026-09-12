/**
 * lever.js — jobs.lever.co/{company}/{id}/apply
 *
 * The simplest board: a plain POST form with stable `name` attributes.
 * Custom questions arrive as cards[{uuid}][field0] and get their text from the
 * enclosing .application-question block.
 */

const NAME_MAP = {
  name: 'name.full',
  email: 'email',
  phone: 'phone.raw',
  org: 'work[0].company',
  'urls[LinkedIn]': 'links.linkedin',
  'urls[Github]': 'links.github',
  'urls[GitHub]': 'links.github',
  'urls[Portfolio]': 'links.portfolio',
  'urls[Other]': 'links.portfolio',
  location: 'location.raw',
};

export default {
  id: 'lever',
  label: 'Lever',
  // jobs.lever.co and the EU tenant jobs.eu.lever.co serve the same markup.
  matches(url) { return /(^|\.)lever\.co$/.test(new URL(url).hostname); },
  isMultiStep: false,
  canonicalMap: NAME_MAP,

  /** Look up a control's canonical profile path by its `name` attribute. */
  canonicalAttr(el) {
    const name = el.getAttribute('name');
    if (name && NAME_MAP[name]) return NAME_MAP[name];
    // The country select that decides WHICH EEO survey the form shows: Lever
    // ships one hidden survey per country and `hideAndShowSurveys.js` unhides
    // the matching one on this control's change event. It carries no name
    // attribute, so the class is the only handle. Leaving it blank left the
    // gender, race and veteran questions hidden and therefore unfillable.
    if (el.classList?.contains('candidate-location')) return 'location.country';
    return null;
  },

  /**
   * One .application-question block is, by construction, one question.
   *
   * Lever's pronoun block holds nine checkboxes named "pronouns" plus a
   * "Custom" box carrying no name at all, so grouping by the name attribute
   * split one question into two and stored "Custom" as a question of its own.
   */
  groupContainer(el) {
    return el.closest?.('li.application-question, .application-question') || null;
  },

  labelOverride(el) {
    const name = el.getAttribute('name') || '';
    // cards[uuid][field3] — the readable question sits on the wrapping block.
    if (name.startsWith('cards[')) {
      const block = el.closest('.application-question, li.application-question');
      const text = block?.querySelector('.text, .application-label')?.textContent;
      if (text) return text.replace(/\s+/g, ' ').trim();
    }
    // urls[LinkedIn] renders no visible label on some templates.
    const urlMatch = /^urls\[(.+)\]$/.exec(name);
    if (urlMatch) return `${urlMatch[1]} URL`;
    return null;
  },

  /** Lever's location field is an autocomplete: typing without picking loses it. */
  needsTyping(field) {
    return field.control.getAttribute('name') === 'location';
  },

  /**
   * Drive that autocomplete without firing `input`.
   *
   * Lever's retrieveLocations.js opens the dropdown on `input` and, on blur
   * while it is open, clears the location AND the hidden #selected-location the
   * form actually submits. The captcha iframe takes focus shortly after the
   * field is touched, so an announced write gets erased before its own search
   * comes back. The search itself is bound to keydown, so suppressing `input`
   * costs nothing and keeps the destructive blur path closed.
   */
  typeahead: { announceInput: false },
};
