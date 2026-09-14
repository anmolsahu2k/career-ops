import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalEnv } from '../lib/runtime/load-env.mjs';

test('loadLocalEnv leaves existing process.env values in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-env-'));
  const name = `CAREER_OPS_TEST_${Date.now()}`;
  process.env[name] = 'from-process';
  writeFileSync(join(dir, '.env'), `${name}=from-file\n`);
  const result = loadLocalEnv({ root: dir });
  assert.equal(result.loaded, true);
  assert.equal(process.env[name], 'from-process');
  delete process.env[name];
});

test('loadLocalEnv fills a missing variable from .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-env-fill-'));
  const name = `CAREER_OPS_TEST_FILL_${Date.now()}`;
  delete process.env[name];
  writeFileSync(join(dir, '.env'), `${name}=from-file\n`);
  const result = loadLocalEnv({ root: dir });
  assert.equal(result.loaded, true);
  assert.equal(process.env[name], 'from-file');
  delete process.env[name];
});
