/**
 * main.js — orchestrator. Handles popup messages, runs the fill pass, and
 * keeps the capture loop armed.
 */

import {
  detectFields, hasUserValue, isCredentialScreen, readValue, TEXTISH_KINDS,
} from './engine.js';
import {
  findAnswer, matchOption, canonicalFieldFor, fitsKind, readPath, splitMulti,
  mapSanctionsChoice, restrictedCountryStoredAnswer, mapNoneLikeChoice,
  namedSchoolAffiliationAnswer, careerFairContactAnswer, graduationSeasonAnswer,
  commuteOrRelocateOption, localOrRelocateAnswer, exportControlCountryAnswer, normalizeKey,
  startAvailabilityAnswer, usPersonExportAnswer, f1OptCptCurrentAnswer, graduationDateAnswer,
  workAuthorizationStatusAnswer, citizenshipStatusAnswer, citizenshipOtherExplainAnswer,
  securityClearanceAnswer, namedEmployerHistoryAnswer, currentlyEmployedAtNamedOrgAnswer,
  militaryReserveOrGuardAnswer, usGovernmentEmploymentAnswer, relativesAtNamedOrgAnswer,
  applicationAffirmationAnswer,
  completedEducationLevelAnswer, workLocationInterestAnswer, remoteWorkStateAnswer,
  relocationPreferenceAnswer, futureOpportunityDeclineAnswer,
  travelPercentageAnswer, operationalSmsOptInAnswer,
  degreeGpaAnswer, standardizedTestAnswer,
  essentialFunctionsAnswer,
  isEphemeralApplicationQuestion, isOtpVerificationQuestion,
  filledValueMatches,
} from './matcher.js';
import {
  fillText, fillNativeSelect, fillRadio, fillCheckbox, fillListbox, fillCombobox, simulateTyping,
  fillDateParts, fillFileInput, isResumeInput, attachRequiredComboboxOptions, setNativeValue,
} from './filler.js';
import { loadAll, recordUse, getResumeFor } from './store.js';
import { detectBoard } from './adapters/index.js';
import { fieldDescriptors, navigationState, isOptionalMarketingConsent, riskCategory, mapFutureOpportunityChoice } from './application-descriptors.js';
import { armCapture } from './capture.js';
import {
  markFilled, markUnknown, markFailed, markLearned, clearMark, clearMarks, showPanel, showCaptured,
} from './panel.js';

const adapter = detectBoard(location.href);

// MV3 workers are demand-started. The headed runner seeds through the worker
// itself, so a mounted content script wakes it without performing any form action.
chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});

/**
 * control -> every value we put in it, so capture never learns our own fill.
 *
 * A set, and claimed BEFORE the write, for two reasons. `fillText` blurs, which
 * fires focusout synchronously, so capture ran and stored our own value as a
 * user answer before the write was even recorded. And a widget often commits
 * something other than what we asked for ("Pittsburgh, Pennsylvania, United
 * States" goes in, "Pittsburgh, PA, USA" comes back), so one string is not
 * enough to recognise our own work. Learning our own pick would be worse than
 * useless: a wrong guess would come back as a user-blessed answer that outranks
 * the profile.
 */
const written = new Map();

/**
 * True while a fill is running, so capture records state but learns nothing.
 *
 * Declared up here because `armCapture` runs its first scan synchronously and
 * that scan reads this flag: leaving the declaration further down put it in the
 * temporal dead zone, and the arm-time scan died with a ReferenceError. Nothing
 * looked broken, because an unhandled rejection just loses that one scan.
 */
let filling = false;

function noteWritten(control, value) {
  if (!written.has(control)) written.set(control, new Set());
  written.get(control).add(String(value));
}

/** True when this control holds a value we put there, rather than the user's. */
function holdsOurValue(field) {
  return written.get(field.control)?.has(readValue(field)) ?? false;
}
/** control -> FieldInfo for fields flagged orange, so they can flip green. */
const unknownFields = new Map();

armCapture({
  adapter,
  weWrote: (el, value) => written.get(el)?.has(String(value)) ?? false,
  isFilling: () => filling,
  onLearned: (el, entry) => {
    const field = unknownFields.get(el);
    if (field) {
      markLearned(field);
      unknownFields.delete(el);
    }
    // Keyed by the question, not the element: React swaps the node out when a
    // value changes, so an element-keyed row is unfindable exactly when there
    // is something to report.
    showCaptured(entry.key, entry.answer);
  },
  // A profile-backed question we abstained on is worth learning: the stored
  // value did not map onto this form's options, and without this it would be
  // answered by hand on every application.
  wasUnresolved: (el) => unknownFields.has(el),
  onProfileField: (el, key) => {
    // Identity fields are never learned. Saying so, and where the value does
    // live, beats a row that sits there looking like capture failed.
    showCaptured(key, 'profile field, edit it in Options', { learned: false });
  },
});

