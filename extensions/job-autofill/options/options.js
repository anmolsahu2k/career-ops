import {
  loadAll, saveAll, deleteAnswer, importData, exportData,
  getResume, setResume, clearResume,
} from '../content/store.js';
import { looksOpaqueId } from '../content/matcher.js';

const $ = sel => document.querySelector(sel);
let state = null;

const PROFILE_FIELDS = [
  ['name.first', 'First name'],
  ['name.last', 'Last name'],
  ['name.full', 'Full name'],
  ['email', 'Email'],
  ['emails.school', 'School email'],
  ['phone.raw', 'Phone'],
  ['location.city', 'City'],
  ['location.state', 'State'],
  ['location.stateAbbr', 'State abbreviation'],
  ['location.country', 'Country'],
  ['location.raw', 'Location (one line)'],
  ['address.line1', 'Street address'],
  ['address.line2', 'Apt / unit'],
  ['address.postalCode', 'ZIP / postal code'],
  ['links.linkedin', 'LinkedIn URL'],
  ['links.github', 'GitHub URL'],
  ['links.portfolio', 'Portfolio URL'],
  ['links.twitter', 'Twitter / X URL'],
  ['identity.citizenship', 'Country of citizenship'],
  ['identity.dob', 'Date of birth'],
  ['identity.visaStatus', 'Visa status'],
  ['identity.highSchool', 'High school'],
  ['identity.primaryLanguage', 'Primary language'],
  ['identity.secondaryLanguage', 'Secondary language'],
];

