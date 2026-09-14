import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  classifyTitleLevel,
  loadCandidateContext,
  postingAgeDays,
  resolveEligibilityGates,
  resolveGeographyGate,
  titleLevelCompatible,
} from '../lib/runtime/candidate-context.mjs';
import { evaluateScanResults, writeScanResultsTsv } from '../lib/runtime/evaluate-scan.mjs';
import { prepareTask, buildProviderRequest } from '../lib/runtime/prepare.mjs';

const NEW_GRAD_CONTEXT = {
  available: true,
  entry_level_only: true,
  us_only: true,
  work_authorized_at_start: true,
  level_band: 'New Grad / Entry-Level',
  evidence: {
    id: 'EV-CANDIDATE',
    source_type: 'candidate-record',
    uri: 'career-ops://candidate/profile',
    content: 'Candidate record: new grad, US-only, OPT-eligible, 2.5 years SDE experience.',
    liveness_state: 'UNKNOWN',
    trust_class: 'trusted_evidence',
    derive_oracles: false,
  },
};

function longJd(extra = '') {
  return `${'We are hiring an engineer to build and operate production services with Node.js, Python, and cloud infrastructure. '.repeat(10)}${extra}`;
}

test('classifyTitleLevel catches the abbreviated senior titles that reached the evaluator', () => {
  assert.equal(classifyTitleLevel('Sr. Forward Deployed Engineer').band, 'senior');
  assert.equal(classifyTitleLevel('Sr Solutions Engineer').band, 'senior');
  assert.equal(classifyTitleLevel('Senior Software Engineer').band, 'senior');
  assert.equal(classifyTitleLevel('Staff Machine Learning Engineer').band, 'senior');
  assert.equal(classifyTitleLevel('Engineering Manager').band, 'senior');
  assert.equal(classifyTitleLevel('Software Engineer III').band, 'senior');
});

test('classifyTitleLevel keeps entry and carved-out titles', () => {
  assert.equal(classifyTitleLevel('Software Engineer, New Grad').band, 'entry');
  assert.equal(classifyTitleLevel('Member of Technical Staff').band, 'entry');
  assert.equal(classifyTitleLevel('Software Engineer II').band, 'unknown');
  assert.equal(classifyTitleLevel('Software Engineer, Agent').band, 'unknown');
  // An explicit entry marker outranks a weak senior token.
  assert.equal(classifyTitleLevel('Associate Solutions Architect').band, 'entry');
});

test('titleLevelCompatible only filters when the profile is entry-level', () => {
  assert.equal(titleLevelCompatible('Sr. Engineer', NEW_GRAD_CONTEXT).ok, false);
  assert.equal(titleLevelCompatible('Sr. Engineer', { entry_level_only: false }).ok, true);
  assert.equal(titleLevelCompatible('Software Engineer', NEW_GRAD_CONTEXT).ok, true);
});

test('resolveGeographyGate reads the location column then falls back to the posting', () => {
  const ctx = NEW_GRAD_CONTEXT;
  assert.equal(resolveGeographyGate({ locationText: 'Austin, TX', context: ctx }).value, 'YES');
  assert.equal(resolveGeographyGate({ locationText: 'Remote - US', context: ctx }).value, 'YES');
  assert.equal(resolveGeographyGate({ locationText: 'London, United Kingdom', context: ctx }).value, 'NO');
  assert.equal(resolveGeographyGate({ locationText: 'Bengaluru, India', context: ctx }).value, 'NO');
  // Bare "Remote" is not a geography signal, so the description decides.
  assert.equal(
    resolveGeographyGate({ locationText: 'Remote', jdText: 'This role sits in Seattle, Washington.', context: ctx }).value,
    'YES',
  );
  assert.equal(resolveGeographyGate({ locationText: 'Remote', context: ctx }).value, 'UNKNOWN');
  // No configured constraint means the gate stays unresolved.
  assert.equal(resolveGeographyGate({ locationText: 'Austin, TX', context: { us_only: false } }).value, 'UNKNOWN');
});

