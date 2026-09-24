/**
 * Handshake search filters Career-Ops applies. Pure confirmation is unit-tested;
 * Playwright clicks live in applyHandshakeFiltersOnPage.
 */

export const DEFAULT_HANDSHAKE_FILTERS = Object.freeze({
  search_url: 'https://cmu.joinhandshake.com/stu/postings',
  job_types: ['Full-Time'],
  locations: ['United States'],
  include_remote: true,
  posted_within_days: 21,
  hide_applied: true,
  keyword_source: 'target_roles',
});

export function handshakeFilterSpec(config = {}) {
  const raw = config?.applications?.main_profile?.handshake || {};
  const jobTypes = Array.isArray(raw.job_types) && raw.job_types.length
    ? raw.job_types.map(String)
    : [...DEFAULT_HANDSHAKE_FILTERS.job_types];
  const locations = Array.isArray(raw.locations) && raw.locations.length
    ? raw.locations.map(String)
    : [...DEFAULT_HANDSHAKE_FILTERS.locations];
  return {
    search_url: String(raw.search_url || DEFAULT_HANDSHAKE_FILTERS.search_url),
    job_types: jobTypes,
    locations,
    include_remote: raw.include_remote !== false,
    posted_within_days: Number.isFinite(Number(raw.posted_within_days))
      ? Number(raw.posted_within_days)
      : DEFAULT_HANDSHAKE_FILTERS.posted_within_days,
    hide_applied: raw.hide_applied !== false,
    keyword_source: String(raw.keyword_source || DEFAULT_HANDSHAKE_FILTERS.keyword_source),
    keywords: String(raw.keywords || ''),
  };
}

export function handshakeSearchUrl(spec, { keywords = '' } = {}) {
  const url = new URL(spec.search_url || DEFAULT_HANDSHAKE_FILTERS.search_url);
  const query = String(keywords || spec.keywords || '').trim();
  if (query && !url.searchParams.get('query') && !url.searchParams.get('q')) {
    url.searchParams.set('query', query);
  }
  return url.toString();
}

function haystack(pageText = '', href = '', chips = []) {
  return `${pageText}\n${href}\n${(chips || []).join('\n')}`.toLowerCase();
}

export function confirmHandshakeFilters(spec, { pageText = '', url = '', chips = [] } = {}) {
  const text = haystack(pageText, url, chips);
  const missing = [];
  const confirmed = [];
  for (const jobType of spec.job_types || []) {
    const token = String(jobType).toLowerCase();
    if (text.includes(token) || text.includes(token.replace('-', ' ')) || text.includes('full time')) {
      confirmed.push(`job_type:${jobType}`);
    } else missing.push(`job_type:${jobType}`);
  }
  for (const location of spec.locations || []) {
    const token = String(location).toLowerCase();
    if (text.includes(token) || text.includes('united states') || text.includes('usa')) {
      confirmed.push(`location:${location}`);
    } else missing.push(`location:${location}`);
  }
  if (spec.include_remote) {
    if (/\bremote\b/.test(text)) confirmed.push('remote');
    else missing.push('remote');
  }
  if (spec.hide_applied) {
    if (/hide applied|exclude applied|already applied/i.test(text) || /applied=false|hide_applied/i.test(url)) {
      confirmed.push('hide_applied');
    } else missing.push('hide_applied');
  }
  if (Number(spec.posted_within_days) > 0) {
    if (/past (?:week|month)|last \d+ days|posted_within|21 day/i.test(text) || /posted/i.test(url)) {
      confirmed.push('posted_within');
    } else missing.push('posted_within');
  }
  const required = (spec.job_types || []).map(jobType => `job_type:${jobType}`);
  const requiredMissing = missing.filter(item => required.includes(item));
  return {
    ok: requiredMissing.length === 0,
    confirmed,
    missing,
    fail_closed: requiredMissing.length > 0,
  };
}

async function clickMatching(page, patterns) {
  const re = patterns[0];
  const spec = re instanceof RegExp ? { source: re.source, flags: re.flags } : { source: String(re), flags: 'i' };
  const already = await page.evaluate(({ source, flags }) => {
    const pattern = new RegExp(source, flags);
    return [...document.querySelectorAll('[aria-pressed="true"], [aria-checked="true"], input[type="checkbox"]:checked')]
      .some(el => pattern.test((el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ')));
  }, spec).catch(() => false);
  if (already) return true;
  const locator = page.locator('button, a, [role="button"], label, [role="checkbox"], input[type="checkbox"]').filter({
    hasText: patterns[0],
  });
  const count = await locator.count().catch(() => 0);
  if (!count) return false;
  await locator.first().click({ timeout: 4000 }).catch(() => {});
  return true;
}

export async function applyHandshakeFiltersOnPage(page, spec, { keywords = '' } = {}) {
  const target = handshakeSearchUrl(spec, { keywords });
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1500));
  for (const jobType of spec.job_types || []) {
    await clickMatching(page, [new RegExp(jobType.replace('-', '[- ]?'), 'i')]);
  }
  for (const location of spec.locations || []) {
    await clickMatching(page, [new RegExp(location, 'i')]);
  }
  if (spec.include_remote) await clickMatching(page, [/remote/i]);
  if (spec.hide_applied) await clickMatching(page, [/hide applied|exclude applied/i]);
  if (keywords) {
    const search = page.locator('input[type="search"], input[placeholder*="Search" i], input[name="query"], [role="searchbox"]').first();
    if (await search.count().catch(() => 0)) {
      await search.fill(String(keywords)).catch(() => {});
      await search.press('Enter').catch(() => {});
    }
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1200));
  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const chips = await page.evaluate(() => [...document.querySelectorAll('[class*="chip"], [class*="filter"], [aria-pressed="true"]')]
    .map(el => (el.innerText || '').trim())
    .filter(Boolean)
    .slice(0, 24)).catch(() => []);
  const confirmation = confirmHandshakeFilters(spec, { pageText, url: page.url(), chips });
  return { ...confirmation, url: page.url(), pageText };
}
