#!/usr/bin/env node

/**
 * seed-autofill.mjs — build the job-autofill extension's starting answer file.
 *
 * Reads config/profile.yml (identity), cv.md (education + work history), and a
 * transcribed answer bank from templates/application-tactics.md, and writes
 * extensions/job-autofill/data/answers.json. Import that file from the
 * extension's options page.
 *
 * Usage:
 *   node scripts/seed-autofill.mjs [--dry-run] [--out <path>]
 *
 * Deliberately brittle on cv.md: if the headings stop matching, this exits
 * non-zero and names the section rather than emitting silently-wrong dates.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag !== -1 && process.argv[outFlag + 1]
  ? resolve(process.argv[outFlag + 1])
  : join(ROOT, 'extensions', 'job-autofill', 'data', 'answers.json');

const NOW = new Date().toISOString();

function die(msg) {
  console.error(`\n  seed-autofill: ${msg}\n`);
  process.exit(1);
}

function read(relPath) {
  const p = join(ROOT, relPath);
  if (!existsSync(p)) die(`missing ${relPath} (this script needs the personal data files)`);
  return readFileSync(p, 'utf-8');
}

/**
 * Optional curated export from a previous autofill tool. Gitignored, because it
 * carries address, date of birth, and demographic answers that must not enter a
 * tracked file. Absent is fine: the seed just falls back to the repo files.
 */
const CURATED_PATH = join(ROOT, 'extensions', 'job-autofill', 'data', 'jobwizard-curated.json');
function readCurated() {
  if (!existsSync(CURATED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CURATED_PATH, 'utf-8'));
  } catch (e) {
    die(`extensions/job-autofill/data/jobwizard-curated.json is not valid JSON: ${e.message}`);
  }
}

// ── 1. profile.yml → identity ──────────────────────────────────────

function buildProfileIdentity() {
  const cfg = yaml.load(read('config/profile.yml'));
  const c = cfg?.candidate;
  if (!c?.full_name) die('config/profile.yml has no candidate.full_name');

  const parts = String(c.full_name).trim().split(/\s+/);
  const first = parts[0];
  const last = parts.length > 1 ? parts.slice(1).join(' ') : '';

  const phoneRaw = String(c.phone || '').trim();
  const digits = phoneRaw.replace(/\D/g, '');
  const countryCode = phoneRaw.startsWith('+') ? `+${digits.slice(0, digits.length - 10)}` : '';
  const national = digits.slice(-10);

  // "Pittsburgh, PA, USA" → city / state / country
  const loc = String(c.location || '').split(',').map(s => s.trim());
  const country = loc[2] || cfg?.location?.country || '';

  return {
    name: { first, last, full: String(c.full_name).trim() },
    email: String(c.email || '').trim(),
    phone: { raw: phoneRaw, countryCode, national },
    location: {
      city: loc[0] || cfg?.location?.city || '',
      state: expandState(loc[1] || ''),
      stateAbbr: loc[1] || '',
      country: /^usa?$/i.test(country) ? 'United States' : country.replace(/\s*\(.*\)$/, ''),
      raw: String(c.location || '').trim(),
    },
    links: {
      linkedin: httpsify(c.linkedin),
      github: httpsify(c.github),
      portfolio: httpsify(c.portfolio_url),
    },
  };
}

const STATE_NAMES = { PA: 'Pennsylvania', CA: 'California', NY: 'New York', TX: 'Texas', WA: 'Washington', MA: 'Massachusetts' };
function expandState(abbr) {
  return STATE_NAMES[abbr] || abbr;
}

function httpsify(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

// ── 2. cv.md → education + work ────────────────────────────────────

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2025-08" -> "August" */
function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? MONTH_NAMES[Number(m[2]) - 1] || '' : '';
}

/** "2025-08" -> "2025" */
function yearOf(ym) {
  const m = /^(\d{4})-\d{2}$/.exec(String(ym || ''));
  return m ? m[1] : '';
}

function toMonth(text) {
  const m = /([A-Za-z]{3,})\s+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mm ? `${m[2]}-${mm}` : null;
}

