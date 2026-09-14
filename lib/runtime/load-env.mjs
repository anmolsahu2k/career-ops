/**
 * Load gitignored `.env` into process.env without logging values.
 * Existing environment variables win unless `override` is set.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

export function loadLocalEnv({ root, override = false } = {}) {
  if (!root) return { loaded: false, path: null };
  const path = resolve(root, '.env');
  if (!existsSync(path)) return { loaded: false, path };
  loadDotenv({ path, override: Boolean(override) });
  return { loaded: true, path };
}