test('resolveEligibilityGates records absence only when the posting is complete', () => {
  const complete = resolveEligibilityGates({
    jdText: longJd(),
    context: NEW_GRAD_CONTEXT,
    scorable: true,
  });
  assert.equal(complete.gates.citizenship_restricted, 'NO');
  assert.equal(complete.gates.sponsorship_compatible, 'YES');

  const thin = resolveEligibilityGates({ jdText: 'Apply here.', context: NEW_GRAD_CONTEXT, scorable: false });
  assert.equal(thin.gates.citizenship_restricted, undefined);
  assert.equal(thin.gates.sponsorship_compatible, undefined);
});

test('resolveEligibilityGates never overrides explicit restriction language', () => {
  const restricted = resolveEligibilityGates({
    jdText: `${longJd()} This role requires US citizens only and we will not sponsor employment visas.`,
    context: NEW_GRAD_CONTEXT,
    scorable: true,
  });
  assert.equal(restricted.gates.citizenship_restricted, 'YES');
  assert.equal(restricted.gates.sponsorship_compatible, 'NO');
});

test('postingAgeDays converts a publish date to whole days', () => {
  const now = Date.parse('2026-09-12T00:00:00.000Z');
  assert.equal(postingAgeDays('2026-09-01T00:00:00.000Z', now), 11);
  assert.equal(postingAgeDays(null, now), null);
  assert.equal(postingAgeDays('not-a-date', now), null);
});

test('loadCandidateContext strips contact details from the CV evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-candidate-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'profile.yml'), [
    'candidate:',
    '  full_name: Test Person',
    'location:',
    '  country: United States',
    '  visa_status: F-1; OPT-eligible',
    'ft_constraints:',
    '  geography: US-only',
    '  work_auth: OPT at start',
    'target_roles:',
    '  archetypes:',
    '    - name: Software Engineer',
    '      level: New Grad / Entry-Level',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'cv.md'), '# Test Person\n\n(412) 555-1234 | secret@example.com\n\nBuilt services.\n');

  const context = loadCandidateContext({ root: dir, reload: true });
  assert.equal(context.available, true);
  assert.equal(context.entry_level_only, true);
  assert.equal(context.us_only, true);
  assert.equal(context.work_authorized_at_start, true);
  assert.equal(context.evidence.trust_class, 'trusted_evidence');
  assert.equal(context.evidence.liveness_state, 'UNKNOWN');
  assert.doesNotMatch(context.evidence.content, /secret@example\.com/);
  assert.doesNotMatch(context.evidence.content, /555-1234/);
  assert.match(context.evidence.content, /Built services/);
});

test('the candidate record reaches the provider request without resolving posting gates', () => {
  const task = prepareTask({
    company: 'Acme',
    role: 'Software Engineer, New Grad',
    url: 'https://jobs.example.com/1',
    source: 'greenhouse',
    evidence: [
      {
        id: 'EV-1',
        source_type: 'greenhouse',
        uri: 'https://jobs.example.com/1',
        content: longJd(),
        liveness_state: 'YES',
        structured_fields: { required_evidence_complete: 'YES' },
      },
      { ...NEW_GRAD_CONTEXT.evidence },
    ],
  });

  const candidate = task.evidence_manifest.find(item => item.id === 'EV-CANDIDATE');
  assert.equal(candidate.trust_class, 'trusted_evidence');
  // Oracles must not read the candidate record for posting facts.
  assert.equal(candidate.structured_fields, undefined);

  const request = buildProviderRequest(task, {
    'EV-1': longJd(),
    'EV-CANDIDATE': NEW_GRAD_CONTEXT.evidence.content,
  });
  assert.match(request.instruction, /first-party record/i);
  assert.equal(request.evidence.length, 2);
  assert.match(request.evidence[1].content, /new grad/i);
});

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