function sectionOf(md, heading) {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const m = re.exec(md);
  if (!m) die(`cv.md has no "## ${heading}" section`);
  return m[1];
}

function buildEducation(md) {
  const section = sectionOf(md, 'Education');
  const blocks = section.split(/^### /m).slice(1);
  if (blocks.length === 0) die('cv.md Education section has no "### School - Degree" entries');

  return blocks.map(block => {
    const [headingLine, ...rest] = block.split('\n');
    const heading = headingLine.trim();
    const dash = heading.indexOf(' - ');
    if (dash === -1) die(`cv.md education heading is missing " - " separator:\n    ### ${heading}`);

    const school = heading.slice(0, dash).trim();
    const degreeRaw = heading.slice(dash + 3).trim();
    const body = rest.join('\n');

    const gpa = /CGPA\s*\*\*([\d.]+)\s*\/\s*[\d.]+\*\*/.exec(body)?.[1] || '';
    const dateLine = /((?:[A-Za-z]{3,}\s+\d{4}))\s*[-–—]\s*((?:Expected\s+)?[A-Za-z]{3,}\s+\d{4}|Present)/.exec(body);
    if (!dateLine) die(`cv.md education entry has no parsable date range:\n    ### ${heading}`);

    const endText = dateLine[2];
    const fieldMatch = /\(([^)]+)\)/.exec(degreeRaw);

    const degree = /master/i.test(degreeRaw) ? "Master's"
      : /b\.?tech|bachelor/i.test(degreeRaw) ? "Bachelor's"
      : degreeRaw;
    const startMonth = toMonth(dateLine[1]);
    const endMonth = toMonth(endText);

    return {
      school,
      degree,
      degreeRaw,
      // Dropdown-friendly wording. Boards offer "Master's Degree", never the
      // full programme name.
      degreeOption: `${degree} Degree`,
      field: fieldMatch ? fieldMatch[1] : degreeRaw.replace(/^.*?,\s*/, ''),
      gpa,
      startMonth,
      endMonth,
      // Split forms ask for month and year separately, per education block.
      // Derived here so the adapter can address them by index and never rely
      // on a shared "Start date year" answer.
      startMonthName: monthName(startMonth),
      startYear: yearOf(startMonth),
      endMonthName: monthName(endMonth),
      endYear: yearOf(endMonth),
      current: /present|expected/i.test(endText),
    };
  });
}

/**
 * Skills a taxonomy picker can actually match, pipe-separated.
 *
 * Workday's Skills box is a search against its own taxonomy, so it only ever
 * commits a term the taxonomy already knows. cv.md's list is written for a
 * human and includes phrases no taxonomy carries ("multi-agent orchestration",
 * "NCCN clinical-guideline encoding", "ICD-10 / CPT / HCPCS familiarity"), and
 * a term that matches nothing costs a search round-trip and risks the widget
 * committing something else instead.
 *
 * So: the named technology rows only, capped. The cap is not cosmetic — each
 * skill is a separate search, and the whole list would make one fill pass take
 * the better part of a minute.
 *
 * The comma-separated free-text answer for "list your skills" boxes lives in
 * the answer bank and is unaffected by this.
 */
/**
 * How many skills to offer a taxonomy picker.
 *
 * Six, not the whole CV list. Each term is a separate search against the
 * board's own taxonomy, and while a term that matches nothing now costs ~150ms
 * rather than ~7s (the filler bails as soon as the widget says "No Results"),
 * every term still costs a round-trip. Six covers the languages and frameworks
 * a screener filters on; the exhaustive list belongs on the resume.
 */
const SKILL_CAP = 6;

/**
 * Skills a taxonomy picker can actually match, pipe-separated.
 *
 * Workday's Skills box searches Workday's own taxonomy and only ever commits a
 * term that taxonomy carries. cv.md's list is written for a human and includes
 * phrases no taxonomy holds ("multi-agent orchestration", "NCCN
 * clinical-guideline encoding"), so those are dropped rather than searched for.
 */
