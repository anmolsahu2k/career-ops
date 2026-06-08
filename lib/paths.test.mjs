import assert from 'node:assert';
import { test } from 'node:test';
import { resolvePaths } from './paths.mjs';

test('defaults to ft when env unset or empty', () => {
  delete process.env.CAREER_OPS_DATA_DIR;
  let p = resolvePaths(import.meta.url);
  assert.ok(p.root.endsWith('career-ops'), `root was ${p.root}`);
  assert.ok(p.appsFile.endsWith('ft/data/applications.md'), p.appsFile);
  assert.ok(p.reportsDir.endsWith('ft/reports'), p.reportsDir);
  assert.ok(p.batchDir('tracker-additions').endsWith('ft/batch/tracker-additions'), p.batchDir('tracker-additions'));
  assert.ok(p.portalsFile.endsWith('career-ops/portals.yml'), p.portalsFile);
  process.env.CAREER_OPS_DATA_DIR = '';   // set-but-empty must NOT resolve to root archive
  p = resolvePaths(import.meta.url);
  assert.ok(p.appsFile.endsWith('ft/data/applications.md'), `empty-env: ${p.appsFile}`);
  delete process.env.CAREER_OPS_DATA_DIR;
});

test('CAREER_OPS_DATA_DIR=. targets the root archive', () => {
  process.env.CAREER_OPS_DATA_DIR = '.';
  const p = resolvePaths(import.meta.url);
  assert.ok(p.appsFile.endsWith('career-ops/data/applications.md'), p.appsFile);
  delete process.env.CAREER_OPS_DATA_DIR;
});

test('rejects absolute and traversal targets', () => {
  for (const bad of ['/etc', '../evil', 'ft/../..']) {
    process.env.CAREER_OPS_DATA_DIR = bad;
    assert.throws(() => resolvePaths(import.meta.url), /CAREER_OPS_DATA_DIR/, `should reject ${bad}`);
  }
  delete process.env.CAREER_OPS_DATA_DIR;
});
