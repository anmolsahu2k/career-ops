import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { persistencePaths } from '../runtime/transaction.mjs';

/** Remove only aged, local application artifacts. Attempt records and the
 * append-only event log are deliberately retained for idempotency and audit. */
export function cleanupApplicationArtifacts(target, { days = 14, now = new Date() } = {}) {
  const retentionDays = Number(days);
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('Application artifact retention must be between 1 and 3650 days');
  }
  const root = resolve(persistencePaths(target).runtimeDir, 'applications', 'artifacts');
  if (!existsSync(root)) return { removed: 0, root };
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(root)) {
    // Artifact directories are created exclusively from an attempt identifier.
    if (!/^application-[a-z0-9-]+$/i.test(name)) continue;
    const path = resolve(root, name);
    if (!(path.startsWith(`${root}\\`) || path.startsWith(`${root}/`))) continue;
    let metadata;
    try { metadata = lstatSync(path); } catch { continue; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mtimeMs > cutoff) continue;
    rmSync(path, { recursive: true, force: false, maxRetries: 2 });
    removed++;
  }
  return { removed, root, retention_days: retentionDays };
}
