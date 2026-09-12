#!/usr/bin/env node
/**
 * outreach-leads.mjs — Build outreach leads from the career-ops pipeline.
 *
 * Lead model (chosen 2026-07-17): founders / hiring managers at companies
 * ALREADY in the pipeline. Reads the tracker (applications.md under
 * $CAREER_OPS_DATA_DIR) and emits one lead per company (its best-scoring role)
 * to data/outreach-leads.json for outreach-draft.mjs to draft against.
 *
 * Ranking uses the tracker's own `N.N/5` evaluation score — the LLM oferta
 * grade that read the full JD against the CV. Default floor is 4.0: outreach
 * is only worth the effort on roles that already cleared a strong evaluation.
 *
 * Terminal statuses (Rejected / Discarded / Purged / Rejected-at-eval / SKIP / Offer) are excluded — no
 * point cold-emailing a company that already closed the loop. The recipient
 * (`to`) is deliberately left null: you add the founder/HM address before
 * staging. This tool never sends anything (drafts-only; you send). Zero-token.
 *
 * Usage:
 *   node outreach-leads.mjs              # write data/outreach-leads.json (>= 4.0)
 *   node outreach-leads.mjs --dry-run    # preview counts, no write
 *   node outreach-leads.mjs --min-score 4.5   # raise the evaluation floor
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';

const P = resolvePaths(import.meta.url);
const APPS_FILE = P.appsFile;
const LEADS_PATH = join(P.dataDir, 'outreach-leads.json');

// Statuses we do NOT reach out to (already closed or off-limits).
const TERMINAL = new Set(['rejected', 'discarded', 'purged', 'rejected_at_eval', 'skip', 'offer']);

const DEFAULT_MIN_SCORE = 4.0;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const minIdx = args.indexOf('--min-score');
const parsedMin = minIdx !== -1 ? parseFloat(args[minIdx + 1]) : NaN;
const minScore = Number.isFinite(parsedMin) ? parsedMin : DEFAULT_MIN_SCORE;

/**
 * Parse a tracker score cell (`4.2/5`, `4/5`) to a number.
 * Non-numeric sentinels (`N/A`, `-`, blank) return null → row is skipped,
 * since an unevaluated role has no grade to justify outreach.
 * @param {string} cell @returns {number|null}
 */
function parseScoreCell(cell) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*5\s*$/.exec(String(cell || '').replace(/\*\*/g, ''));
  return m ? parseFloat(m[1]) : null;
}

function slugifyCompany(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main() {
  if (!existsSync(APPS_FILE)) {
    console.error(`Error: ${APPS_FILE} not found.`);
    process.exit(1);
  }
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);

  // Fold to one lead per company, keeping its best-scoring role.
  const byCompany = new Map();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || !row.company) continue;
    const status = row.status.replace(/\*\*/g, '').trim().toLowerCase();
    if (TERMINAL.has(status)) continue;
    const evalScore = parseScoreCell(row.score);
    if (evalScore === null || evalScore < minScore) continue;
    const key = slugifyCompany(row.company);
    const prev = byCompany.get(key);
    if (!prev || evalScore > prev.score) {
      byCompany.set(key, {
        id: `pipeline-${key}`,
        source: 'pipeline',
        company: row.company,
        role: row.role,
        tracker_num: row.num,
        status: row.status.replace(/\*\*/g, '').trim(),
        score: evalScore,
        to: null,        // you fill the founder/HM address before staging
        all_guesses: [],
      });
    }
  }

  // Carry hand-added enrichment across a rebuild. Everything below is authored
  // by hand or by a research pass (verified addresses, contact identity, the
  // per-company hook, bespoke copy) and exists nowhere else on disk, so a plain
  // overwrite silently destroys it. Tracker-derived fields (role, score,
  // status, tracker_num) still refresh from the tracker; only these are kept.
  const PRESERVED = [
    'to', 'all_guesses', 'contact_name', 'contact_title', 'linkedin_profile',
    'enrichment_confidence', 'enrichment_note', 'hook', 'custom_body', 'custom_subject',
  ];
  let carried = 0;
  if (existsSync(LEADS_PATH)) {
    try {
      const prior = JSON.parse(readFileSync(LEADS_PATH, 'utf-8'));
      const byId = new Map(prior.map(l => [l.id, l]));
      for (const lead of byCompany.values()) {
        const old = byId.get(lead.id);
        if (!old) continue;
        let touched = false;
        for (const k of PRESERVED) {
          if (old[k] !== undefined && old[k] !== null &&
              !(Array.isArray(old[k]) && old[k].length === 0)) {
            lead[k] = old[k];
            touched = true;
          }
        }
        if (touched) carried++;
      }
    } catch (err) {
      // A corrupt prior file must not silently cost the enrichment: stop and
      // let the user recover it rather than overwriting with a bare rebuild.
      console.error(`Error: could not read existing ${LEADS_PATH} to preserve enrichment.`);
      console.error(`  ${err.message}`);
      console.error('  Fix or move that file, then re-run. Refusing to overwrite it.');
      process.exit(1);
    }
  }

  const leads = [...byCompany.values()].sort((a, b) => b.score - a.score);
  console.log(`Pipeline leads: ${leads.length} distinct companies (eval score >= ${minScore})`);
  if (carried) console.log(`Preserved enrichment on ${carried} existing lead(s).`);
  if (leads.length) {
    const top = leads.slice(0, 8).map(l => `  ${l.score.toFixed(1)}/5  ${l.company} — ${l.role}`).join('\n');
    console.log(top);
  }
  if (dryRun) {
    console.log('(dry run — data/outreach-leads.json not written)');
    return;
  }
  writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${LEADS_PATH}`);
}

main();
