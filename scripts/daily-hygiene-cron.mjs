#!/usr/bin/env node
/**
 * daily-hygiene-cron.mjs
 *
 * W9 of career-ops Phase 3. Runs every morning at 8am Pittsburgh time.
 * Recommended cron: `0 8 * * *` with timezone "America/New_York".
 *
 * Daily tracker hygiene wrapper. Chains three existing scripts:
 *
 *   1. node check-liveness.mjs       (URL liveness check; flags dead postings)
 *   2. node followup-cadence.mjs     (computes which Applied rows are overdue)
 *   3. node verify-pipeline.mjs      (integrity check after upstream writes)
 *
 * Plus a cross-reference step against W1's daily-digest output to flag any
 * candidate already present in the tracker by company + role.
 *
 * Output: career-ops/data/hygiene-{YYYY-MM-DD}.md with five sections:
 *   - Liveness check
 *   - Follow-up cadence
 *   - Cross-ref with W1 digest
 *   - Pipeline verification
 *   - Errors
 *
 * Flags:
 *   --dry-run   Pass --dry-run through to upstream scripts when supported,
 *               otherwise document what would run without executing.
 *
 * Constraints (project hard rules):
 *   - No em-dashes or en-dashes anywhere.
 *   - No CV PDF generation.
 *   - No F-1 / CPT / Heinz / OIE / visa explainer text.
 *   - Stdlib only. Shell out via child_process.
 *   - process.env.TZ set to America/New_York for any date math.
 *   - 9-column tracker schema is FROZEN. We never write status here.
 *     check-liveness.mjs is responsible for any status transitions.
 *
 * Idempotent:
 *   Re-running on the same day appends a "Re-run" stanza to that day's log.
 *
 * Exit codes:
 *   0   all upstream scripts succeeded
 *   1   one or more upstream scripts failed (verify-pipeline failure is fatal)
 *   2   internal wrapper error (filesystem, parsing, etc.)
 */

process.env.TZ = 'America/New_York';

import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// career-ops root is parent of scripts/
const CAREER_OPS_ROOT = resolve(__dirname, '..');
const TRACKER_PATH = join(CAREER_OPS_ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(CAREER_OPS_ROOT, 'reports');
const DATA_DIR = join(CAREER_OPS_ROOT, 'data');

const CHECK_LIVENESS = join(CAREER_OPS_ROOT, 'check-liveness.mjs');
const FOLLOWUP_CADENCE = join(CAREER_OPS_ROOT, 'followup-cadence.mjs');
const VERIFY_PIPELINE = join(CAREER_OPS_ROOT, 'verify-pipeline.mjs');

const PER_URL_TIMEOUT_MS = 25000;
const SCRIPT_TIMEOUT_MS = 600000; // 10 min ceiling for any single upstream call

// Em-dash and en-dash scrubber. Hard rule 1: no em-dashes or en-dashes
// anywhere in the hygiene log output. Upstream scripts may print them in
// captured stdout / stderr (e.g. when echoing tracker text), so we strip them
// at the log boundary. Replacement is a regular ASCII hyphen, which preserves
// readability without violating the rule. The codepoints are referenced via
// \u escapes so this source file itself stays free of dash characters.
function scrubDashes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[\u2013\u2014]/g, '-');
}

// Statuses we DO want to liveness-check. Skip terminal states.
const LIVENESS_ELIGIBLE_STATUSES = new Set([
  'evaluated',
  'applied',
  'responded',
  'interview',
]);

// ---------- argv ----------

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// ---------- date helpers ----------

function todayIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nowStamp(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${todayIso(date)} ${hh}:${mm}:${ss} America/New_York`;
}

function yesterdayIso(date) {
  const y = new Date(date);
  y.setDate(y.getDate() - 1);
  return todayIso(y);
}

// ---------- tracker parsing (9-col, read-only) ----------

function parseTracker() {
  if (!existsSync(TRACKER_PATH)) return [];
  const content = readFileSync(TRACKER_PATH, 'utf-8');
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 9) continue;
    const num = parseInt(parts[1], 10);
    if (Number.isNaN(num)) continue;
    rows.push({
      num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      score: parts[5],
      status: parts[6],
      pdf: parts[7],
      report: parts[8],
      notes: parts[9] || '',
    });
  }
  return rows;
}

function normalizeStatus(raw) {
  return String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

function reportPathFromCell(cell) {
  if (!cell) return null;
  const m = cell.match(/\]\(([^)]+)\)/);
  if (!m) return null;
  return resolve(CAREER_OPS_ROOT, m[1]);
}

function urlFromReport(reportFilePath) {
  if (!reportFilePath || !existsSync(reportFilePath)) return null;
  try {
    const text = readFileSync(reportFilePath, 'utf-8');
    const m = text.match(/^\s*\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function collectLivenessCandidates(rows) {
  const out = [];
  for (const r of rows) {
    const status = normalizeStatus(r.status);
    if (!LIVENESS_ELIGIBLE_STATUSES.has(status)) continue;
    const reportFp = reportPathFromCell(r.report);
    const url = urlFromReport(reportFp);
    if (!url) continue;
    out.push({
      num: r.num,
      company: r.company,
      role: r.role,
      status,
      url,
    });
  }
  return out;
}

// ---------- W1 digest cross-ref ----------

function findRecentDigestPath(now) {
  // Prefer yesterday's digest, fall back to today's, then most recent within 7 days.
  const candidates = [];
  for (let back = 1; back <= 7; back += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    candidates.push(join(DATA_DIR, `daily-digest-${todayIso(d)}.md`));
  }
  // Also include today, but rank it after yesterday so the cron's normal usage
  // catches the digest that was written this morning before 8am.
  candidates.unshift(join(DATA_DIR, `daily-digest-${todayIso(now)}.md`));

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseDigestCandidates(digestPath) {
  // The W1 digest format may evolve. We use a tolerant parser:
  //   - any markdown table row with at least 2 cells where header includes
  //     "Company" and "Role" (case-insensitive) yields a {company, role} pair.
  //   - any line of the form "Company: X" followed by "Role: Y" within a small
  //     window also yields a pair.
  if (!existsSync(digestPath)) return [];

  const text = readFileSync(digestPath, 'utf-8');
  const lines = text.split('\n');
  const pairs = [];

  // Pass 1: tables with Company / Role columns
  let inTable = false;
  let companyIdx = -1;
  let roleIdx = -1;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      companyIdx = -1;
      roleIdx = -1;
      continue;
    }
    const cells = line.split('|').map((s) => s.trim());
    // Header row detection
    if (!inTable) {
      const lower = cells.map((c) => c.toLowerCase());
      const ci = lower.findIndex((c) => c === 'company' || c === 'empresa');
      const ri = lower.findIndex((c) => c === 'role' || c === 'puesto' || c === 'position');
      if (ci !== -1 && ri !== -1) {
        inTable = true;
        companyIdx = ci;
        roleIdx = ri;
      }
      continue;
    }
    // Separator row
    if (cells.every((c) => /^-+$|^:?-+:?$|^$/.test(c))) continue;
    const company = cells[companyIdx];
    const role = cells[roleIdx];
    if (company && role && company !== '---' && role !== '---') {
      pairs.push({ company, role });
    }
  }

  // Pass 2: bullet style "Company: X" / "Role: Y" within 3 lines
  for (let i = 0; i < lines.length; i += 1) {
    const cm = lines[i].match(/^\s*[-*]?\s*Company\s*:\s*(.+?)\s*$/i);
    if (!cm) continue;
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j += 1) {
      const rm = lines[j].match(/^\s*[-*]?\s*Role\s*:\s*(.+?)\s*$/i);
      if (rm) {
        pairs.push({ company: cm[1], role: rm[1] });
        break;
      }
    }
  }

  // Dedupe
  const seen = new Set();
  const unique = [];
  for (const p of pairs) {
    const key = `${p.company.toLowerCase()}::${p.role.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

function trackerKey(company, role) {
  const c = String(company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = String(role || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
  return `${c}::${r}`;
}

function crossReferenceDigest(trackerRows, digestPath) {
  if (!digestPath) {
    return {
      digestPath: null,
      checked: 0,
      alreadyInTracker: [],
      newCandidates: [],
    };
  }
  const digestPairs = parseDigestCandidates(digestPath);
  const trackerSet = new Set(trackerRows.map((r) => trackerKey(r.company, r.role)));
  const alreadyInTracker = [];
  const newCandidates = [];
  for (const p of digestPairs) {
    const key = trackerKey(p.company, p.role);
    if (trackerSet.has(key)) {
      alreadyInTracker.push(p);
    } else {
      newCandidates.push(p);
    }
  }
  return {
    digestPath,
    checked: digestPairs.length,
    alreadyInTracker,
    newCandidates,
  };
}

// ---------- subprocess runner ----------

function runScript(label, scriptPath, scriptArgs, opts = {}) {
  const start = Date.now();
  const result = {
    label,
    script: scriptPath,
    args: scriptArgs,
    skipped: false,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    error: null,
  };
  if (!existsSync(scriptPath)) {
    result.skipped = true;
    result.error = `script not found: ${scriptPath}`;
    return result;
  }
  if (opts.skip) {
    result.skipped = true;
    result.error = opts.skipReason || 'skipped';
    return result;
  }
  try {
    const proc = spawnSync('node', [scriptPath, ...scriptArgs], {
      cwd: CAREER_OPS_ROOT,
      encoding: 'utf-8',
      timeout: opts.timeoutMs || SCRIPT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TZ: 'America/New_York' },
    });
    result.exitCode = proc.status;
    result.signal = proc.signal;
    // Scrub upstream stdout / stderr at capture time so any em-dashes or
    // en-dashes inherited from tracker text never reach the hygiene log.
    result.stdout = scrubDashes(proc.stdout || '');
    result.stderr = scrubDashes(proc.stderr || '');
    if (proc.error) {
      result.error = scrubDashes(proc.error.message);
    }
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - start;
  }
  return result;
}

// ---------- liveness url file ----------

function writeLivenessUrlFile(candidates, todayStamp) {
  const tmpDir = join(CAREER_OPS_ROOT, 'data');
  const fp = join(tmpDir, `.liveness-urls-${todayStamp}.txt`);
  const lines = [
    `# liveness URL list generated by daily-hygiene-cron on ${todayStamp}`,
    `# eligible statuses: ${[...LIVENESS_ELIGIBLE_STATUSES].join(', ')}`,
    `# total: ${candidates.length}`,
    '',
    ...candidates.map((c) => c.url),
  ];
  writeFileSync(fp, lines.join('\n'), 'utf-8');
  return fp;
}

// ---------- log rendering ----------

function renderHygieneLog({
  runStamp,
  todayStamp,
  trackerCount,
  livenessCandidates,
  livenessResult,
  followupResult,
  digestXref,
  verifyResult,
  errors,
  isRerun,
  dryRun,
}) {
  const lines = [];
  const heading = isRerun ? `## Re-run ${runStamp}` : `# Hygiene log ${todayStamp}`;
  if (!isRerun) {
    lines.push(heading);
    lines.push('');
    lines.push(`**Generated:** ${runStamp}`);
    lines.push(`**Mode:** ${dryRun ? 'dry-run' : 'live'}`);
    lines.push(`**Tracker rows scanned:** ${trackerCount}`);
    lines.push('');
  } else {
    lines.push(heading);
    lines.push('');
    lines.push(`**Mode:** ${dryRun ? 'dry-run' : 'live'}`);
    lines.push(`**Tracker rows scanned:** ${trackerCount}`);
    lines.push('');
  }

  // Section 1: Liveness check
  lines.push('## Liveness check');
  lines.push('');
  lines.push(`Eligible statuses: ${[...LIVENESS_ELIGIBLE_STATUSES].join(', ')}.`);
  lines.push(`URLs collected from reports: ${livenessCandidates.length}.`);
  lines.push('');
  if (dryRun) {
    lines.push(`Status: dry-run, no HTTP calls executed.`);
    lines.push(`Would invoke: \`node check-liveness.mjs --file <generated url list>\` with per-URL timeout ${PER_URL_TIMEOUT_MS} ms across ${livenessCandidates.length} URL(s).`);
    lines.push('Note: check-liveness.mjs has no native --dry-run flag; the wrapper documents the call instead of executing it.');
  } else if (livenessResult.skipped) {
    lines.push(`Status: SKIPPED (${livenessResult.error || 'no reason given'}).`);
  } else {
    lines.push(`Exit code: ${livenessResult.exitCode}.`);
    lines.push(`Duration: ${livenessResult.durationMs} ms.`);
    if (livenessResult.error) {
      lines.push(`Wrapper error: ${livenessResult.error}.`);
    }
    if (livenessResult.stdout) {
      lines.push('');
      lines.push('```');
      lines.push(livenessResult.stdout.trimEnd());
      lines.push('```');
    }
    if (livenessResult.stderr && livenessResult.stderr.trim().length > 0) {
      lines.push('');
      lines.push('stderr:');
      lines.push('```');
      lines.push(livenessResult.stderr.trimEnd());
      lines.push('```');
    }
    lines.push('');
    lines.push('Note: per project rule the wrapper does not write status itself. Any postings reported as expired should be reviewed and transitioned to `Discarded` (the canonical state from `templates/states.yml`) by the user or by check-liveness.mjs in a future revision.');
  }
  lines.push('');

  // Section 2: Follow-up cadence
  lines.push('## Follow-up cadence');
  lines.push('');
  if (dryRun) {
    lines.push(`Status: dry-run, no follow-up writes executed.`);
    lines.push('Would invoke: `node followup-cadence.mjs --summary`. The script itself does not have a `--dry-run` flag, so the dry-run path documents the call without executing it.');
  } else if (followupResult.skipped) {
    lines.push(`Status: SKIPPED (${followupResult.error || 'no reason given'}).`);
  } else {
    lines.push(`Exit code: ${followupResult.exitCode}.`);
    lines.push(`Duration: ${followupResult.durationMs} ms.`);
    if (followupResult.error) {
      lines.push(`Wrapper error: ${followupResult.error}.`);
    }
    if (followupResult.stdout) {
      lines.push('');
      lines.push('```');
      lines.push(followupResult.stdout.trimEnd());
      lines.push('```');
    }
    if (followupResult.stderr && followupResult.stderr.trim().length > 0) {
      lines.push('');
      lines.push('stderr:');
      lines.push('```');
      lines.push(followupResult.stderr.trimEnd());
      lines.push('```');
    }
  }
  lines.push('');

  // Section 3: Cross-ref with W1 digest
  lines.push('## Cross-ref with W1 digest');
  lines.push('');
  if (!digestXref.digestPath) {
    lines.push('No `daily-digest-{YYYY-MM-DD}.md` found within the last 7 days. Cross-reference skipped.');
  } else {
    const rel = digestXref.digestPath.replace(`${CAREER_OPS_ROOT}/`, '');
    lines.push(`Digest: \`${rel}\`.`);
    lines.push(`Candidates parsed from digest: ${digestXref.checked}.`);
    lines.push(`Already in tracker: ${digestXref.alreadyInTracker.length}.`);
    lines.push(`New (not in tracker): ${digestXref.newCandidates.length}.`);
    if (digestXref.alreadyInTracker.length > 0) {
      lines.push('');
      lines.push('### Already in tracker');
      lines.push('');
      for (const p of digestXref.alreadyInTracker) {
        lines.push(`- ${p.company} / ${p.role} (already in tracker, skip duplicate eval)`);
      }
    }
    if (digestXref.newCandidates.length > 0) {
      lines.push('');
      lines.push('### New candidates');
      lines.push('');
      for (const p of digestXref.newCandidates) {
        lines.push(`- ${p.company} / ${p.role}`);
      }
    }
  }
  lines.push('');

  // Section 4: Pipeline verification
  lines.push('## Pipeline verification');
  lines.push('');
  if (dryRun) {
    lines.push(`Status: dry-run, no verification call executed.`);
    lines.push('Would invoke: `node verify-pipeline.mjs`. Must exit 0 in a live run.');
  } else if (verifyResult.skipped) {
    lines.push(`Status: SKIPPED (${verifyResult.error || 'no reason given'}).`);
  } else {
    lines.push(`Exit code: ${verifyResult.exitCode}.`);
    lines.push(`Duration: ${verifyResult.durationMs} ms.`);
    if (verifyResult.error) {
      lines.push(`Wrapper error: ${verifyResult.error}.`);
    }
    if (verifyResult.stdout) {
      lines.push('');
      lines.push('```');
      lines.push(verifyResult.stdout.trimEnd());
      lines.push('```');
    }
    if (verifyResult.stderr && verifyResult.stderr.trim().length > 0) {
      lines.push('');
      lines.push('stderr:');
      lines.push('```');
      lines.push(verifyResult.stderr.trimEnd());
      lines.push('```');
    }
  }
  lines.push('');

  // Section 5: Errors
  lines.push('## Errors');
  lines.push('');
  if (errors.length === 0) {
    lines.push('None.');
  } else {
    for (const e of errors) {
      lines.push(`- ${e}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------- main ----------

function main() {
  const now = new Date();
  const todayStamp = todayIso(now);
  const runStamp = nowStamp(now);

  const logPath = join(DATA_DIR, `hygiene-${todayStamp}.md`);
  const isRerun = existsSync(logPath);

  const errors = [];

  let trackerRows = [];
  try {
    trackerRows = parseTracker();
  } catch (err) {
    const msg = `failed to parse tracker: ${err.message}`;
    errors.push(msg);
    console.error(msg);
  }

  const livenessCandidates = collectLivenessCandidates(trackerRows);

  // 1) Liveness check
  let livenessResult;
  if (livenessCandidates.length === 0) {
    livenessResult = {
      label: 'check-liveness',
      script: CHECK_LIVENESS,
      args: [],
      skipped: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: 'no eligible URLs (tracker has no Applied / Evaluated / Responded / Interview rows with reports containing **URL:**)',
    };
  } else if (DRY_RUN) {
    livenessResult = {
      label: 'check-liveness',
      script: CHECK_LIVENESS,
      args: ['--file', '<generated url list>', '(--dry-run not supported by check-liveness.mjs)'],
      skipped: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: 'dry-run',
    };
  } else {
    let urlFile;
    try {
      urlFile = writeLivenessUrlFile(livenessCandidates, todayStamp);
    } catch (err) {
      errors.push(`failed to write liveness URL list: ${err.message}`);
      urlFile = null;
    }
    if (urlFile) {
      livenessResult = runScript(
        'check-liveness',
        CHECK_LIVENESS,
        ['--file', urlFile],
        { timeoutMs: Math.max(SCRIPT_TIMEOUT_MS, livenessCandidates.length * PER_URL_TIMEOUT_MS) },
      );
      if (livenessResult.error) {
        errors.push(`check-liveness wrapper error: ${livenessResult.error}`);
      }
      // Surface non-zero exit (any expired or uncertain URL) as informational,
      // not a fatal wrapper error. The user reviews and updates status.
    } else {
      livenessResult = {
        label: 'check-liveness',
        script: CHECK_LIVENESS,
        args: [],
        skipped: true,
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: 'failed to materialize URL list file',
      };
    }
  }

  // 2) Follow-up cadence
  let followupResult;
  if (DRY_RUN) {
    followupResult = {
      label: 'followup-cadence',
      script: FOLLOWUP_CADENCE,
      args: ['--summary', '(no --dry-run flag in upstream script)'],
      skipped: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: 'dry-run',
    };
  } else {
    followupResult = runScript('followup-cadence', FOLLOWUP_CADENCE, ['--summary']);
    if (followupResult.error) {
      errors.push(`followup-cadence wrapper error: ${followupResult.error}`);
    }
    if (followupResult.exitCode !== 0 && followupResult.exitCode !== null) {
      errors.push(`followup-cadence exited ${followupResult.exitCode}`);
    }
  }

  // 3) Cross-reference W1 digest
  const digestPath = findRecentDigestPath(now);
  const digestXref = crossReferenceDigest(trackerRows, digestPath);

  // 4) Verify pipeline (must exit 0 live)
  let verifyResult;
  if (DRY_RUN) {
    verifyResult = {
      label: 'verify-pipeline',
      script: VERIFY_PIPELINE,
      args: ['(no --dry-run flag in upstream script)'],
      skipped: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: 'dry-run',
    };
  } else {
    verifyResult = runScript('verify-pipeline', VERIFY_PIPELINE, []);
    if (verifyResult.error) {
      errors.push(`verify-pipeline wrapper error: ${verifyResult.error}`);
    }
    if (verifyResult.exitCode !== 0 && verifyResult.exitCode !== null) {
      errors.push(`verify-pipeline exited ${verifyResult.exitCode} (non-zero, see log for details). The wrapper does NOT auto-revert; user review required.`);
    }
  }

  // Render and write log
  const body = renderHygieneLog({
    runStamp,
    todayStamp,
    trackerCount: trackerRows.length,
    livenessCandidates,
    livenessResult,
    followupResult,
    digestXref,
    verifyResult,
    errors,
    isRerun,
    dryRun: DRY_RUN,
  });

  // Final em-dash / en-dash sweep on the rendered log. Belt and braces.
  const safeBody = scrubDashes(body);

  try {
    if (isRerun) {
      appendFileSync(logPath, `\n\n${safeBody}`, 'utf-8');
    } else {
      writeFileSync(logPath, safeBody, 'utf-8');
    }
  } catch (err) {
    console.error(`failed to write hygiene log: ${err.message}`);
    process.exit(2);
  }

  // Console summary
  console.log(`hygiene log: ${logPath}`);
  console.log(`mode: ${DRY_RUN ? 'dry-run' : 'live'}`);
  console.log(`tracker rows: ${trackerRows.length}`);
  console.log(`liveness candidates: ${livenessCandidates.length}`);
  console.log(
    `liveness exit: ${livenessResult.skipped ? 'skipped' : livenessResult.exitCode}`,
  );
  console.log(
    `followup-cadence exit: ${followupResult.skipped ? 'skipped' : followupResult.exitCode}`,
  );
  console.log(
    `verify-pipeline exit: ${verifyResult.skipped ? 'skipped' : verifyResult.exitCode}`,
  );
  console.log(`digest cross-ref: ${digestXref.digestPath ? digestXref.digestPath : 'no recent digest found'}`);

  // Exit policy:
  //   - dry-run always exits 0 if log wrote successfully
  //   - live: exit 1 if verify-pipeline failed, otherwise 0
  if (DRY_RUN) {
    process.exit(0);
  }
  if (!verifyResult.skipped && verifyResult.exitCode !== 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
