/**
 * phase-models.mjs — models each Career-Ops web tab actually invokes.
 * Display-only. Deterministic policy still does not branch on a model name.
 */

import { hostedFallbackProviderIds } from '../applications/answers.mjs';

export const EVALUATE_JOB_PROVIDERS = Object.freeze({
  evaluate_judge: 'antigravity-gemini-flash-high',
  evaluate_sweep: 'cerebras-gpt-oss-120b',
  evaluate_overflow: 'groq-llama-70b',
});

function titleCaseSnapshot(value = '') {
  return String(value)
    .replace(/[:_]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, char => char.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bLlm\b/g, 'LLM')
    .trim();
}

export function providerDisplayName(config, providerId) {
  if (!providerId) return 'none';
  const provider = config?.providers?.[providerId];
  const snapshot = provider?.model_snapshot;
  if (snapshot && !/^replace-after/i.test(String(snapshot))) return titleCaseSnapshot(snapshot);
  return titleCaseSnapshot(String(providerId).replace(/^(?:antigravity|codex)-/, ''));
}

function entry(role, { model = 'none', provider_id = null, detail = '' } = {}) {
  return { role, model, provider_id, detail };
}

/** Models the Discovery, Evaluate, and Tracker tabs invoke from this UI. */
export function funnelPhaseModels(config = {}) {
  const judge = EVALUATE_JOB_PROVIDERS.evaluate_judge;
  const sweep = EVALUATE_JOB_PROVIDERS.evaluate_sweep;
  const overflow = EVALUATE_JOB_PROVIDERS.evaluate_overflow;
  const hosted = hostedFallbackProviderIds(config || {})[0] || null;
  const localEnabled = config.applications?.local_prose?.enabled === true;
  const local = localEnabled && typeof config.applications?.local_prose?.provider === 'string'
    ? config.applications.local_prose.provider
    : null;
  const coverLocal = localEnabled && config.applications?.local_prose?.cover_letters === true;
  const coverId = coverLocal ? local : hosted;
  const salaryId = local || hosted;
  return {
    discovery: [
      entry('Scan', { model: 'none', detail: 'deterministic, zero tokens' }),
      entry('Evaluate row', { model: providerDisplayName(config, judge), provider_id: judge }),
      entry('Handshake eval', { model: providerDisplayName(config, judge), provider_id: judge, detail: 'same judge as Evaluate' }),
    ],
    evaluate: [
      entry('Plan', { model: 'none', detail: 'liveness and prune, no LLM' }),
      entry('Judge', { model: providerDisplayName(config, judge), provider_id: judge }),
      entry('Sweep', { model: providerDisplayName(config, sweep), provider_id: sweep }),
      entry('Overflow', { model: providerDisplayName(config, overflow), provider_id: overflow }),
    ],
    tracker: [
      entry('Fill / submit', { model: 'none', detail: 'deterministic matcher and submissionGate' }),
      entry('Cover letter', {
        model: coverId ? providerDisplayName(config, coverId) : 'none',
        provider_id: coverId,
        detail: coverLocal ? 'qualified local prose' : 'Antigravity hosted fallback',
      }),
      entry('Salary preference', {
        model: salaryId ? providerDisplayName(config, salaryId) : 'none',
        provider_id: salaryId,
        detail: local ? 'qualified local prose' : (hosted ? 'Antigravity hosted fallback' : 'no prose provider'),
      }),
    ],
  };
}
