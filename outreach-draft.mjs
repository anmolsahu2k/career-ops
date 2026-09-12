#!/usr/bin/env node
/**
 * outreach-draft.mjs — Zero-token cold-outreach drafter for pipeline companies.
 *
 * Reads data/outreach-leads.json (built by outreach-leads.mjs), classifies each
 * role into an archetype, and renders two channels per lead to
 * data/outreach-ready/{id}.json:
 *   - email:    TL;DR + three proof bullets + signature (subject + htmlBody)
 *   - linkedin: a connection note (<=300 chars) + a post-connect DM
 * The /career-ops outreach flow stages the email into Gmail via the gmail MCP
 * draft_email tool; the LinkedIn text is copy-paste (no LinkedIn send exists).
 * You add the recipient, review, and send. Nothing here sends anything.
 *
 * Content rules baked in (career-ops CLAUDE.md): no em/en dashes (guarded), no
 * visa / OPT / H-1B / sponsorship line, no proactive availability phrase. Proof
 * points are authored from cv.md; review the drafts before sending.
 *
 * Usage:
 *   node outreach-draft.mjs             # draft all leads
 *   node outreach-draft.mjs --limit 10  # cap this run
 *   node outreach-draft.mjs --dry-run   # print one sample, write nothing
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const LEADS_PATH = join(P.dataDir, 'outreach-leads.json');
const POST_LEADS_PATH = join(P.dataDir, 'outreach-post-leads.json');
const READY_DIR = join(P.dataDir, 'outreach-ready');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limIdx = args.indexOf('--limit');
const limit = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) || Infinity : Infinity;

// ── Signature (from cv.md; single source of truth for contact facts) ─────────
const SIGNATURE = [
  '<p>Best regards,<br>',
  '<strong>Anmol Sahu</strong><br>',
  'anmolsahu2k@gmail.com<br>',
  '<a href="https://linkedin.com/in/anmolsahu2k">linkedin.com/in/anmolsahu2k</a><br>',
  '<a href="https://github.com/anmolsahu2k">github.com/anmolsahu2k</a></p>',
].join('\n');

// ── Archetype proof bullets (authored from cv.md; VET before sending) ────────
// Each set contributes the first 3 bullets to the email. No em/en dashes.
const BULLETS = {
  'ai-ml': [
    '<li><strong>Agentic AI in production, Tabhi:</strong> built a Python 3.12 / FastAPI post-transaction QC service with exactly-once event-to-meter processing in a single MongoDB transaction, verified under a 30-way concurrent burst with zero 5xx.</li>',
    '<li><strong>Multi-agent systems, Cloudify (TartanHacks):</strong> orchestrated OpenAI and Anthropic Claude via the Dedalus SDK to cut full-stack cloud migration from days to under 20 minutes across 8+ stack configurations.</li>',
    '<li><strong>Deep learning, EEG classification (CMU 11-685):</strong> trained a multi-head CNN plus Transformer whose 11.5K-parameter EEGNet beat a 127.6M-parameter baseline (11,000x fewer parameters), with an EEG-to-CLIP retrieval pipeline on a PSC GPU cluster.</li>',
  ],
  'data': [
    '<li><strong>Large-scale ML, Highmark Health x CMU:</strong> designing an XGBoost cancer-staging pipeline over 6M+ longitudinal claims records across 20,323 members, augmenting features with NCCN clinical guidelines to handle 40 to 51% missingness.</li>',
    '<li><strong>Detection analytics, Tabhi:</strong> normalized 160,427 transactions across 11 heterogeneous drops into a Parquet workspace and isolated a directly minable $1.54M money wedge with 7 adversarially verified analytical lenses.</li>',
    '<li><strong>Applied ML, Byju\'s:</strong> designed and deployed a multi-class rank-prediction model for national competitive exams, reaching 70%+ classification accuracy in production.</li>',
  ],
  'backend': [
    '<li><strong>Production backend, Tabhi:</strong> Python 3.12 / FastAPI QC service with exactly-once event processing, crash-straggler recovery, and disaster rebuild-from-log, verified at zero 5xx under a 30-way concurrent burst.</li>',
    '<li><strong>High-traffic platform, Byju\'s (2.5 years SDE):</strong> built an e-commerce portal serving 200,000+ daily users, cutting sales cost 15% and lifting ARPU 20%; contributed to an AWS to GCP migration saving $400K annually.</li>',
    '<li><strong>Systems, Byju\'s:</strong> refactored 10+ legacy verticals into a unified microservice topology and authored a scheduling-service test suite to 100% coverage.</li>',
  ],
  'fde': [
    '<li><strong>Customer-facing delivery, Tabhi:</strong> reverse-engineered a 21,000-line, 110-exception-code Java tool into a code-verified capability-gap diff and a 28-endpoint OpenAPI 3.1 spec, delivered founder-direct.</li>',
    '<li><strong>End-to-end tooling, Cloudify:</strong> a single-CLI multi-agent migrator across AWS, GCP, and Heroku that takes full-stack cloud migration from days to under 20 minutes.</li>',
    '<li><strong>Track record:</strong> 6 hackathon wins totaling ~$22K, including 1st place at Red Hat Hack APAC (200+ participants) building an AI education platform on Red Hat OpenShift.</li>',
  ],
  'frontend': [
    '<li><strong>Growth engineering, Byju\'s:</strong> built an e-commerce portal serving 200,000+ daily users and optimized the checkout workflows that cut sales cost 15% and lifted ARPU 20%.</li>',
    '<li><strong>Product frontend, Byju\'s:</strong> engineered a DRM-protected react-pdf reader with full-text search, jump-to-page, and OS-level screenshot prevention, securing premium content for 400,000+ paid subscribers.</li>',
    '<li><strong>Performance, Byju\'s:</strong> migrated 10,000+ articles off ReactJS with SEO tagging and indexed page ranking, taking organic traffic 2.5x and page speed 30x.</li>',
  ],
  'infra': [
    '<li><strong>Cloud migration, Byju\'s:</strong> contributed to an AWS to GCP migration of application and data infrastructure for $400K annual savings with improved reliability.</li>',
    '<li><strong>Automation, Cloudify:</strong> multi-agent full-stack migration across 8+ stack configurations from one CLI command.</li>',
    '<li><strong>HPC, EEG project:</strong> engineered a Slurm sbatch pipeline on the PSC GPU cluster with preflight CUDA checks and a one-command job-status dashboard.</li>',
  ],
};
// General fallback: strongest all-rounders when the role matches no archetype.
BULLETS['default'] = [BULLETS['ai-ml'][0], BULLETS['backend'][1], BULLETS['data'][0]];

// ── LinkedIn proof phrases (one short clause per archetype; plain text) ───────
// Kept compact so the connection note stays under LinkedIn's 300-char cap.
const LINKEDIN_PROOF = {
  'ai-ml': 'shipped agentic AI in production at Tabhi plus Cloudify, a multi-agent OpenAI and Claude cloud migration tool',
  'data': 'built an XGBoost cancer-staging pipeline over 6M+ claims records at Highmark x CMU',
  'backend': 'spent 2.5 years as an SDE at Byju\'s on a 200K+ daily-user platform and a $400K cloud migration',
  'fde': 'delivered founder-direct at Tabhi and built Cloudify, a single-CLI multi-agent cloud migrator',
  'frontend': 'shipped React product frontends at Byju\'s: checkout work that lifted ARPU 20% and a DRM reader for 400K+ paid subscribers',
  'infra': 'ran an AWS to GCP migration at Byju\'s and HPC training pipelines on the PSC cluster',
  'default': 'has 2.5 years of SDE experience plus shipped agentic-AI and ML work (Cloudify, Highmark)',
};

// ── Role → archetype (order matters: specific before generic) ────────────────
function archetypeFor(role) {
  const r = (role || '').toLowerCase();
  if (/\b(ai engineer|machine learning|ml engineer|applied ai|applied scientist|deep learning|\bml\b|\bai\b|llm|agent)/.test(r)) return 'ai-ml';
  if (/\b(data engineer|data scientist|data analyst|analytics|\bdata\b)/.test(r)) return 'data';
  if (/\b(forward deployed|forward-deployed|solutions engineer|customer engineer|\bfde\b|sales engineer)/.test(r)) return 'fde';
  if (/\b(devops|infrastructure|\binfra\b|platform|\bsre\b|site reliability|cloud engineer)/.test(r)) return 'infra';
  // Frontend before backend: "Software Engineer I, Frontend, Growth" would
  // otherwise fall through to backend and pitch the wrong body of work.
  if (/\b(frontend|front-end|\bui\b|user interface|web engineer|react|javascript|typescript)/.test(r)) return 'frontend';
  if (/\b(backend|back-end|software engineer|software developer|full stack|full-stack|\bswe\b|developer)/.test(r)) return 'backend';
  return 'default';
}

// Replace em/en dashes with a plain hyphen (CLAUDE.md hard rule 1). Applied to
// lead-sourced fields (company/role) that we cannot control at the source.
function clean(s) {
  return String(s).replace(/[–—]/g, '-');
}

function esc(s) {
  return clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Post-sourced leads open by naming the actual post: the poster asked to be
// contacted, so referencing it reads as a reply rather than a cold pitch.
// Pipeline leads (no post) open on the company instead.
function openerFor(lead, company, role) {
  return lead.source === 'linkedin-post'
    ? `Saw your post about the ${role} opening at ${company}`
    : `Saw ${company} is hiring for ${role}`;
}

function buildHtml(lead, archetype) {
  const company = esc(lead.company);
  const role = esc(lead.role || 'the role');
  const bullets = BULLETS[archetype].join('\n  ');
  // Greet by first name when the lead carries a verified contact; leads still
  // at contact_name: null open cold (no "Hi {name}," placeholder to forget).
  const first = lead.contact_name ? esc(String(lead.contact_name).trim().split(/\s+/)[0]) : null;
  // Bespoke copy wins over the archetype template. `custom_body` is the HTML
  // between the greeting and the signature, hand-authored per lead. The
  // template shape (self-assessing TL;DR, three archetype bullets, generic
  // call ask) is unvalidated, so any lead worth real effort gets written by
  // hand instead; see the 2026-07-20 research pass in CHANGELOG.md.
  if (lead.custom_body) {
    return [
      '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">',
      ...(first ? [`<p>Hi ${first},</p>`, ''] : []),
      lead.custom_body,
      '',
      SIGNATURE,
      '</div>',
    ].join('\n');
  }
  return [
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">',
    ...(first ? [`<p>Hi ${first},</p>`, ''] : []),
    `<p><strong>TL;DR:</strong> ${openerFor(lead, company, role)}. I am a strong new-grad fit: CMU MISM-BIDA (Dec 2026) with 2.5 years of SDE experience at Byju\'s plus shipped agentic-AI and ML work. Resume attached. Open to a 15-minute call in the next week or two?</p>`,
    '',
    '<ol>',
    `  ${bullets}`,
    '</ol>',
    '',
    // Optional per-lead "why this company" line. Set `hook` on the lead in
    // outreach-leads.json; it renders verbatim between the bullets and the
    // close. Without it the email is archetype-generic, which reads as a
    // template to anyone who sees more than one of them.
    ...(lead.hook ? ['', `<p>${esc(lead.hook)}</p>`] : []),
    '',
    '<p>I have attached my resume. Thank you for your time.</p>',
    '',
    SIGNATURE,
    '</div>',
  ].join('\n');
}

// LinkedIn channel: a connection note (<=300 chars, LinkedIn's cap), a
// post-connect DM, and a people-search URL. Plain text ({name} placeholder
// for the person you find). The pipeline gives the company but not a person,
// so search_url lands you on that company's recruiters / hiring managers /
// founders in one click; pick the right person there, then use connect/dm.
function buildLinkedIn(lead, archetype) {
  const company = clean(lead.company);
  const role = clean(lead.role || 'the role');
  const proof = LINKEDIN_PROOF[archetype];
  // If the lead was enriched with a real contact, greet by first name;
  // otherwise leave the {name} placeholder for you to fill at send time.
  const name = lead.contact_name ? clean(String(lead.contact_name).trim().split(/\s+/)[0]) : '{name}';
  const opener = openerFor(lead, company, role).replace(/^Saw /, 'saw ');
  let connect = `Hi ${name}, ${opener}. I am Anmol, a CMU MISM-BIDA new-grad (Dec 2026) who ${proof}. Would love to connect and hear about the team.`;
  if (connect.length > 300) {
    connect = `Hi ${name}, saw ${company} is hiring. I am Anmol, a CMU MISM-BIDA new-grad (Dec 2026) who ${proof}. Would love to connect and hear about the team.`;
  }
  if (connect.length > 300) connect = connect.slice(0, 297).trimEnd() + '...';
  const dm = `Hi ${name}, thanks for connecting. I am exploring ${role} roles at ${company}. Quick context: I ${proof}. Would you be open to a 15-minute chat about the team and what you are looking for? Happy to share my resume.`;
  const query = `${company} recruiter OR "hiring manager" OR "talent acquisition" OR founder`;
  const search_url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
  // profile_url is the enriched person's LinkedIn (when known); else null so the
  // consumer falls back to search_url to find them. post_url is set on
  // linkedin-post leads so you can jump back and comment on the thread too.
  return {
    contact_name: lead.contact_name || null,
    profile_url: lead.linkedin_profile || null,
    post_url: lead.post_url || null,
    connect,
    dm,
    search_url,
  };
}

// Fail loudly if an em/en dash reaches the output (CLAUDE.md hard rule 1).
function assertNoDashes(text, id) {
  const m = text.match(/[–—]/);
  if (m) throw new Error(`outreach-draft: em/en dash in draft ${id} — scrub the source bullet`);
}

/** Read a leads JSON array; missing file or bad shape yields []. */
function readLeads(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error(`Warning: ${path} is not valid JSON, skipping it.`);
    return [];
  }
}

