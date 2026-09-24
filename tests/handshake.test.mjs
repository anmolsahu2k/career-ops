import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import handshakeAdapter from '../extensions/job-autofill/content/adapters/handshake.js';
import { classifyApplyLanding, enabledAts, isCertifiedAts, mainProfileAtsEnabled } from '../lib/applications/ats.mjs';
import {
  assertLoopbackCdpUrl,
  closeOwnedTabs,
  connectMainProfile,
  defaultChromeUserDataDir,
  handshakeTabHeuristic,
  isOwnedTabPolicy,
  liveConnectEndpoints,
  parseDevToolsActivePort,
  probeCdp,
  readLiveCdpEndpoint,
  resolveMainProfileUserDataDir,
} from '../lib/applications/chrome-cdp.mjs';
import { diagnoseApplications } from '../lib/applications/doctor.mjs';
import { applyScoreFloor, DEDICATED_APPLY_SCORE_FLOOR, isEligibleRow } from '../lib/applications/eligibility.mjs';
import { attemptsForBrowserMode } from '../lib/applications/runner.mjs';
import { handshakeNativeGate, externalApplicationLabel, handshakeExternalOverlayAction, chooseExternalApplyTarget } from '../lib/handshake/apply-native.mjs';
import {
  isHandshakeOutboundRedirect,
  isIncidentalExternalHost,
  recordableLanding,
  selectExternalLanding,
  unwrapExternalUrl,
} from '../lib/handshake/external-landing.mjs';
import { handshakeCommitmentFromTracker, handshakeHardGate, handshakeShouldApply } from '../lib/handshake/evaluate.mjs';
import { handshakeExternalFollowThrough, runHandshakeTrackerApply } from '../lib/handshake/session.mjs';
import { confirmHandshakeFilters, handshakeFilterSpec } from '../lib/handshake/filters.mjs';
import { classifyApplyMode, extractHandshakeJob, handshakeJobFromHtml, isHandshakeJobUrl, isHandshakeSearchUrl } from '../lib/handshake/job-page.mjs';
import { handshakeKeywords } from '../lib/handshake/keywords.mjs';
import { handshakeCoverLetterMissing } from '../lib/handshake/cover-letter.mjs';
import { handshakeCompanyName } from '../lib/handshake/job-page.mjs';
import { listingsFromHtml, parseHandshakeListingLabel } from '../lib/handshake/listing.mjs';
import { handshakeConfigSnapshot } from '../lib/handshake/status.mjs';
import { evaluateLivePosting, fetchJobEvidence } from '../lib/runtime/evaluate-scan.mjs';
import { makeResponse } from './runtime-fixtures.mjs';

const JD = `${'Build TypeScript APIs for a new-grad software engineer in the United States. Full-time remote-US. '.repeat(16)}Apply now.`;

function stubConfig() {
  return {
    runtime_version: 1,
    api_billing: false,
    writer_host: hostname(),
    resource_pools: {
      'test-pool': {
        schema: 'ResourcePoolV1',
        schema_version: 1,
        quota_state: 'AVAILABLE',
        remaining_ratio: 1,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        minimum_reserve_ratio: 0,
        emergency_reserve_ratio: 0,
      },
    },
    providers: {
      'test-provider': {
        type: 'command',
        enabled: true,
        command: ['node', '-e', 'process.stdout.write("{}")'],
        model_vendor: 'local',
        model_family: 'test',
        model_snapshot: 'test-1',
        execution_surface: 'test',
        resource_pool: 'test-pool',
        capability_class: 'CONSEQUENTIAL',
        capabilities: ['structured_output', 'evidence_citations'],
        risk_ceiling: 'CONSEQUENTIAL',
        qualification: {
          qualified: true,
          lifecycle_state: 'production',
          confidence_interval_95: { lower: 0.99, upper: 1 },
        },
        observation: {
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          available: true,
          latency_ms: 1,
        },
      },
    },
  };
}

