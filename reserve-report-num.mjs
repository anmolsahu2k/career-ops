#!/usr/bin/env node

/**
 * reserve-report-num.mjs — Atomically reserve the next report number.
 *
 * Fixes the race condition described in #749: when two Claude Code windows
 * (or batch workers) run simultaneously they each compute `max(existing)+1`
 * independently and collide on the same report-number slot.
 *
 * ## How it works
 *
 * Uses `fs.writeFileSync(path, data, { flag: 'wx' })` — which maps to
 * `open(O_CREAT|O_EXCL)` on POSIX and `CreateFile(CREATE_NEW)` on Windows —
 * to create a sentinel file atomically.  If two processes try to claim the
 * same number simultaneously only one succeeds; the loser increments and
 * retries.  No external lock daemon or advisory file is needed.
 *
 * The sentinel is a zero-byte marker named `NNN-RESERVED.md` inside
 * `reports/`.  The caller (mode file or agent) must:
 *   1. Run this script to get a number.
 *   2. Write the real report file `NNN-{slug}-{date}.md`.
 *   3. Delete the sentinel (or let verify-pipeline.mjs GC it on next run).
 *
 * ## Usage
 *
 *   node reserve-report-num.mjs
 *   # stdout: 035           (zero-padded, 3 digits)
 *
 *   node reserve-report-num.mjs --count 8
 *   # stdout: 042-049       (reserves a contiguous range — for multi-agent
 *   #                        fan-outs: reserve first, hand each parallel
 *   #                        worker its own number. On collision the whole
 *   #                        range restarts past the taken slot, so skipped
 *   #                        numbers become permanent gaps — expected, not
 *   #                        corruption. Range protection follows the normal
 *   #                        sentinel TTL: reserve right before spawning.)
 *
 *   node reserve-report-num.mjs --release 035
 *   node reserve-report-num.mjs --release 042-049
 *   # Deletes the sentinel(s) (call after writing the real report(s)).
 *
 *   node reserve-report-num.mjs --gc
 *   # Removes all stale sentinels older than MAX_SENTINEL_AGE_MS.
 *   # Called automatically by verify-pipeline.mjs.
 *
 * The script exits with code 0 on success, non-zero on fatal error.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { resolvePaths } from './lib/paths.mjs';
import { reportTreeNumbers, trackerNumbers, batchTsvNumbers } from './lib/report-numbers.mjs';

// Reports live under $CAREER_OPS_DATA_DIR (default ft/), one folder per company:
// reports/{company-slug}/{NNN}-{role-slug}-{date}.md. Since the 2026-07-27
// reconciliation the NNN counter is global across ONE space: report files,
// tracker row numbers, and un-merged batch TSVs (see lib/report-numbers.mjs).
// RESERVED sentinels stay flat in reports/ — they are transient, not per-company.
// Setting CAREER_OPS_REPORTS_DIR narrows occupancy to that directory alone
// (isolated/manual mode); the default resolver path scans the full space.
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS_DIR || resolvePaths(import.meta.url).reportsDir;
const FULL_SPACE = !process.env.CAREER_OPS_REPORTS_DIR;

// Sentinels older than this are considered stale and may be GC'd.
// 4 hours covers any reasonable interactive or batch session.
const MAX_SENTINEL_AGE_MS = 4 * 60 * 60 * 1000;

// Maximum number of retries before giving up (guards against pathological
// contention — in practice 2-3 parallel windows will resolve in < 5 tries).
const MAX_RETRIES = 50;

// Maximum range size for --count (guards typos like --count 800).
const MAX_COUNT = 50;

// ── helpers ─────────────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(3, '0');
}

/**
 * Set of numbers currently occupying slots in the one number space:
 *   - reports tree (flat RESERVED sentinels + company-folder report files)
 *   - tracker row numbers (applications.md column 1)
 *   - un-merged batch TSV numbers (batch/**, skipping merged/)
 * The last two are skipped in CAREER_OPS_REPORTS_DIR isolated mode.
 * Advisory only — real atomicity comes from claimSlot's O_CREAT|O_EXCL write.
 */
function takenPrefixes() {
  const taken = reportTreeNumbers(REPORTS_DIR);
  if (FULL_SPACE) {
    const p = resolvePaths(import.meta.url);
    for (const n of trackerNumbers(p.appsFile)) taken.add(n);
    for (const n of batchTsvNumbers(p.batchDir(''))) taken.add(n);
  }
  return taken;
}

/** Highest numeric slot currently taken across the whole reports/ tree. */
function maxSlot() {
  let max = 0;
  for (const p of takenPrefixes()) max = Math.max(max, p);
  return max;
}

/**
 * Attempt to atomically claim slot `n`. Returns true on success.
 * `taken` is an optional pre-scanned Set from takenPrefixes(); without it,
 * the occupancy pre-check scans REPORTS_DIR itself. Either way the check is
 * only advisory — the 'wx' write below is what guarantees atomicity.
 */
