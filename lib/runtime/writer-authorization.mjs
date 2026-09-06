import { hostname } from 'node:os';

function authorizationError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizedHost(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function assertWriterHost(config, { currentHost = hostname() } = {}) {
  const configuredHost = normalizedHost(config?.writer_host);
  if (!configuredHost) {
    throw authorizationError(
      'WRITER_HOST_NOT_CONFIGURED',
      'Runtime mutation requires a non-empty writer_host in the selected configuration',
    );
  }

  const observedHost = normalizedHost(currentHost);
  if (!observedHost) {
    throw authorizationError(
      'WRITER_HOST_IDENTITY_UNAVAILABLE',
      'Runtime mutation requires a non-empty operating-system host identity',
    );
  }

  if (observedHost !== configuredHost) {
    throw authorizationError(
      'WRITER_HOST_MISMATCH',
      `Runtime mutation is authorized only on writer_host ${config.writer_host}`,
      { configured_writer_host: config.writer_host, observed_host: currentHost },
    );
  }

  return { configured_writer_host: config.writer_host, observed_host: currentHost };
}
