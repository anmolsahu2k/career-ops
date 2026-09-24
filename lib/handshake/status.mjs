/**
 * Handshake operator snapshot: config plus optional loopback CDP probe.
 * Does not attach Playwright and never closes Chrome tabs.
 */

import { record } from '../runtime/util.mjs';
import { diagnoseApplications } from '../applications/doctor.mjs';
import { applyScoreFloor } from '../applications/eligibility.mjs';
import { probeCdp, probeCdpCached, resolveMainProfileUserDataDir } from '../applications/chrome-cdp.mjs';
import { handshakeFilterSpec } from './filters.mjs';

const DEFAULT_PROVIDER = 'antigravity-gemini-flash-high';

export function handshakeConfigSnapshot(config = {}) {
  const selected = config && typeof config === 'object' ? config : {};
  const main = selected.applications?.main_profile || {};
  const enabled = main.enabled === true && Array.isArray(main.ats) && main.ats.includes('handshake');
  return {
    enabled,
    cdp_ok: false,
    logged_in: false,
    filters: handshakeFilterSpec(selected),
    apply_score_minimum: applyScoreFloor(selected, { ats: 'handshake' }),
    evaluate_provider: main.evaluate_provider || DEFAULT_PROVIDER,
    detail: enabled ? 'CDP not probed' : 'main_profile handshake disabled',
  };
}

export async function handshakeStatusSnapshot(config, { fetchImpl = fetch, timeoutMs = 1500, cached = true } = {}) {
  const base = handshakeConfigSnapshot(config);
  const main = config?.applications?.main_profile || {};
  if (!base.enabled || !main.cdp_url) return base;
  const probeFn = cached ? probeCdpCached : probeCdp;
  const userDataDir = resolveMainProfileUserDataDir(main);
  const probe = await probeFn(main.cdp_url, { fetchImpl, timeoutMs, userDataDir });
  return {
    ...base,
    cdp_ok: Boolean(probe.cdp_ok),
    logged_in: Boolean(probe.logged_in),
    handshake_tab_count: probe.handshake_tab_count || 0,
    attach: probe.attach || (probe.cdp_ok ? 'http' : null),
    detail: probe.detail || base.detail,
  };
}

export async function diagnoseHandshake(target, config, { fetchImpl = fetch } = {}) {
  const apply = diagnoseApplications(target, config);
  const handshake = await handshakeStatusSnapshot(config, { fetchImpl, cached: false, timeoutMs: 1500 });
  const checks = [...(apply.checks || [])];
  checks.push({
    ok: handshake.enabled,
    code: 'HANDSHAKE_MAIN_PROFILE',
    detail: handshake.enabled ? 'handshake is in main_profile.ats' : 'enable applications.main_profile.ats handshake',
  });
  checks.push({
    ok: handshake.cdp_ok,
    code: 'HANDSHAKE_CDP',
    detail: handshake.detail || (handshake.cdp_ok ? 'CDP live' : 'CDP down'),
  });
  checks.push({
    ok: handshake.logged_in || !handshake.cdp_ok,
    code: 'HANDSHAKE_LOGIN',
    detail: handshake.logged_in
      ? 'Handshake tab looks signed in'
      : handshake.cdp_ok
        ? 'Open a signed-in Handshake tab (or doctor will still run session login detection live)'
        : 'CDP down; login not checked',
  });
  const failed = checks.filter(item => !item.ok && item.code !== 'HANDSHAKE_LOGIN');
  return record('HandshakeDoctorReportV1', {
    ready: failed.length === 0 && handshake.enabled,
    checks,
    handshake,
    apply,
    summary: failed.length
      ? failed.map(item => `${item.code}: ${item.detail}`).join('; ')
      : handshake.detail || 'Handshake doctor ready',
  });
}
