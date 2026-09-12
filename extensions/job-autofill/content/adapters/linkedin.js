/**
 * linkedin.js — signed-in LinkedIn Easy Apply
 *
 * This adapter is intentionally narrow: only a `/jobs/view/{id}` page can be
 * inspected or filled. The extension is present on LinkedIn's other pages so
 * the runner can use the existing signed-in browser later, but profile pages,
 * messages, feed posts, and job-search controls are always ignored.
 *
 * It is not added to the production ATS allowlist until the CDP-attached
 * main-profile canary and final-screen fixtures have passed.
 */

const NAME_MAP = {
  firstName: 'name.first',
  lastName: 'name.last',
  emailAddress: 'email',
  phoneNumber: 'phone.raw',
};

function isJobView(url) {
  try { return /^\/jobs\/view\/\d+(?:\/|$)/.test(new URL(url).pathname); }
  catch { return false; }
}

export default {
  id: 'linkedin',
  label: 'LinkedIn Easy Apply',
  matches(url) {
    try { return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname); }
    catch { return false; }
  },
  isMultiStep: true,
  canonicalMap: NAME_MAP,
  skipPage(url) { return !isJobView(url); },
  canonicalAttr(el) {
    const name = el.getAttribute?.('name');
    return NAME_MAP[name] || null;
  },
  /**
   * LinkedIn keeps its global search bars and page chrome mounted while Easy
   * Apply is open. Only the dialog is part of the application. Returning null
   * is deliberate: callers abstain rather than scan the rest of the page when
   * no Easy Apply dialog is visible.
   */
  formRoot(root = document) {
    return root.querySelector?.(
      '.jobs-easy-apply-modal, [role="dialog"][aria-label*="Easy Apply" i], [role="dialog"][data-test-modal]'
    ) || null;
  },
  // LinkedIn labels each question with an accessible aria-label while the
  // rendered label may be a transient React sibling. The core engine already
  // prefers that label; no broad DOM selector belongs here because it would
  // accidentally capture controls outside the Easy Apply dialog.
  labelOverride() { return null; },
};
