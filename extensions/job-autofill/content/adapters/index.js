import generic from './generic.js';
import workday from './workday.js';
import greenhouse from './greenhouse.js';
import ashby from './ashby.js';
import lever from './lever.js';
import successfactors from './successfactors.js';
import linkedin from './linkedin.js';

const ADAPTERS = [workday, greenhouse, ashby, lever, successfactors, linkedin];

export function detectBoard(url = location.href) {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matches(url)) return adapter;
    } catch {
      // A bad URL should not take the whole detection pass down.
    }
  }
  return generic;
}

export { generic };

/**
 * Which employer's posting is this, from the URL alone.
 * Every board puts the company slug in a predictable position, so a captured
 * answer can record where it came from without scraping the page.
 */
export function detectCompany(url = location.href) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname;
  const parts = u.pathname.split('/').filter(Boolean);

  // {tenant}.wdN.myworkdayjobs.com/en-US/{site}/...
  const workday = /^([^.]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/.exec(host);
  if (workday) return titleize(workday[1]);

  // job-boards.greenhouse.io/{company}/jobs/... and the embed variant
  if (host.endsWith('greenhouse.io')) {
    const forParam = u.searchParams.get('for');
    if (forParam) return titleize(forParam);
    if (parts[0] && parts[0] !== 'embed') return titleize(parts[0]);
  }

  // jobs.lever.co/{company}/{id} and jobs.ashbyhq.com/{company}/{id}
  if (host.endsWith('lever.co') || host.endsWith('ashbyhq.com')) {
    if (parts[0]) return titleize(parts[0]);
  }

  if (host.includes('successfactors')) {
    const company = u.searchParams.get('company');
    if (company) return titleize(company);
  }

  // Company careers page hosting an embed: strip www and the public suffix.
  return titleize(host.replace(/^(www|careers|jobs)\./, '').split('.')[0]);
}

function titleize(slug) {
  return String(slug)
    .replace(/[-_]+/g, ' ')
    // Board slugs often glue a suffix on: "preciselyusjobs", "stripecareers".
    .replace(/(usjobs|uscareers|careers|jobs|hq|inc)$/i, '')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}
