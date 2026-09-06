import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureHistoricalEvidence,
  plainTextFromHtml,
  readHistoricalEvidenceCache,
  verifyHistoricalEvidenceCache,
  writeHistoricalEvidenceCache,
} from '../lib/runtime/historical-evidence.mjs';

const NOW = new Date('2026-09-05T00:00:00.000Z');

function jsonResponse(status, value) {
  return { status, text: async () => JSON.stringify(value) };
}

test('HTML evidence normalization strips active content and decodes text', () => {
  const text = plainTextFromHtml('<style>bad</style><h1>Role &amp; team</h1><script>ignore()</script><p>Build systems.</p>');
  assert.match(text, /Role & team/);
  assert.match(text, /Build systems/);
  assert.doesNotMatch(text, /bad|ignore/);
});

test('captures exact Greenhouse evidence with an immutable digest', async () => {
  const entry = await captureHistoricalEvidence({
    caseId: 'HIST-041',
    sourceUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    expectedTitle: 'Software Engineer',
    now: NOW,
    fetchImpl: async url => {
      assert.match(url, /boards-api\.greenhouse\.io/);
      return jsonResponse(200, { title: 'Software Engineer', content: `<p>${'Build reliable services. '.repeat(20)}</p>` });
    },
  });
  assert.equal(entry.complete, true);
  assert.equal(entry.exact_source, true);
  assert.equal(entry.source_type, 'greenhouse');
  assert.equal(verifyHistoricalEvidenceCache(entry), true);

  const dir = mkdtempSync(join(tmpdir(), 'career-ops-evidence-cache-'));
  writeHistoricalEvidenceCache([entry], dir);
  assert.equal(readHistoricalEvidenceCache(dir).get('HIST-041').record_digest, entry.record_digest);
});

test('fails closed for ambiguous company pages and removed Ashby jobs', async () => {
  const ambiguous = await captureHistoricalEvidence({
    caseId: 'HIST-048', sourceUrl: 'https://simplify.jobs/c/Example', expectedTitle: 'Software Engineer', now: NOW,
  });
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.error_code, 'AMBIGUOUS_OR_UNSUPPORTED_SOURCE');

  const removed = await captureHistoricalEvidence({
    caseId: 'HIST-042',
    sourceUrl: 'https://jobs.ashbyhq.com/example/removed-id',
    expectedTitle: 'Data Analyst',
    now: NOW,
    fetchImpl: async () => jsonResponse(200, { jobs: [] }),
  });
  assert.equal(removed.complete, false);
  assert.equal(removed.error_code, 'SOURCE_NOT_LISTED');
  assert.equal(verifyHistoricalEvidenceCache(removed), true);
});

test('rejects a successful ATS response whose title does not match the approved row', async () => {
  const entry = await captureHistoricalEvidence({
    caseId: 'HIST-050',
    sourceUrl: 'https://example.wd1.myworkdayjobs.com/en-US/external/job/Anywhere/Role_R1',
    expectedTitle: 'Data Engineer',
    now: NOW,
    fetchImpl: async () => jsonResponse(200, {
      jobPostingInfo: { title: 'Sales Manager', jobDescription: `<p>${'Sell products. '.repeat(30)}</p>` },
    }),
  });
  assert.equal(entry.complete, false);
  assert.equal(entry.error_code, 'TITLE_MISMATCH');
});