test('loopback CDP URLs are required and owned-tab close never touches foreign pages', async () => {
  assert.equal(assertLoopbackCdpUrl('http://127.0.0.1:9222').hostname, '127.0.0.1');
  assert.throws(() => assertLoopbackCdpUrl('http://8.8.8.8:9222'), /loopback/);
  assert.equal(isOwnedTabPolicy('owned'), true);
  assert.equal(isOwnedTabPolicy('dedicated'), false);
  const closed = [];
  const owned = { isClosed: () => false, close: async () => closed.push('owned') };
  await closeOwnedTabs({ ownedPages: new Set([owned]) });
  assert.deepEqual(closed, ['owned']);
  assert.equal(handshakeTabHeuristic({ url: 'https://cmu.joinhandshake.com/stu/jobs/1' }).handshake, true);
  assert.equal(handshakeTabHeuristic({ url: 'https://cmu.joinhandshake.com/login' }).login, true);
});

test('probeCdp reports down without throwing', async () => {
  const probe = await probeCdp('http://127.0.0.1:9', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    timeoutMs: 50,
  });
  assert.equal(probe.cdp_ok, false);
  assert.match(probe.detail, /chrome:\/\/inspect/i);
});

test('live Chrome inspect uses DevToolsActivePort websocket, not HTTP 9222', async () => {
  assert.throws(() => parseDevToolsActivePort('nope'), /invalid/i);
  const parsed = parseDevToolsActivePort('9333\r\n/devtools/browser/abc-123\n');
  assert.equal(parsed.port, 9333);
  assert.equal(parsed.wsUrl, 'ws://127.0.0.1:9333/devtools/browser/abc-123');
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-devtools-port-'));
  writeFileSync(join(dir, 'DevToolsActivePort'), '9444\n/devtools/browser/live-id\n');
  try {
    const live = readLiveCdpEndpoint(dir);
    assert.equal(live.wsUrl, 'ws://127.0.0.1:9444/devtools/browser/live-id');
    assert.deepEqual(liveConnectEndpoints(live), [
      'ws://127.0.0.1:9444/devtools/browser/live-id',
      'ws://127.0.0.1:9444/devtools/browser',
    ]);
    const probe = await probeCdp('http://127.0.0.1:9', {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      timeoutMs: 50,
      userDataDir: dir,
    });
    assert.equal(probe.cdp_ok, true);
    assert.equal(probe.attach, 'live');
    assert.equal(probe.wsUrl, live.wsUrl);
    let connected = '';
    const session = await connectMainProfile({
      applications: {
        main_profile: {
          enabled: true,
          cdp_url: 'http://127.0.0.1:9',
          user_data_dir: dir,
          ats: ['handshake'],
        },
      },
    }, {
      chromiumImpl: {
        connectOverCDP: async (url) => {
          connected = url;
          return { contexts: () => [{ pages: () => [] }] };
        },
      },
    });
    assert.equal(connected, 'ws://127.0.0.1:9444/devtools/browser/live-id');
    assert.equal(session.attach, 'live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(resolveMainProfileUserDataDir({ browser_channel: 'chrome' }), defaultChromeUserDataDir('chrome'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    assert.match(defaultChromeUserDataDir('chrome'), /Google\\Chrome\\User Data$/);
  }
});

test('live Chrome Handshake attach uses inspect client when Playwright is the default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-inspect-connect-'));
  writeFileSync(join(dir, 'DevToolsActivePort'), '9444\n/devtools/browser/live-id\n');
  try {
    let used = null;
    const session = await connectMainProfile({
      applications: {
        main_profile: {
          enabled: true,
          cdp_url: 'http://127.0.0.1:9',
          user_data_dir: dir,
          ats: ['handshake'],
        },
      },
    }, {
      focusWindow: false,
      inspectConnect: async (endpoints) => {
        used = endpoints;
        return {
          browser: { contexts: () => [{}] },
          context: { pages: () => [] },
          disconnect() {},
        };
      },
    });
    assert.equal(session.attach, 'live');
    assert.equal(used[0], 'ws://127.0.0.1:9444/devtools/browser/live-id');
    assert.equal(typeof session.disconnect, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Handshake filters fail closed when Full-Time is not confirmed', () => {
  const spec = handshakeFilterSpec({
    applications: { main_profile: { handshake: { job_types: ['Full-Time'], hide_applied: true } } },
  });
  const miss = confirmHandshakeFilters(spec, { pageText: 'internships in canada', url: 'https://cmu.joinhandshake.com/stu/postings' });
  assert.equal(miss.fail_closed, true);
  assert.ok(miss.missing.some(item => item.startsWith('job_type:')));
  const ok = confirmHandshakeFilters(spec, {
    pageText: 'Full-Time · United States · Remote · Hide applied · Past 21 days',
    url: 'https://cmu.joinhandshake.com/stu/postings?posted=21',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.fail_closed, false);
});

test('Handshake company name ignores the job title and the Handshake suffix', () => {
  assert.equal(
    handshakeCompanyName('Software Engineer- New Grad |Engine| | SingleStore | Handshake', 'Software Engineer- New Grad |Engine|'),
    'SingleStore',
  );
  assert.equal(handshakeCompanyName('Software Engineer | Figwork | Handshake', 'Software Engineer'), 'Figwork');
  assert.equal(handshakeCoverLetterMissing('Attach your cover letter or Upload new Submit Application'), true);
  assert.equal(handshakeCoverLetterMissing('Attach your cover letter 6249-cover-letter.pdf Preview document'), false);
});

test('listing and job-page parsers extract Handshake cards and apply mode', () => {
  const html = `
    <article data-career-ops="listing"><a href="/stu/jobs/11"><span data-career-ops="listing-title">Software Engineer</span></a>
    <div data-career-ops="listing-company">Acme</div><div data-career-ops="listing-location">Remote</div></article>`;
  const listings = listingsFromHtml(html, 'https://cmu.joinhandshake.com');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Software Engineer');
  assert.ok(isHandshakeJobUrl(listings[0].url));
  assert.equal(isHandshakeJobUrl('https://cmu.joinhandshake.com/job-search/11458140'), true);
  assert.equal(isHandshakeSearchUrl('https://cmu.joinhandshake.com/job-search'), true);
  assert.equal(isHandshakeSearchUrl('https://cmu.joinhandshake.com/job-search/11458140'), false);
  const parsed = parseHandshakeListingLabel('Plaid Technologies Software Engineering, New Grad $155K/yr · Full-time CMU collection San Francisco, CA + 1 1wk ago');
  assert.match(parsed.title, /Software Engineering, New Grad/);
  assert.equal(parsed.jobType, 'Full-time');
  assert.match(parsed.location, /San Francisco/);
  const jobHtml = `<h1>Software Engineer</h1><div data-career-ops="company">Acme</div>
    <div data-career-ops="jd">Role description for a full-time software engineer in the United States. ${JD}</div>
    <button data-career-ops="apply">Quick Apply</button>`;
  const job = handshakeJobFromHtml(jobHtml, 'https://cmu.joinhandshake.com/stu/jobs/11');
  assert.equal(job.applyMode, 'native');
  assert.equal(classifyApplyMode({ buttons: ['Apply Externally'] }), 'external');
  assert.equal(extractHandshakeJob({ alreadyApplied: true, title: 'x' }).applyMode, 'already_applied');
  const external = handshakeJobFromHtml(
    `<h1>Full-Stack Software Engineer</h1><div data-career-ops="company">Cruitical</div>
    <div data-career-ops="jd">${JD}</div>
    <a href="https://cmu.joinhandshake.com/redirect?url=https%3A%2F%2Fcareers.cruitical.com%2Fjobs%2Ffull-stack">Apply Externally</a>`,
    'https://cmu.joinhandshake.com/jobs/11458140',
  );
  assert.equal(external.applyMode, 'external');
  assert.equal(
    unwrapExternalUrl(external.applyUrl),
    'https://careers.cruitical.com/jobs/full-stack',
  );
});

test('live evaluate uses pageText and skips headless Handshake HTTP fetch', async () => {
  let httpCalls = 0;
  const fetchImpl = async () => {
    httpCalls += 1;
    throw new Error('http should not run');
  };
  const evidence = await fetchJobEvidence({
    url: 'https://cmu.joinhandshake.com/stu/jobs/99',
    company: 'Acme',
    title: 'Software Engineer',
    source: 'handshake',
  }, { fetchImpl, pageText: JD, skipHttpFetch: true });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.method, 'page_text');
  assert.equal(httpCalls, 0);

  const empty = await fetchJobEvidence({
    url: 'https://cmu.joinhandshake.com/stu/jobs/99',
    company: 'Acme',
    title: 'Software Engineer',
    source: 'handshake',
  }, { fetchImpl, pageText: 'short', skipHttpFetch: false });
  assert.equal(empty.ok, false);
  assert.equal(httpCalls, 0);
});

