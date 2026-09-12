#!/usr/bin/env node
/**
 * backup.mjs -- user-triggered off-disk backup of the gitignored personal data.
 *
 * career-ops keeps its entire operational state (tracker, reports, resumes,
 * the signed offer PDF, portals config, memory) in gitignored files that live
 * on ONE disk with no Time Machine and no cloud sync. This script tars that set
 * to a mounted Google Drive folder so a disk failure mid-search is survivable.
 *
 * Rule 6 compliant: no cron, no schedule. The user runs it (`npm run backup`
 * or `node backup.mjs`, exposed as `/career-ops backup`).
 *
 * What it captures (the recovery set):
 *   - every gitignored + untracked file under the repo (minus re-derivable junk)
 *   - the auto-memory dir (behavioral memory, outside the repo)
 * What it does NOT capture by default (secrets; opt in with --with-secrets):
 *   - ~/.gmail-mcp/*.json, .env, .claude/settings.local.json
 *     These go into a SEPARATE tarball so credential material is never mixed
 *     into the main archive. Prefer regenerating them (docs/RECOVERY.md) over
 *     copying, but --with-secrets is there if you want the belt-and-suspenders.
 *
 * Usage:
 *   node backup.mjs                 # main recovery set -> newest Google Drive mount
 *   node backup.mjs --dest <dir>    # explicit destination dir
 *   node backup.mjs --with-secrets  # also write a separate secrets tarball
 *   node backup.mjs --dry-run       # print the manifest, write nothing
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const WITH_SECRETS = argv.includes('--with-secrets');
const destIdx = argv.indexOf('--dest');
const RETENTION = 5; // keep the last N dated archives per prefix

// Today's date. Date.now() is fine here (this is a normal script, not a
// workflow); format as YYYY-MM-DD for the archive name.
const TODAY = new Date().toISOString().slice(0, 10);

// ── Destination ─────────────────────────────────────────────────────
function resolveDest() {
  if (destIdx !== -1 && argv[destIdx + 1]) return argv[destIdx + 1];
  const cloud = join(HOME, 'Library', 'CloudStorage');
  if (existsSync(cloud)) {
    const drives = readdirSync(cloud).filter(d => d.startsWith('GoogleDrive-'));
    if (drives.length > 0) {
      // Deterministic pick: first alphabetically, so re-runs land in one place.
      drives.sort();
      return join(cloud, drives[0], 'career-ops-backups');
    }
  }
  return null;
}

const dest = resolveDest();
if (!dest) {
  console.error('No backup destination. No ~/Library/CloudStorage/GoogleDrive-* mount found.');
  console.error('Pass one explicitly:  node backup.mjs --dest /path/to/off-disk/folder');
  process.exit(1);
}

// ── Manifest: gitignored + untracked files, minus re-derivable junk ──
const JUNK = [
  'node_modules/', '__pycache__/', '.pytest_cache/', '.playwright-mcp/',
  'career-dashboard', 'package-lock.json', 'bun.lock', '.DS_Store',
];
// Secrets never go in the MAIN archive; they belong in the opt-in secrets
// tarball only. Keeping them out means the main archive can be handled casually.
const SECRETS = new Set(['.env', '.claude/settings.local.json']);
function isJunk(p) {
  if (SECRETS.has(p)) return true;
  return JUNK.some(j => p === j || p.includes('/' + j) || p.startsWith(j) || p.endsWith('/' + j) || p.endsWith(j));
}

// NUL-delimited so UTF-8 report dir names (reports/medecins-sans-frontieres/,
// reports/naive/) survive intact instead of breaking on a shell glob.
const raw = execFileSync(
  'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
);
const files = raw.split('\0').filter(Boolean).filter(p => !isJunk(p));

// The auto-memory dir lives outside the repo; add it wholesale.
const MEMORY_DIR = join(HOME, '.claude', 'projects', '-Users-anmolsahu2k-Stuff-Create-career-ops', 'memory');
const includeMemory = existsSync(MEMORY_DIR);

let totalBytes = 0;
for (const f of files) {
  try { totalBytes += statSync(join(ROOT, f)).size; } catch { /* vanished mid-run */ }
}

console.log(`Backup manifest: ${files.length} repo files (${(totalBytes / 1e6).toFixed(1)} MB)` +
  (includeMemory ? ' + auto-memory dir' : ''));

if (DRY) {
  console.log('\n[dry-run] destination would be:', dest);
  console.log('[dry-run] first 15 files:');
  for (const f of files.slice(0, 15)) console.log('  ', f);
  if (files.length > 15) console.log(`   ... and ${files.length - 15} more`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

// ── Write the main archive ──────────────────────────────────────────
// Feed the file list to tar NUL-delimited via a temp list file. bsdtar (macOS)
// and GNU tar both accept `--null -T <file>`.
const listFile = join(tmpdir(), `career-ops-backup-list-${TODAY}.txt`);
const listBody = files.join('\0') + (includeMemory ? '\0' + MEMORY_DIR : '');
writeFileSync(listFile, listBody);

const mainArchive = join(dest, `career-ops-${TODAY}.tar.gz`);
// -C ROOT so repo paths are stored relative; the absolute memory path is stored
// as-is (restores under the same home). Acceptable for a personal backup.
execFileSync('tar', ['-c', '-z', '-f', mainArchive, '--null', '-T', listFile, '-C', ROOT], {
  stdio: 'inherit',
});
rmSync(listFile, { force: true });
console.log('Wrote', mainArchive, `(${(statSync(mainArchive).size / 1e6).toFixed(1)} MB)`);

// ── Optional secrets archive (opt-in) ───────────────────────────────
if (WITH_SECRETS) {
  const secretPaths = [
    join(HOME, '.gmail-mcp'),
    join(ROOT, '.env'),
    join(ROOT, '.claude', 'settings.local.json'),
  ].filter(existsSync);
  if (secretPaths.length) {
    const secretsArchive = join(dest, `career-ops-secrets-${TODAY}.tar.gz`);
    execFileSync('tar', ['-c', '-z', '-f', secretsArchive, ...secretPaths], { stdio: 'inherit' });
    console.log('Wrote', secretsArchive, '(SECRETS: store securely, prefer regeneration per docs/RECOVERY.md)');
  }
}

// ── Retention: keep the last N per prefix ───────────────────────────
function prune(prefix) {
  const dated = readdirSync(dest)
    .filter(f => f.startsWith(prefix) && f.endsWith('.tar.gz'))
    .sort(); // dated names sort chronologically
  const excess = dated.slice(0, Math.max(0, dated.length - RETENTION));
  for (const f of excess) {
    rmSync(join(dest, f), { force: true });
    console.log('Pruned old archive:', f);
  }
}
prune('career-ops-2');       // main archives (career-ops-YYYY...)
prune('career-ops-secrets'); // secrets archives

console.log('\nBackup complete.');
