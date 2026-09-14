/**
 * Wait until the visible required-control count stops changing. ATS boards
 * mount EEO / location-dependent fields after the first fill; advancing Next
 * without this wait leaves blanks that only show up at submit time.
 */
export async function waitForFieldStability(page, {
  timeoutMs = 8000,
  quietMs = 700,
  pollMs = 250,
} = {}) {
  const started = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await page.evaluate(() => {
      const form = document.querySelector('form, [role="tabpanel"]#form') || document.body;
      if (!form) return 0;
      return [...form.querySelectorAll('input, select, textarea')].filter(el => {
        if (el.disabled || el.type === 'hidden') return false;
        const style = getComputedStyle(el);
        if (el.type !== 'file' && (style.display === 'none' || style.visibility === 'hidden')) return false;
        return el.required || el.getAttribute('aria-required') === 'true';
      }).length;
    }).catch(() => 0);
    if (count === lastCount) {
      if (Date.now() - quietSince >= quietMs) {
        return { stable: true, field_count: count, waited_ms: Date.now() - started };
      }
    } else {
      lastCount = count;
      quietSince = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return { stable: false, field_count: lastCount, waited_ms: Date.now() - started };
}
