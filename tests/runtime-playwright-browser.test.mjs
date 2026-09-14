import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  playwrightChildEnv,
  sanitizePlaywrightBrowsersEnv,
} from '../lib/runtime/playwright-browser.mjs';

test('drops Cursor sandbox PLAYWRIGHT_BROWSERS_PATH overrides', () => {
  const env = {
    PLAYWRIGHT_BROWSERS_PATH: 'C:\\Users\\anmol\\AppData\\Local\\Temp\\cursor-sandbox-cache\\abc\\playwright',
    KEEP: '1',
  };
  const result = sanitizePlaywrightBrowsersEnv(env);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'cursor-sandbox-cache');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  assert.equal(env.KEEP, '1');
});

test('drops a browsers path that does not exist', () => {
  const env = { PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), 'career-ops-missing-playwright') };
  const result = sanitizePlaywrightBrowsersEnv(env);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'missing-dir');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, undefined);
});

test('keeps a real custom browsers directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-pw-'));
  try {
    const env = { PLAYWRIGHT_BROWSERS_PATH: dir };
    const result = sanitizePlaywrightBrowsersEnv(env);
    assert.equal(result.changed, false);
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('playwrightChildEnv clones without mutating process.env', () => {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const child = playwrightChildEnv({
    PLAYWRIGHT_BROWSERS_PATH: 'C:\\Temp\\cursor-sandbox-cache\\x\\playwright',
    FOO: 'bar',
  });
  assert.equal(child.PLAYWRIGHT_BROWSERS_PATH, undefined);
  assert.equal(child.FOO, 'bar');
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, previous);
});
