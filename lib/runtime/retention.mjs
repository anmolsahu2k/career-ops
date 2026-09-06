import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SANITIZER_LIMITS } from './constants.mjs';
import { canonicalJson, isoNow, record, sha256 } from './util.mjs';

function scrub(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|AIza|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[REDACTED_PHONE]');
}

export function retainValidationFailure(target, rawResult, error, {
  debugging = false,
  now = new Date(),
  maximumBytes = DEFAULT_SANITIZER_LIMITS.raw_response_bytes,
} = {}) {
  const dir = join(target, '.career-ops-runtime', 'failed-responses');
  mkdirSync(dir, { recursive: true });
  const raw = typeof rawResult.response === 'string' ? rawResult.response : JSON.stringify(rawResult.response);
  const sanitized = scrub(raw);
  const capped = Buffer.from(sanitized, 'utf8').subarray(0, maximumBytes).toString('utf8');
  const retentionDays = debugging ? 30 : 7;
  const item = record('FailedProviderResponseV1', {
    task_id: rawResult.task_id,
    provider_snapshot: rawResult.provider_snapshot,
    response_digest: sha256(raw),
    scrubbed_response: capped,
    error: { code: error.code || error.name, message: scrub(error.message).slice(0, 2000) },
    retained_at: now.toISOString(),
    expires_at: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
    local_only: true,
  });
  const path = join(dir, `${Date.now()}-${sha256(rawResult.task_id).slice(0, 12)}.json`);
  writeFileSync(path, `${canonicalJson(item)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

export function cleanupRetention(target, { now = new Date() } = {}) {
  const dir = join(target, '.career-ops-runtime', 'failed-responses');
  if (!existsSync(dir)) return { removed: 0 };
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const item = JSON.parse(readFileSync(path, 'utf8'));
      if (Date.parse(item.expires_at) <= now.getTime()) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // Malformed retention files are left in place for explicit inspection.
    }
  }
  return { removed };
}
