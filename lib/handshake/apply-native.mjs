/**
 * Native Handshake Apply / Quick Apply. Fail-closed: extra required questions
 * and unrecognized flows become review items. Submit is the caller's choice
 * after submissionGate.
 */

import { submissionGate } from '../applications/policy.mjs';
import { ensureHandshakeCoverLetter, handshakeCoverLetterMissing } from './cover-letter.mjs';
import { classifyApplyMode } from './job-page.mjs';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function handshakeApplyButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a[role="button"], a')]
    .map(el => ({
      tag: el.tagName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter(item => /apply|submit application/i.test(item.text))
    .slice(0, 12)).catch(() => []);
}

export async function detectHandshakeApplyMode(page) {
  const targets = await page.evaluate(collectHandshakeExternalTargets).catch(() => []);
  const employer = chooseExternalApplyTarget(targets);
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const buttons = (await handshakeApplyButtons(page)).map(item => item.text);
  if (/you applied|already applied|application sent|withdraw application/i.test(text)) return { mode: 'already_applied', buttons, text, employer };
  if (employer) return { mode: 'external', buttons, text, employer };
  return { mode: classifyApplyMode({ buttons }), buttons, text, employer: null };
}

async function clickLabel(page, pattern) {
  const clicked = await page.evaluate(({ source, flags }) => {
    const re = new RegExp(source, flags);
    const nodes = [...document.querySelectorAll('a[href], button, [role="button"], a, input[type="submit"]')];
    const matches = nodes.filter(el => re.test((el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ')));
    const el = matches.find(item => item.tagName === 'A' && item.href) || matches[0];
    if (!el) return { ok: false, href: '', text: '' };
    const href = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    el.click();
    return { ok: true, href, text };
  }, { source: pattern.source, flags: pattern.flags }).catch(() => ({ ok: false, href: '', text: '' }));
  if (clicked?.ok) {
    await delay(1500);
    return clicked;
  }
  const buttons = page.locator('button, a[role="button"], a, input[type="submit"]');
  const count = await buttons.count();
  for (let index = 0; index < count; index++) {
    const el = buttons.nth(index);
    const label = String(await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (pattern.test(label)) {
      await el.click({ timeout: 5000 });
      await delay(1500);
      return { ok: true, href: '', text: label };
    }
  }
  return null;
}

/** Self-contained. Runs in the Handshake job tab. */
export function handshakeExternalApplySnapshot() {
  const re = /apply\s+externally|external\s+apply|apply\s+on\s+(?:company|employer)/i;
  return [...document.querySelectorAll('a, button, [role="button"]')].flatMap((el) => {
    const text = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!re.test(text)) return [];
    return [{
      text,
      href: el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '',
    }];
  }).slice(0, 8);
}

export async function handshakeExternalApplyTargets(page) {
  return page.evaluate(handshakeExternalApplySnapshot).catch(() => []);
}

async function armExternalNavigationProbe(page) {
  await page.evaluate(() => {
    if (window.__careerOpsNavArmed) return;
    window.__careerOpsNavArmed = true;
    window.__careerOpsExternal = [];
    const push = (url) => {
      const value = String(url || '');
      if (value) window.__careerOpsExternal.push(value);
    };
    const origOpen = window.open;
    window.open = function(url, ...rest) {
      push(url);
      return origOpen.call(this, url, ...rest);
    };
    document.addEventListener('click', (event) => {
      const link = event.target?.closest?.('a[href]');
      if (link?.href) push(link.href);
    }, true);
  }).catch(() => {});
}

async function readExternalNavigationProbe(page) {
  const urls = await page.evaluate(() => window.__careerOpsExternal || []).catch(() => []);
  return Array.isArray(urls) ? urls : [];
}

/** Runs inside the Handshake tab. Hidden steppers do not count as an open overlay. */
export function handshakeExternalOverlaySnapshot() {
  const labelOf = (el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const controls = [...document.querySelectorAll('button, a, [role="button"]')];
  const externalRe = /external\s+application/i;
  const leave = controls.find(el => visible(el) && externalRe.test(labelOf(el)) && el.disabled !== true && el.getAttribute('aria-disabled') !== 'true');
  const applyStillThere = controls.some(el => visible(el) && /apply\s+externally|external\s+apply/i.test(labelOf(el)) && el.disabled !== true);
  if (!leave || applyStillThere) {
    return { overlayOpen: false, resumeInput: false, resumeAttached: false, buttons: [], leaveDisabled: true };
  }
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter(visible);
  const resume = inputs.find((el) => {
    const label = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.closest('label, div, section')?.innerText || ''}`;
    return /resume|curriculum|cv|document/i.test(label);
  }) || inputs[0] || null;
  if (resume) resume.setAttribute('data-career-ops-resume', '1');
  const preview = controls.some(el => visible(el) && /preview\s+document|\.pdf\b/i.test(labelOf(el)));
  const labels = controls.filter(visible).map(labelOf).filter(text => /apply|resume|document|external|upload|preview|attach|next/i.test(text));
  const buttons = [...new Set([labelOf(leave), ...labels])].filter(Boolean).slice(0, 20);
  return {
    overlayOpen: true,
    resumeInput: true,
    resumeAttached: Boolean(resume?.files?.length) || preview || !resume,
    buttons,
    leaveDisabled: false,
  };
}

export function externalApplicationLabel(buttons = []) {
  return (buttons || []).find(label => /external\s+application/i.test(String(label || ''))) || '';
}

/** Apply Externally is the first click. External Application is the overlay button that opens the employer tab. */
export function handshakeExternalOverlayAction(snapshot = {}) {
  if (!snapshot.overlayOpen) return 'open_overlay';
  if (!snapshot.resumeAttached) return 'attach_resume';
  if (externalApplicationLabel(snapshot.buttons) && snapshot.leaveDisabled !== true) return 'external_application';
  if (externalApplicationLabel(snapshot.buttons)) return 'wait_external_application';
  return 'missing_external_application';
}

/** Self-contained. Opens the resume chooser when the overlay hides the file input. */
export function revealHandshakeResumeControl() {
  const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], [data-hook="apply-modal"]');
  if (!dialog || dialog.querySelector('input[type="file"]')) return false;
  const el = [...dialog.querySelectorAll('button, [role="button"], label')].find((item) => {
    const text = (item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return /resume|attach|upload/i.test(text) && !/external\s+application/i.test(text);
  });
  if (!el) return false;
  el.click();
  return true;
}

/** Walks open shadow roots. Handshake's apply wizard is not only in light DOM. */
export function collectHandshakeExternalTargets() {
  const rows = [];
  const visit = (root, depth) => {
    if (!root?.querySelectorAll || depth > 6) return;
    for (const el of root.querySelectorAll('a[href], button, [role="button"]')) {
      const text = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const href = el.href || el.getAttribute('href') || '';
      if (!/apply|external|resume|view application|next/i.test(`${text} ${href}`)) continue;
      const rect = el.getBoundingClientRect();
      rows.push({
        text: text.slice(0, 120),
        href,
        w: rect.width,
        h: rect.height,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      });
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
    }
  };
  visit(document, 0);
  return rows.slice(0, 40);
}

export function chooseExternalApplyTarget(targets = []) {
  const usable = [];
  for (const item of targets || []) {
    const href = String(item?.href || '');
    if (!/^https?:/i.test(href)) continue;
    try {
      if (/(^|\.)joinhandshake\.com$/i.test(new URL(href).hostname)) continue;
    } catch { continue; }
    usable.push({ ...item, href });
  }
  return usable.find(item => /view application|external application|apply here|apply on/i.test(item.text || ''))
    || usable[0]
    || null;
}

/** Clicks View application when Handshake already has the employer URL, else Step 2. */
export function clickHandshakeEmployerLink() {
  const nodes = [];
  const visit = (root, depth) => {
    if (!root?.querySelectorAll || depth > 6) return;
    nodes.push(...root.querySelectorAll('a[href], button, [role="button"]'));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
    }
  };
  visit(document, 0);
  const labelOf = (el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const employer = nodes.find((el) => {
    const href = el.href || '';
    const text = labelOf(el);
    if (!/^https?:/i.test(href) || !/view application|external application|apply here|apply on/i.test(text)) return false;
    try { return !/(^|\.)joinhandshake\.com$/i.test(new URL(href).hostname); } catch { return false; }
  });
  const step = nodes.find(el => /external\s+application/i.test(labelOf(el)) && el.disabled !== true && el.getAttribute('aria-disabled') !== 'true');
  const el = employer || step;
  if (!el) return { ok: false, href: '', text: '' };
  const href = el.href || el.getAttribute('href') || '';
  const text = labelOf(el);
  el.click();
  return { ok: true, href, text };
}

/** Self-contained. Clicks the visible Apply Externally control, not a hidden duplicate. */
export function clickVisibleApplyExternally() {
  const re = /apply\s+externally|external\s+apply/i;
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const el = nodes.find(item => visible(item) && re.test((item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()))
    || nodes.find(item => re.test((item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
  if (!el) return { ok: false, href: '', text: '' };
  const href = el.href || el.getAttribute('href') || '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  el.click();
  return { ok: true, href, text };
}
export function clickHandshakeExternalApplicationButton() {
  const re = /external\s+application/i;
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const el = [...document.querySelectorAll('button, a, [role="button"]')].find((item) => {
    const text = (item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return visible(item) && re.test(text) && item.disabled !== true && item.getAttribute('aria-disabled') !== 'true';
  });
  if (!el) return { ok: false, href: '', text: '' };
  const href = el.href || el.getAttribute('href') || '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  el.click();
  return { ok: true, href, text };
}

async function attachHandshakeResume(page, resumePath) {
  if (typeof page.setInputFiles === 'function') {
    await page.setInputFiles('input[data-career-ops-resume="1"]', resumePath);
    return;
  }
  const input = page.locator('input[data-career-ops-resume="1"]').first();
  await input.setInputFiles(resumePath);
}

/**
 * Apply Externally opens an overlay. Attach the configured resume, then click
 * External Application. That second click is what opens the employer tab.
 */
export async function submitHandshakeExternalOverlay(page, { resumePath = '', beforeLeave = null } = {}) {
  await armExternalNavigationProbe(page);
  const readTarget = async () => chooseExternalApplyTarget(
    await page.evaluate(collectHandshakeExternalTargets).catch(() => []),
  );
  let picked = await readTarget();
  if (!picked) {
    const openBy = Date.now() + 15000;
    let opened = { ok: false, href: '', text: '' };
    while (Date.now() < openBy && !opened.ok && !opened.text) {
      opened = await clickTrustedLabel(page, 'apply\\s+externally|external\\s+apply');
      if (!opened.ok) {
        opened = await page.evaluate(clickVisibleApplyExternally).catch(() => ({ ok: false, href: '', text: '' }));
      }
      if (opened?.ok || opened?.text) break;
      await delay(400);
    }
    if (!opened?.ok && !opened?.text) {
      return { status: 'NEEDS_REVIEW', reason: 'APPLY_CONTROL_MISSING', href: '', probe: [] };
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !picked) {
      if (resumePath) {
        await page.evaluate(() => {
          const input = document.querySelector('input[type="file"]');
          if (input) input.setAttribute('data-career-ops-resume', '1');
        }).catch(() => {});
        await attachHandshakeResume(page, resumePath).catch(() => {});
      }
      picked = await readTarget();
      if (picked) break;
      await page.evaluate(clickHandshakeEmployerLink).catch(() => ({ ok: false }));
      await delay(500);
      picked = await readTarget();
    }
  }
  if (!picked?.href) {
    return { status: 'NEEDS_REVIEW', reason: 'EXTERNAL_APPLICATION_CONTROL_MISSING', href: '', probe: [] };
  }
  if (beforeLeave) await beforeLeave();
  let clicked = { ok: true, href: picked.href, text: picked.text || '' };
  try {
    clicked = await page.evaluate(clickHandshakeEmployerLink);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/context|destroyed|navigation|target closed/i.test(message)) {
      clicked = { ok: true, href: picked.href, text: picked.text || '' };
    }
  }
  const probe = await readExternalNavigationProbe(page);
  return {
    status: 'OPENED',
    reason: 'external_application',
    href: clicked?.href || picked.href,
    probe: [...new Set([picked.href, ...(probe || [])])],
    text: clicked?.text || picked.text || '',
    url: page.url(),
  };
}

export async function clickHandshakeApply(page) {
  const detected = await detectHandshakeApplyMode(page);
  if (detected.mode === 'already_applied') return detected;
  await armExternalNavigationProbe(page);
  const targets = detected.mode === 'external' ? await handshakeExternalApplyTargets(page) : [];
  if (detected.mode === 'external') {
    const clicked = await clickLabel(page, /apply\s+externally|external\s+apply/i);
    const probe = await readExternalNavigationProbe(page);
    return {
      ...detected,
      clicked: clicked?.text || clicked,
      href: clicked?.href || targets.find(item => item.href)?.href || '',
      probe,
      url: page.url(),
    };
  }
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((item) => {
      const text = (item.innerText || '').replace(/\s+/g, ' ').trim();
      const rect = item.getBoundingClientRect();
      return /^(?:quick\s+apply|apply|apply\s+now)$/i.test(text) && rect.width > 1 && rect.height > 1 && item.disabled !== true;
    });
    if (!el) return { ok: false, href: '', text: '' };
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    el.click();
    return { ok: true, href: '', text };
  }).catch(() => ({ ok: false, href: '', text: '' }));
  return { ...detected, clicked: clicked?.text || clicked, url: page.url() };
}

export async function inspectHandshakeNativeForm(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const login = /sign in to handshake|log in to continue/i.test(text);
  const captcha = /captcha|recaptcha/i.test(text);
  const success = /you applied|you(?:'|’)ve applied|withdraw application|application (?:was )?sent|application (?:was )?submitted|successfully applied/i.test(text);
  const submitVisible = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].some((el) => {
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && /submit application|^submit$/i.test(text) && el.disabled !== true;
  })).catch(() => false);
  const fields = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('input, select, textarea')].filter(el => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button'].includes(type)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    });
    return controls.map(el => ({
      question: el.getAttribute('aria-label') || el.name || el.id || el.placeholder || '',
      required: el.required === true,
      value: el.value || '',
      type: (el.getAttribute('type') || el.tagName || '').toLowerCase(),
    }));
  }).catch(() => []);
  return { text, login, captcha, success, submitVisible, fields };
}

export function handshakeNativeGate(inspect, { certified = true } = {}) {
  const fields = (inspect.fields || []).map(field => ({
    question: field.question || 'Handshake field',
    required: Boolean(field.required),
    value: field.value || '',
    validation_error: field.required && !field.value,
    risk: 'LOW',
  }));
  return submissionGate({
    page: {
      login: inspect.login,
      mfa: false,
      captcha: inspect.captcha,
      accountCreation: false,
      certified,
      exactReviewPage: Boolean(inspect.submitVisible || inspect.success),
    },
    fields,
    resume: { hash: 'handshake-profile', expected_hash: 'handshake-profile' },
    generated: [],
  });
}

async function clickTrustedLabel(page, source) {
  const point = await page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((item) => {
      const text = (item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const rect = item.getBoundingClientRect();
      return re.test(text) && rect.width > 40 && rect.height > 20 && item.disabled !== true;
    });
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
      hit: (hit?.innerText || hit?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }, source).catch(() => null);
  if (!point || typeof page.trustedClick !== 'function') return { ok: false, href: '', text: '' };
  if (!new RegExp(source, 'i').test(`${point.hit} ${point.text}`)) return { ok: false, href: '', text: '' };
  try {
    await page.trustedClick(point.x, point.y);
    return { ok: true, href: '', text: point.text };
  } catch {
    return { ok: false, href: '', text: '' };
  }
}

async function clickVisibleHandshakeSubmit(page) {
  const point = await page.evaluate(() => {
    const matches = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((item) => {
      const text = (item.innerText || item.value || '').replace(/\s+/g, ' ').trim();
      const rect = item.getBoundingClientRect();
      return rect.width > 40 && rect.height > 20 && /submit application|^submit$/i.test(text) && item.disabled !== true;
    });
    const el = matches.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => null);
  if (!point) return { ok: false, text: '' };
  if (typeof page.trustedClick === 'function') {
    await page.trustedClick(point.x, point.y);
    return { ok: true, text: point.text, trusted: true };
  }
  return { ok: false, text: point.text };
}

export async function applyHandshakeNative(page, { maySubmit = false, certified = true, skipClick = false, resumePath = '', coverLetter = null } = {}) {
  const started = skipClick ? await detectHandshakeApplyMode(page) : await clickHandshakeApply(page);
  if (started.mode === 'already_applied') {
    return { status: 'SUBMITTED', reason: 'handshake-withdraw-application', mode: started.mode };
  }
  if (started.mode === 'external') {
    return { status: 'EXTERNAL', reason: 'apply_externally', mode: started.mode, url: page.url(), employer: started.employer || null };
  }
  if (started.mode === 'unknown' && !started.clicked) {
    return { status: 'NEEDS_REVIEW', reason: 'APPLY_CONTROL_MISSING', mode: started.mode };
  }
  const deadline = Date.now() + 10000;
  let inspect = await inspectHandshakeNativeForm(page);
  while (Date.now() < deadline && !inspect.submitVisible && !inspect.success) {
    await delay(400);
    inspect = await inspectHandshakeNativeForm(page);
  }
  if (inspect.success) return { status: 'SUBMITTED', reason: 'handshake-withdraw-application', mode: 'native', inspect };
  if (!inspect.submitVisible) {
    return { status: 'NEEDS_REVIEW', reason: 'SUBMIT_CONTROL_MISSING', mode: 'native', inspect };
  }
  if (resumePath) await attachHandshakeResume(page, resumePath).catch(() => {});
  if (maySubmit && coverLetter && handshakeCoverLetterMissing(inspect.text)) {
    const attached = await ensureHandshakeCoverLetter(page, coverLetter).catch(error => ({
      attached: false,
      error: String(error?.message || error).slice(0, 180),
    }));
    inspect = await inspectHandshakeNativeForm(page);
    if (!attached?.attached || handshakeCoverLetterMissing(inspect.text)) {
      return {
        status: 'NEEDS_REVIEW',
        reason: 'VALIDATION_ERROR',
        blockers: [{ code: 'VALIDATION_ERROR', detail: attached?.error || 'Handshake required a cover letter before Submit Application' }],
        mode: 'native',
        inspect,
      };
    }
  }
  inspect = await inspectHandshakeNativeForm(page);
  const gate = handshakeNativeGate(inspect, { certified });
  if (gate.blockers.length) {
    return {
      status: 'NEEDS_REVIEW',
      reason: gate.blockers[0]?.code || 'SUBMISSION_BLOCKED',
      blockers: gate.blockers,
      mode: 'native',
      inspect,
    };
  }
  if (!maySubmit) {
    return { status: 'READY_TO_SUBMIT', reason: 'submit_disabled', mode: 'native', inspect };
  }
  const submitted = await clickVisibleHandshakeSubmit(page);
  if (!submitted?.ok) {
    return { status: 'NEEDS_REVIEW', reason: 'SUBMIT_CONTROL_MISSING', mode: 'native', inspect };
  }
  await delay(500);
  const confirmBy = Date.now() + 12000;
  let after = await inspectHandshakeNativeForm(page);
  while (Date.now() < confirmBy && !after.success) {
    await delay(400);
    after = await inspectHandshakeNativeForm(page);
  }
  if (after.success) {
    return { status: 'SUBMITTED', reason: 'adapter-text', mode: 'native', inspect: after };
  }
  if (/please enter a valid response|make sure all required fields are filled out/i.test(after.text || '')) {
    return {
      status: 'NEEDS_REVIEW',
      reason: 'VALIDATION_ERROR',
      blockers: [{ code: 'VALIDATION_ERROR', detail: 'Handshake required a document or answer before Submit Application' }],
      mode: 'native',
      inspect: after,
    };
  }
  return {
    status: 'SUBMISSION_UNKNOWN',
    reason: 'no_confirmation',
    mode: 'native',
    inspect: after,
  };
}