// The provider leaves every gate UNKNOWN. Anything that resolves must come from
// the deterministic seed, which is exactly what used to be missing.
function unknownGateProvider(captured) {
  return {
    async complete(request) {
      captured.push(request);
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
        response: JSON.stringify({
          decision_inputs: {
            gates: Object.fromEntries([
              'posting_live', 'citizenship_restricted', 'geography_eligible',
              'sponsorship_compatible', 'required_evidence_complete',
            ].map(gate => [gate, { value: 'UNKNOWN', evidence_refs: [] }])),
            score: 4.5,
            recommendation: 'APPLY',
            confidence: 0.9,
          },
          presentation_content: {
            A: 'An entry-level backend role building production services.',
            B: 'The candidate record shows matching backend and cloud work.',
            C: 'The posting level matches an entry-level candidate.',
            D: 'Compensation evidence was not provided.',
            E: 'Lead with production service ownership.',
            F: 'Prepare coding and system design examples.',
            G: 'The validated source states the posting is active.',
          },
        }),
        usage: {},
        latency_ms: 1,
        attempts: 1,
        capability_degradation: false,
      };
    },
  };
}

function triageDir(prefix, rows) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'scan-results-2026-09-12.tsv');
  writeScanResultsTsv(file, rows);
  return { dir, file };
}

test('deterministic gates make APPLY reachable and write the full Notes dialect', async () => {
  const { dir, file } = triageDir('career-ops-apply-gates-', [{
    url: 'https://jobs.example.com/newgrad',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);
  const captured = [];

  const result = await evaluateScanResults({
    target: dir,
    config: stubConfig(),
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle: unknownGateProvider(captured),
    candidateContext: NEW_GRAD_CONTEXT,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'greenhouse',
      content: longJd(),
      title: 'Software Engineer, New Grad',
      liveness_state: 'YES',
      posted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      method: 'ats_api',
    }),
  });

  assert.equal(result.committed, 1, JSON.stringify(result.results, null, 2));
  const row = result.results[0];
  // Every consequential gate resolved from the seed, so APPLY survives policy.
  assert.equal(row.decision, 'APPLY', JSON.stringify(row, null, 2));
  assert.equal(row.age_days, 3);
  assert.deepEqual(row.policy_reasons, []);

  // The candidate record was actually sent.
  assert.equal(captured.length, 1);
  assert.ok(captured[0].evidence.some(item => item.id === 'EV-CANDIDATE'));

  const tracker = readFileSync(join(dir, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /TRUE-AGE: 3d/);
  assert.match(tracker, /Submit SDE resume/);
  assert.match(tracker, /APPLY\./);
  assert.match(tracker, /SRC: manual/);
});

test('senior titles are dropped before liveness and before any provider call', async () => {
  const { dir, file } = triageDir('career-ops-level-gate-', [{
    url: 'https://jobs.example.com/senior',
    company: 'Databricks',
    title: 'Sr. Forward Deployed Engineer',
    location: 'San Francisco, CA',
    source: 'greenhouse-api',
  }, {
    url: 'https://jobs.example.com/newgrad',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);

  const result = await evaluateScanResults({
    target: dir,
    files: [file],
    apply: false,
    skipLiveness: true,
    candidateContext: NEW_GRAD_CONTEXT,
  });

  assert.equal(result.status, 'PLAN');
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].company, 'Acme');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].code, 'LEVEL_MISMATCH');
  assert.match(result.skipped[0].reason, /above the/i);
  assert.equal(result.gates.level_skipped, 1);
  assert.equal(result.gates.entry_level_only, true);
});

