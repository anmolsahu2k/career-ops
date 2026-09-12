import { assertRawProviderResult, assertTaskEnvelope } from './contracts.mjs';
import { normalizeEvaluation } from './normalize.mjs';
import { decide } from './policy-engine.mjs';
import { buildProviderRequest } from './prepare.mjs';
import { retainValidationFailure } from './retention.mjs';
import { sanitizePresentation } from './sanitizer.mjs';
import { record } from './util.mjs';
import { addUsage, normalizeUsage } from './usage.mjs';

export function evaluateResponse(task, response, providerSnapshot = null, { now } = {}) {
  assertTaskEnvelope(task);
  const snapshot = providerSnapshot || {
    provider: 'manual', model_snapshot: 'manual-user-selected',
    capability_class: task.minimum_capability_class, execution_surface: 'manual',
  };
  const rawResult = record('RawProviderResultV1', {
    task_id: task.task_id,
    provider_snapshot: snapshot,
    response,
    usage: {},
    latency_ms: 0,
    attempts: 1,
    capability_degradation: false,
  });
  assertRawProviderResult(rawResult);
  const normalized = normalizeEvaluation(task, rawResult, now ? { now } : undefined);
  const decision = decide(task, normalized, now ? { now } : undefined);
  const presentation = sanitizePresentation(normalized.presentation_content, decision);
  return { task, rawResult, normalized, decision, presentation };
}

export async function evaluateWithProvider({ task, evidenceContent, provider, retentionTarget = null }) {
  assertTaskEnvelope(task);
  const request = buildProviderRequest(task, evidenceContent);
  let lastError;
  let lastRaw;
  let accumulatedUsage = {};
  let accumulatedLatency = 0;
  const usageTrace = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await provider.complete(request, {
        attempt,
        repair: attempt === 2 ? { error: lastError.code || lastError.name, message: lastError.message } : null,
      });
      const attemptUsage = normalizeUsage(raw.usage);
      accumulatedUsage = addUsage(accumulatedUsage, attemptUsage);
      accumulatedLatency += Number(raw.latency_ms || 0);
      const trace = {
        attempt,
        request: attempt === 1 ? 'INITIAL' : 'REPAIR',
        usage: attemptUsage,
        latency_ms: Number(raw.latency_ms || 0),
        schema_result: 'PENDING',
      };
      usageTrace.push(trace);
      lastRaw = {
        ...raw,
        usage: accumulatedUsage,
        usage_trace: usageTrace,
        latency_ms: accumulatedLatency,
        attempts: attempt,
      };
      assertRawProviderResult(lastRaw);
      const normalized = normalizeEvaluation(task, lastRaw);
      const decision = decide(task, normalized);
      const presentation = sanitizePresentation(normalized.presentation_content, decision);
      trace.schema_result = 'VALID';
      return { task, rawResult: lastRaw, normalized, decision, presentation };
    } catch (error) {
      if (usageTrace.length) usageTrace.at(-1).schema_result = 'INVALID';
      lastError = error;
      if (attempt === 2) {
        if (retentionTarget && lastRaw) retainValidationFailure(retentionTarget, lastRaw, error);
        error.attempts = attempt;
        error.usage = accumulatedUsage;
        error.usageTrace = usageTrace;
        error.latencyMs = accumulatedLatency;
        throw error;
      }
    }
  }
  throw lastError;
}
