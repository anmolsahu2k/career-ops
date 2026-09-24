import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ATS_MATURITY, CERTIFIED_ATS, enabledAts } from './ats.mjs';
import { applicationQueuePreview } from './enqueue-summary.mjs';
import { record } from '../runtime/util.mjs';

const EXTENSION = resolve('extensions/job-autofill');
const EXTENSION_SEED = resolve(EXTENSION, 'data', 'answers.json');
const OTP_READER = resolve('scripts/stage-ats-otp.py');
const GMAIL_MCP = join(homedir(), '.gmail-mcp');
export const GMAIL_OTP_TESTING_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

function check(ok, code, detail, extra = {}) {
  return { ok: Boolean(ok), code, detail, ...extra };
}

export function gmailOtpCredentialLifetime(payload = {}, { now = Date.now(), fileMtimeMs = null } = {}) {
  let issued = Date.parse(payload?.authorized_at || '');
  let source = 'authorized_at';
  if (!Number.isFinite(issued)) {
    issued = Number(fileMtimeMs);
    source = 'file_mtime';
  }
  if (!Number.isFinite(issued)) {
    return {
      expired: true,
      error: 'authorized_at_missing',
      source: 'missing',
      age_seconds: 0,
      expires_in_seconds: 0,
      testing_refresh_days: 7,
    };
  }
  const remaining = GMAIL_OTP_TESTING_REFRESH_MS - (now - issued);
  const expired = remaining <= 0;
  return {
    expired,
    error: expired ? 'token_expired' : null,
    source,
    age_seconds: Math.max(0, Math.floor((now - issued) / 1000)),
    expires_in_seconds: expired ? 0 : Math.floor(remaining / 1000),
    testing_refresh_days: 7,
  };
}

export function formatGmailOtpRemaining(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value >= 86400) return `${Math.floor(value / 86400)}d`;
  if (value >= 3600) return `${Math.ceil(value / 3600)}h`;
  return `${Math.max(1, Math.ceil(value / 60))}m`;
}

function gmailOtpCredsPath() {
  return process.env.CAREER_OPS_GMAIL_OTP_CREDS
    ? resolve(process.env.CAREER_OPS_GMAIL_OTP_CREDS)
    : join(GMAIL_MCP, 'personal-credentials.json');
}

function gmailOtpKeysPath() {
  return process.env.CAREER_OPS_GMAIL_OTP_KEYS
    ? resolve(process.env.CAREER_OPS_GMAIL_OTP_KEYS)
    : join(GMAIL_MCP, 'gcp-oauth.keys.json');
}

function readGmailOtpLifetime(credsPath) {
  if (!existsSync(credsPath)) {
    return { expired: true, error: 'credentials_unreadable', source: 'missing', expires_in_seconds: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(credsPath, 'utf8'));
    const authorizedAt = parsed && typeof parsed === 'object' ? parsed.authorized_at : null;
    return gmailOtpCredentialLifetime(
      { authorized_at: authorizedAt },
      { fileMtimeMs: statSync(credsPath).mtimeMs },
    );
  } catch {
    return { expired: true, error: 'credentials_unreadable', source: 'unreadable', expires_in_seconds: 0 };
  }
}

