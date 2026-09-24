/**
 * Handshake job-page extractors. Production runs page.evaluate(handshakeJobSnapshot).
 * Tests feed a snapshot or fixture HTML into the pure helpers.
 */

export const HANDSHAKE_JOB_PATH = /\/(?:stu\/|edu\/)?(?:jobs|postings|job-search)\/(\d+)/i;

export function isHandshakeHost(url = '') {
  try { return /(^|\.)joinhandshake\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

export function isHandshakeJobUrl(url = '') {
  if (!isHandshakeHost(url)) return false;
  try { return HANDSHAKE_JOB_PATH.test(new URL(url).pathname); }
  catch { return false; }
}

export function isHandshakeSearchUrl(url = '') {
  if (!isHandshakeHost(url)) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    if (/\/job-search\/\d+/i.test(path)) return false;
    return /\/(?:stu\/)?postings$/i.test(path)
      || /\/job-search$/i.test(path)
      || /\/stu\/jobs$/i.test(path);
  } catch { return false; }
}

export function classifyApplyMode({ alreadyApplied = false, buttons = [] } = {}) {
  if (alreadyApplied) return 'already_applied';
  const labels = (Array.isArray(buttons) ? buttons : []).map(item => String(item || ''));
  if (labels.some(label => /apply\s+externally|external\s+apply|apply\s+on\s+(?:company|employer)/i.test(label))) {
    return 'external';
  }
  if (labels.some(label => /quick\s+apply|^apply$|apply\s+now|submit\s+application/i.test(label))) {
    return 'native';
  }
  return 'unknown';
}

/** Company from a Handshake document title, ignoring the visible job title and the Handshake suffix. */
export function handshakeCompanyName(docTitle = '', visibleTitle = '') {
  const title = String(visibleTitle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const titleParts = new Set(title.split('|').map(part => part.trim()).filter(Boolean));
  const parts = String(docTitle || '').split('|').map(part => part.trim()).filter(Boolean);
  const company = parts.find((part) => {
    const norm = part.toLowerCase();
    if (!norm || norm === 'handshake' || norm === 'jobs') return false;
    if (title && (title === norm || title.startsWith(`${norm} `) || title.startsWith(`${norm}|`) || norm.startsWith(title))) return false;
    if (titleParts.has(norm)) return false;
    return true;
  });
  return company || '';
}

export function extractHandshakeJob(snapshot = {}) {
  const url = String(snapshot.url || '');
  const title = String(snapshot.title || '').replace(/\s+/g, ' ').trim();
  const company = String(snapshot.company || '').replace(/\s+/g, ' ').trim();
  const location = String(snapshot.location || '').replace(/\s+/g, ' ').trim();
  const jdText = String(snapshot.jdText || snapshot.pageText || '').replace(/\u00a0/g, ' ').trim();
  const alreadyApplied = Boolean(snapshot.alreadyApplied);
  const login = Boolean(snapshot.login);
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const applyMode = snapshot.applyMode || classifyApplyMode({ alreadyApplied, buttons });
  const applyUrls = [...new Set((Array.isArray(snapshot.applyUrls) ? snapshot.applyUrls : [])
    .map((item) => {
      const raw = String(item || '').trim();
      if (/^https?:/i.test(raw)) return raw;
      try { return new URL(raw, url).href; } catch { return ''; }
    })
    .filter(href => /^https?:/i.test(href)))];
  return {
    url,
    title,
    company,
    location,
    jdText,
    pageText: jdText,
    alreadyApplied,
    login,
    buttons,
    applyMode,
    applyLabel: buttons[0] || '',
    applyUrls,
    applyUrl: applyUrls[0] || '',
    jobUrl: isHandshakeJobUrl(url),
  };
}

export function handshakeJobFromHtml(html = '', url = '') {
  const text = String(html);
  const title = text.match(/data-career-ops="title"[^>]*>([^<]+)/i)?.[1]
    || text.match(/<h1[^>]*>([^<]+)/i)?.[1]
    || '';
  const company = text.match(/data-career-ops="company"[^>]*>([^<]+)/i)?.[1]
    || text.match(/data-hook="job-employer"[^>]*>([^<]+)/i)?.[1]
    || '';
  const location = text.match(/data-career-ops="location"[^>]*>([^<]+)/i)?.[1]
    || '';
  const jd = text.match(/data-career-ops="jd"[^>]*>([\s\S]*?)<\/(?:div|section|article)>/i)?.[1]
    || text.match(/data-hook="job-description"[^>]*>([\s\S]*?)<\/(?:div|section|article)>/i)?.[1]
    || '';
  const alreadyApplied = /you applied|already applied|application sent/i.test(text);
  const login = /sign in to handshake|log in to continue/i.test(text);
  const buttons = [...text.matchAll(/data-career-ops="apply(?:-external)?"[^>]*>([^<]+)/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  if (!buttons.length) {
    if (/apply externally/i.test(text)) buttons.push('Apply Externally');
    else if (/quick apply/i.test(text)) buttons.push('Quick Apply');
    else if (/>\s*apply\s*</i.test(text)) buttons.push('Apply');
  }
  const jdText = jd.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const applyUrls = [...text.matchAll(/href="([^"]+)"[^>]*>\s*Apply Externally/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  return extractHandshakeJob({
    url, title: title.trim(), company: company.trim(), location: location.trim(),
    jdText, alreadyApplied, login, buttons, applyUrls,
  });
}

/** Runs inside the Handshake job tab. */
export function handshakeJobSnapshot() {
  const text = document.body?.innerText || '';
  const titleEl = [...document.querySelectorAll('[data-career-ops="title"], h1, [data-hook="job-title"]')].find(el => {
    const value = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return value && !/^(jobs|share this job|why are you reporting|confirm application)/i.test(value);
  });
  const docParts = (document.title || '').split('|').map(part => part.trim()).filter(Boolean);
  const titleFromDoc = docParts[0] && !/^jobs$/i.test(docParts[0]) ? docParts[0] : '';
  const title = (titleEl?.innerText || titleFromDoc || '').replace(/\s+/g, ' ').trim();
  const companyEl = document.querySelector('[data-career-ops="company"], [data-hook="job-employer"], a[href*="/employers/"], a[href*="/edu/employers"]');
  const companyFromDoc = (() => {
    const visible = title.toLowerCase();
    const visibleParts = new Set(visible.split('|').map(part => part.trim()).filter(Boolean));
    const match = docParts.find((part) => {
      const norm = part.toLowerCase();
      if (!norm || norm === 'handshake' || norm === 'jobs') return false;
      if (visible && (visible === norm || visible.startsWith(`${norm} `) || visible.startsWith(`${norm}|`) || norm.startsWith(visible))) return false;
      if (visibleParts.has(norm)) return false;
      return true;
    });
    return match || '';
  })();
  const locationEl = document.querySelector('[data-career-ops="location"], [data-hook="job-location"]');
  const jdEl = document.querySelector('[data-career-ops="jd"], [data-hook="job-description"], [class*="job-description"], article, main');
  const buttons = [...document.querySelectorAll('button, a[role="button"], a')]
    .map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(label => /apply/i.test(label))
    .slice(0, 8);
  const applyRe = /apply\s+externally|external\s+apply|apply\s+on\s+(?:company|employer)/i;
  const applyUrls = [...document.querySelectorAll('a[href], button, [role="button"]')].flatMap((el) => {
    const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const href = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
    if (!href) return [];
    if (applyRe.test(label) || /external_redirect|apply_redirect|\/ncc\//i.test(href)) return [href];
    return [];
  });
  return {
    url: location.href,
    title,
    company: (companyEl?.innerText || companyFromDoc || '').replace(/\s+/g, ' ').trim(),
    location: (locationEl?.innerText || '').replace(/\s+/g, ' ').trim(),
    jdText: (jdEl?.innerText || text).trim(),
    alreadyApplied: /you applied|already applied|application sent/i.test(text),
    login: /sign in to handshake|log in to continue/i.test(text),
    buttons,
    applyUrls,
  };
}