// Kept apart from the grid above so the review page never renders demographic
// answers unless they are asked for.
const DEMOGRAPHIC_FIELDS = [
  ['demographics.gender', 'Gender'],
  ['demographics.genderIdentity', 'Gender identity'],
  ['demographics.race', 'Race / ethnicity'],
  ['demographics.hispanicLatino', 'Hispanic or Latino'],
  ['demographics.veteran', 'Veteran status'],
  ['demographics.disability', 'Disability status'],
  ['demographics.demographicSurveyConsent', 'Consent to demographic surveys'],
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function set(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Where an answer came from: platform, employer, and the posting itself. */
function sourceCell(e) {
  const latest = (e.origins || [])[0];
  const lines = [];

  if (e.source === 'seed') lines.push('seeded from repo');
  else if (e.source === 'manual') lines.push('edited by you');
  else lines.push('captured');

  if (latest) {
    const board = latest.board && latest.board !== 'generic' ? latest.board : '';
    const where = [latest.company, board].filter(Boolean).join(' &middot; ');
    if (where) lines.push(`<strong>${escapeHtml(where)}</strong>`);
    if (latest.title) lines.push(`<span title="${escapeHtml(latest.title)}">${escapeHtml(latest.title.slice(0, 34))}</span>`);
    lines.push(`<a href="${escapeHtml(latest.url)}" target="_blank" rel="noreferrer">open posting</a>`);
    if (latest.at) lines.push(new Date(latest.at).toISOString().slice(0, 10));
    const more = (e.origins || []).length - 1;
    if (more > 0) lines.push(`+${more} other posting${more === 1 ? '' : 's'}`);
  } else if ((e.boards || []).length) {
    lines.push(escapeHtml(e.boards.join(', ')));
  }

  lines.push(`used ${e.useCount || 0}&times;`);
  return lines.join('<br>');
}

// ── answers table ──────────────────────────────────────────────────

function renderAnswers() {
  const query = $('#search').value.trim().toLowerCase();
  const showSensitive = $('#showSensitive').checked;
  const tbody = $('#answers tbody');

  const entries = Object.values(state.answers)
    .filter(e => showSensitive || !e.sensitive)
    .filter(e => {
      if (!query) return true;
      const hay = [e.key, e.answer, ...(e.questions || [])].join(' ').toLowerCase();
      return hay.includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const total = Object.keys(state.answers).length;
  const hiddenCount = total - Object.values(state.answers).filter(e => showSensitive || !e.sensitive).length;
  $('#count').textContent = `${entries.length} shown of ${total}${hiddenCount ? ` (${hiddenCount} EEO hidden)` : ''}`;

  $('#answersEmpty').hidden = total > 0;

  tbody.innerHTML = entries.map(e => `
    <tr data-key="${escapeHtml(e.key)}" class="${e.sensitive ? 'sensitive' : ''}">
      <td class="q">${escapeHtml(e.questions?.[0] || e.key)}</td>
      <td class="a"><textarea rows="${e.answerType === 'textarea' ? 4 : 1}">${escapeHtml(e.answer)}</textarea></td>
      <td class="meta">${sourceCell(e)}</td>
      <td class="actions">
        <button class="save">Save</button>
        <button class="danger delete">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    const key = tr.dataset.key;
    tr.querySelector('.save').addEventListener('click', async () => {
      const value = tr.querySelector('textarea').value.trim();
      if (!value) return toast('Answer cannot be empty. Use Delete instead.');
      state.answers[key].answer = value;
      state.answers[key].source = 'manual';
      state.answers[key].updatedAt = new Date().toISOString();
      await saveAll(state);
      toast('Saved.');
    });
    tr.querySelector('.delete').addEventListener('click', async () => {
      if (!confirm(`Delete the saved answer for:\n\n${state.answers[key].questions?.[0] || key}`)) return;
      await deleteAnswer(key);
      delete state.answers[key];
      renderAnswers();
      toast('Deleted.');
    });
  });
}

// ── profile ────────────────────────────────────────────────────────

function fieldInput([path, label]) {
  return `
    <div class="field">
      <label for="p_${path}">${label}</label>
      <input id="p_${path}" data-path="${path}" value="${escapeHtml(get(state.profile, path) || '')}">
    </div>`;
}

function renderProfile() {
  $('#profileGrid').innerHTML = PROFILE_FIELDS.map(fieldInput).join('');
  $('#demographicGrid').innerHTML = DEMOGRAPHIC_FIELDS.map(fieldInput).join('');

  $('#eduRows').innerHTML = (state.profile.education || []).map((e, i) => `
    <div class="row-card">
      <strong>Education ${i + 1}</strong>
      <div class="grid" style="margin-top:6px">
        ${['school', 'degreeRaw', 'field', 'gpa', 'startMonth', 'endMonth'].map(k => `
          <div class="field">
            <label>${k}</label>
            <input data-edu="${i}" data-key="${k}" value="${escapeHtml(e[k] || '')}">
          </div>`).join('')}
      </div>
    </div>
  `).join('') || '<div class="empty">No education entries. Run the seed script.</div>';

  $('#workRows').innerHTML = (state.profile.work || []).map((w, i) => `
    <div class="row-card">
      <strong>Work ${i + 1}</strong>
      <div class="grid" style="margin-top:6px">
        ${['company', 'title', 'location', 'startMonth', 'endMonth'].map(k => `
          <div class="field">
            <label>${k}</label>
            <input data-work="${i}" data-key="${k}" value="${escapeHtml(w[k] || '')}">
          </div>`).join('')}
      </div>
    </div>
  `).join('') || '<div class="empty">No work entries. Run the seed script.</div>';
}

$('#saveProfile').addEventListener('click', async () => {
  document.querySelectorAll('#profileGrid input[data-path], #demographicGrid input[data-path]').forEach(input => {
    set(state.profile, input.dataset.path, input.value.trim());
  });
  document.querySelectorAll('[data-edu]').forEach(input => {
    const row = state.profile.education[Number(input.dataset.edu)];
    if (row) row[input.dataset.key] = input.value.trim();
  });
  document.querySelectorAll('[data-work]').forEach(input => {
    const row = state.profile.work[Number(input.dataset.work)];
    if (row) row[input.dataset.key] = input.value.trim();
  });
  await saveAll(state);
  toast('Profile saved.');
});

// ── settings ───────────────────────────────────────────────────────

function renderSettings() {
  $('#threshold').value = state.settings.fuzzyThreshold;
  $('#resumeNote').value = state.settings.resumeNote;
  $('#autoFillOnLoad').checked = state.settings.autoFillOnLoad === true;
}

$('#saveSettings').addEventListener('click', async () => {
  const t = Number($('#threshold').value);
  if (!(t >= 0.5 && t <= 1)) return toast('Threshold must be between 0.5 and 1.');
  state.settings.fuzzyThreshold = t;
  state.settings.resumeNote = $('#resumeNote').value.trim();
  state.settings.autoFillOnLoad = $('#autoFillOnLoad').checked;
  await saveAll(state);
  toast('Settings saved.');
});

// ── import / export ────────────────────────────────────────────────

$('#export').addEventListener('click', async () => {
  const data = await exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'answers.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported to Downloads.');
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const res = await importData(json, { replaceAll: $('#replaceAll').checked });
    state = await loadAll();
    renderAll();
    toast(res.replaced ? `Replaced: ${res.answers} answers.` : `Imported: ${res.added} new, ${res.updated} updated.`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
  event.target.value = '';
});

// ── boot ───────────────────────────────────────────────────────────

function renderAll() {
  renderAnswers();
  renderProfile();
  renderSettings();
  refreshCleanup();
}

$('#search').addEventListener('input', renderAnswers);
$('#showSensitive').addEventListener('change', renderAnswers);

/**
 * Purge answers whose value is a widget's internal id rather than text.
 * An earlier build fell back to input.value when it could not read a radio's
 * label, which on Workday stored 32-char GUIDs.
 */
/**
 * Labels that repeat once per education or employment block. A captured answer
 * under one of these keys came from whichever block was filled last, so it will
 * happily put a bachelor's dates on a master's entry. These are now served from
 * the indexed profile instead, and captures are blocked, but answers saved
 * before that fix are still on disk and still wrong.
 */
const REPEATED_BLOCK_KEYS = new Set([
  'start date year', 'start date month', 'end date year', 'end date month',
  'start date', 'end date', 'school', 'degree', 'discipline', 'major',
  'company', 'employer', 'job title', 'title', 'position title', 'from', 'to',
]);

/**
 * Keys that were never questions: an option's own text, or a widget's status
 * text, captured before the grouping and label fixes landed.
 *
 * Ashby gave every checkbox in a "select all that apply" block its own name, so
 * one question arrived as one field per option and ticking a box filed the
 * option text as the question. Lever's location label swallowed the
 * autocomplete's "Loading" node while the search ran, so the same field was
 * keyed two different ways within one pass.
 *
 * Listed rather than inferred. The tempting rule — an entry whose question and
 * answer are the same string — is exactly what a consent checkbox looks like,
 * and that one is a real answer worth keeping.
 */
const OPTION_TEXT_KEYS = new Set([
  'asian or asian american', 'bisexual', 'lesbian', 'gay', 'queer',
  'he him', 'he/him', 'she her', 'she/her', 'they them', 'they/them',
  'current location loading',
]);

function junkKeys() {
  return Object.values(state.answers)
    .filter(e => looksOpaqueId(e.answer)
      || (e.source === 'captured' && REPEATED_BLOCK_KEYS.has(e.key))
      || (e.source === 'captured' && OPTION_TEXT_KEYS.has(e.key)))
    .map(e => e.key);
}

function refreshCleanup() {
  const n = junkKeys().length;
  const btn = $('#cleanup');
  btn.hidden = n === 0;
  btn.textContent = `Remove ${n} unusable answer${n === 1 ? '' : 's'}`;
}

$('#cleanup').addEventListener('click', async () => {
  const keys = junkKeys();
  if (!keys.length) return;
  const preview = keys.slice(0, 5).map(k => `  ${state.answers[k].questions?.[0] || k}`).join('\n');
  if (!confirm(`Delete ${keys.length} answer(s) that cannot be reused — an internal widget id, a label every education or employment block repeats, or an option's text filed as a question?\n\n${preview}${keys.length > 5 ? '\n  ...' : ''}`)) return;
  for (const k of keys) {
    await deleteAnswer(k);
    delete state.answers[k];
  }
  renderAnswers();
  refreshCleanup();
  toast(`Removed ${keys.length}.`);
});

state = await loadAll();
renderAll();

/* ---- Resume ---------------------------------------------------------- */

/**
 * chrome.storage takes JSON, not Blobs, so the PDF is held as base64 and
 * rebuilt into a File at fill time. Encoded in chunks because spreading a
 * multi-megabyte byte array into String.fromCharCode overflows the call stack.
 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function renderResume() {
  const resume = await getResume();
  const state = $('#resumeState');
  const clear = $('#resumeClear');
  if (resume?.name) {
    state.textContent = `${resume.name} (${Math.round(resume.size / 1024)} KB)`;
    clear.hidden = false;
  } else {
    state.textContent = 'none stored — file uploads will be left for you';
    clear.hidden = true;
  }
}

$('#resumePick').addEventListener('click', () => $('#resumeFile').click());

$('#resumeFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    // chrome.storage.local caps at ~10MB with unlimitedStorage absent, and
    // base64 inflates by a third, so an oversized PDF is refused here rather
    // than failing opaquely on write.
    if (file.size > 4 * 1024 * 1024) throw new Error('PDF is over 4MB');
    await setResume({
      name: file.name,
      type: file.type || 'application/pdf',
      size: file.size,
      base64: toBase64(await file.arrayBuffer()),
    });
    await renderResume();
    toast(`Resume stored: ${file.name}`);
  } catch (err) {
    toast(`Could not store resume: ${err.message}`);
  }
  event.target.value = '';
});

$('#resumeClear').addEventListener('click', async () => {
  await clearResume();
  await renderResume();
  toast('Resume removed.');
});

renderResume();
