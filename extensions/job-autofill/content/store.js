/**
 * store.js — chrome.storage.local access. The stored object and the
 * export/import JSON are the same shape (see README).
 */

import { normalizeKey, isSensitiveQuestion, looksOpaqueId, readPath, isEphemeralApplicationQuestion, isEphemeralAnswerEntry, dropEphemeralAnswers } from './matcher.js';

export const SCHEMA_VERSION = 1;

export const DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  profile: {
    name: { first: '', last: '', full: '' },
    email: '',
    emails: { personal: '', school: '' },
    phone: { raw: '', countryCode: '', national: '' },
    location: { city: '', state: '', stateAbbr: '', country: '', raw: '' },
    address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '' },
    links: { linkedin: '', github: '', portfolio: '' },
    identity: {
      citizenship: '', dob: '', visaStatus: '', highSchool: '',
      primaryLanguage: '', secondaryLanguage: '',
    },
    // Stored locally like any other field. Surfaced separately in the review UI.
    demographics: {
      gender: '', genderIdentity: '', race: '', hispanicLatino: '', veteran: '', disability: '',
      // This is deliberately limited by the matcher to explicit demographic
      // survey consent checkboxes. It never grants consent to general terms,
      // privacy policies, arbitration, or other company agreements.
      demographicSurveyConsent: '',
    },
    education: [],
    work: [],
  },
  answers: {},
  settings: {
    fuzzyThreshold: 0.75,
    resumeNote: 'SDE / backend / infra roles -> SDE resume PDF. AI / ML / DS roles -> MLE resume PDF.',
    // Off by default. Filling only when asked is the safer default, so this
    // stays an opt-in the user turns on from the popup or the options page.
    autoFillOnLoad: false,
  },
};

function nowIso() {
  return new Date().toISOString();
}

async function persistAnswersIfDropped(storedAnswers) {
  const answers = dropEphemeralAnswers(storedAnswers || {});
  if (Object.keys(answers).length !== Object.keys(storedAnswers || {}).length) {
    await chrome.storage.local.set({ answers });
  }
  return answers;
}

async function persistJobAnswersIfDropped() {
  const { jobAnswers } = await chrome.storage.local.get('jobAnswers');
  if (!jobAnswers || typeof jobAnswers !== 'object') return;
  const next = Object.fromEntries(
    Object.entries(jobAnswers).filter(([, entry]) => !isEphemeralAnswerEntry(entry)),
  );
  if (Object.keys(next).length !== Object.keys(jobAnswers).length) {
    await chrome.storage.local.set({ jobAnswers: next });
  }
}

export async function loadAll() {
  const stored = await chrome.storage.local.get(null);
  const answers = await persistAnswersIfDropped(stored.answers || {});
  await persistJobAnswersIfDropped();
  return {
    ...DEFAULTS,
    ...stored,
    profile: { ...DEFAULTS.profile, ...(stored.profile || {}) },
    settings: { ...DEFAULTS.settings, ...(stored.settings || {}) },
    answers,
  };
}

export async function saveAll(data) {
  await chrome.storage.local.set({
    schemaVersion: SCHEMA_VERSION,
    profile: data.profile,
    answers: data.answers,
    settings: data.settings,
  });
}

/**
 * The resume, held as base64 so it survives chrome.storage (which takes JSON,
 * not Blobs) and can be rebuilt into a File at fill time.
 *
 * Kept OUT of saveAll's write set on purpose: saveAll rewrites profile, answers
 * and settings together, and a multi-megabyte PDF riding along on every answer
 * capture would be written hundreds of times a session.
 */
export async function getResume() {
  const { resume, resumes } = await chrome.storage.local.get(['resume', 'resumes']);
  return resumes?.default || resume || null;
}

export async function getResumeFor(kind = 'default') {
  const { resume, resumes } = await chrome.storage.local.get(['resume', 'resumes']);
  return resumes?.[kind] || (kind === 'default' ? resume || null : null);
}

export async function setResume(resume, kind = 'default') {
  const { resumes = {} } = await chrome.storage.local.get('resumes');
  await chrome.storage.local.set({ resumes: { ...resumes, [kind]: resume }, ...(kind === 'default' ? { resume } : {}) });
}

export async function clearResume(kind = 'default') {
  const { resumes = {} } = await chrome.storage.local.get('resumes');
  const next = { ...resumes };
  delete next[kind];
  await chrome.storage.local.set({ resumes: next });
  if (kind === 'default') await chrome.storage.local.remove('resume');
}

/**
 * Write one or more settings without touching the answer bank.
 *
 * `saveAll` rewrites profile, answers and settings together, so using it for a
 * single toggle from the popup would write back whatever answers were loaded a
 * moment earlier and lose anything the capture loop stored in between.
 */