function buildSkills(md) {
  const section = sectionOf(md, 'Skills');
  const rows = ['Languages', 'ML/AI', 'Backend / Frameworks', 'Frontend', 'Cloud / Infra'];
  const perRow = rows.map(row => {
    const line = new RegExp(`^\\*\\*${row.replace(/[/]/g, '\\/')}\\*\\*:\\s*(.+)$`, 'm').exec(section);
    if (!line) return [];
    return line[1].split(',')
      .map(raw => raw.trim())
      // Two words is the ceiling that keeps "Spring Boot" and "Next.js" while
      // dropping prose like "prompt engineering".
      .filter(skill => skill && skill.split(/\s+/).length <= 2)
      .filter(skill => !/familiarity|encoding|modeling/i.test(skill));
  });

  // Round-robin across the categories. Taking the first six in file order spent
  // the whole budget on Languages and dropped React, AWS and Spring Boot, which
  // matter more for a backend role than the tail of any one list.
  const out = [];
  for (let i = 0; out.length < SKILL_CAP; i++) {
    if (perRow.every(row => i >= row.length)) break;
    for (const row of perRow) {
      if (i < row.length && !out.includes(row[i]) && out.length < SKILL_CAP) out.push(row[i]);
    }
  }
  return out.join(' | ');
}

/**
 * Skills are seeded as ordinary ANSWERS, never as a canonical profile path.
 *
 * `resolveCandidates` consults the profile BEFORE the answer bank, so a
 * canonical `skills` path would outrank anything the capture loop had learned.
 * That inverts the rule this project keeps everywhere else: an answer the user
 * gave must beat a generated one. As a seeded answer it sits at the right
 * precedence and a correction simply overwrites the key.
 *
 * Pipe-separated because a picker takes one term at a time, which is what
 * `splitMulti` and the multi-value branch of the combobox filler expect.
 */
const SKILL_QUESTIONS = ['Type to Add Skills', 'Skills', 'Add Skills', 'Key Skills'];

function buildWork(md) {
  const section = sectionOf(md, 'Experience');
  const headings = [...section.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
  if (headings.length === 0) die('cv.md Experience section has no "### Company - Title (dates), Location" entries');

  return headings.map(heading => {
    // "Company - Title (May 2026 - Present), Austin, TX"
    const m = /^(.+?)\s+-\s+(.+?)\s*\(([^)]+)\)\s*,\s*(.+)$/.exec(heading);
    if (!m) die(`cv.md experience heading does not match "Company - Title (dates), Location":\n    ### ${heading}`);

    const [, company, title, dates, location] = m;
    const range = /(.+?)\s*[-–—]\s*(.+)/.exec(dates);
    if (!range) die(`cv.md experience heading has no parsable date range:\n    ### ${heading}`);

    const startMonth = toMonth(range[1]);
    const endMonth = /present/i.test(range[2]) ? null : toMonth(range[2]);

    return {
      company: company.trim(),
      title: title.trim(),
      location: location.trim(),
      startMonth,
      endMonth,
      // Split month/year parts, exactly as education already carries them.
      // Workday's work-history block asks for "From" and "To" as separate
      // month and year controls, and a repeated block may never fall back to
      // the shared answer bank, so an entry that cannot answer from its own
      // fields answers not at all.
      startMonthName: monthName(startMonth),
      startYear: yearOf(startMonth),
      endMonthName: monthName(endMonth),
      endYear: yearOf(endMonth),
      current: /present/i.test(range[2]),
    };
  });
}

// ── 3. answer bank ─────────────────────────────────────────────────
//
// Transcribed by hand from templates/application-tactics.md. That file states
// its answers in prose and tables, so parsing it would be guesswork; each entry
// below names the section it came from. Re-check these whenever that file
// changes. EEO / demographic questions are deliberately absent: they are
// learned from real forms, never seeded.

