import { loadAll, updateSettings } from '../content/store.js';

const statusEl = document.getElementById('status');
const primaryBtn = document.getElementById('primary');
const injectBtn = document.getElementById('inject');
const resultEl = document.getElementById('result');
const autoFillBox = document.getElementById('autoFill');

document.getElementById('openOptions').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function detect() {
  const tab = await activeTab();
  if (!tab?.id) {
    statusEl.textContent = 'No active tab.';
    return;
  }

  const show = res => {
    if (res.skipped) {
      // Sign-in steps, account gates, and a board's job list all land here.
      statusEl.textContent = `${res.boardLabel}: no application form on this page.`;
      return;
    }
    statusEl.textContent = `${res.boardLabel}: ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} detected.`;
    primaryBtn.disabled = res.fieldCount === 0;
  };

  try {
    const res = await send(tab.id, { type: 'detect' });
    if (!res?.ok) throw new Error('no response');
    show(res);
    return;
  } catch {
    // Nothing answered. The usual cause is a company careers page that embeds
    // a board in an iframe: we hold no permission for the host page, so the
    // manifest never injects. Opening this popup is a user gesture, which
    // grants activeTab, so inject and retry before giving up.
    statusEl.textContent = 'Looking for an embedded application form...';
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content/bootstrap.js'],
    });
    const res = await send(tab.id, { type: 'detect' });
    if (!res?.ok) throw new Error('no response');
    show(res);
    statusEl.textContent += ' (embedded form)';
  } catch {
    statusEl.textContent = 'Not a recognized job board.';
    injectBtn.hidden = false;
  }
}

primaryBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  primaryBtn.disabled = true;
  primaryBtn.textContent = 'Filling…';
  try {
    const report = await send(tab.id, { type: 'fill' });
    renderReport(report);
  } catch (err) {
    resultEl.innerHTML = `<span class="err">Fill failed: ${err.message}</span>`;
  }
  primaryBtn.textContent = 'Fill this page';
  primaryBtn.disabled = false;
});

injectBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['content/bootstrap.js'],
  });
  injectBtn.hidden = true;
  setTimeout(detect, 400);
});

/**
 * Put the verbose detect payload on the clipboard.
 *
 * The content script has always been able to explain every field it found and
 * why each resolved or did not; nothing could get that explanation off the
 * user's machine. Boards behind a login (Workday, SuccessFactors) cannot be
 * reproduced from outside, so a report of "it fills nothing" was unanswerable
 * without asking the user to hand over a session. This closes that: one click,
 * one paste, and the failure is fully described.
 *
 * Values are truncated to 40 characters by the detect handler and the answers
 * themselves are the user's own, so this carries nothing they did not already
 * put on the page.
 */
document.getElementById('diag').addEventListener('click', async () => {
  const btn = document.getElementById('diag');
  const tab = await activeTab();
  btn.textContent = 'Collecting…';
  try {
    const res = await send(tab.id, { type: 'detect', verbose: true });
    if (!res?.ok) throw new Error(res?.error || 'no response from the page');
    const report = {
      url: res.url,
      board: res.board,
      skipped: res.skipped,
      fieldCount: res.fieldCount,
      fields: (res.fields || []).map(f => ({
        label: f.rawLabel,
        labelSource: f.labelSource,
        kind: f.kind,
        normKey: f.normKey,
        options: f.optionCount,
        resolvedFrom: f.resolvedFrom,
        value: f.value,
        control: f.debug,
      })),
    };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    btn.textContent = `Copied ${report.fieldCount} fields`;
  } catch (err) {
    btn.textContent = 'Failed';
    resultEl.innerHTML = `<span class="err">${err.message}</span>`;
  }
  setTimeout(() => { btn.textContent = 'Copy page diagnostics'; }, 2500);
});

// Fill-on-load. The same toggle lives on the options page; this copy is here
// because it is the only screen you have open while looking at a form.
loadAll().then(({ settings }) => { autoFillBox.checked = settings.autoFillOnLoad === true; });

autoFillBox.addEventListener('change', async () => {
  // Settings only: `saveAll` would write back an answer bank read a moment ago
  // and lose whatever the capture loop stored on the page in the meantime.
  await updateSettings({ autoFillOnLoad: autoFillBox.checked });
});

function renderReport(report) {
  if (!report?.ok) {
    resultEl.innerHTML = `<span class="err">${report?.error || 'Fill failed.'}</span>`;
    return;
  }
  if (report.skipped) {
    resultEl.innerHTML = '<span class="warn">Sign-in step, nothing filled.</span>';
    return;
  }
  const parts = [`<span class="ok">${report.filled} filled</span>`];
  if (report.unknown) parts.push(`<span class="warn">${report.unknown} unknown</span>`);
  if (report.failed) parts.push(`<span class="err">${report.failed} failed</span>`);
  resultEl.innerHTML = parts.join(' &middot; ');
}

detect();