export async function updateSettings(patch) {
  const { settings } = await loadAll();
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getProfileValue(path) {
  const { profile } = await loadAll();
  const v = readPath(profile, path);
  return v == null ? '' : String(v);
}

/**
 * Insert or update one learned answer.
 * A captured/manual answer always beats a seeded one — the user's own typing
 * is the ground truth this whole extension exists to collect.
 */
export async function upsertAnswer({ rawQuestion, answer, answerType, board, source = 'captured', origin = null }) {
  const key = normalizeKey(rawQuestion);
  if (!key || !answer || !String(answer).trim()) return null;
  if (isEphemeralApplicationQuestion(rawQuestion) || isEphemeralApplicationQuestion(key)) return null;
  // An opaque widget id is never a usable answer.
  if (looksOpaqueId(answer)) return null;

  const data = await loadAll();
  const existing = data.answers[key];

  if (existing && existing.source !== 'seed' && source === 'seed') return existing;

  const entry = existing
    ? { ...existing }
    : {
        key,
        questions: [],
        answer: '',
        answerType: answerType || 'text',
        boards: [],
        origins: [],
        source,
        sensitive: isSensitiveQuestion(rawQuestion),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        useCount: 0,
      };

  entry.answer = String(answer).trim();
  entry.answerType = answerType || entry.answerType;
  entry.source = source;
  entry.updatedAt = nowIso();
  if (rawQuestion && !entry.questions.includes(rawQuestion)) entry.questions.push(rawQuestion);
  if (board && !entry.boards.includes(board)) entry.boards.push(board);

  // Where this answer was last given. Keeps the most recent few so the review
  // page can show which posting an answer came from, newest first.
  if (origin?.url) {
    entry.origins = [
      { ...origin, at: nowIso() },
      ...(entry.origins || []).filter(o => o.url !== origin.url),
    ].slice(0, 5);
  }

  data.answers[key] = entry;
  await saveAll(data);
  return entry;
}

/** Essays are specific to a job.  Keeping them in a separate, URL-keyed bank
 * prevents a company-tailored answer from silently appearing on another form.
 * Promotion to the global answer bank remains an explicit options-page action. */
export async function upsertJobScopedAnswer({ rawQuestion, answer, answerType = 'textarea', board, origin = null, source = 'manual' }) {
  if (!origin?.url) return null;
  if (isEphemeralApplicationQuestion(rawQuestion)) return null;
  const key = `${origin.url.split('#')[0]}::${normalizeKey(rawQuestion)}`;
  const { jobAnswers = {} } = await chrome.storage.local.get('jobAnswers');
  const entry = {
    key, rawQuestion, answer: String(answer || '').trim(), answerType, board, source,
    origin: { ...origin, at: nowIso() }, updatedAt: nowIso(),
  };
  if (!entry.answer || looksOpaqueId(entry.answer)) return null;
  await chrome.storage.local.set({ jobAnswers: { ...jobAnswers, [key]: entry } });
  return entry;
}

export async function recordUse(key) {
  const data = await loadAll();
  const entry = data.answers[key];
  if (!entry) return;
  entry.useCount = (entry.useCount || 0) + 1;
  await saveAll(data);
}

export async function deleteAnswer(key) {
  const data = await loadAll();
  delete data.answers[key];
  await saveAll(data);
}

/**
 * Merge an exported/seeded file back in.
 * Without `replaceAll`, existing captured/manual answers survive: a re-run of
 * the seed script must never silently undo a correction typed on a real form.
 */
export async function importData(json, { replaceAll = false } = {}) {
  if (!json || typeof json !== 'object') throw new Error('Import file is not a JSON object');
  if (json.schemaVersion && json.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`File uses schemaVersion ${json.schemaVersion}, this extension understands ${SCHEMA_VERSION}`);
  }

  if (replaceAll) {
    const merged = {
      ...DEFAULTS,
      ...json,
      profile: { ...DEFAULTS.profile, ...(json.profile || {}) },
      settings: { ...DEFAULTS.settings, ...(json.settings || {}) },
      answers: dropEphemeralAnswers(json.answers || {}),
    };
    await saveAll(merged);
    await persistJobAnswersIfDropped();
    return { answers: Object.keys(merged.answers).length, replaced: true };
  }

  const data = await loadAll();
  if (json.profile) data.profile = { ...data.profile, ...json.profile };
  if (json.settings) data.settings = { ...data.settings, ...json.settings };

  let added = 0;
  let updated = 0;
  for (const [key, incoming] of Object.entries(dropEphemeralAnswers(json.answers || {}))) {
    const existing = data.answers[key];
    if (!existing) {
      data.answers[key] = incoming;
      added++;
      continue;
    }
    const existingIsUserOwned = existing.source === 'captured' || existing.source === 'manual';
    const incomingIsUserOwned = incoming.source === 'captured' || incoming.source === 'manual';
    const incomingIsNewer = new Date(incoming.updatedAt || 0) > new Date(existing.updatedAt || 0);
    if (!existingIsUserOwned || (incomingIsUserOwned && incomingIsNewer)) {
      data.answers[key] = { ...existing, ...incoming };
      updated++;
    }
  }
  data.answers = dropEphemeralAnswers(data.answers || {});
  await saveAll(data);
  await persistJobAnswersIfDropped();
  return { added, updated, replaced: false };
}

/** Drop rotating codes, salary prompts, and other one-shot answers from local storage. */
export async function purgeEphemeralStoredAnswers() {
  const data = await loadAll();
  data.answers = dropEphemeralAnswers(data.answers || {});
  await saveAll(data);
  await persistJobAnswersIfDropped();
  return { answers: Object.keys(data.answers).length };
}

export async function exportData() {
  const data = await loadAll();
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: data.profile,
    answers: data.answers,
    settings: data.settings,
  };
}