/** Enough of a control's identity to fix a board's label resolution offline. */
function describeControl(el) {
  if (!el) return null;
  const labelledBy = el.getAttribute('aria-labelledby');
  return {
    tag: el.tagName,
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    automationId: el.getAttribute('data-automation-id') || '',
    id: el.id || '',
    name: el.getAttribute('name') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    hasPopup: el.getAttribute('aria-haspopup') || '',
    labelledByTexts: labelledBy
      ? labelledBy.split(/\s+/).filter(Boolean)
          .map(id => (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
      : [],
    parentAutomationId: el.closest('[data-automation-id]')?.getAttribute('data-automation-id') || '',
    // Ashby renders controls with no id or name at all, so diagnostics need a
    // positional handle to click them.
    domPath: cssPath(el),
  };
}

/** Shortest unambiguous CSS path to an element. */
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const parent = node.parentElement;
    if (!parent) { parts.unshift(node.tagName.toLowerCase()); break; }
    const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${index})` : node.tagName.toLowerCase());
    node = parent;
  }
  return parts.join(' > ');
}

function baseDetect(fields) {
  return {
    ok: true,
    board: adapter.id,
    boardLabel: adapter.label,
    fieldCount: fields.length,
    skipped: adapter.skipPage?.(location.href) === true || isCredentialScreen(),
    url: location.href,
  };
}

async function uploadedFileReadback(fields) {
  const uploads = [];
  for (const field of fields) {
    if (field.kind !== 'file') continue;
    const file = field.control?.files?.[0];
    if (!file) continue;
    let sha256 = null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* A missing digest is fail-closed in the runtime gate. */ }
    uploads.push({
      field_id: fieldDescriptors([field])[0].field_id,
      is_resume: isResumeInput(field.control, field.rawLabel),
      name: file.name,
      size: file.size,
      sha256,
    });
  }
  return uploads;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'detect') {
    const fields = detectFields(document, adapter);
    if (msg.verbose) {
      // Explain each field's resolution so a board that fills badly can be
      // diagnosed without guessing which layer gave up.
      loadAll().then(data => {
        const threshold = data.settings.fuzzyThreshold ?? 0.75;
        sendResponse({
          ...baseDetect(fields),
          fields: fields.map(f => {
            const r = resolveValue(f, data, threshold);
            return {
              rawLabel: f.rawLabel,
              kind: f.kind,
              labelSource: f.labelSource,
              normKey: f.normKey,
              optionCount: f.options.length,
              resolvedFrom: r?.from || null,
              value: r ? String(r.value).slice(0, 40) : null,
              debug: describeControl(f.control),
            };
          }),
        });
      });
      return true;
    }
    const response = baseDetect(fields);
    // The message is delivered to every frame, but the sender only ever sees
    // the first reply. Embedded boards (a Greenhouse iframe inside a company
    // careers page) put the real form in a subframe while the host frame has a
    // stray search box, so an empty frame answering first would report the
    // wrong counts. Frames with nothing to fill yield briefly and let a frame
    // that actually found fields win the race.
    if (fields.length > 0) {
      sendResponse(response);
      return false;
    }
    setTimeout(() => sendResponse(response), 250);
    return true;
  }

  if (msg?.type === 'fill') {
    // Same frame race as detect: a frame with nothing to fill must not be the
    // one whose report reaches the popup.
    const empty = detectFields(document, adapter).length === 0;
    const respond = report => (empty ? setTimeout(() => sendResponse(report), 250) : sendResponse(report));
    runFill().then(respond).catch(err => respond({ ok: false, error: String(err) }));
    return true; // async response
  }

  if (msg?.type === 'inspect') {
    const fields = detectFields(document, adapter);
    attachRequiredComboboxOptions(fields, adapter)
      .then(ready => sendResponse({
        ...baseDetect(ready), fields: fieldDescriptors(ready), navigation: navigationState(document),
      }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (msg?.type === 'readback') {
    const fields = detectFields(document, adapter);
    Promise.all([attachRequiredComboboxOptions(fields, adapter), uploadedFileReadback(fields)])
      .then(([ready, files]) => sendResponse({
        ...baseDetect(ready), fields: fieldDescriptors(ready), files, navigation: navigationState(document),
      }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (msg?.type === 'fillOverrides') {
    const fields = detectFields(document, adapter);
    const descriptors = fieldDescriptors(fields);
    const values = new Map((msg.overrides || []).map(item => [item.field_id, item]));
    const overrides = new Map();
    for (let index = 0; index < fields.length; index++) {
      const value = values.get(descriptors[index].field_id);
      if (value && typeof value.value === 'string') overrides.set(fields[index], value);
    }
    runFill({ overrides, resumeKind: msg.resumeKind || 'default' })
      .then(async report => {
        // Runtime-supplied prose is allowed to target only the exact descriptor
        // that was inspected moments earlier.  A normal fill pass can abstain
        // before it reaches that descriptor when an SPA re-renders its form.
        // Retry a still-empty exact target once, never overwrite a value the
        // candidate supplied, then report what the DOM actually retained.
        // Prefer the live control from the pre-fill scan: a committed
        // react-select input may drop out of a fresh detectFields pass.
        const currentFields = detectFields(document, adapter);
        const currentDescriptors = fieldDescriptors(currentFields);
        const overrideResults = [];
        for (const requested of msg.overrides || []) {
          let field = null;
          const originalIndex = descriptors.findIndex(item => item.field_id === requested.field_id);
          if (originalIndex >= 0) field = fields[originalIndex];
          if (!field) {
            const index = currentDescriptors.findIndex(item => item.field_id === requested.field_id);
            if (index >= 0) field = currentFields[index];
          }
          if (!field) {
            overrideResults.push({ field_id: requested.field_id, matched: false, accepted: false });
            continue;
          }
          const before = readValue(field);
          // An existing candidate-entered value has priority over automation.
          if (!before) {
            try { await applyValue(field, requested.value); } catch { /* Readback below is authoritative. */ }
          }
          document.activeElement?.blur?.();
          await new Promise(resolve => setTimeout(resolve, 150));
          const actual = readValue(field);
          overrideResults.push({
            field_id: requested.field_id,
            matched: true,
            accepted: filledValueMatches(actual, requested.value),
            preserved_candidate_value: Boolean(before && !holdsOurValue(field)),
          });
        }
        const finalFields = detectFields(document, adapter);
        sendResponse({ ...report, overrideResults, fields: fieldDescriptors(finalFields), navigation: navigationState(document) });
      })
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

/**
 * Passes run one at a time, in order.
 *
 * `filling` is a single boolean cleared at exactly one place, so two overlapping
 * passes (the automatic one, plus the user pressing Fill) would have the first
 * to finish clear the flag while the other was still writing. That re-opens the
 * window the flag exists to close: capture would record our own writes as the
 * user's answers, and both passes would apply values to the same widget.
 */
let queue = Promise.resolve();
function runFill(opts = {}) {
  const run = () => doFill(opts);
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function doFill({ auto = false, overrides = null, resumeKind = 'default' } = {}) {
  if (adapter.skipPage?.(location.href) || isCredentialScreen()) {
    return { ok: true, board: adapter.id, filled: 0, unknown: 0, failed: 0, unknowns: [], skipped: true };
  }

  filling = true;
  const data = await loadAll();
  const threshold = data.settings.fuzzyThreshold ?? 0.75;

  clearMarks();
  unknownFields.clear();

  // Repeated sections start collapsed behind an Add button, so on Workday's
  // "My Experience" there is literally nothing in the DOM to fill until they
  // are opened. Done before detection, and never on a section that already has
  // controls, so re-running a fill cannot append a second copy of the same job.
  let opened = [];
  try {
    opened = (await adapter.expandSections?.(data.profile)) || [];
  } catch (err) {
    // A board that changes its markup must not take the whole pass down.
    console.warn('[job-autofill] could not open repeated sections:', err);
  }

  const fields = detectFields(document, adapter);
  for (const field of fields) seenControls.add(field.control);
  const report = {
    ok: true,
    board: adapter.id,
    boardLabel: adapter.label,
    filled: 0,
    unknown: 0,
    failed: 0,
    unknowns: [],
    reverted: [],
    failures: [],
    multiStep: Boolean(adapter.isMultiStep),
    resumeNote: '',
    hasFileInput: Boolean(document.querySelector('input[type="file"]')),
    opened,
  };
  const usedKeys = [];
  const applied = [];

  // Sequential on purpose: listbox widgets mount a shared popup container and
  // filling two at once makes them fight over it.
  for (const field of fields) {
    // A local answer bank can contain a valid answer from a previous form, but
    // it cannot authorize opting into talent communities, job alerts, or other
    // future-contact marketing. Leave voluntary controls untouched. A required
    // future-opportunity control may still be completed with unique No.
    if (isOptionalMarketingConsent(field.rawLabel, (field.options || []).map(option => option.text || option.value))
        && field.required !== true) {
      clearMark(field);
      continue;
    }
    const risk = riskCategory(field.rawLabel, (field.options || []).map(option => option.text || option.value));
    // Rotating email codes must never come from the answer bank. A leftover
    // value from a previous posting would look complete and get submitted.
    if (risk === 'EPHEMERAL' || isOtpVerificationQuestion(field.rawLabel)) {
      if (field.control && (TEXTISH_KINDS.has(field.kind) || field.kind === 'textarea')) {
        try { setNativeValue(field.control, ''); } catch { /* leave the control as-is if it refuses a clear */ }
      }
      clearMark(field);
      continue;
    }
    if (isEphemeralApplicationQuestion(field.rawLabel)) {
      clearMark(field);
      continue;
    }
    // Compensation is role-specific. Current compensation is never supplied,
    // while desired compensation is handled by the runner's bounded,
    // job-scoped preference policy rather than a global answer-bank match.
    if (['SALARY', 'CURRENT_COMPENSATION'].includes(risk)) {
      clearMark(field);
      continue;
    }
    // A file input is filled from the stored resume, not from the answer bank,
    // so it takes its own path before the answer lookup below.
    if (field.kind === 'file') {
      const outcome = await applyResume(field, resumeKind);
      if (outcome === 'filled' || outcome?.status === 'filled') {
        // Counted here rather than pushed onto `applied`: that list is the
        // re-read queue for widgets that can silently revert a write, and its
        // entries are {field, value} pairs. Pushing a bare field put an
        // undefined into the destructuring at the top of that loop, which threw
        // and took the whole pass down with it — fields stayed filled, but the
        // report never came back and the panel never rendered, so the Needs-you
        // list vanished on exactly the setup that has a resume stored. A file
        // input cannot revert the way react-select does; `.files` either took
        // the resume or it did not, and fillFileInput already checked.
        report.filled++;
        // Greenhouse replaces the native file input with a visual receipt as
        // soon as a file is attached.  Preserve only its filename and digest
        // in the fill report so the runtime can verify the exact configured
        // document after that DOM replacement.  Never retain file bytes here.
        if (outcome?.sha256) report.resume = { name: outcome.name, sha256: outcome.sha256 };
        markFilled(field);
      } else {
        // No resume stored, or the write did not take. Either way it is on the
        // user, so it has to be counted as well as listed: the header read
        // "1 needs you" over a list of three.
        report.unknown++;
        report.unknowns.push(field);
        markUnknown(field);
      }
      continue;
    }
    if (hasUserValue(field)) {
      // Already answered. If it holds OUR value from an earlier pass, keep
      // reporting it as filled: a later pass clears the marks and re-detects,
      // so counting only what this pass wrote made the panel appear to lose
      // fields ("6 filled" dropping to "2 filled") the moment a form revealed
      // a new section. A value the user typed stays theirs and is not counted.
      if (holdsOurValue(field)) {
        report.filled++;
        markFilled(field);
      }
      continue;
    }

    // Empty, and we are the ones who filled it earlier: the user deleted our
    // answer. A blank is an answer. An automatic pass must never write it back,
    // or a value they explicitly removed goes into a submitted application
    // wearing a green outline that says it was reviewed. Pressing Fill is an
    // explicit request, so that path still refills.
    if (auto && written.has(field.control)) {
      clearMark(field);
      continue;
    }

    const override = overrides?.get(field);
    const candidates = override ? [{ value: override.value, from: `override:${override.provenance || 'runtime'}` }] : resolveCandidates(field, data, threshold);
    if (candidates.length === 0) {
      report.unknown++;
      report.unknowns.push({ rawLabel: field.rawLabel, el: field.control });
      unknownFields.set(field.control, field);
      markUnknown(field);
      continue;
    }

    let outcome = 'unmapped';
    let resolved = candidates[0];
    for (const candidate of candidates) {
      resolved = candidate;
      noteWritten(field.control, candidate.value);
      try {
        outcome = await applyValue(field, candidate.value, data);
      } catch {
        outcome = 'failed';
      }
      // Claim what the widget actually committed straight away. It is often not
      // the string we asked for, and the verification pass below is too late:
      // a scan triggered by our own clicks can reach it first and store our own
      // fill as if the user had chosen it.
      noteWritten(field.control, readValue(field));
      // Only an option mismatch is worth retrying with another candidate.
      if (outcome !== 'unmapped') break;
    }

    if (outcome === 'filled') {
      report.filled++;
      applied.push({ field, value: String(resolved.value) });
      markFilled(field);
      if (resolved.answerKey) usedKeys.push(resolved.answerKey);
      adapter.afterFill?.(field);
    } else if (outcome === 'unmapped') {
      // We have an answer, but it doesn't safely pick one of THIS form's
      // options. That is the matcher abstaining, not a bug, so it belongs in
      // the "needs you" list rather than the failure count.
      //
      // Release the claim made before the write. Nothing was written, and
      // holding it makes capture treat the user's own pick as our work: an
      // abstained sponsorship question could never be learned, because the
      // value they chose was the one we had considered and rejected.
      written.delete(field.control);
      report.unknown++;
      report.unknowns.push({ rawLabel: field.rawLabel, el: field.control });
      unknownFields.set(field.control, field);
      markUnknown(field);
    } else {
      // Same release on a failed write: the user is about to correct it, and
      // their correction is exactly what should be learned.
      written.delete(field.control);
      report.failed++;
      report.failures.push({ rawLabel: field.rawLabel, el: field.control });
      markFailed(field);
    }
  }

  // A React widget can accept a write and then revert it when focus leaves.
  // react-select does exactly that: the text sits in the box looking filled,
  // then vanishes on blur because no option was ever committed. Reporting that
  // as "filled" is the worst failure this tool can have, because you would
  // submit an application trusting a green outline over an empty field. So
  // blur everything, let the page settle, and re-read before claiming anything.
  document.activeElement?.blur?.();
  await new Promise(r => setTimeout(r, 400));
  for (const { field, value } of applied) {
    if (!field.control.isConnected) continue;
    const committed = readValue(field);
    if (committed !== '') {
      // A widget can commit a different string than the one we asked for.
      noteWritten(field.control, committed);
      continue;
    }

    // The value did not survive. A control that looks like a text input but
    // discards what you type is almost always a dropdown in disguise: Workday
    // renders "How Did You Hear About Us?" and "Country Phone Code" that way.
    // Retry once through the option-picking path before calling it failed,
    // which also covers boards we have never seen.
    if (TEXTISH_KINDS.has(field.kind)) {
      try {
        await fillCombobox(field, value, options => matchOption(value, options));
        await new Promise(r => setTimeout(r, 250));
        if (readValue(field) !== '') {
          noteWritten(field.control, readValue(field));
          markFilled(field);
          continue;
        }
      } catch { /* fall through to reporting it as failed */ }
    }

    report.filled--;
    report.failed++;
    report.reverted.push({ rawLabel: field.rawLabel, el: field.control });
    report.failures.push({ rawLabel: field.rawLabel, el: field.control });
    written.delete(field.control);
    markFailed(field);
  }

  if (report.hasFileInput) report.resumeNote = data.settings.resumeNote;

  for (const key of usedKeys) await recordUse(key);

  filling = false;
  watchForLateFields();
  showPanel(report, {
    onFillAgain: () => { void runFill(); },
    presentKeys: new Set(fields.map(f => f.normKey).filter(Boolean)),
  });
  chrome.runtime.sendMessage({ type: 'fillReport', report: stripEls(report) }).catch(() => {});

  return stripEls(report);
}

/**
 * Fill sections that appear only after an earlier answer reveals them.
 *
 * A form is not a fixed list of fields. Lever keeps one EEO survey per country
 * in the page at `display: none` and unhides the matching one when a location
 * is chosen, so filling the location **is what creates** the gender, race and
 * veteran questions. They arrive after our snapshot, and with nothing watching,
 * the whole block stayed invisible to the extension: not filled, not even
 * listed as needing the user.
 *
 * Armed only after a fill the user asked for, so this never turns into
 * fill-on-load. Bounded, because a React board rerenders constantly and an
 * unbounded loop would refill forever.
 */
const seenControls = new WeakSet();
const MAX_RESCANS = 3;
let rescans = 0;
let rescanTimer = null;
let observer = null;

function watchForLateFields() {
  if (observer || rescans >= MAX_RESCANS) return;
  observer = new MutationObserver(scheduleRescan);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    // Revealing a hidden section is an attribute change, not an insertion.
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
}

function scheduleRescan() {
  if (filling) return;
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(runRescan, 600);
}

/** True when the user is in a field: a pass would blur them and be ignored. */
function userIsTyping() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.closest?.('#job-autofill-panel')) return false;
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function runRescan() {
  if (filling) return;
  // A pass blurs everything to verify what stuck, and learns nothing while it
  // runs. Doing that under someone mid-sentence would throw them out of the
  // field AND discard the answer they were giving, so wait for them to finish.
  if (userIsTyping()) {
    rescanTimer = setTimeout(runRescan, 1200);
    return;
  }
  if (rescans >= MAX_RESCANS) {
    observer?.disconnect();
    observer = null;
    return;
  }
  // Only a field we have never seen, and that nobody has answered, is worth
  // another pass. Without both tests, our own writes and a board's rerenders
  // would each trigger one.
  const fresh = detectFields(document, adapter)
    .filter(f => f.kind !== 'file' && !seenControls.has(f.control) && !hasUserValue(f));
  if (!fresh.length) return;
  rescans++;
  void runFill({ auto: true });
}

/**
 * Everything worth trying in a field, best first: adapter attribute map, then
 * the canonical profile synonyms, then the learned answer bank.
 *
 * More than one candidate matters for dropdowns. The profile holds the true
 * value ("Business Intelligence and Data Analytics") while a board offers only
 * its own vocabulary ("Information Systems"), so when the profile value cannot
 * map onto the options we fall through to what was actually submitted before
 * rather than giving up. An empty list means leave the field alone, which
 * always beats guessing.
 */
function resolveCandidates(field, data, threshold) {
  const out = [];
  const push = (value, from, answerKey) => {
    if (value === undefined || value === null || String(value) === '') return;
    if (!fitsKind(field.kind, String(value))) return;
    if (out.some(c => c.value === String(value))) return;
    out.push({ value: String(value), from, answerKey });
  };

  const attrPath = adapter.canonicalAttr?.(field.control);
  if (attrPath) push(readPath(data.profile, attrPath), `adapter:${attrPath}`);

  const canonPath = canonicalFieldFor(field.normKey, field.kind);
  const noneLike = mapNoneLikeChoice(
    field.rawLabel,
    field.options,
    canonPath ? readPath(data.profile, canonPath) : '',
  );
  if (noneLike) push(noneLike, 'profile:none-preference');
  // Stored acknowledgements are intentionally narrow.  Optional policy and
  // marketing consent must remain untouched even when this company words an
  // otherwise known acknowledgement similarly.
  if (canonPath && (!canonPath.startsWith('application.acknowledgements.') || field.required)) {
    push(readPath(data.profile, canonPath), `profile:${canonPath}`);
  }

  // Ashby marks `__systemfield_data_consent_ack` without HTML required, but
  // Submit still fails closed until it is checked. Treat the known system-field
  // Affirmation label the same as a required privacy acknowledgement.
  const privacyAck = field.kind === 'checkbox'
    && (
      /\bapplicant privacy policy\b/.test(field.normKey)
      || /^(?:affirmation|acknowledgement|acknowledgment)$/.test(field.normKey)
    );
  if (privacyAck && (field.required || /^(?:affirmation|acknowledgement|acknowledgment)$/.test(field.normKey))) {
    push(readPath(data.profile, 'application.acknowledgements.requiredPrivacyPolicy') || 'I agree',
      'profile:application.acknowledgements.requiredPrivacyPolicy');
  }
  if (field.kind === 'checkbox' && field.required) {
    if (/\bcandidate ai responsible use policy\b/.test(field.normKey)
        && /\bown work and experience\b/.test(field.normKey)) {
      push(readPath(data.profile, 'application.acknowledgements.requiredCandidateAiResponsibleUse'),
        'profile:application.acknowledgements.requiredCandidateAiResponsibleUse');
    }
  }

  // A field inside a repeated block (education #2, employer #3) must never be
  // filled from the global answer bank: every block shares the same label, so
  // the stored answer belongs to whichever block was filled last. Only the
  // indexed profile lookup above can be right here. Blank beats a plausible
  // wrong date on an employment history.
  if (field.groupIndex != null) return out;

  const schoolAffiliation = namedSchoolAffiliationAnswer(field.rawLabel, data.profile?.education);
  if (schoolAffiliation) push(schoolAffiliation, 'profile:education-affiliation');

  const graduationSeason = graduationSeasonAnswer(field.rawLabel, data.profile?.education);
  if (graduationSeason) push(graduationSeason, 'profile:education-graduation-season');
  const graduationDate = graduationDateAnswer(field.rawLabel, field.options, data.profile?.education, {
    kind: field.kind,
  });
  if (graduationDate) push(graduationDate, 'profile:education-graduation-date');
  const degreeGpa = degreeGpaAnswer(field.rawLabel, field.options, data.profile?.education);
  if (degreeGpa) push(degreeGpa, 'profile:education-degree-gpa');
  const testScore = standardizedTestAnswer(field.rawLabel, field.options);
  if (testScore) push(testScore, 'profile:standardized-test');
  const clearance = securityClearanceAnswer(field.rawLabel, field.options);
  if (clearance) push(clearance, 'profile:security-clearance');
  const employerHistory = namedEmployerHistoryAnswer(field.rawLabel, field.options, data.profile?.work);
  if (employerHistory) push(employerHistory, 'profile:named-employer-history');
  const hit = findAnswer(field.normKey, data.answers, { threshold });
  const relocateAnswer = hit?.entry?.answer
    || findAnswer(normalizeKey('Are you willing to relocate?'), data.answers, { threshold })?.entry?.answer;
  const namedEmployerNow = currentlyEmployedAtNamedOrgAnswer(field.rawLabel, field.options, data.profile?.work);
  if (namedEmployerNow) push(namedEmployerNow, 'profile:currently-employed-named-org');
  const reserveOrGuard = militaryReserveOrGuardAnswer(field.rawLabel, field.options, data.profile?.work);
  if (reserveOrGuard) push(reserveOrGuard, 'profile:military-reserve-or-guard');
  const usGovEmployment = usGovernmentEmploymentAnswer(field.rawLabel, field.options, data.profile?.work);
  if (usGovEmployment) push(usGovEmployment, 'profile:us-government-employment');
  const relativesNamedOrg = relativesAtNamedOrgAnswer(field.rawLabel, field.options, data.answers);
  if (relativesNamedOrg) push(relativesNamedOrg, 'profile:relatives-at-named-org');
  const affirmation = applicationAffirmationAnswer(field.rawLabel, field.options);
  if (affirmation) push(affirmation, 'profile:application-affirmation');
  const completedEducation = completedEducationLevelAnswer(field.rawLabel, field.options, data.profile?.education);
  if (completedEducation) push(completedEducation, 'profile:completed-education');
  const locationInterest = workLocationInterestAnswer(field.rawLabel, field.options, {
    location: data.profile?.location,
    relocateAnswer,
  });
  if (locationInterest) push(locationInterest, 'profile:work-locations');
  const relocationPref = relocationPreferenceAnswer(field.rawLabel, field.options, { relocateAnswer });
  if (relocationPref) push(relocationPref, 'profile:relocation-preference');
  const futureDecline = futureOpportunityDeclineAnswer(field.rawLabel, field.options);
  if (futureDecline) push(futureDecline, 'policy:future-opportunity-no');
  const remoteState = remoteWorkStateAnswer(field.rawLabel, field.options, {
    location: data.profile?.location,
    relocateAnswer,
  });
  if (remoteState) push(remoteState, 'profile:remote-work-state');
  const travelPercent = travelPercentageAnswer(field.rawLabel, field.options, data.answers);
  if (travelPercent) push(travelPercent, 'answers:travel-percentage');
  const smsOptIn = operationalSmsOptInAnswer(field.rawLabel, field.options, data.answers);
  if (smsOptIn) push(smsOptIn, 'answers:sms-opt-in');
  const usPersonFlag = /^(yes|true)$/i.test(String(readPath(data.profile, 'application.usPerson') || ''));
  const workAuthStatus = workAuthorizationStatusAnswer(field.rawLabel, field.options, data.answers, {
    usPerson: usPersonFlag,
  });
  if (workAuthStatus) push(workAuthStatus, 'profile:work-authorization-status');
  const citizenStatus = citizenshipStatusAnswer(field.rawLabel, field.options, {
    citizenship: readPath(data.profile, 'identity.citizenship'),
    usPerson: usPersonFlag,
  });
  if (citizenStatus) push(citizenStatus, 'profile:citizenship-status');
  const citizenExplain = citizenshipOtherExplainAnswer(field.rawLabel, {
    citizenship: readPath(data.profile, 'identity.citizenship'),
    usPerson: usPersonFlag,
  });
  if (citizenExplain) push(citizenExplain, 'profile:citizenship-other-explain');
  const essentialFunctions = essentialFunctionsAnswer(field.rawLabel, field.options, data.answers);
  if (essentialFunctions) push(essentialFunctions, 'answers:essential-functions');

  const careerFair = careerFairContactAnswer(field.rawLabel);
  if (careerFair) push(careerFair, 'policy:career-fair-na');

  const decline = mapFutureOpportunityChoice(field.rawLabel, field.options);
  if (decline) push(decline, 'policy:future-opportunity-no');

  const commuteRelocate = commuteOrRelocateOption(field.rawLabel, field.options, {
    location: data.profile?.location,
    relocateAnswer,
  });
  if (commuteRelocate) push(commuteRelocate, 'profile:commute-or-relocate');
  const localRelocate = localOrRelocateAnswer(field.rawLabel, field.options, {
    location: data.profile?.location,
    relocateAnswer,
  });
  if (localRelocate) push(localRelocate, 'profile:local-or-relocate');
  const startAvail = startAvailabilityAnswer(field.rawLabel, field.options, data.answers, { kind: field.kind });
  if (startAvail) push(startAvail, 'answers:start-availability');
  const sanctions = mapSanctionsChoice(
    field.rawLabel,
    field.options,
    hit?.entry?.answer || restrictedCountryStoredAnswer(data.answers)?.answer,
    data.profile,
  );
  if (sanctions) push(sanctions, 'answers:sanctions');
  const exportCountry = exportControlCountryAnswer(field.rawLabel, {
    citizenship: data.profile?.identity?.citizenship,
    storedRestrictedNo: Boolean(restrictedCountryStoredAnswer(data.answers)),
  });
  if (exportCountry) push(exportCountry, 'profile:export-control-country');
  const usPerson = usPersonExportAnswer(field.rawLabel, field.options, {
    usPerson: /^(yes|true)$/i.test(String(readPath(data.profile, 'application.usPerson') || '')),
  });
  if (usPerson) push(usPerson, 'profile:us-person-export');
  const f1OptCpt = f1OptCptCurrentAnswer(
    field.rawLabel,
    field.options,
    readPath(data.profile, 'application.currentlyOnF1OptCpt'),
  );
  if (f1OptCpt) push(f1OptCpt, 'profile:f1-opt-cpt');
  else if (!sanctions && !exportCountry && !usPerson && hit) push(hit.entry.answer, `answers:${hit.method}`, hit.entry.key);

  return out;
}

/**
 * Attach the stored resume to a file input.
 *
 * Reported as needing the user when nothing is stored, which is the honest
 * state: the field is real, we simply have no bytes for it. That keeps the
 * panel's "Needs you" list meaningful instead of silently skipping the one
 * field an application will not submit without.
 */
async function applyResume(field, resumeKind = 'default') {
  // Only the resume slot. A cover letter, transcript or writing sample is a
  // different document, and the stored resume is not it.
  if (!isResumeInput(field.control, field.rawLabel)) return 'unmapped';
  const resume = await getResumeFor(resumeKind);
  if (!resume?.base64) return 'unmapped';
  if (!fillFileInput(field, resume)) return 'failed';
  let sha256 = null;
  try {
    const bytes = Uint8Array.from(atob(resume.base64), char => char.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { /* The runtime treats a missing receipt as a resume mismatch. */ }
  return { status: 'filled', name: resume.name, sha256 };
}

/** First candidate only, for the diagnostic view. */
function resolveValue(field, data, threshold) {
  return resolveCandidates(field, data, threshold)[0] || null;
}

/**
 * Write a value into a control.
 * @returns {Promise<'filled'|'unmapped'|'failed'>} 'unmapped' means the stored
 *   answer doesn't map onto this form's options and we chose not to guess.
 */
async function applyValue(field, value, data = {}) {
  const mappedChoice = (options, answer = value) => {
    const relocateStored = findAnswer(normalizeKey('Are you willing to relocate?'), data.answers || {})?.entry?.answer
      || answer;
    const local = localOrRelocateAnswer(field.rawLabel, options, {
      location: data.profile?.location,
      relocateAnswer: relocateStored,
    });
    const commute = commuteOrRelocateOption(field.rawLabel, options, {
      location: data.profile?.location,
      relocateAnswer: relocateStored,
    });
    const sanctions = mapSanctionsChoice(field.rawLabel, options, answer, data.profile);
    const usPerson = usPersonExportAnswer(field.rawLabel, options, {
      usPerson: /^(yes|true)$/i.test(String(readPath(data.profile, 'application.usPerson') || '')),
    });
    const f1OptCpt = f1OptCptCurrentAnswer(
      field.rawLabel,
      options,
      readPath(data.profile, 'application.currentlyOnF1OptCpt') || answer,
    );
    const graduationDate = graduationDateAnswer(field.rawLabel, options, data.profile?.education, {
      kind: field.kind,
    });
    const degreeGpa = degreeGpaAnswer(field.rawLabel, options, data.profile?.education);
    const testScore = standardizedTestAnswer(field.rawLabel, options);
    const clearance = securityClearanceAnswer(field.rawLabel, options);
    const employerHistory = namedEmployerHistoryAnswer(field.rawLabel, options, data.profile?.work);
    const namedEmployerNow = currentlyEmployedAtNamedOrgAnswer(field.rawLabel, options, data.profile?.work);
    const reserveOrGuard = militaryReserveOrGuardAnswer(field.rawLabel, options, data.profile?.work);
    const usGovEmployment = usGovernmentEmploymentAnswer(field.rawLabel, options, data.profile?.work);
    const relativesNamedOrg = relativesAtNamedOrgAnswer(field.rawLabel, options, data.answers);
    const affirmation = applicationAffirmationAnswer(field.rawLabel, options);
    const completedEducation = completedEducationLevelAnswer(field.rawLabel, options, data.profile?.education);
    const locationInterest = workLocationInterestAnswer(field.rawLabel, options, {
      location: data.profile?.location,
      relocateAnswer: relocateStored,
    });
    const relocationPref = relocationPreferenceAnswer(field.rawLabel, options, {
      relocateAnswer: relocateStored,
    });
    const futureDecline = futureOpportunityDeclineAnswer(field.rawLabel, options);
    const noneLike = mapNoneLikeChoice(field.rawLabel, options, answer);
    const remoteState = remoteWorkStateAnswer(field.rawLabel, options, {
      location: data.profile?.location,
      relocateAnswer: relocateStored,
    });
    const travelPercent = travelPercentageAnswer(field.rawLabel, options, data.answers);
    const smsOptIn = operationalSmsOptInAnswer(field.rawLabel, options, data.answers);
    const workAuthStatus = workAuthorizationStatusAnswer(field.rawLabel, options, data.answers, {
      usPerson: /^(yes|true)$/i.test(String(readPath(data.profile, 'application.usPerson') || '')),
    });
    const citizenStatus = citizenshipStatusAnswer(field.rawLabel, options, {
      citizenship: readPath(data.profile, 'identity.citizenship'),
      usPerson: /^(yes|true)$/i.test(String(readPath(data.profile, 'application.usPerson') || '')),
    });
    const essentialFunctions = essentialFunctionsAnswer(field.rawLabel, options, data.answers);
    return matchOption(local || commute || sanctions || usPerson || f1OptCpt || graduationDate
      || degreeGpa || testScore || clearance || employerHistory || namedEmployerNow
      || reserveOrGuard || usGovEmployment || relativesNamedOrg || affirmation
      || completedEducation
      || locationInterest || relocationPref || futureDecline || noneLike || remoteState || travelPercent || smsOptIn
      || workAuthStatus || citizenStatus
      || essentialFunctions
      || answer, options);
  };
  const pickOption = options => mappedChoice(options);
  const done = ok => (ok ? 'filled' : 'failed');

  switch (field.kind) {
    // A split month/day/year box. 'unmapped' rather than 'failed' when the
    // stored answer is not a date: the answer is fine, it just isn't one this
    // widget can take, and the user should see it as needing them.
    case 'date-parts':
      return fillDateParts(field, value) ? 'filled' : 'unmapped';
    case 'select': {
      const option = mappedChoice(field.options);
      if (!option) return 'unmapped';
      return done(fillNativeSelect(field, option));
    }
    case 'radio':
    case 'buttongroup': {
      const option = mappedChoice(field.options);
      if (!option) return 'unmapped';
      if (field.kind === 'radio') return done(fillRadio(field, option));
      option.el.click();
      return 'filled';
    }
    case 'checkbox': {
      // A stored answer can hold several values ("check all that apply"), so
      // tick every one that this form offers rather than only the first.
      const wanted = splitMulti(value);
      if (wanted.length > 1) {
        let ticked = 0;
        for (const part of wanted) {
          const match = matchOption(part, field.options);
          if (match && fillCheckbox(field, match, true)) ticked++;
        }
        return ticked > 0 ? 'filled' : 'unmapped';
      }
      const mapped = mapSanctionsChoice(field.rawLabel, field.options, value, data.profile)
        || mapNoneLikeChoice(field.rawLabel, field.options, value);
      const option = matchOption(mapped || value, field.options) || matchOption(value, field.options);
      if (option) return done(fillCheckbox(field, option, true));
      if (!/^(yes|no|true|false|checked)$/i.test(value)) return 'unmapped';
      return done(fillCheckbox(field, null, /^(yes|true|checked)$/i.test(value)));
    }
    case 'combobox':
      return done(await fillListbox(field, pickOption));
    case 'combobox-input': {
      // Same for a multi-select: a skills picker takes each value in turn.
      const wanted = splitMulti(value);
      if (wanted.length > 1) {
        let added = 0;
        for (const part of wanted) {
          const outcome = await fillCombobox(field, part, options => matchOption(part, options));
          if (outcome === 'filled') added++;
        }
        return added > 0 ? 'filled' : 'unmapped';
      }
      return fillCombobox(field, value, pickOption);
    }
    default:
      // Server-backed autocomplete: it can only be filled by committing one of
      // its own results, so it reports 'unmapped' when none matches instead of
      // leaving text the widget will throw away.
      if (adapter.needsTyping?.(field)) {
        return simulateTyping(field, value, pickOption, adapter.typeahead);
      }
      return done(fillText(field, value));
  }
}

/** Element references can't cross the message boundary. */
function stripEls(report) {
  return {
    ...report,
    unknowns: report.unknowns.map(u => ({ rawLabel: u.rawLabel })),
    reverted: report.reverted.map(u => ({ rawLabel: u.rawLabel })),
    failures: report.failures.map(u => ({ rawLabel: u.rawLabel })),
  };
}

// ── fill on load (opt-in) ──────────────────────────────────────────

/**
 * Optional: run a pass as soon as an application form is on screen, with no
 * click. Off by default and stored as `settings.autoFillOnLoad`, because
 * filling only when asked is the safer default and the whole design leans on
 * that (see the "armed only by a fill" note on `watchForLateFields`).
 *
 * Turning it on does not relax any of the guards that make an unasked pass
 * safe. It reuses `runFill({ auto: true })`, so it is serialized with a manual
 * Fill, it never overwrites a value you typed, and it never rewrites a value of
 * ours that you deleted — a blank you left on purpose stays blank.
 */
const AUTO_POLL_MS = 400;
const AUTO_MAX_WAIT_MS = 12000;
/** Bound on unasked passes per mount, so an SPA that rewrites its URL can't loop. */
const AUTO_MAX_PASSES = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wait until the form has stopped growing, then report how many fields it has.
 *
 * Boards render in stages: Greenhouse mounts its react-select widgets after
 * first paint, and Workday's steps arrive over the wire. Filling the moment the
 * first input exists would pass over half a form and burn the one unasked pass
 * on it, so this waits for two consecutive scans to agree before returning.
 */
async function waitForForm() {
  const deadline = Date.now() + AUTO_MAX_WAIT_MS;
  let previous = -1;
  while (Date.now() < deadline) {
    if (isCredentialScreen()) return 0;
    const count = detectFields(document, adapter).filter(f => f.kind !== 'file').length;
    if (count > 0 && count === previous) return count;
    previous = count;
    await sleep(AUTO_POLL_MS);
  }
  return Math.max(previous, 0);
}

let autoPasses = 0;

async function autoFillPass() {
  if (autoPasses >= AUTO_MAX_PASSES) return;
  if (adapter.skipPage?.(location.href)) return;
  if (!(await waitForForm())) return;

  // Someone already answering by hand outranks us. A pass blurs every control
  // to verify what stuck, so firing under a caret would throw them out of the
  // field and discard the sentence they were typing. Wait a little, and if they
  // are still at it, leave the form alone — the popup's Fill button is still
  // there when they want it.
  for (let waited = 0; userIsTyping() && waited < 15000; waited += 1000) await sleep(1000);
  if (userIsTyping()) return;

  autoPasses++;
  await runFill({ auto: true });
}

/**
 * Multi-step flows never reload the page, so one pass at mount would fill step
 * one and abandon the rest. The path (not the query string, which these boards
 * rewrite constantly) is what changes between steps.
 */
function watchForStepChanges() {
  let path = location.pathname;
  setInterval(() => {
    if (location.pathname === path) return;
    path = location.pathname;
    void autoFillPass();
  }, 1000);
}

void (async () => {
  const { settings } = await loadAll();
  if (!settings.autoFillOnLoad) return;
  await autoFillPass();
  watchForStepChanges();
})();