const SEED_ANSWERS = [
  // § "Are you authorized to work in the US?" / "Will you require sponsorship?"
  { q: 'Are you legally authorized to work in the United States?', a: 'Yes', type: 'select' },
  { q: 'Are you authorized to work in the US?', a: 'Yes', type: 'select' },
  // "lawfully" rather than "legally", seen live on Ashby. The two share too few
  // significant tokens to match each other, and the short forms above are not
  // specific enough to carry by containment, so this phrasing needs its own
  // entry rather than a looser matching rule.
  { q: 'Are you authorized to work lawfully in the United States?', a: 'Yes', type: 'select' },
  { q: 'Are you lawfully authorized to work in the United States?', a: 'Yes', type: 'select' },
  { q: 'Will you now or in the future require sponsorship for employment visa status?', a: 'Yes', type: 'select' },
  { q: 'Do you require sponsorship now or in the future?', a: 'Yes', type: 'select' },
  { q: 'Are you a U.S. citizen or permanent resident?', a: 'No', type: 'select' },

  // § "Pittsburgh / on-site / relocation"
  { q: 'When can you start?', a: 'Available January 2027', type: 'text' },
  { q: 'Earliest start date', a: 'Available January 2027', type: 'text' },
  { q: 'What is your availability?', a: 'Available January 2027', type: 'text' },
  { q: 'Are you willing to relocate?', a: 'Yes', type: 'select' },
  { q: 'Are you willing to work on-site?', a: 'Yes', type: 'select' },
  { q: 'Where are you currently located?', a: 'Pittsburgh, PA', type: 'text' },
  { q: 'What is your current city?', a: 'Pittsburgh, PA', type: 'text' },

  // § "Are you currently employed?" and § "Have you applied before?"
  { q: 'Are you currently employed?', a: 'No', type: 'select' },
  { q: 'Are you 18 years of age or older?', a: 'Yes', type: 'select' },

  // § "What is your expected salary?"
  { q: 'What are your salary expectations?', a: 'Open to standard new-grad base for this role and location', type: 'text' },
  { q: 'Expected salary', a: 'Open to standard new-grad base for this role and location', type: 'text' },
  { q: 'What are your total compensation expectations?', a: 'Open to discussion based on role scope and total compensation structure.', type: 'text' },

  // § "How did you hear about this role?"
  { q: 'How did you hear about this role?', a: 'LinkedIn job search', type: 'select' },
  { q: 'How did you hear about us?', a: 'LinkedIn job search', type: 'select' },

  // Recurring questions met on live Greenhouse postings that no section of
  // application-tactics.md covers yet.
  { q: 'Are you able to perform the essential job duties of this position with or without reasonable accommodation?', a: 'Yes', type: 'select' },
  { q: 'Can you perform the essential functions of this job with or without reasonable accommodation?', a: 'Yes', type: 'select' },
  { q: 'Which cloud platform do you have the most professional experience with?', a: 'AWS', type: 'select' },
  { q: 'Who is submitting this application?', a: 'Myself', type: 'select' },
  { q: 'If selected as a finalist, could you travel for an in-person interview with two weeks notice?', a: 'Yes', type: 'select' },
  { q: 'Please provide links to any public technical work (GitHub, blog, conference talks, open-source projects, personal projects, etc.).', a: 'https://github.com/anmolsahu2k and https://anmolsahu2k.github.io/', type: 'text' },

  // § "Did you use AI tools to prepare this application?"
  { q: 'Did you use AI tools to prepare this application?', a: 'Yes. I used Claude to help structure my responses; the experience and judgment in the content are mine.', type: 'text' },
];

// CLAUDE.md rule 1: no em-dashes or en-dashes in candidate-facing text.
const DASH_RE = /[—–]/;

const EEO_RE =
  /gender|race|ethnic|veteran|disab|hispanic|latin|orientation|transgender|pronoun|self.?identif|communities do you belong/i;

function buildAnswers(curatedAnswers = []) {
  const answers = {};
  const scrubbed = [];
  let sensitiveCount = 0;

  const add = ({ q, a, type }) => {
    let answer = a;
    if (DASH_RE.test(answer)) {
      answer = answer.replace(/—/g, ', ').replace(/–/g, '-');
      scrubbed.push(q);
    }
    const key = normalizeKey(q);
    if (!key || !answer) return;
    const sensitive = EEO_RE.test(q);
    if (sensitive) sensitiveCount++;
    answers[key] = {
      key,
      questions: [q],
      answer,
      answerType: type,
      boards: [],
      source: 'seed',
      sensitive,
      createdAt: NOW,
      updatedAt: NOW,
      useCount: 0,
    };
  };

  for (const entry of SEED_ANSWERS) add(entry);
  // Curated entries land second so they win on any key collision: they were
  // transcribed from real submitted applications and reviewed by hand.
  for (const entry of curatedAnswers) add(entry);

  if (scrubbed.length) {
    console.log(`  Scrubbed em/en dashes from ${scrubbed.length} answer(s): ${scrubbed.join('; ')}`);
  }
  return { answers, sensitiveCount };
}

