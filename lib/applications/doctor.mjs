import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ATS_MATURITY, CERTIFIED_ATS, enabledAts } from './ats.mjs';
import { applicationQueuePreview } from './enqueue-summary.mjs';
import { record } from '../runtime/util.mjs';

const EXTENSION = resolve('extensions/job-autofill');
const EXTENSION_SEED = resolve(EXTENSION, 'data', 'answers.json');

function check(ok, code, detail) {
  return { ok: Boolean(ok), code, detail };
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
  if (apps.gmail_otp?.enabled === true) {
    checks.push(check(Boolean(apps.gmail_otp.python_command), 'GMAIL_OTP',
      `gmail OTP enabled via ${apps.gmail_otp.python_command || 'python'}`));
  } else {
    checks.push(check(true, 'GMAIL_OTP', 'gmail OTP disabled (use --pause-for-auth or apply mfa-code)'));
  }
  if (apps.main_profile?.enabled === true) {
    checks.push(check(Boolean(apps.main_profile.cdp_url), 'MAIN_PROFILE_CDP',
      apps.main_profile.cdp_url
        ? `main_profile CDP: ${apps.main_profile.cdp_url}`
        : 'main_profile.enabled without cdp_url'));
  }
  checks.push(check(apps.auto_submit !== true || apps.enabled === true, 'AUTO_SUBMIT',
    apps.auto_submit === true
      ? 'auto_submit true — CLI still requires --submit'
      : 'auto_submit false (dry-run / ready-to-submit only)'));

  const preview = applicationQueuePreview(target);
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
