/**
 * greenhouse.js — boards.greenhouse.io (classic) and job-boards.greenhouse.io
 * (React rewrite). Also matches embedded iframes via all_frames.
 */

const ID_MAP = {
  first_name: 'name.first',
  last_name: 'name.last',
  email: 'email',
  phone: 'phone.raw',
  job_application_answers_attributes_0_text_value: null,
};

/**
 * Greenhouse numbers each repeated education block: school--0, degree--0,
 * start-year--0, then --1 for the next. Route those straight at the matching
 * profile entry so the second degree's dates can never land on the first.
 * Without this they all share the label "Start date year" and one global
 * answer fills every block with the same, mostly wrong, value.
 */
const EDUCATION_FIELDS = {
  school: 'school',
  degree: 'degreeOption',
  discipline: 'fieldOption',
  'start-month': 'startMonthName',
  'start-year': 'startYear',
  'end-month': 'endMonthName',
  'end-year': 'endYear',
};

export function educationPath(attr) {
  const m = /^([a-z-]+)--(\d+)$/.exec(String(attr || ''));
  if (!m) return null;
  const key = EDUCATION_FIELDS[m[1]];
  return key ? `education[${m[2]}].${key}` : null;
}

export default {
  id: 'greenhouse',
  label: 'Greenhouse',
  matches(url) {
    const h = new URL(url).hostname;
    // A suffix-only check would incorrectly claim look-alike hosts such as
    // `notgreenhouse.io`. Certified navigation requires a real DNS boundary.
    return /(^|\.)greenhouse\.io$/i.test(h) || /^grnh\.se$/i.test(h);
  },
  isMultiStep: false,
  canonicalMap: ID_MAP,

  /**
   * The board's job list, not an application.
   *
   * A taken-down posting redirects to "job-boards.greenhouse.io/{company}
   * ?error=true", whose only controls are the list's own search box and filter
   * dropdowns. Reporting those as fillable fields is misleading, and worse, a
   * filter the user then touches would be learned as an answer to a question
   * called "Department".
   */
  skipPage(url) {
    const { pathname } = new URL(url);
    if (/\/jobs\/\d+/.test(pathname)) return false;
    // Embedded application forms live at /embed/job_app.
    if (/\/embed\/job_app/.test(pathname)) return false;
    return true;
  },

  canonicalAttr(el) {
    const id = el.getAttribute('id');
    if (id && ID_MAP[id]) return ID_MAP[id];
    const name = el.getAttribute('name');
    if (name && ID_MAP[name]) return ID_MAP[name];
    return educationPath(id || name || '');
  },

  /**
   * School and degree are typeaheads backed by a fixed list: free text is
   * discarded on submit, so the suggestion has to be clicked.
   */
  needsTyping(field) {
    const id = field.control.getAttribute('id') || '';
    return /school|degree|discipline/i.test(id) && field.control.tagName === 'INPUT';
  },

  /**
   * Legacy select2 hides the real <select> behind a styled shell. Setting the
   * native select still submits correctly; the shell text is cosmetic.
   */
  afterFill(field) {
    const el = field.control;
    if (el.tagName !== 'SELECT') return;
    const shell = el.parentElement?.querySelector('.select2-chosen, .select2-selection__rendered');
    if (shell && el.selectedOptions[0]) shell.textContent = el.selectedOptions[0].textContent;
  },
};
