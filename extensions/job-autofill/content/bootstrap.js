/**
 * bootstrap.js — classic content script.
 *
 * MV3 content_scripts entries cannot be ES modules, so this stub dynamic-imports
 * the real (module) entry point. That keeps every other file a plain ES module,
 * which is what lets tests/matcher.test.mjs import matcher.js unmodified under
 * `node --test` with no build step anywhere.
 */

(async () => {
  if (window.__jobAutofillMounted) return;
  window.__jobAutofillMounted = true;
  try {
    await import(chrome.runtime.getURL('content/main.js'));
  } catch (err) {
    console.error('[job-autofill] failed to load:', err);
    window.__jobAutofillMounted = false;
  }
})();
