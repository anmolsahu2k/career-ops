import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenhouseEmbedUrl,
  greenhouseJobId,
  guessGreenhouseBoardTokens,
  looksLikeResolvableGreenhouseShell,
  resolveCertifiedApplyUrl,
} from '../lib/applications/apply-url.mjs';
import { atsFor } from '../lib/applications/ats.mjs';

test('gh_jid careers shells are resolvable greenhouse provenance', () => {
  const url = 'https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002';
  assert.equal(atsFor(url), 'generic');
  assert.equal(greenhouseJobId(url), '8645054002');
  assert.equal(looksLikeResolvableGreenhouseShell(url), true);
  assert.ok(guessGreenhouseBoardTokens(url, { company: 'Databricks' }).includes('databricks'));
});

test('resolveCertifiedApplyUrl builds the official Greenhouse embed after a live board probe', async () => {
  const resolved = await resolveCertifiedApplyUrl(
    'https://databricks.com/company/careers/open-positions/job?gh_jid=8645054002',
    {
      company: 'Databricks',
      fetchImpl: async (url) => {
        assert.match(url, /boards\/databricks\/jobs\/8645054002$/);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 8645054002, title: 'Sr. Forward Deployed Engineer' }),
        };
      },
    },
  );
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.ats, 'greenhouse');
  assert.equal(resolved.url, buildGreenhouseEmbedUrl('databricks', '8645054002'));
  assert.equal(atsFor(resolved.url), 'greenhouse');
});

test('resolveCertifiedApplyUrl stays unresolved when no Greenhouse board accepts the job id', async () => {
  const resolved = await resolveCertifiedApplyUrl(
    'https://careers.example.test/jobs/role?gh_jid=12345',
    { company: 'Example', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
  );
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.reason, 'greenhouse-board-unresolved');
});
