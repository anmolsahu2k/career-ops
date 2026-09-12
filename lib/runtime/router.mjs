import { CAPABILITY_RANK, NO_PROVIDER_REASONS } from './constants.mjs';
import { assertTaskEnvelope } from './contracts.mjs';
import { isoNow, record } from './util.mjs';

const RISK_RANK = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, CONSEQUENTIAL: 3 });

function validObservation(provider, nowMs) {
  if (!provider.observation) return false;
  const expiresAt = Date.parse(provider.observation.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

export function effectiveReserveRatio(pool, defaults = {}, nowMs = Date.now()) {
  const minimum = Number(pool.minimum_reserve_ratio ?? defaults.minimum_ratio ?? 0.2);
  if ((pool.adaptive_reserve_enabled ?? defaults.adaptive) !== true) return minimum;
  let reserve = Math.max(minimum, Number(pool.adaptive_reserve_ratio || 0));
  const windowStart = Date.parse(pool.window_started_at || '');
  const resetAt = Date.parse(pool.reset_at || '');
  if (Number.isFinite(windowStart) && Number.isFinite(resetAt) && resetAt > windowStart && nowMs > windowStart) {
    const elapsed = Math.min(1, (nowMs - windowStart) / (resetAt - windowStart));
    const used = Math.max(0, 1 - Number(pool.remaining_ratio));
    if (elapsed > 0) {
      const projectedUse = used / elapsed;
      const sustainableUse = 1 - minimum;
      reserve = Math.max(reserve, Math.min(0.5, minimum + Math.max(0, projectedUse - sustainableUse) * 0.25));
    }
  }
  return reserve;
}

function quotaAvailable(provider, pools, defaults, nowMs) {
  const pool = pools[provider.resource_pool];
  if (!pool || pool.quota_state === 'UNKNOWN') return false;
  if (provider.model_vendor !== 'local') {
    const expiresAt = Date.parse(pool.expires_at || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
  }
  const remaining = Number(pool.remaining_ratio);
  const minimum = effectiveReserveRatio(pool, defaults, nowMs);
  const emergency = Number(pool.emergency_reserve_ratio ?? 0.05);
  const reserve = pool.emergency_authorized ? emergency : minimum;
  return Number.isFinite(remaining) && remaining > reserve;
}

function auditIndependent(provider, auditOf) {
  if (!auditOf) return true;
  return provider.model_vendor !== auditOf.model_vendor && provider.execution_surface !== auditOf.execution_surface;
}

export function routeTask(task, runtimeConfig, {
  now = isoNow(),
  auditOf = null,
  requireIndependentAudit = task.minimum_capability_class === 'INDEPENDENT_AUDIT',
  // A bounded workflow may deliberately restrict fallback to a provider family
  // with separately approved data handling and quota economics.  This is a
  // restriction, never a way to bypass ordinary qualification or quota gates.
  providerIds = null,
} = {}) {
  assertTaskEnvelope(task);
  const failures = new Map(NO_PROVIDER_REASONS.map(reason => [reason, 0]));
  const preferred = Array.isArray(providerIds) && providerIds.length
    ? providerIds.filter(id => typeof id === 'string' && id) : null;
  const preferenceRank = new Map((preferred || []).map((id, index) => [id, index]));
  const providers = Object.entries(runtimeConfig.providers || {})
    .filter(([id]) => !preferred || preferenceRank.has(id))
    .map(([id, provider]) => ({ id, ...provider }));
  const pools = runtimeConfig.resource_pools || {};
  const nowMs = Date.parse(now);
  const eligible = [];

  for (const provider of providers) {
    if (!provider.enabled || provider.available === false
      || (provider.type?.endsWith('_api') && runtimeConfig.api_billing !== true)) {
      failures.set('PROVIDER_UNAVAILABLE', failures.get('PROVIDER_UNAVAILABLE') + 1);
      continue;
    }
    if (!(provider.capability_class in CAPABILITY_RANK)
      || CAPABILITY_RANK[provider.capability_class] < CAPABILITY_RANK[task.minimum_capability_class]) {
      failures.set('NO_CAPABILITY', failures.get('NO_CAPABILITY') + 1);
      continue;
    }
    if (!(task.required_capabilities || []).every(item => (provider.capabilities || []).includes(item))) {
      failures.set('NO_CAPABILITY', failures.get('NO_CAPABILITY') + 1);
      continue;
    }
    if (provider.qualification?.qualified !== true
      || provider.qualification.lifecycle_state !== 'production'
      || Number(provider.qualification.confidence_interval_95?.lower || 0) < 0.90) {
      failures.set('QUALITY_FLOOR_UNMET', failures.get('QUALITY_FLOOR_UNMET') + 1);
      continue;
    }
    if (RISK_RANK[provider.risk_ceiling || 'LOW'] < RISK_RANK[task.risk]) {
      failures.set('RISK_TOO_HIGH', failures.get('RISK_TOO_HIGH') + 1);
      continue;
    }
    if (requireIndependentAudit && !auditIndependent(provider, auditOf)) {
      failures.set('AUDIT_INDEPENDENCE_UNAVAILABLE', failures.get('AUDIT_INDEPENDENCE_UNAVAILABLE') + 1);
      continue;
    }
    if (!validObservation(provider, nowMs)) {
      failures.set('OBSERVATION_EXPIRED', failures.get('OBSERVATION_EXPIRED') + 1);
      continue;
    }
    if (provider.observation.available !== true) {
      failures.set('PROVIDER_UNAVAILABLE', failures.get('PROVIDER_UNAVAILABLE') + 1);
      continue;
    }
    if (!quotaAvailable(provider, pools, runtimeConfig.reserves || {}, nowMs)) {
      failures.set('QUOTA_UNAVAILABLE', failures.get('QUOTA_UNAVAILABLE') + 1);
      continue;
    }
    eligible.push(provider);
  }

  eligible.sort((a, b) => {
    const preference = (preferenceRank.get(a.id) ?? Infinity) - (preferenceRank.get(b.id) ?? Infinity);
    if (preference !== 0) return preference;
    const latency = Number(a.observation.latency_ms || Infinity) - Number(b.observation.latency_ms || Infinity);
    if (latency !== 0) return latency;
    return Number(a.cost_rank || Infinity) - Number(b.cost_rank || Infinity);
  });
  if (eligible.length) {
    const selected = eligible[0];
    return record('RouteDecisionV1', {
      task_id: task.task_id,
      routed_at: now,
      result: 'ROUTED',
      provider_id: selected.id,
      model_snapshot: selected.model_snapshot,
      capability_class: selected.capability_class,
      capability_degradation: false,
      resource_pool: selected.resource_pool,
      audit_independence: requireIndependentAudit ? 'FULL' : 'NOT_REQUIRED',
    });
  }
  const precedence = [
    'NO_CAPABILITY', 'QUALITY_FLOOR_UNMET', 'RISK_TOO_HIGH',
    'AUDIT_INDEPENDENCE_UNAVAILABLE', 'QUOTA_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE', 'OBSERVATION_EXPIRED',
  ];
  const reason = precedence.find(item => failures.get(item) > 0) || 'PROVIDER_UNAVAILABLE';
  return record('RouteDecisionV1', {
    task_id: task.task_id,
    routed_at: now,
    result: 'NO_ELIGIBLE_PROVIDER',
    reason,
    disposition: reason === 'PROVIDER_UNAVAILABLE' || reason === 'QUOTA_UNAVAILABLE' ? 'DEFERRED' : 'REVIEW_REQUIRED',
    failures: Object.fromEntries([...failures].filter(([, count]) => count > 0)),
  });
}

export function routeProfileTask(task, runtimeConfig, profileId, {
  mode = 'individual',
  now = isoNow(),
} = {}) {
  assertTaskEnvelope(task);
  const profile = runtimeConfig.routing_profiles?.[profileId];
  if (!profile) throw new Error(`Unknown routing profile: ${profileId}`);
  if (!['individual', 'bulk'].includes(mode)) throw new Error('Profile route mode must be individual or bulk');
  const stageNames = mode === 'bulk' ? ['triage', 'judgment', 'escalation'] : ['judgment', 'escalation'];
  const stages = stageNames.map(stage => {
    const providerId = profile[stage]?.provider;
    if (!runtimeConfig.providers?.[providerId]) throw new Error(`Unknown ${stage} provider in routing profile ${profileId}`);
    const stageTask = stage === 'triage'
      ? { ...task, risk: 'MEDIUM', minimum_capability_class: 'STANDARD' }
      : task;
    const decision = routeTask(stageTask, {
      ...runtimeConfig,
      providers: { [providerId]: runtimeConfig.providers[providerId] },
    }, { now });
    return {
      stage,
      authority: profile[stage].authority,
      conditional: stage === 'escalation',
      provider_id: providerId,
      route: decision,
    };
  });
  return record('ProfileRoutePlanV1', {
    task_id: task.task_id,
    profile_id: profileId,
    mode,
    triage_skipped: mode === 'individual',
    deterministic_policy_authoritative: true,
    stages,
  });
}