function main() {
  // Two independent sources: pipeline leads (regenerated from the tracker by
  // outreach-leads.mjs) and post leads (captured by outreach-post-lead.mjs).
  // They live in separate files precisely so regenerating one never wipes the other.
  const pipelineLeads = readLeads(LEADS_PATH);
  const postLeads = readLeads(POST_LEADS_PATH);
  const leads = [...postLeads, ...pipelineLeads]; // warmest (post) first
  if (leads.length === 0) {
    console.log(`No leads to draft. Run: node outreach-leads.mjs (pipeline) or node outreach-post-lead.mjs (a LinkedIn hiring post).`);
    return;
  }
  console.log(`Leads: ${postLeads.length} from posts, ${pipelineLeads.length} from pipeline`);
  if (!dryRun) mkdirSync(READY_DIR, { recursive: true });

  let n = 0;
  for (const lead of leads) {
    if (n >= limit) break;
    const archetype = archetypeFor(lead.role);
    // Default subject asserts the sender's own fit, which is the most
    // template-shaped line in the email and identical across every lead.
    // `custom_subject` overrides it for leads written by hand.
    const subject = lead.custom_subject
      ? clean(lead.custom_subject)
      : `Strong fit for ${clean(lead.role)} at ${clean(lead.company)} (Anmol Sahu, CMU)`;
    const htmlBody = buildHtml(lead, archetype);
    const linkedin = buildLinkedIn(lead, archetype);
    assertNoDashes(subject + htmlBody + linkedin.connect + linkedin.dm, lead.id);
    const draft = {
      id: lead.id,
      source: lead.source || 'pipeline',
      company: clean(lead.company),
      to: lead.to || null,
      all_guesses: lead.all_guesses || [],
      role: clean(lead.role),
      archetype,
      subject,
      htmlBody,
      linkedin,
      drafted_at: new Date().toISOString(),
    };
    if (dryRun && n === 0) {
      console.log(`--- sample draft (${lead.company}, archetype=${archetype}) ---`);
      console.log(`[EMAIL] ${subject}`);
      console.log(htmlBody);
      console.log(`\n[LINKEDIN find person]\n${linkedin.search_url}`);
      console.log(`\n[LINKEDIN connect ${linkedin.connect.length}/300]\n${linkedin.connect}`);
      console.log(`\n[LINKEDIN dm]\n${linkedin.dm}`);
    }
    if (!dryRun) writeFileSync(join(READY_DIR, `${lead.id}.json`), JSON.stringify(draft, null, 2) + '\n', 'utf-8');
    n++;
  }
  console.log(dryRun
    ? `(dry run) would draft ${Math.min(leads.length, limit)} of ${leads.length} leads to ${READY_DIR}`
    : `Drafted ${n} of ${leads.length} leads to ${READY_DIR}`);
}

main();
