import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWriterHost } from '../lib/runtime/writer-authorization.mjs';

test('writer authorization accepts the configured host case-insensitively', () => {
  const result = assertWriterHost(
    { writer_host: 'AnmolDaPredator' },
    { currentHost: 'anmoldapredator' },
  );
  assert.equal(result.configured_writer_host, 'AnmolDaPredator');
});

test('writer authorization rejects a different host', () => {
  assert.throws(
    () => assertWriterHost({ writer_host: 'AnmolDaPredator' }, { currentHost: 'mac-backup' }),
    error => error.code === 'WRITER_HOST_MISMATCH'
      && error.details.configured_writer_host === 'AnmolDaPredator'
      && error.details.observed_host === 'mac-backup',
  );
});

test('writer authorization rejects missing configured or observed identity', () => {
  assert.throws(
    () => assertWriterHost({}, { currentHost: 'AnmolDaPredator' }),
    error => error.code === 'WRITER_HOST_NOT_CONFIGURED',
  );
  assert.throws(
    () => assertWriterHost({ writer_host: 'AnmolDaPredator' }, { currentHost: '' }),
    error => error.code === 'WRITER_HOST_IDENTITY_UNAVAILABLE',
  );
});
