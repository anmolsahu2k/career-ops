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

// A dropped socket or a 429 is not the same failure as invalid JSON: the first
// deserves the same request again after a pause, the second deserves a repair
// prompt. Treating them alike burned a candidate row on every network hiccup.
const TRANSIENT_ERROR_PATTERNS = [
  /timed?\s?out/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /eai_again/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /\b429\b/,
  /rate.?limit/i,
  /\b50[0234]\b/,
  /overloaded/i,
  /temporarily unavailable/i,
  /service unavailable/i,
];

function isTransientProviderError(error) {
  const text = `${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`;
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function completeWithBackoff(provider, request, options, { retries, baseDelayMs }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await provider.complete(request, options);
    } catch (error) {
      lastError = error;
      if (!isTransientProviderError(error) || attempt === retries) throw error;
      await sleep(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

export async function evaluateWithProvider({
  task,
  evidenceContent,
  provider,
  retentionTarget = null,
  transientRetries = 2,
  retryBaseMs = 1500,
}) {
  assertTaskEnvelope(task);
  const request = buildProviderRequest(task, evidenceContent);
  let lastError;
  let lastRaw;
  let accumulatedUsage = {};
  let accumulatedLatency = 0;
  const usageTrace = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // A transient failure produces no provider result, so it does not consume
      // one of the two contract-visible attempts.
      if (attempt === 2) await sleep(retryBaseMs);
      const raw = await completeWithBackoff(provider, request, {
        attempt,
        repair: attempt === 2 && !isTransientProviderError(lastError)
          ? { error: lastError.code || lastError.name, message: lastError.message }
          : null,
      }, { retries: Math.max(0, Number(transientRetries) || 0), baseDelayMs: Math.max(100, Number(retryBaseMs) || 1500) });
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
