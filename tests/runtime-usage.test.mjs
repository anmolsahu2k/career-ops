import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWithProvider } from '../lib/runtime/orchestrator.mjs';
import { normalizeUsage } from '../lib/runtime/usage.mjs';
import { record } from '../lib/runtime/util.mjs';
import { makeResponse, makeTask } from './runtime-fixtures.mjs';

test('usage normalization preserves OpenAI-compatible reasoning and cache components', () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 30,
    total_tokens: 130,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 20 },
  }), {
    input_tokens: 100,
    output_tokens: 30,
    reasoning_tokens: 20,
    thinking_tokens: 20,
    cache_read_tokens: 40,
    total_tokens: 130,
    measurement_quality: 'EXACT_COMPONENTS',
  });
});

test('usage normalization supports Antigravity Gemini envelopes and total-only Codex reports', () => {
  assert.deepEqual(normalizeUsage({
    promptTokenCount: 90,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 4,
    cachedContentTokenCount: 20,
    totalTokenCount: 104,
  }), {
    input_tokens: 90,
    output_tokens: 10,
    reasoning_tokens: 4,
    thinking_tokens: 4,
    cache_read_tokens: 20,
    total_tokens: 104,
    measurement_quality: 'EXACT_COMPONENTS',
  });
  assert.deepEqual(normalizeUsage({ total_tokens: 77, measurement_quality: 'REPORTED_TOTAL_ONLY' }), {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 77,
    measurement_quality: 'REPORTED_TOTAL_ONLY',
  });
});

test('repair usage is attributed per attempt and accumulated without inventing token splits', async () => {
  const task = makeTask();
  let calls = 0;
  const provider = {
    snapshot: () => ({ provider: 'fixture', model_snapshot: 'fixture', capability_class: 'CONSEQUENTIAL' }),
    async complete(_request, { attempt }) {
      calls++;
      return record('RawProviderResultV1', {
        task_id: task.task_id,
        provider_snapshot: this.snapshot(),
        response: attempt === 1 ? {} : makeResponse(),
        usage: attempt === 1
          ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          : { total_tokens: 23, measurement_quality: 'REPORTED_TOTAL_ONLY' },
        latency_ms: attempt,
        attempts: attempt,
        capability_degradation: false,
      });
    },
  };
  const result = await evaluateWithProvider({ task, evidenceContent: { 'EV-1': 'Validated job posting evidence.' }, provider });
  assert.equal(calls, 2);
  assert.equal(result.rawResult.usage.total_tokens, 38);
  assert.equal(result.rawResult.usage.measurement_quality, 'REPORTED_TOTAL_ONLY');
  assert.deepEqual(result.rawResult.usage_trace.map(item => [item.request, item.usage.total_tokens, item.schema_result]), [
    ['INITIAL', 15, 'INVALID'],
    ['REPAIR', 23, 'VALID'],
  ]);
});