function claimSlot(n, taken = null) {
  // Check if any file (real report or sentinel) already occupies this slot
  const occupied = (taken || takenPrefixes()).has(n);
  if (occupied) return false;

  const sentinel = join(REPORTS_DIR, `${pad(n)}-RESERVED.md`);
  try {
    // 'wx' = O_CREAT | O_EXCL — fails if file already exists.
    writeFileSync(sentinel, '', { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false; // another process beat us
    throw err; // unexpected FS error
  }
}

/** Release (delete) the sentinel for slot `n`. */
function releaseSlot(n) {
  const sentinel = join(REPORTS_DIR, `${pad(n)}-RESERVED.md`);
  if (existsSync(sentinel)) unlinkSync(sentinel);
}

/**
 * Reserve `count` contiguous slots. All-or-nothing per attempt: if any slot
 * in the candidate range is already taken, release the slots claimed so far
 * and restart past the collision. Each slot claim is individually atomic
 * (O_CREAT|O_EXCL), which is all the pipeline needs — contiguity is an
 * ergonomic property, not a correctness one. Skipped numbers become
 * permanent gaps; report numbers are opaque IDs, so gaps are harmless.
 * Returns the array of reserved numbers, or null if MAX_RETRIES attempts
 * were exhausted. Terminates under contention: `base` strictly advances
 * past every collision, so two racing ranges can never livelock.
 */
function reserveRange(count) {
  let base = maxSlot() + 1;
  let tries = 0;
  // One directory scan per attempt, shared by every per-slot check;
  // refreshed only after a collision forces a retry.
  let taken = takenPrefixes();
  while (tries < MAX_RETRIES) {
    const claimed = [];
    let failedAt = -1;
    for (let n = base; n < base + count; n++) {
      if (claimSlot(n, taken)) {
        claimed.push(n);
      } else {
        failedAt = n;
        break;
      }
    }
    if (failedAt === -1) return claimed;
    for (const n of claimed) releaseSlot(n);
    base = failedAt + 1;
    tries++;
    taken = takenPrefixes();
  }
  return null;
}

/** GC stale sentinels (no real report was written within MAX_SENTINEL_AGE_MS). */
function gc() {
  if (!existsSync(REPORTS_DIR)) return;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      // Runtime reservations contain a versioned JSON record and are durable:
      // allocated numbers are never reused, even after an interrupted commit.
      // Legacy zero-byte sentinels retain the historical four-hour TTL.
      const contents = readFileSync(full, 'utf8').trim();
      if (contents) {
        try {
          const reservation = JSON.parse(contents);
          if (reservation.schema === 'ReportNumberReservationV1' && reservation.permanent === true) continue;
        } catch { /* malformed non-empty sentinels follow the legacy TTL */ }
      }
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > MAX_SENTINEL_AGE_MS) {
        unlinkSync(full);
        removed++;
        process.stderr.write(`reserve-report-num: GC stale sentinel ${name}\n`);
      }
    } catch {
      // Already gone — fine.
    }
  }
  if (removed > 0) {
    process.stderr.write(`reserve-report-num: removed ${removed} stale sentinel(s)\n`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const [,, cmd, arg] = process.argv;

if (cmd === '--release') {
  const m = (arg || '').match(/^(\d+)(?:-(\d+))?$/);
  if (!m) {
    process.stderr.write('Usage: node reserve-report-num.mjs --release <NNN>[-<MMM>]\n');
    process.exit(1);
  }
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (end < start) {
    process.stderr.write('reserve-report-num: --release range end must be >= start\n');
    process.exit(1);
  }
  for (let n = start; n <= end; n++) releaseSlot(n);
  process.exit(0);
}

if (cmd === '--gc') {
  gc();
  process.exit(0);
}

// Default (or --count N): reserve the next slot(s).
let count = 1;
if (cmd === '--count') {
  if (!/^\d+$/.test(arg || '')) {
    process.stderr.write(`Usage: node reserve-report-num.mjs --count <1-${MAX_COUNT}>\n`);
    process.exit(1);
  }
  count = parseInt(arg, 10);
  if (count < 1 || count > MAX_COUNT) {
    process.stderr.write(`Usage: node reserve-report-num.mjs --count <1-${MAX_COUNT}>\n`);
    process.exit(1);
  }
}
// Any other/unknown cmd falls through to a single reserve — unchanged
// legacy behavior.

mkdirSync(REPORTS_DIR, { recursive: true });

const nums = reserveRange(count);
if (!nums) {
  process.stderr.write(`reserve-report-num: could not claim ${count} slot(s) after ${MAX_RETRIES} retries\n`);
  process.exit(1);
}

process.stdout.write(
  count === 1
    ? pad(nums[0]) + '\n'
    : `${pad(nums[0])}-${pad(nums[nums.length - 1])}\n`
);
process.exit(0);
