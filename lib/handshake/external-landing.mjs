/**
 * Apply Externally landing selection. Daily Chrome has many off-Handshake
 * tabs (Drive, Gmail). Those are not the apply destination unless the
 * Apply Externally click opened them or named them in href/window.open.
 */

import { classifyApplyLanding } from '../applications/ats.mjs';

export function isIncidentalExternalHost(host = '') {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return true;
  if (h === 'careers.google.com' || h === 'jobs.google.com') return false;
  if (h === 'google.com' || h.endsWith('.google.com')) return true;
  if (h.endsWith('.googleusercontent.com') || h === 'gmail.com') return true;
  return [
    'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'facebook.com', 'instagram.com', 'reddit.com',
  ].includes(h);
}

export function isHandshakeOutboundRedirect(url = '') {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)joinhandshake\.com$/i.test(parsed.hostname)) return false;
    return /apply|redirect|external|ncc|out|exit|away|outbound/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export function unwrapExternalUrl(url = '', base = '') {
  let href = '';
  try { href = base ? new URL(String(url), base).href : new URL(String(url)).href; }
  catch { return ''; }
  try {
    const parsed = new URL(href);
    if (/(^|\.)joinhandshake\.com$/i.test(parsed.hostname)) {
      for (const key of ['url', 'redirect_url', 'redirect', 'destination', 'to', 'target', 'u', 'next']) {
        const inner = parsed.searchParams.get(key);
        if (inner && /^https?:/i.test(inner)) return unwrapExternalUrl(inner);
      }
    }
  } catch { /* keep href */ }
  return href;
}

export function hintUrls(clicked = {}, base = '') {
  return [...(clicked.probe || []), clicked.href]
    .filter(Boolean)
    .map(raw => unwrapExternalUrl(raw, base))
    .filter(Boolean);
}

export function allowHostsFromHints(urls = []) {
  const hosts = new Set();
  for (const href of urls) {
    const landing = classifyApplyLanding(href);
    if (landing.host) hosts.add(landing.host);
  }
  return hosts;
}

export function isUsableExternalLanding(item = {}) {
  return Boolean(item?.off_handshake && item.host && !item.preexisting);
}

/** Certified ATS first, then a real careers host, never a leftover Drive tab. */
export function selectExternalLanding(candidates = [], { allowHosts = new Set() } = {}) {
  const usable = candidates.filter(item => isUsableExternalLanding(item));
  return usable.find(item => item.certified)
    || usable.find(item => !isIncidentalExternalHost(item.host))
    || usable.find(item => allowHosts.has(item.host))
    || usable[0]
    || null;
}

/** Prefer the live landing, then Apply Externally href/window.open, never Handshake. */
export function recordableLanding(landed = {}, clicked = {}, pageUrl = '') {
  const hints = hintUrls(clicked, pageUrl).map((href) => ({
    ...classifyApplyLanding(href),
    preexisting: false,
  }));
  const current = landed?.url ? [{ ...landed, preexisting: false }] : [];
  const picked = selectExternalLanding([...current, ...hints]);
  if (!picked) return landed;
  return { ...landed, ...picked, off_handshake: true };
}
