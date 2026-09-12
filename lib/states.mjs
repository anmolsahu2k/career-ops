import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function loadStateContract(path) {
  const document = yaml.load(readFileSync(path, 'utf8'));
  if (!document || !Array.isArray(document.states) || document.states.length === 0) {
    throw new Error('states.yml must contain a non-empty states array');
  }
  const canonicalStatuses = new Set();
  const canonicalIds = new Set();
  const aliases = new Map();
  for (const [index, state] of document.states.entries()) {
    const id = normalized(state?.id);
    const label = normalized(state?.label);
    if (!id || !label) throw new Error(`states.yml entry ${index + 1} requires id and label`);
    if (canonicalIds.has(id)) throw new Error(`states.yml contains duplicate id: ${id}`);
    if (canonicalStatuses.has(label)) throw new Error(`states.yml contains duplicate label: ${state.label}`);
    canonicalIds.add(id);
    canonicalStatuses.add(label);
    for (const aliasValue of state.aliases || []) {
      const alias = normalized(aliasValue);
      if (!alias) throw new Error(`states.yml ${state.id} contains an empty alias`);
      const prior = aliases.get(alias);
      if (prior && prior !== label) throw new Error(`states.yml alias ${alias} maps to multiple states`);
      aliases.set(alias, label);
    }
  }
  return { canonicalStatuses, canonicalIds, aliases };
}

export function isCanonicalStatus(value, contract) {
  const status = normalized(value);
  return contract.canonicalStatuses.has(status) || contract.aliases.has(status);
}
