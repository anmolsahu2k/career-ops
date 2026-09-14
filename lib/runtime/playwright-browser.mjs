/**
 * playwright-browser.mjs — durable Chromium launch for Career-Ops.
 *
 * Cursor agent shells set PLAYWRIGHT_BROWSERS_PATH to a temp sandbox cache
 * that often lacks chrome-headless-shell. Plan/liveness then fail even when
 * the user already has browsers in the normal ms-playwright directory.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SANDBOX_FRAGMENT = /cursor-sandbox-cache/i;

export function defaultPlaywrightBrowsersDir() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(local, 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return join(homedir(), '.cache', 'ms-playwright');
}

/**
 * Drop a Playwright browsers override that cannot actually launch Chromium.
 * Mutates `env` (defaults to process.env) and returns what changed.
 */
export function sanitizePlaywrightBrowsersEnv(env = process.env) {
  const current = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!current) return { changed: false, reason: 'unset' };
  const sandbox = SANDBOX_FRAGMENT.test(String(current));
  const missing = !existsSync(current);
  if (!sandbox && !missing) return { changed: false, reason: 'custom-ok', path: current };
  delete env.PLAYWRIGHT_BROWSERS_PATH;
  return {
    changed: true,
    reason: sandbox ? 'cursor-sandbox-cache' : 'missing-dir',
    previous: current,
  };
}

export function playwrightChildEnv(base = process.env) {
  const env = { ...base };
  sanitizePlaywrightBrowsersEnv(env);
  return env;
}

function missingBrowserError(cause) {
  const error = new Error(
    'Playwright Chromium is not installed. Run: npx playwright install chromium',
  );
  error.code = 'PLAYWRIGHT_BROWSER_MISSING';
  error.cause = cause || null;
  return error;
}

/**
 * Launch headless Chromium, ignoring Cursor sandbox browser caches.
 * Falls back to the installed Google Chrome channel when the bundled
 * headless shell is still missing after sanitizing the env.
 */
export async function launchChromium(options = {}) {
  sanitizePlaywrightBrowsersEnv();
  const { chromium } = await import('playwright');
  const launchOptions = { headless: true, ...options };
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) {
    return chromium.launch(launchOptions);
  }
  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch (cause) {
    throw missingBrowserError(cause);
  }
}
