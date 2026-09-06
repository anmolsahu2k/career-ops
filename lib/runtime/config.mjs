import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { CAPABILITY_CLASSES } from './constants.mjs';

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Runtime configuration must be an object');
  if (config.runtime_version !== 1) throw new Error('runtime_version must equal 1');
  if (config.api_billing !== false && config.api_billing !== true) throw new Error('api_billing must be explicitly true or false');
  if (config.subscription_overage !== false && config.subscription_overage !== true) throw new Error('subscription_overage must be explicitly true or false');
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
