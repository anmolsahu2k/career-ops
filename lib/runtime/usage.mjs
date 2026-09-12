export const USAGE_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'thinking_tokens',
  'cache_read_tokens',
  'total_tokens',
]);

const QUALITY_RANK = Object.freeze({
  UNAVAILABLE: 0,
  REPORTED_TOTAL_ONLY: 1,
  PARTIAL_COMPONENTS: 2,
  EXACT_COMPONENTS: 3,
});

function finiteToken(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

export function normalizeUsage(value = {}) {
  const usage = value && typeof value === 'object' ? value : {};
  const input = finiteToken(usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount, usage.inputTokens);
  const output = finiteToken(usage.output_tokens, usage.completion_tokens, usage.candidatesTokenCount, usage.outputTokens);
  const thinking = finiteToken(
    usage.thinking_tokens,
    usage.reasoning_tokens,
    usage.thoughtsTokenCount,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
  );
  const cacheRead = finiteToken(
    usage.cache_read_tokens,
    usage.cached_tokens,
    usage.cachedContentTokenCount,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
  );
  const reportedTotal = finiteToken(usage.total_tokens, usage.totalTokenCount, usage.totalTokens);
  const hasInput = input !== null;
  const hasOutput = output !== null;
  const hasComponents = hasInput || hasOutput || thinking !== null || cacheRead !== null;
  const total = reportedTotal ?? (hasInput || hasOutput ? (input || 0) + (output || 0) : 0);
  let measurementQuality = usage.measurement_quality;
  if (!Object.hasOwn(QUALITY_RANK, measurementQuality)) {
    measurementQuality = hasInput && hasOutput
      ? 'EXACT_COMPONENTS'
      : reportedTotal !== null && !hasComponents
        ? 'REPORTED_TOTAL_ONLY'
        : hasComponents
          ? 'PARTIAL_COMPONENTS'
          : 'UNAVAILABLE';
  }
  return {
    input_tokens: input || 0,
    output_tokens: output || 0,
    reasoning_tokens: thinking || 0,
    thinking_tokens: thinking || 0,
    cache_read_tokens: cacheRead || 0,
    total_tokens: total,
    measurement_quality: measurementQuality,
  };
}

export function addUsage(left = {}, right = {}) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  const populated = [a, b].filter(item => item.measurement_quality !== 'UNAVAILABLE');
  const measurementQuality = populated.length === 0
    ? 'UNAVAILABLE'
    : populated.reduce((lowest, item) => (
        QUALITY_RANK[item.measurement_quality] < QUALITY_RANK[lowest]
          ? item.measurement_quality
          : lowest
      ), populated[0].measurement_quality);
  return {
    ...Object.fromEntries(USAGE_FIELDS.map(name => [name, a[name] + b[name]])),
    measurement_quality: measurementQuality,
  };
}

export function divideUsage(value = {}, count = 1) {
  const usage = normalizeUsage(value);
  const divisor = Math.max(1, Number(count) || 1);
  return {
    ...Object.fromEntries(USAGE_FIELDS.map(name => [name, Math.ceil(usage[name] / divisor)])),
    measurement_quality: usage.measurement_quality,
  };
}

export function usageTotal(value = {}) {
  return normalizeUsage(value).total_tokens;
}
