/**
 * handshake.js — CMU / joinhandshake.com job pages.
 *
 * Only a job posting URL is inspected or filled. Search, profile, and messaging
 * chrome stay out of the form root. Native Quick Apply uses the Apply dialog
 * as formRoot. Apply Externally attaches the resume in that overlay, then
 * External Application opens the employer tab for the ATS adapter.
 *
 * Certified only through applications.main_profile (CDP). Never added to the
 * dedicated-profile supported_ats allowlist.
 */

const NAME_MAP = {
  first_name: 'name.first',
  last_name: 'name.last',
  email: 'email',
  phone: 'phone.raw',
};

function isJobView(url) {
  try { return /\/(?:stu\/|edu\/)?(?:jobs|postings|job-search)\/\d+/i.test(new URL(url).pathname); }
  catch { return false; }
}

export default {
  id: 'handshake',
  label: 'Handshake',
  matches(url) {
    try { return /(^|\.)joinhandshake\.com$/i.test(new URL(url).hostname); }
    catch { return false; }
  },
  isMultiStep: false,
  canonicalMap: NAME_MAP,
  skipPage(url) { return !isJobView(url); },
  canonicalAttr(el) {
    const name = el.getAttribute?.('name') || el.getAttribute?.('id');
    return NAME_MAP[name] || null;
  },
  /**
   * Handshake keeps global search and nav mounted while Quick Apply is open.
   * Only the Apply dialog is the application. Returning null abstains rather
   * than scanning the rest of the page.
   */
  formRoot(root = document) {
    return root.querySelector?.(
      '[role="dialog"][data-career-ops="apply-dialog"], [role="dialog"], [data-hook="apply-modal"], form[data-career-ops="handshake-apply"]'
    ) || null;
  },
  labelOverride() { return null; },
};
