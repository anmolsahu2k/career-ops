import { classifyLiveness } from '../../liveness-core.mjs';

/** Collect the same page signals check-liveness / scan gates use. */
export async function collectPageLivenessSignals(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const applyControls = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'),
    );
    return candidates
      .filter(element => {
        if (element.closest('nav, header, footer')) return false;
        if (element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (!element.getClientRects().length) return false;
        return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
      })
      .map(element => {
        const label = [
          element.innerText,
          element.value,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        return label;
      })
      .filter(Boolean);
  });
  return { bodyText, applyControls };
}

/**
 * Probe an already-opened application page. Expired postings must never reach
 * fill/prose/submit; uncertain ones become explicit review items.
 */
export async function probePageLiveness(page, { status = 0 } = {}) {
  try {
    const finalUrl = page.url();
    const { bodyText, applyControls } = await collectPageLivenessSignals(page);
    return classifyLiveness({ status, finalUrl, bodyText, applyControls });
  } catch (error) {
    return { result: 'expired', reason: `navigation error: ${String(error.message || error).split('\n')[0]}` };
  }
}

/** Map a liveness verdict onto attempt transition inputs. */
export function livenessAttemptPatch(verdict) {
  const result = verdict?.result || 'uncertain';
  if (result === 'active') return null;
  if (result === 'expired') {
    return {
      state: 'SKIPPED',
      blockers: [{ code: 'LIVENESS_EXPIRED', detail: verdict.reason || 'Posting classified expired before fill' }],
    };
  }
  return {
    state: 'NEEDS_REVIEW',
    blockers: [{ code: 'LIVENESS_UNCERTAIN', detail: verdict.reason || 'Posting liveness could not be confirmed' }],
  };
}
