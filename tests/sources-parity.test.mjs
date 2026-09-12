// Cross-language parity for the discovery-source taxonomy.
//
// The taxonomy lives in three places because three runtimes need it:
//   lib/sources.mjs                 (Node: analytics, backfill, merge)  <- source of truth
//   scripts/discovery_filters.py    (Python: every ingest writer)
//   dashboard/internal/data/career.go (Go: the progress screen's breakdown)
//
// They drifted once already and it cost real analytics: jobspy stamped
// `SRC: linkedin` on tracker rows while scan-history recorded the same pipeline
// as `jobspy-linkedin`, so LinkedIn reported 317 scanned / 0 tracked beside a
// phantom 0 scanned / 10 tracked bucket. These tests fail the suite the moment
// the three copies disagree again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CANONICAL_SOURCES, SOURCE_GROUPS, normalizeSource, groupOf } from '../lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Labels that must resolve identically in every runtime. Each one has burned us
// or is a shape a live feed actually emits.
const SHARED_CASES = [
  'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'google',
  'hnhiring', 'greenhouse', 'ashby', 'lever', 'workday', 'playwright',
  'jobright', 'simplifyjobs', 'speedyapply', 'vanshb03', 'hiring-cafe',
  'web-search', 'gmail', 'external-moaijobs', 'greenhouse-api',
];

function pythonNormalize(labels) {
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
from discovery_filters import normalize_source, CANONICAL_SOURCES, SOURCE_GROUPS
labels = json.loads(sys.argv[1])
print(json.dumps({
    "normalized": {l: normalize_source(l) for l in labels},
    "canonical": CANONICAL_SOURCES,
    "groups": SOURCE_GROUPS,
}))
`;
  const out = execFileSync('python3', ['-c', src, JSON.stringify(labels)], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('python mirror exposes the same canonical source set as lib/sources.mjs', () => {
  const py = pythonNormalize([]);
  assert.deepEqual(
    [...py.canonical].sort(),
    [...CANONICAL_SOURCES].sort(),
    'scripts/discovery_filters.py CANONICAL_SOURCES drifted from lib/sources.mjs'
  );
});

test('python mirror groups every source the same way', () => {
  const py = pythonNormalize([]);
  for (const [group, list] of Object.entries(SOURCE_GROUPS)) {
    assert.deepEqual(
      [...(py.groups[group] || [])].sort(),
      [...list].sort(),
      `group "${group}" differs between lib/sources.mjs and discovery_filters.py`
    );
  }
});

test('python and node normalize the same raw labels identically', () => {
  const py = pythonNormalize(SHARED_CASES);
  for (const label of SHARED_CASES) {
    assert.equal(
      py.normalized[label],
      normalizeSource(label),
      `normalize("${label}") differs between python and node`
    );
  }
});

test('"aggregator" resolves to null in both runtimes (it names the engine, not the feed)', () => {
  const py = pythonNormalize(['aggregator', 'aggregator-unknown', '2026-08-07', '']);
  assert.equal(normalizeSource('aggregator'), null);
  assert.equal(py.normalized['aggregator'], null);
  assert.equal(py.normalized['aggregator-unknown'], null);
  // A bare ISO date is a column-order accident, never a source.
  assert.equal(normalizeSource('2026-08-07'), null);
  assert.equal(py.normalized['2026-08-07'], null);
});

test('the go dashboard groups every canonical source, and none as a typo', () => {
  const go = readFileSync(join(ROOT, 'dashboard/internal/data/career.go'), 'utf8');
  const block = go.match(/var sourceGroups = map\[string\]string\{([\s\S]*?)\n\}/);
  assert.ok(block, 'sourceGroups map not found in dashboard/internal/data/career.go');

  const goGroups = new Map();
  for (const m of block[1].matchAll(/"([a-z0-9-]+)":\s*"([a-z-]+)"/g)) {
    goGroups.set(m[1], m[2]);
  }

  for (const source of CANONICAL_SOURCES) {
    assert.ok(
      goGroups.has(source),
      `dashboard sourceGroups is missing "${source}"; it would render under "manual"`
    );
    assert.equal(
      goGroups.get(source),
      groupOf(source),
      `dashboard groups "${source}" as "${goGroups.get(source)}", taxonomy says "${groupOf(source)}"`
    );
  }
  for (const source of goGroups.keys()) {
    assert.ok(
      CANONICAL_SOURCES.includes(source),
      `dashboard sourceGroups has "${source}", which is not a canonical source id`
    );
  }
});

test('the go dashboard resolves the legacy aliases that already exist in tracker data', () => {
  const go = readFileSync(join(ROOT, 'dashboard/internal/data/career.go'), 'utf8');
  const block = go.match(/var sourceAliases = map\[string\]string\{([\s\S]*?)\n\}/);
  assert.ok(block, 'sourceAliases map not found in dashboard/internal/data/career.go');

  const goAliases = new Map();
  for (const m of block[1].matchAll(/"([a-z0-9_-]+)":\s*"([a-z0-9-]+)"/g)) {
    goAliases.set(m[1], m[2]);
  }

  // `linkedin` is the one that actually shipped into applications.md.
  assert.equal(goAliases.get('linkedin'), 'jobspy-linkedin');
  for (const [alias, target] of goAliases) {
    assert.equal(
      target,
      normalizeSource(alias),
      `dashboard aliases "${alias}" to "${target}", taxonomy says "${normalizeSource(alias)}"`
    );
  }
});
