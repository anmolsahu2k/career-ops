import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { CAPABILITY_CLASSES } from './constants.mjs';

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Runtime configuration must be an object');
  if (config.runtime_version !== 1) throw new Error('runtime_version must equal 1');
  if (config.api_billing !== false && config.api_billing !== true) throw new Error('api_billing must be explicitly true or false');
  if (config.subscription_overage !== false && config.subscription_overage !== true) throw new Error('subscription_overage must be explicitly true or false');
  if (config.applications !== undefined) {
    const applications = config.applications;
    if (!applications || typeof applications !== 'object') throw new Error('applications must be an object');
    if (applications.enabled !== undefined && typeof applications.enabled !== 'boolean') throw new Error('applications.enabled must be boolean');
    if (applications.auto_after_scan !== undefined && typeof applications.auto_after_scan !== 'boolean') throw new Error('applications.auto_after_scan must be boolean');
    if (applications.auto_submit !== undefined && typeof applications.auto_submit !== 'boolean') throw new Error('applications.auto_submit must be boolean');
    if (applications.auto_submit === true && applications.enabled !== true) throw new Error('applications.auto_submit requires applications.enabled');
    if (applications.time_zone !== undefined) {
      if (typeof applications.time_zone !== 'string' || !applications.time_zone.trim()) throw new Error('applications.time_zone must be an IANA time zone');
      try { new Intl.DateTimeFormat('en-US', { timeZone: applications.time_zone }); }
      catch { throw new Error('applications.time_zone must be an IANA time zone'); }
    }
    if (applications.main_profile !== undefined) {
      const mainProfile = applications.main_profile;
      if (!mainProfile || typeof mainProfile !== 'object' || typeof mainProfile.enabled !== 'boolean'
        || typeof mainProfile.cdp_url !== 'string' || !Array.isArray(mainProfile.ats)
        || mainProfile.ats.some(ats => !['linkedin', 'handshake'].includes(ats))) {
        throw new Error('applications.main_profile requires enabled, loopback cdp_url, and LinkedIn/Handshake ats only');
      }
      if (mainProfile.enabled) {
        let url;
        try { url = new URL(mainProfile.cdp_url); } catch { throw new Error('applications.main_profile.cdp_url must be a loopback URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
          throw new Error('applications.main_profile.cdp_url must be a loopback URL');
        }
      }
    }
    if (applications.hosted_fallback_providers !== undefined) {
      if (!Array.isArray(applications.hosted_fallback_providers)
        || applications.hosted_fallback_providers.some(id => typeof id !== 'string' || !/^antigravity-/i.test(id) || !config.providers?.[id])) {
        throw new Error('applications.hosted_fallback_providers must name configured Antigravity providers only');
      }
    }
    if (applications.local_prose !== undefined) {
      const localProse = applications.local_prose;
      if (!localProse || typeof localProse !== 'object'
        || typeof localProse.enabled !== 'boolean'
        || typeof localProse.canary_only !== 'boolean'
        || typeof localProse.provider !== 'string') {
        throw new Error('applications.local_prose requires enabled, canary_only, and provider');
      }
    }
  }
  for (const [id, provider] of Object.entries(config.providers || {})) {
    if (!CAPABILITY_CLASSES.includes(provider.capability_class)) throw new Error(`Provider ${id} has an invalid capability_class`);
    if (provider.local_only && provider.base_url) {
      const url = new URL(provider.base_url);
      if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error(`Local provider ${id} must bind to loopback`);
    }
    if (provider.type?.endsWith('_api') && provider.enabled && config.api_billing !== true) {
      throw new Error(`API provider ${id} cannot be enabled while api_billing is false`);
    }
  }
  for (const [id, profile] of Object.entries(config.routing_profiles || {})) {
    for (const stage of ['triage', 'judgment', 'escalation']) {
      if (!config.providers?.[profile?.[stage]?.provider]) {
        throw new Error(`Routing profile ${id} has an unknown ${stage} provider`);
      }
    }
    if (profile.triage.authority !== 'RANK_ONLY') {
      throw new Error(`Routing profile ${id} triage authority must be RANK_ONLY`);
    }
    const share = Number(profile.escalation.max_share);
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      throw new Error(`Routing profile ${id} escalation max_share must be 0-1`);
    }
  }
  return config;
}

export function loadRuntimeConfig(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Runtime configuration not found: ${resolved}`);
  return validateConfig(yaml.load(readFileSync(resolved, 'utf8')));
}

export function mergeRuntimeState(config, state = {}) {
  const providers = {};
  for (const [id, provider] of Object.entries(config.providers || {})) {
    providers[id] = { ...provider, observation: state.provider_observations?.[id] || provider.observation };
  }
  const resourcePools = {};
  for (const [id, pool] of Object.entries(config.resource_pools || {})) {
    resourcePools[id] = { ...pool, ...(state.resource_pools?.[id] || {}) };
  }
  return { ...config, providers, resource_pools: resourcePools };
}