test('stale postings are skipped instead of scored', async () => {
  const { dir, file } = triageDir('career-ops-age-gate-', [{
    url: 'https://jobs.example.com/stale',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);
  const captured = [];

  const result = await evaluateScanResults({
    target: dir,
    config: stubConfig(),
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    maxAgeDays: 21,
    providerHandle: unknownGateProvider(captured),
    candidateContext: NEW_GRAD_CONTEXT,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'greenhouse',
      content: longJd(),
      title: 'Software Engineer, New Grad',
      liveness_state: 'YES',
      posted_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      method: 'ats_api',
    }),
  });

  assert.equal(result.committed, 0);
  assert.equal(result.results[0].status, 'SKIPPED_STALE');
  assert.equal(result.results[0].age_days, 60);
  assert.equal(captured.length, 0, 'a stale posting must not reach the provider');
});

test('a provider with no qualification record is allowed but recorded', async () => {
  const { dir, file } = triageDir('career-ops-unqualified-provider-', [{
    url: 'https://jobs.example.com/newgrad',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);
  const config = stubConfig();
  delete config.providers['test-provider'].qualification;
  delete config.providers['test-provider'].observation;

  const result = await evaluateScanResults({
    target: dir,
    config,
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle: unknownGateProvider([]),
    candidateContext: NEW_GRAD_CONTEXT,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'greenhouse',
      content: longJd(),
      title: 'Software Engineer, New Grad',
      liveness_state: 'YES',
      posted_at: new Date().toISOString(),
      method: 'ats_api',
    }),
  });

  assert.equal(result.committed, 1);
  assert.equal(result.provider_override.forced, true);
  assert.deepEqual(result.provider_override.gaps, ['never_qualified', 'unobserved']);
});

test('a provider that failed qualification is refused unless the override is explicit', async () => {
  const { dir, file } = triageDir('career-ops-force-provider-', [{
    url: 'https://jobs.example.com/newgrad',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);
  const config = stubConfig();
  config.providers['test-provider'].qualification.qualified = false;

  await assert.rejects(
    () => evaluateScanResults({
      target: dir,
      config,
      files: [file],
      apply: true,
      skipLiveness: true,
      provider: 'test-provider',
      acknowledgeQuota: true,
      providerHandle: unknownGateProvider([]),
      candidateContext: NEW_GRAD_CONTEXT,
    }),
    /has failed qualification/,
  );

  const forced = await evaluateScanResults({
    target: dir,
    config,
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    forceProvider: true,
    providerHandle: unknownGateProvider([]),
    candidateContext: NEW_GRAD_CONTEXT,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'greenhouse',
      content: longJd(),
      title: 'Software Engineer, New Grad',
      liveness_state: 'YES',
      posted_at: new Date().toISOString(),
      method: 'ats_api',
    }),
  });
  assert.equal(forced.committed, 1);
  assert.equal(forced.provider_override.forced, true);
  assert.ok(forced.provider_override.gaps.includes('qualification_failed'));
});

test('thin evidence cannot produce a score', async () => {
  const { dir, file } = triageDir('career-ops-thin-evidence-', [{
    url: 'https://jobs.example.com/thin',
    company: 'Acme',
    title: 'Software Engineer, New Grad',
    location: 'Austin, TX',
    source: 'manual',
  }]);

  const result = await evaluateScanResults({
    target: dir,
    config: stubConfig(),
    files: [file],
    apply: true,
    skipLiveness: true,
    provider: 'test-provider',
    acknowledgeQuota: true,
    providerHandle: unknownGateProvider([]),
    candidateContext: NEW_GRAD_CONTEXT,
    fetchEvidence: async () => ({
      ok: true,
      source_type: 'manual',
      content: 'Software Engineer. Apply now. We build things.',
      title: 'Software Engineer, New Grad',
      liveness_state: 'YES',
      posted_at: new Date().toISOString(),
      method: 'page_text',
    }),
  });

  const row = result.results[0];
  assert.equal(row.status, 'COMMITTED');
  assert.equal(row.decision, 'REVIEW_REQUIRED');
  assert.equal(row.score, null);
  assert.equal(row.scorable, false);
});
