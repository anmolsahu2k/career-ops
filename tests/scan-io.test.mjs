// lib/scan-io.mjs is the one definition of the feed-intake gates shared by
// scan.mjs, scan-freehire.mjs and scan-linkedin.mjs. It was extracted FROM
// scan.mjs precisely so a second scanner could not fork the dedup rule and
// drift; these tests pin the behaviour that extraction was meant to preserve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INTERN_DENY_RE, buildTitleFilter, loadSeenUrls, loadSeenCompanyRoles,
  aliasResolve, writeScanResults, appendToScanHistory, logSkipped,
} from '../lib/scan-io.mjs';

const FILTER = {
  must_match: '\\b(engineer|developer|data|machine learning|ai|new grad)\\b',
  positive: ['engineer', 'data', 'ai', 'machine learning'],
  negative: ['senior', 'staff', 'principal'],
};

test('intern deny-list drops intern titles without killing "International"', () => {
  const f = buildTitleFilter(FILTER);
  assert.equal(f('Software Engineering Intern'), false);
  assert.equal(f('Software Engineer, Co-op'), false);
  assert.equal(f('Data Science Summer 2027'), false);
  assert.equal(f('University Hire, Software Engineer'), false);
  // The reason this is a word-boundary regex and not a `negative` substring.
  assert.equal(INTERN_DENY_RE.test('International Data Engineer'), false);
  assert.equal(f('International Data Engineer'), true);
});

test('three-stage title filter: must_match, positive, negative', () => {
  const f = buildTitleFilter(FILTER);
  assert.equal(f('Software Engineer, New Grad'), true);
  assert.equal(f('Technical Recruiter'), false);          // fails must_match
  assert.equal(f('Senior Software Engineer'), false);     // hits negative
  assert.equal(f('Machine Learning Engineer'), true);
});

test('an empty positive list means "no domain restriction", not "reject all"', () => {
  const f = buildTitleFilter({ ...FILTER, positive: [] });
  assert.equal(f('Data Engineer'), true);
});

test('loadSeenUrls unions the scan-history ledger and tracker URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const hist = join(dir, 'scan-history.tsv');
  const apps = join(dir, 'applications.md');
  writeFileSync(hist, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n' +
    'https://a.com/1\t2026-08-01\tfreehire\tSWE\tAcme\tadded\tSF\n');
  writeFileSync(apps, '| 1 | 2026-08-02 | Globex | SWE | 4.1 | Applied | - | [r](https://b.com/2) | SRC: freehire. |\n');

  const seen = loadSeenUrls({ scanHistoryPath: hist, applicationsPath: apps });
  assert.ok(seen.has('https://a.com/1'), 'history url missing');
  assert.ok(seen.has('https://b.com/2'), 'tracker url missing');
  assert.equal(seen.has('https://c.com/3'), false);
});

test('loadSeenUrls tolerates missing files (fresh workspace)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const seen = loadSeenUrls({
    scanHistoryPath: join(dir, 'nope.tsv'), applicationsPath: join(dir, 'nope.md'),
  });
  assert.equal(seen.size, 0);
});

test('company::role dedup keys fold through the portals.yml brand aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const portals = join(dir, 'portals.yml');
  const apps = join(dir, 'applications.md');
  writeFileSync(portals, 'company_aliases:\n  netsuite: oracle\n  github: microsoft\n\ntracked_companies:\n');
  writeFileSync(apps, '| 1 | 2026-08-02 | NetSuite | Software Engineer | 4.0 | Applied | - | - | - |\n');

  assert.equal(aliasResolve('NetSuite', portals), 'oracle');
  assert.equal(aliasResolve('Some Startup', portals), 'some-startup');

  const seen = loadSeenCompanyRoles({ applicationsPath: apps, portalsPath: portals });
  // The whole point: the same req arriving as "Oracle" must match the NetSuite row.
  assert.ok(seen.has('oracle::software engineer'), 'alias-folded key missing');
  assert.ok(seen.has('netsuite::software engineer'), 'raw key missing');
});

test('writeScanResults APPENDS to an existing handoff file', () => {
  // Regression: an unconditional overwrite here silently discarded a prior
  // scanner's survivors (2026-07-30, 493 rows). Every scanner writes this file.
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const rows = (n) => [{ url: `https://x.com/${n}`, company: 'Acme', title: 'SWE', location: 'SF', source: 'freehire' }];

  const p1 = writeScanResults(rows(1), '2026-08-09', dir);
  const p2 = writeScanResults(rows(2), '2026-08-09', dir);
  assert.equal(p1, p2, 'both writes must target the same per-date file');

  const lines = readFileSync(p1, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 3, 'expected header + 2 rows');
  assert.ok(lines[0].startsWith('url\tcompany\ttitle'), 'header written once');
  assert.ok(lines[1].includes('/1') && lines[2].includes('/2'), 'first write survived');
});

test('writeScanResults writes nothing for an empty batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  assert.equal(writeScanResults([], '2026-08-09', dir), null);
  assert.equal(existsSync(join(dir, 'scan-results-2026-08-09.tsv')), false);
});

test('scan-history rows carry the location column and the source', () => {
  // Regression: the ledger used to drop location, so rebuilding the handoff
  // file from history pushed Canada-only reqs into a US-only eval wave.
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const hist = join(dir, 'scan-history.tsv');
  appendToScanHistory(
    [{ url: 'https://x.com/1', company: 'Acme', title: 'SWE', location: 'Toronto, ON', source: 'freehire' }],
    '2026-08-09', hist);

  const [header, row] = readFileSync(hist, 'utf-8').trim().split('\n');
  assert.equal(header.split('\t').length, 7);
  const cells = row.split('\t');
  assert.equal(cells[2], 'freehire', 'portal/source column');
  assert.equal(cells[5], 'added');
  assert.equal(cells[6], 'Toronto, ON', 'location must survive');
});

test('logSkipped records the drop reason so per-source yields stay honest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const hist = join(dir, 'scan-history.tsv');
  logSkipped([{ url: 'https://x.com/9', company: 'Acme', title: 'Recruiter', location: '', source: 'freehire' }],
    '2026-08-09', hist, 'skipped_filter');
  const row = readFileSync(hist, 'utf-8').trim().split('\n')[1];
  assert.equal(row.split('\t')[5], 'skipped_filter');
});

test('a tab inside a location cannot corrupt the TSV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanio-'));
  const hist = join(dir, 'scan-history.tsv');
  appendToScanHistory(
    [{ url: 'https://x.com/1', company: 'Acme', title: 'SWE', location: 'A\tB', source: 'freehire' }],
    '2026-08-09', hist);
  const row = readFileSync(hist, 'utf-8').trim().split('\n')[1];
  assert.equal(row.split('\t').length, 7, 'embedded tab must be neutralised');
});
