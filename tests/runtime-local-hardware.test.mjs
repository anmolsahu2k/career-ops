import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionCases, runLocalHardwareQualification } from '../lib/runtime/local-hardware-qualification.mjs';
import { record } from '../lib/runtime/util.mjs';

test('local hardware qualification verifies extraction and never authorizes routing', async () => {
  const cases = buildExtractionCases(50);
  let index = 0;
  const provider = {
    complete: async request => {
      assert.equal(request.task.task_class, 'field_extraction');
      const expected = cases[index++].expected;
      return record('RawProviderResultV1', {
        task_id: request.task.task_id,
        provider_snapshot: {
          provider: 'local', model_vendor: 'local', model_family: 'qwen3',
          model_snapshot: 'qwen3:test', capability_class: 'EXTRACTION', execution_surface: 'test',
        },
        response: JSON.stringify(expected),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        latency_ms: 20,
        attempts: 1,
        capability_degradation: false,
      });
    },
  };
  const qualification = await runLocalHardwareQualification({
    provider,
    providerId: 'local',
    providerConfig: {
      local_only: true,
      model_vendor: 'local',
      model_snapshot: 'qwen3:test',
      capability_class: 'EXTRACTION',
      risk_ceiling: 'LOW',
      base_url: 'http://127.0.0.1:11434/v1',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{
        name: 'qwen3:test', model: 'qwen3:test', digest: 'digest',
        size: 2_500_000_000, size_vram: 2_500_000_000, context_length: 4096,
      }] }),
    }),
    now: new Date('2026-09-06T18:00:00.000Z'),
  });
  assert.equal(qualification.schema, 'LocalHardwareQualificationV1');
  assert.equal(qualification.sample_count, 50);
  assert.equal(qualification.metrics.exact_match_count, 50);
  assert.equal(qualification.metrics.gpu_residency_ratio, 1);
  assert.equal(qualification.qualified, true);
  assert.equal(qualification.routing_authorized, false);
});

test('local hardware qualification rejects capability or endpoint expansion', async () => {
  const provider = { complete: async () => { throw new Error('must not run'); } };
  await assert.rejects(runLocalHardwareQualification({
    provider,
    providerId: 'remote',
    providerConfig: {
      local_only: false,
      model_vendor: 'remote',
      capability_class: 'EXTRACTION',
      risk_ceiling: 'LOW',
      base_url: 'https://example.com/v1',
    },
  }), /local-only/);
  await assert.rejects(runLocalHardwareQualification({
    provider,
    providerId: 'local',
    providerConfig: {
      local_only: true,
      model_vendor: 'local',
      capability_class: 'STANDARD',
      risk_ceiling: 'MEDIUM',
      base_url: 'http://127.0.0.1:11434/v1',
    },
  }), /EXTRACTION capability and LOW risk/);
});