test('evaluateLivePosting commits SRC handshake through the existing judge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-handshake-eval-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
`);
  const providerHandle = {
    async complete(request) {
      return {
        schema: 'RawProviderResultV1',
        schema_version: 1,
        task_id: request.task.task_id,
        provider_snapshot: {
          provider: 'test-provider',
          model_snapshot: 'test-1',
          capability_class: 'CONSEQUENTIAL',
          execution_surface: 'test',
        },
        response: JSON.stringify(makeResponse()),
        usage: {},
        latency_ms: 1,
        attempts: 1,
        capability_degradation: false,
      };
    },
  };
  try {
    const result = await evaluateLivePosting({
      target: dir,
      config: stubConfig(),
      posting: {
        url: 'https://cmu.joinhandshake.com/stu/jobs/42',
        company: 'Handshake Co',
        title: 'Software Engineer',
        location: 'Remote - United States',
        source: 'handshake',
      },
      pageText: JD,
      provider: 'test-provider',
      acknowledgeQuota: true,
      providerHandle,
    });
    assert.equal(result.committed, 1, JSON.stringify(result.results, null, 2));
    assert.equal(result.results[0].source, 'handshake');
    const tracker = readFileSync(join(dir, 'data', 'applications.md'), 'utf8');
    assert.match(tracker, /SRC: handshake/);
    assert.match(tracker, /Handshake Co/);
    assert.equal(existsSync(join(dir, 'data', 'scan-results-live.tsv')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Handshake adapter matches job pages only', () => {
  assert.equal(handshakeAdapter.id, 'handshake');
  assert.equal(handshakeAdapter.matches('https://cmu.joinhandshake.com/stu/jobs/1'), true);
  assert.equal(handshakeAdapter.matches('https://cmu.joinhandshake.com/job-search/11458140'), true);
  assert.equal(handshakeAdapter.skipPage('https://cmu.joinhandshake.com/job-search'), true);
  assert.equal(handshakeAdapter.skipPage('https://cmu.joinhandshake.com/job-search/11458140'), false);
  assert.equal(handshakeAdapter.skipPage('https://cmu.joinhandshake.com/stu/postings'), true);
  assert.equal(handshakeAdapter.skipPage('https://cmu.joinhandshake.com/stu/jobs/1'), false);
  assert.equal(handshakeAdapter.matches('https://jobs.lever.co/acme/1'), false);
});

test('handshake is certified only with main_profile; dedicated floor stays 4.0', () => {
  const dedicated = { applications: { supported_ats: ['greenhouse'] } };
  assert.equal(enabledAts(dedicated).has('handshake'), false);
  const main = {
    applications: {
      supported_ats: ['greenhouse'],
      main_profile: { enabled: true, ats: ['handshake'] },
    },
  };
  assert.equal(enabledAts(main).has('handshake'), true);
  assert.equal(enabledAts(main).has('greenhouse'), true);
  assert.equal(mainProfileAtsEnabled(main, 'handshake'), true);
  assert.equal(isCertifiedAts('handshake'), false);
  assert.equal(isCertifiedAts('handshake', main), true);
  assert.equal(applyScoreFloor({}, { ats: 'handshake' }), 3.5);
  assert.equal(applyScoreFloor({}, { ats: 'greenhouse' }), DEDICATED_APPLY_SCORE_FLOOR);
  assert.equal(isEligibleRow({ status: 'Evaluated', score: '3.5/5', notes: 'APPLY' }), false);
  assert.equal(isEligibleRow({ status: 'Evaluated', score: '3.5/5', notes: 'APPLY' }, { scoreFloor: 3.5 }), true);
  assert.equal(isEligibleRow({ status: 'Evaluated', score: '4.0/5', notes: 'APPLY' }), true);
});

test('dedicated apply run drops Handshake attempts', () => {
  const pending = [
    { ats: 'greenhouse', canonical_url: 'https://job-boards.greenhouse.io/acme/jobs/1' },
    { ats: 'handshake', canonical_url: 'https://cmu.joinhandshake.com/stu/jobs/2' },
  ];
  assert.deepEqual(
    attemptsForBrowserMode(pending, { tabPolicy: 'dedicated' }).map(item => item.ats),
    ['greenhouse'],
  );
  assert.equal(attemptsForBrowserMode(pending, { tabPolicy: 'owned' }).length, 2);
});

test('Handshake apply floor and DO_NOT_APPLY gate', () => {
  assert.equal(handshakeShouldApply({ status: 'COMMITTED', decision: 'APPLY', score: 3.5 }), true);
  assert.equal(handshakeShouldApply({ status: 'COMMITTED', decision: 'CONSIDER', score: 3.5 }), true);
  assert.equal(handshakeShouldApply({ status: 'COMMITTED', decision: 'APPLY', score: 3.4 }), false);
  assert.equal(handshakeShouldApply({ status: 'COMMITTED', decision: 'DO_NOT_APPLY', score: 5 }), false);
  const gated = handshakeHardGate({ title: 'Software Engineer', jdText: 'short', login: false });
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'JD_TOO_SHORT');
});

test('Handshake tracker Apply reuses committed A-G and refuses without main_profile CDP', async () => {
  const committed = handshakeCommitmentFromTracker({
    num: 6247,
    score: '4.5/5',
    notes: 'APPLY SRC: handshake',
  });
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(committed.decision, 'APPLY');
  assert.equal(committed.score, 4.5);
  assert.equal(committed.report_number, 6247);
  assert.equal(handshakeShouldApply(committed, { scoreFloor: 3.5 }), true);
  await assert.rejects(
    () => runHandshakeTrackerApply({
      target: '.',
      config: { applications: { enabled: true } },
      trackerNumber: 6247,
    }),
    (err) => err.code === 'HANDSHAKE_DISABLED',
  );
});

test('Apply Externally overlay attaches a resume before External Application', () => {
  assert.equal(handshakeExternalOverlayAction({ overlayOpen: false }), 'open_overlay');
  assert.equal(handshakeExternalOverlayAction({
    overlayOpen: true,
    resumeAttached: false,
    buttons: ['External Application'],
  }), 'attach_resume');
  assert.equal(externalApplicationLabel(['Apply Externally', 'Step 2: External Application']), 'Step 2: External Application');
  assert.equal(/external\s+application/i.test('Apply Externally'), false);
  assert.equal(handshakeExternalOverlayAction({
    overlayOpen: true,
    resumeAttached: true,
    leaveDisabled: true,
    buttons: ['External Application'],
  }), 'wait_external_application');
  assert.equal(handshakeExternalOverlayAction({
    overlayOpen: true,
    resumeAttached: true,
    leaveDisabled: false,
    buttons: ['External Application'],
  }), 'external_application');
  assert.equal(chooseExternalApplyTarget([
    { text: 'Apply externally', href: 'https://cmu.joinhandshake.com/jobs/1' },
    { text: 'View application', href: 'https://jobs.ashbyhq.com/arch.co/9fde8d03-9f47-44ac-bd14-53829722c06d' },
  ]).href, 'https://jobs.ashbyhq.com/arch.co/9fde8d03-9f47-44ac-bd14-53829722c06d');
  assert.equal(chooseExternalApplyTarget([
    { text: 'Apply here via RippleMatch', href: 'https://app.ripplematch.com/t/c88c4adf' },
  ]).href, 'https://app.ripplematch.com/t/c88c4adf');
});

test('unknown external host is not a certified ATS follow-through', () => {
  const inspect = handshakeNativeGate({
    fields: [],
    login: false,
    captcha: false,
    submitVisible: true,
  }, { certified: false });
  assert.ok(inspect.blockers.some(item => item.code === 'UNSUPPORTED_PORTAL'));
  const ashby = classifyApplyLanding('https://jobs.ashbyhq.com/acme/123');
  assert.equal(ashby.host, 'jobs.ashbyhq.com');
  assert.equal(ashby.ats, 'ashby');
  assert.equal(ashby.certified, true);
  assert.equal(ashby.off_handshake, true);
  const custom = classifyApplyLanding('https://careers.cruitical.com/apply');
  assert.equal(custom.host, 'careers.cruitical.com');
  assert.equal(custom.ats, 'generic');
  assert.equal(custom.certified, false);
  assert.equal(classifyApplyLanding('https://cmu.joinhandshake.com/jobs/1').off_handshake, false);
  const recorded = classifyApplyLanding('https://jobs.ashbyhq.com/acme/123');
  assert.equal(handshakeExternalFollowThrough(recorded, { applications: { supported_ats: ['greenhouse'] } }), false);
  assert.equal(handshakeExternalFollowThrough(recorded, { applications: { supported_ats: ['greenhouse', 'ashby'] } }), true);
  assert.equal(handshakeExternalFollowThrough(custom, { applications: { supported_ats: ['greenhouse', 'ashby'] } }), false);
});

test('Apply Externally ignores leftover Drive tabs', () => {
  assert.equal(isIncidentalExternalHost('drive.google.com'), true);
  assert.equal(isIncidentalExternalHost('mail.google.com'), true);
  assert.equal(isIncidentalExternalHost('careers.google.com'), false);
  assert.equal(isIncidentalExternalHost('careers.cruitical.com'), false);
  assert.equal(isHandshakeOutboundRedirect('https://cmu.joinhandshake.com/ncc/e/abc'), true);
  assert.equal(isHandshakeOutboundRedirect('https://cmu.joinhandshake.com/jobs/11458140'), false);

  const drive = { ...classifyApplyLanding('https://drive.google.com/file/d/abc'), preexisting: true };
  const leftover = { ...classifyApplyLanding('https://drive.google.com/drive/u/0/home'), preexisting: false };
  leftover.preexisting = true;
  const ashby = classifyApplyLanding('https://jobs.ashbyhq.com/acme/1');
  const cruitical = classifyApplyLanding('https://careers.cruitical.com/apply');
  assert.equal(selectExternalLanding([drive, leftover]), null);
  assert.equal(selectExternalLanding([drive, ashby]).host, 'jobs.ashbyhq.com');
  assert.equal(selectExternalLanding([drive, cruitical]).host, 'careers.cruitical.com');
  assert.equal(
    selectExternalLanding([
      { ...classifyApplyLanding('https://drive.google.com/file/d/xyz'), preexisting: false },
    ], { allowHosts: new Set(['drive.google.com']) }).host,
    'drive.google.com',
  );
  assert.equal(
    unwrapExternalUrl('https://cmu.joinhandshake.com/redirect?url=https://careers.cruitical.com/apply'),
    'https://careers.cruitical.com/apply',
  );
  const recorded = recordableLanding(
    classifyApplyLanding('https://cmu.joinhandshake.com/jobs/11458140'),
    { href: 'https://careers.cruitical.com/jobs/full-stack' },
    'https://cmu.joinhandshake.com/jobs/11458140',
  );
  assert.equal(recorded.host, 'careers.cruitical.com');
  assert.equal(recorded.url, 'https://careers.cruitical.com/jobs/full-stack');
  assert.equal(recorded.off_handshake, true);
});

test('handshake keywords come from target roles', () => {
  assert.equal(
    handshakeKeywords({ keyword_source: 'target_roles' }, { target_roles: { primary: ['Software Engineer (New Grad)', 'ML Engineer'] } }),
    'Software Engineer',
  );
});

test('doctor records the Handshake live floor without lowering dedicated 4.0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-handshake-doc-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---:|------|---------|------|------:|--------|-----|--------|-------|
`);
  try {
    const report = diagnoseApplications(dir, {
      applications: {
        enabled: false,
        main_profile: {
          enabled: true,
          cdp_url: 'http://127.0.0.1:9222',
          ats: ['handshake'],
          apply_score_minimum: 3.5,
        },
      },
    });
    const floor = report.checks.find(item => item.code === 'HANDSHAKE_APPLY_FLOOR');
    assert.equal(floor?.ok, true);
    assert.match(floor.detail, /3\.5/);
    assert.match(floor.detail, /4\.0/);
    const snap = handshakeConfigSnapshot({
      applications: { main_profile: { enabled: true, ats: ['handshake'], cdp_url: 'http://127.0.0.1:9222' } },
    });
    assert.equal(snap.enabled, true);
    assert.equal(snap.apply_score_minimum, 3.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
