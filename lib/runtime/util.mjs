import { createHash, randomUUID } from 'node:crypto';

export class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuntimeError('NON_FINITE_NUMBER', 'Canonical JSON cannot contain non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
  if (!isPlainObject(value)) throw new RuntimeError('NON_JSON_VALUE', 'Canonical JSON accepts plain JSON values only');
  if (seen.has(value)) throw new RuntimeError('CYCLIC_VALUE', 'Canonical JSON cannot contain cycles');
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new RuntimeError('POISON_KEY', `Unsafe object key: ${key}`);
    }
    if (value[key] === undefined) throw new RuntimeError('UNDEFINED_VALUE', `Undefined value at ${key}`);
    output[key] = canonicalize(value[key], seen);
  }
  seen.delete(value);
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function record(schema, fields = {}) {
  return { schema, schema_version: 1, ...fields };
}

export function newId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function isoNow(clock = Date) {
  return new clock().toISOString();
}

export function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return slug || fallback;
}

export function safeMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '/')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function assert(condition, code, message, details = {}) {
  if (!condition) throw new RuntimeError(code, message, details);
}
