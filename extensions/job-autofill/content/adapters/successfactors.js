/**
 * successfactors.js — SAP SuccessFactors tenants.
 *
 * Deliberately thin. Tenant DOM varies enough that per-selector knowledge does
 * not transfer, so this leans entirely on the generic engine plus the learning
 * loop. Custom career domains reach it via the popup's inject-on-this-page path.
 */

export default {
  id: 'successfactors',
  label: 'SuccessFactors',
  matches(url) {
    const h = new URL(url).hostname;
    // SAP serves these sites from several domains of its own: successfactors.*
    // for the career sites, sapsf.* for tenant career pages, and jobs2web.com
    // for its recruiting-marketing front ends.
    if (/(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|jobs2web\.com)$/.test(h)) return true;
    // Tenant-branded domains: detect by the SF app markup instead of the host.
    return Boolean(document.querySelector('[id^="careerSiteGeneral"], .jobDetailContainer, #careerSiteApplyForm'));
  },
  isMultiStep: false,
  canonicalMap: {},
  canonicalAttr: null,
};
