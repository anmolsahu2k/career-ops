import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function assertStrictObjects(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'object' && value.properties) {
    assert.equal(value.additionalProperties, false, `${path} must reject additional properties`);
    assert.deepEqual(
      [...(value.required || [])].sort(),
      Object.keys(value.properties).sort(),
      `${path} must require every declared property for strict structured output`,
    );
  }
  for (const [key, child] of Object.entries(value)) assertStrictObjects(child, `${path}.${key}`);
}

for (const name of ['provider-response.v1.schema.json', 'qualification-batch-response.v1.schema.json']) {
  test(`${name} remains compatible with strict structured-output validators`, () => {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/runtime/${name}`, import.meta.url), 'utf8'));
    assertStrictObjects(schema);
  });
}