function gmailOtpCheck(apps) {
  const policy = apps.gmail_otp || {};
  if (policy.enabled !== true) {
    return check(true, 'GMAIL_OTP', 'gmail OTP disabled (use --pause-for-auth or apply mfa-code)');
  }
  const python = String(policy.python_command || '').trim();
  if (!python) return check(false, 'GMAIL_OTP', 'gmail OTP enabled but python_command is empty');
  if (!existsSync(OTP_READER)) return check(false, 'GMAIL_OTP', 'scripts/stage-ats-otp.py is missing');
  const creds = gmailOtpCredsPath();
  const keys = gmailOtpKeysPath();
  if (!existsSync(creds) || !existsSync(keys)) {
    return check(false, 'GMAIL_OTP', 'Gmail MCP credentials missing under ~/.gmail-mcp');
  }
  const greenhouse = Array.isArray(policy.sender_domains?.greenhouse)
    ? policy.sender_domains.greenhouse.filter(domain => /^[a-z0-9.-]+$/i.test(String(domain)))
    : [];
  if (!greenhouse.length) {
    return check(false, 'GMAIL_OTP', 'gmail OTP enabled without greenhouse sender domains');
  }
  const lifetime = readGmailOtpLifetime(creds);
  if (lifetime.expired) {
    return check(false, 'GMAIL_OTP', 'Gmail OTP Testing-app token expired after 7 days. Re-run python scripts/auth-gmail-otp.py', {
      expires_in_seconds: 0,
    });
  }
  return check(true, 'GMAIL_OTP', `gmail OTP ready for Greenhouse via ${python}; Testing-app re-auth in ${formatGmailOtpRemaining(lifetime.expires_in_seconds)}`, {
    expires_in_seconds: lifetime.expires_in_seconds,
  });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Read-only readiness checklist for the autonomous applier. Never mutates
 * attempts, tracker rows, or the Chrome profile.
 */
export function diagnoseApplications(target, config = {}) {
  const apps = config.applications || {};
  const checks = [];
  checks.push(check(apps.enabled === true, 'APPLICATIONS_ENABLED',
    apps.enabled === true ? 'applications.enabled is true' : 'applications.enabled is false (checked-in default)'));
  checks.push(check(Boolean(apps.chrome_profile_dir), 'CHROME_PROFILE',
    apps.chrome_profile_dir ? `profile: ${apps.chrome_profile_dir}` : 'applications.chrome_profile_dir is empty'));
  if (apps.chrome_profile_dir) {
    checks.push(check(existsSync(resolve(apps.chrome_profile_dir)), 'CHROME_PROFILE_EXISTS',
      existsSync(resolve(apps.chrome_profile_dir))
        ? 'Chrome profile directory exists'
        : `missing profile directory: ${apps.chrome_profile_dir}`));
  }
  checks.push(check(existsSync(EXTENSION), 'EXTENSION_PRESENT',
    existsSync(EXTENSION) ? 'job-autofill extension directory present' : 'extensions/job-autofill missing'));
  checks.push(check(existsSync(EXTENSION_SEED), 'ANSWER_SEED',
    existsSync(EXTENSION_SEED)
      ? 'extensions/job-autofill/data/answers.json present'
      : 'run node scripts/seed-autofill.mjs to create answers.json'));
  for (const kind of ['sde', 'mle']) {
    const path = apps.resumes?.[kind] || '';
    if (!path) {
      checks.push(check(false, `RESUME_${kind.toUpperCase()}`, `applications.resumes.${kind} is empty`));
      continue;
    }
    const resolved = resolve(path);
    const present = existsSync(resolved);
    checks.push(check(present, `RESUME_${kind.toUpperCase()}`,
      present ? `${kind}: ${sha256File(resolved).slice(0, 12)}… (${resolved})` : `missing resume file: ${resolved}`));
  }
  const allowed = [...enabledAts(config)];
  checks.push(check(allowed.length > 0, 'SUPPORTED_ATS',
    allowed.length ? `enabled ATS: ${allowed.join(', ')}` : 'supported_ats empty or none certified'));
  const prose = apps.local_prose || {};
  if (prose.enabled === true) {
    checks.push(check(prose.canary_only === true || prose.qualified === true, 'LOCAL_PROSE_GATE',
      prose.canary_only === true
        ? 'local prose is canary-only (cannot submit)'
        : prose.qualified === true
          ? 'local prose marked qualified'
          : 'local prose enabled without canary_only or qualified'));
    if (prose.cover_letters === true) {
      checks.push(check(prose.qualified === true || prose.canary_only === true, 'COVER_LETTER_OPT_IN',
        'cover_letters enabled; ensure qualification artifact exists before relying on it'));
    }
  } else {
    checks.push(check(true, 'LOCAL_PROSE_GATE', 'local prose disabled'));
  }
  checks.push(gmailOtpCheck(apps));
  if (apps.main_profile?.enabled === true) {
    checks.push(check(Boolean(apps.main_profile.cdp_url), 'MAIN_PROFILE_CDP',
      apps.main_profile.cdp_url
        ? `main_profile CDP: ${apps.main_profile.cdp_url}`
        : 'main_profile.enabled without cdp_url'));
    if (Array.isArray(apps.main_profile.ats) && apps.main_profile.ats.includes('handshake')) {
      const floor = Number(apps.main_profile.apply_score_minimum);
      const handshakeFloor = Number.isFinite(floor) ? floor : 3.5;
      checks.push(check(true, 'HANDSHAKE_APPLY_FLOOR',
        `Handshake live apply floor ${handshakeFloor.toFixed(1)}; dedicated-profile enqueue stays at 4.0`));
    }
  }
  checks.push(check(apps.auto_submit !== true || apps.enabled === true, 'AUTO_SUBMIT',
    apps.auto_submit === true
      ? 'auto_submit true — CLI still requires --submit'
      : 'auto_submit false (dry-run / ready-to-submit only)'));

  const preview = applicationQueuePreview(target, { config });
  const failed = checks.filter(item => !item.ok);
  return record('ApplicationDoctorReportV1', {
    ready: failed.length === 0,
    checks,
    queue: {
      eligible_count: preview.eligible_count,
      near_miss_count: preview.near_misses.length,
      near_misses: preview.near_misses.slice(0, 25),
    },
    ats_maturity: Object.fromEntries(
      [...CERTIFIED_ATS, 'linkedin', 'handshake', 'generic'].map(id => [id, ATS_MATURITY[id]]),
    ),
    summary: failed.length
      ? failed.map(item => `${item.code}: ${item.detail}`).join('; ')
      : 'Apply stack looks configured; review queue near-misses before run',
  });
}
