import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { cpus, freemem, hostname, platform, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { record } from './util.mjs';

function findExecutable(command) {
  if (!command) return null;
  if (isAbsolute(command)) {
    try { accessSync(command, constants.X_OK); return command; } catch { return null; }
  }
  const extensions = platform() === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

function probeVersion(path) {
  if (!path) return { usable: false, version_probe: null };
  try {
    const output = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { usable: true, version_probe: output.slice(0, 240) || 'ok' };
  } catch (error) {
    return { usable: false, version_probe: String(error.stderr || error.message).trim().slice(0, 500) };
  }
}

export function observeEnvironment(config, { now = new Date() } = {}) {
  const providers = {};
  for (const [id, provider] of Object.entries(config.providers || {})) {
    const executable = provider.command?.[0];
    const commandPath = executable ? findExecutable(executable) : null;
    const commandProvider = provider.type === 'command' || provider.type?.endsWith('_cli');
    const configured = commandProvider
      ? Boolean(commandPath)
      : Boolean(provider.base_url);
    const probe = commandProvider ? probeVersion(commandPath) : { usable: configured, version_probe: null };
    const credentialPresent = provider.api_key_env ? Boolean(process.env[provider.api_key_env]) : null;
    const authenticationReady = provider.api_key_env && !provider.local_only ? credentialPresent : true;
    providers[id] = record('ProviderObservationV1', {
      provider_id: id,
      available: provider.enabled === true && configured && probe.usable && authenticationReady,
      configured,
      enabled: provider.enabled === true,
      usable: probe.usable,
      version_probe: probe.version_probe,
      credential_present: credentialPresent,
      billing_allowed: provider.type?.endsWith('_api') ? config.api_billing === true : null,
      command_path: commandPath,
      model_snapshot: provider.model_snapshot,
      checked_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      latency_ms: null,
    });
  }
  return {
    environment: record('EnvironmentObservationV1', {
      observed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      host_id: hostname(),
      platform: platform(),
      logical_cpus: cpus().length,
      memory_bytes: { total: totalmem(), free: freemem() },
    }),
    capability_profile: record('CapabilityProfileV1', {
      host_id: hostname(),
      observed_at: now.toISOString(),
      providers,
    }),
    provider_observations: Object.fromEntries(Object.entries(providers).map(([id, value]) => [id, {
      ...value,
      latency_ms: value.latency_ms ?? Number.MAX_SAFE_INTEGER,
    }])),
  };
}
