/**
 * generic.js — fallback adapter. Every hook is a no-op; the engine's own
 * label resolution and the native fillers do all the work.
 */

export default {
  id: 'generic',
  label: 'Unknown board',
  matches() { return true; },
  isMultiStep: false,
  canonicalMap: {},
  canonicalAttr: null,
};
