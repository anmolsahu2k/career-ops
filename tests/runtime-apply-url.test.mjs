import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGreenhouseEmbedUrl,
  certifiedGreenhouseApiEndpoint,
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

test('path /jobs/{digits} is a Greenhouse id only on greenhouse.io hosts', () => {
  assert.equal(greenhouseJobId('https://job-boards.greenhouse.io/oneimaging/jobs/4403125009'), '4403125009');
  assert.equal(greenhouseJobId('https://job-boards.eu.greenhouse.io/lodestarspace/jobs/4969756101'), '4969756101');
  assert.equal(
    certifiedGreenhouseApiEndpoint('https://job-boards.eu.greenhouse.io/lodestarspace/jobs/4969756101'),
    'https://boards-api.greenhouse.io/v1/boards/lodestarspace/jobs/4969756101?content=true',
  );
  assert.equal(greenhouseJobId('https://careers.garmin.com/jobs/16587?icims=1'), null);
  assert.equal(greenhouseJobId('https://www.workatastartup.com/jobs/81444'), null);
  assert.equal(looksLikeResolvableGreenhouseShell('https://careers.garmin.com/jobs/16587?icims=1'), false);
  assert.equal(looksLikeResolvableGreenhouseShell('https://www.workatastartup.com/jobs/81444'), false);
  assert.equal(
    looksLikeResolvableGreenhouseShell('https://www.stepstonegroup.com/current-opportunities/?gh_jid=8171272'),
    true,
  );
  assert.equal(
    certifiedGreenhouseApiEndpoint('https://www.stepstonegroup.com/current-opportunities/?gh_jid=8171272'),
    null,
  );
  assert.ok(guessGreenhouseBoardTokens(
    'https://www.stepstonegroup.com/current-opportunities/?gh_jid=8171272',
    { company: 'StepStone Group' },
  ).includes('stepstonegroup'));
  assert.equal(
    guessGreenhouseBoardTokens(
      'https://www.stepstonegroup.com/current-opportunities/?gh_jid=8171272',
      { company: 'StepStone Group' },
    ).includes('current-opportunities'),
    false,
  );
});
