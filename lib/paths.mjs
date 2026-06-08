// lib/paths.mjs — single source of truth for engine data paths.
// CAREER_OPS_DATA_DIR (default 'ft') selects the target subtree under repo root.
// Shared config (portals.yml, states.yml, cv.md) always resolves to repo root.
import { existsSync } from 'fs';
import { dirname, join, isAbsolute, relative } from 'path';
import { fileURLToPath } from 'url';

function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'CLAUDE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('career-ops repo root (CLAUDE.md) not found from ' + startDir);
    dir = parent;
  }
}

export function resolvePaths(callerUrl) {
  const root = findRepoRoot(dirname(fileURLToPath(callerUrl)));
  const targetName = process.env.CAREER_OPS_DATA_DIR || 'ft';
  // Guard: only '.' or a repo-relative subpath that stays under root.
  if (isAbsolute(targetName) || targetName.split(/[\\/]/).includes('..')) {
    throw new Error(`CAREER_OPS_DATA_DIR must be '.' or a repo-relative subpath, got: ${targetName}`);
  }
  const target = join(root, targetName);
  if (relative(root, target).startsWith('..')) {
    throw new Error(`CAREER_OPS_DATA_DIR escapes repo root: ${targetName}`);
  }
  return {
    root,
    target,
    dataDir: join(target, 'data'),
    appsFile: join(target, 'data', 'applications.md'),
    reportsDir: join(target, 'reports'),
    batchDir: (sub = '') => join(target, 'batch', sub),
    portalsFile: join(root, 'portals.yml'),
    statesFile: join(root, 'templates', 'states.yml'),
  };
}