/** Mirror of the extension's matcher.normalizeKey. Keep the two in step. */
function normalizeKey(text) {
  let s = String(text || '')
    .replace(/[–—−]/g, ' ')
    .toLowerCase()
    .replace(/\((?:optional|required)\)/g, ' ')
    .replace(/[*]/g, ' ')
    .replace(/[^a-z0-9+#/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(optional|required)$/g, '');
  for (const prefix of ['please select', 'please enter', 'please provide', 'please indicate', 'please specify', 'please tell us', 'select one', 'choose one']) {
    if (s.startsWith(prefix + ' ')) { s = s.slice(prefix.length + 1); break; }
  }
  return s.trim();
}

// ── main ───────────────────────────────────────────────────────────

const cv = read('cv.md');
const curated = readCurated();
const identity = buildProfileIdentity();
const education = buildEducation(cv);
const work = buildWork(cv);
const skills = buildSkills(cv);

const { answers, sensitiveCount } = buildAnswers([
  ...(curated?.answers || []),
  ...SKILL_QUESTIONS.map(q => ({ q, a: skills, type: 'multiselect' })),
]);

const extras = { ...(curated?.profileExtras || {}) };
const eduOverrides = extras.educationOverrides || [];
delete extras.educationOverrides;
delete extras._educationOverridesNote;

// Board dropdowns offer their own vocabulary, so each education entry carries a
// dropdown-friendly discipline alongside the truthful one from cv.md.
education.forEach((entry, i) => {
  Object.assign(entry, eduOverrides[i] || {});
  if (!entry.fieldOption) entry.fieldOption = entry.field;
});

const profile = {
  ...identity,
  ...extras,
  // Merge rather than replace the nested groups the repo files also populate.
  emails: { personal: identity.email, ...(extras.emails || {}) },
  links: { ...identity.links, ...(extras.links || {}) },
  location: { ...identity.location, ...(extras.location || {}) },
  education,
  work,
};

const output = {
  schemaVersion: 1,
  profile,
  answers,
  settings: {
    fuzzyThreshold: 0.75,
    resumeNote: 'SDE / backend / infra roles: use the SDE resume PDF. AI / ML / DS roles: use the MLE resume PDF.',
  },
};

console.log('\n  seed-autofill');
console.log(`  Profile:   ${profile.name.full} <${profile.email}>`);
console.log(`  Education: ${education.map(e => e.school).join(', ')}`);
console.log(`  Work:      ${work.map(w => `${w.company} (${w.startMonth} to ${w.endMonth || 'present'})`).join(', ')}`);
console.log(`  Skills:    ${skills}`);
if (curated) {
  console.log(`  Curated:   ${curated.answers.length} answers merged from jobwizard-curated.json`);
  console.log(`             ${(curated._corrected || []).length} corrections, ${(curated._dropped || []).length} drop categories (see that file)`);
} else {
  console.log('  Curated:   none (extensions/job-autofill/data/jobwizard-curated.json absent)');
}
console.log(`  Answers:   ${Object.keys(answers).length} total, ${sensitiveCount} flagged EEO / demographic`);
console.log('\n  Source sections to re-check when templates/application-tactics.md changes:');
console.log('    work authorization / sponsorship, start date + relocation + current city,');
console.log('    salary expectations, how did you hear, AI tool disclosure, currently employed');

if (DRY_RUN) {
  console.log('\n  --dry-run: nothing written\n');
  process.exit(0);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
console.log(`\n  Wrote ${OUT_PATH.replace(ROOT + '/', '')}`);
console.log('  Next: extension options page -> Import JSON -> pick that file\n');
