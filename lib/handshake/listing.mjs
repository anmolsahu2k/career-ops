/**
 * Handshake search-result listing parsers.
 */

import { isHandshakeHost, isHandshakeJobUrl } from './job-page.mjs';

export function normalizeHandshakeJobUrl(href, base = 'https://cmu.joinhandshake.com') {
  try {
    const url = new URL(href, base);
    if (!isHandshakeHost(url.href)) return '';
    url.hash = '';
    const job = url.pathname.match(/\/(?:stu\/|edu\/)?(?:jobs|postings|job-search)\/(\d+)/i);
    if (job) {
      url.pathname = `/jobs/${job[1]}`;
      url.search = '';
      return url.toString();
    }
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'searchId', 'query', 'page', 'per_page'].forEach(key => url.searchParams.delete(key));
    return url.toString();
  } catch {
    return '';
  }
}

export function parseHandshakeListingLabel(blob = '') {
  const text = String(blob || '').replace(/^Selected,\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!text) return { title: '', company: '', location: '', jobType: '' };
  const typeMatch = text.match(/\s·\s(Full-time(?: job)?|Internship|Part[- ]time|On[- ]campus)/i);
  const jobType = typeMatch ? typeMatch[1].replace(/ job$/i, '') : '';
  let head = typeMatch ? text.slice(0, typeMatch.index).trim() : text;
  head = head.replace(/\s\$[\d][\w.,/$%\-]*$/i, '').trim();
  let location = '';
  if (typeMatch) {
    location = text.slice(typeMatch.index + typeMatch[0].length)
      .replace(/CMU collection/ig, '')
      .replace(/Promoted/ig, '')
      .replace(/\s+\d+(?:wk|d|mo|h) ago$/i, '')
      .replace(/\s*\+\s*\d+\s*/g, ' ')
      .replace(/^[·\s]+|[·\s]+$/g, '')
      .trim();
  }
  return { title: head, company: '', location, jobType };
}

export function listingFromCard(card = {}, baseUrl = '') {
  const parsed = parseHandshakeListingLabel(card.aria || '');
  const url = normalizeHandshakeJobUrl(card.url || card.href || '', baseUrl);
  const title = String(parsed.title || card.title || '').replace(/\s+/g, ' ').trim();
  const company = String(card.company || parsed.company || '').replace(/\s+/g, ' ').trim();
  const location = String(card.location || parsed.location || '').replace(/\s+/g, ' ').trim();
  const jobType = String(card.jobType || parsed.jobType || '').replace(/\s+/g, ' ').trim();
  if (!url || !title) return null;
  return { url, title, company, location, jobType, source: 'handshake' };
}

export function listingsFromHtml(html = '', baseUrl = 'https://cmu.joinhandshake.com') {
  const text = String(html);
  const cards = [];
  const articleRe = /<(?:article|li|div)[^>]*data-career-ops="listing"[^>]*>([\s\S]*?)<\/(?:article|li|div)>/gi;
  let match;
  while ((match = articleRe.exec(text))) {
    const block = match[1];
    const href = block.match(/href="([^"]+)"/i)?.[1] || '';
    const title = block.match(/data-career-ops="listing-title"[^>]*>([^<]+)/i)?.[1]
      || block.match(/<a[^>]*>([^<]+)/i)?.[1]
      || '';
    const company = block.match(/data-career-ops="listing-company"[^>]*>([^<]+)/i)?.[1] || '';
    const location = block.match(/data-career-ops="listing-location"[^>]*>([^<]+)/i)?.[1] || '';
    const card = listingFromCard({ url: href, title, company, location }, baseUrl);
    if (card) cards.push(card);
  }
  if (cards.length) return dedupeListings(cards);
  const fallback = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  while ((match = linkRe.exec(text))) {
    const href = match[1];
    const title = match[2].trim();
    if (!isHandshakeJobUrl(normalizeHandshakeJobUrl(href, baseUrl)) && !/\/(?:jobs|postings)\/\d+/i.test(href)) continue;
    const card = listingFromCard({ url: href, title }, baseUrl);
    if (card) fallback.push(card);
  }
  return dedupeListings(fallback);
}

export function dedupeListings(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row?.url || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
  }
  return out;
}

/** Runs inside the Handshake search tab. Must stay self-contained for page.evaluate. */
export function handshakeListingSnapshot() {
  const jobHref = /\/(?:stu\/|edu\/)?(?:jobs|postings|job-search)\/(\d+)/i;
  const cards = [];
  const seen = new Set();
  const push = (item) => {
    const url = String(item?.url || '').trim();
    const title = String(item?.title || item?.aria || '').replace(/\s+/g, ' ').trim();
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    cards.push({
      url,
      title,
      aria: String(item.aria || '').trim(),
      company: String(item.company || '').replace(/\s+/g, ' ').trim(),
      location: String(item.location || '').replace(/\s+/g, ' ').trim(),
    });
  };
  const fromLink = (link, root) => {
    const href = link?.getAttribute?.('href') || root?.getAttribute?.('href') || '';
    const match = String(href).match(jobHref);
    if (!match) return;
    const aria = (link?.getAttribute?.('aria-label') || root?.getAttribute?.('aria-label') || '')
      .replace(/^Selected,\s*/i, '');
    const text = (root?.innerText || link?.innerText || '').replace(/\s+/g, ' ').trim();
    push({
      url: `/jobs/${match[1]}`,
      aria: aria || text,
      title: aria || text,
    });
  };
  for (const option of document.querySelectorAll('[role="option"]')) {
    const link = option.matches?.('a[href]') ? option : option.querySelector('a[href]');
    fromLink(link, option);
  }
  for (const link of document.querySelectorAll('a[href*="/job-search/"], a[href*="/jobs/"], a[href*="/postings/"]')) {
    fromLink(link, link);
  }
  return cards;
}

/** Runs inside the Handshake search tab. Reads hydrated JSON, not the HTML shell. */
export function handshakeListingsFromPageState() {
  const out = [];
  const seen = new Set();
  const jobId = (value) => {
    const text = String(value || '');
    const matched = text.match(/\/(?:jobs|postings)\/(\d+)/i)
      || text.match(/(?:Job[:/]|jobs\/)(\d{5,})/i)
      || text.match(/^(\d{5,})$/);
    return matched ? matched[1] : '';
  };
  const consider = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const id = jobId(node.id) || jobId(node.jobId) || jobId(node.postingId) || jobId(node.job?.id);
    const title = String(node.title || node.jobTitle || node.job?.title || '').replace(/\s+/g, ' ').trim();
    const typename = String(node.__typename || '');
    const looksJob = typename === 'Job'
      || Boolean(node.employer || node.jobType || node.employmentType || node.employerName || node.jobApplySetting);
    if (!id || !title || !looksJob) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      url: `/stu/jobs/${id}`,
      title,
      company: String(node.employer?.name || node.employerName || node.company?.name || node.job?.employer?.name || '').trim(),
      location: String(node.locations?.[0]?.name || node.location?.name || node.job?.location?.name || '').trim(),
    });
  };
  const walk = (node, depth) => {
    if (depth > 10 || !node || typeof node !== 'object') return;
    consider(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const child of values.slice(0, 300)) walk(child, depth + 1);
  };
  for (const script of document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]')) {
    try { walk(JSON.parse(script.textContent || 'null'), 0); } catch { /* ignore */ }
  }
  if (window.__APOLLO_STATE__) walk(window.__APOLLO_STATE__, 0);
  return out.slice(0, 80);
}

export async function listingsFromLivePage(page, { timeoutMs = 14000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let listings = [];
  while (Date.now() < deadline) {
    const fromDom = await page.evaluate(handshakeListingSnapshot).catch(() => []);
    const fromJson = await page.evaluate(handshakeListingsFromPageState).catch(() => []);
    listings = dedupeListings(
      [...(fromDom || []), ...(fromJson || [])]
        .map(card => listingFromCard(card, page.url()))
        .filter(Boolean),
    );
    if (listings.length) return listings;
    await page.evaluate(() => {
      const scroller = document.querySelector('[role="list"], [class*="results"], [class*="Results"], main');
      (scroller || document.scrollingElement)?.scrollBy?.(0, 800);
    }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return listings;
}
