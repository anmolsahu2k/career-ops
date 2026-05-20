// Handshake JD Copy — content script.
//
// Injects a floating "Copy JD" button on app.joinhandshake.com. On click it
// extracts the visible job's title, employer, location, URL, and description,
// then writes a structured plain-text block to the clipboard for pasting into
// Claude Code (/career-ops) when generating cover letters or answering form
// questions.
//
// Works on both the dedicated job page (/job-search/{id}, e.g.
// /job-search/11013856) and the in-context side-panel preview that opens
// when you click a card from search results.
//
// Selector strategy (verified against real Handshake DOM 2026-05-05):
//
//   * Handshake's React build uses Styled Components — class names are
//     hash-suffixed gibberish like `sc-hYiwpA edAVTz` and rotate on every
//     deploy. There are no `data-hook` / `data-testid` attributes on
//     job-detail elements. Selectors keyed on classes WILL break.
//
//   * The single stable anchor in the JD section is the `<h3>` with text
//     "Job description". We find that h3, walk up to the containing
//     wrapper, then extract the body text from inside it.
//
//   * Handshake collapses long JDs by default with a "Show more" button
//     that has class `view-more-button` and aria-label
//     `Show more (What does a {TITLE} do at {COMPANY}?)`. Before
//     extraction, we click the button if present and poll until either
//     the aria-label flips to "Show less" or the visible text grows.
//     The aria-label parenthetical also gives us a title+company fallback
//     in case the page-level h1/employer selectors miss.
//
//   * For title / employer / location at the page level, we still try a
//     short list of candidate selectors, but those are unverified and
//     will likely need fixing. The aria-label fallback covers
//     title+employer when those selectors return nothing.
//
// All extraction is done from your already-rendered DOM. No new requests.

(() => {
  if (window.__handshakeJdCopyMounted) return;
  window.__handshakeJdCopyMounted = true;

  const BUTTON_ID = 'handshake-jd-copy-btn';
  const TOAST_ID = 'handshake-jd-copy-toast';

  const EXPAND_TIMEOUT_MS = 3000;
  const EXPAND_POLL_MS = 100;

  // ── JD section (anchored on the "Job description" h3) ─────────────────
  function findJdSection() {
    for (const h3 of document.querySelectorAll('h3')) {
      const txt = (h3.textContent || '').trim().toLowerCase();
      if (txt === 'job description') {
        // h3 → header wrapper → section wrapper. Both ancestors are <div>s
        // wrapping the header + body. Going up two levels gives us the
        // wrapper that contains the body text + the more/less button.
        const header = h3.parentElement;
        const wrapper = header?.parentElement;
        if (wrapper) return wrapper;
      }
    }
    return null;
  }

  function findViewMoreButton(wrapper) {
    if (!wrapper) return null;
    return wrapper.querySelector('button.view-more-button, button[class*="view-more"]');
  }

  function buttonState(btn) {
    const aria = (btn?.getAttribute('aria-label') || '').toLowerCase();
    if (aria.startsWith('show more')) return 'collapsed';
    if (aria.startsWith('show less')) return 'expanded';
    return 'unknown';
  }

  async function expandIfCollapsed(wrapper) {
    const btn = findViewMoreButton(wrapper);
    if (!btn) return;
    if (buttonState(btn) !== 'collapsed') return;

    const startLen = (wrapper.innerText || '').length;
    btn.click();

    // Poll for either the button flipping to "Show less" or the visible
    // text growing meaningfully (the truncated inline style is removed
    // and the full content mounts).
    const start = Date.now();
    while (Date.now() - start < EXPAND_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, EXPAND_POLL_MS));
      const nowBtn = findViewMoreButton(wrapper);
      if (buttonState(nowBtn) === 'expanded') return;
      const nowLen = (wrapper.innerText || '').length;
      if (nowLen > startLen * 1.3) return;
    }
  }

  // Walks the JD subtree and emits structured plain text:
  //   * `<p>` / `<div>` / `<h1..h6>` / `<section>` / `<article>` → wrapped
  //     in newlines so paragraph breaks survive
  //   * `<li>` → bullet-prefixed (`- ...`) on its own line
  //   * `<br>` → newline
  //   * `<button>` / `<svg>` / `<script>` / `<style>` → dropped
  //   * The "Job description" h3 anchor → dropped
  //
  // We can't rely on `innerText` here because Handshake's collapsed JD
  // applies inline-block + truncation styles, AND because reading
  // innerText off a detached clone collapses block boundaries (no
  // rendered layout = behaves like textContent). Walking the DOM
  // ourselves gives us deterministic structure regardless of CSS state.
  function htmlToText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (tag === 'button' || tag === 'svg' || tag === 'script' || tag === 'style') {
      return '';
    }
    if (/^h[1-6]$/.test(tag) && (node.textContent || '').trim().toLowerCase() === 'job description') {
      return '';
    }
    if (tag === 'br') return '\n';

    let inner = '';
    for (const child of node.childNodes) inner += htmlToText(child);

    if (tag === 'li') {
      const t = inner.trim();
      return t ? '\n- ' + t : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      const t = inner.trim();
      return t ? '\n' + t + '\n' : '';
    }
    if (/^(p|div|section|article|header|footer|tr|hr|h[1-6])$/.test(tag)) {
      const t = inner.trim();
      return t ? '\n' + t + '\n' : '';
    }
    return inner;
  }

  function extractDescription(wrapper) {
    if (!wrapper) return '';
    let text = htmlToText(wrapper);
    // Collapse runs of 3+ newlines to a single paragraph break, strip
    // trailing whitespace before line ends, trim.
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // Title + company fallback parsed from the view-more button's aria-label
  // ("Show more (What does a {TITLE} do at {COMPANY}?)").
  function titleAndEmployerFromButton(wrapper) {
    const btn = findViewMoreButton(wrapper);
    const aria = btn?.getAttribute('aria-label') || '';
    const m = aria.match(/^Show (?:more|less) \(What does an? (.+?) do at (.+?)\?\)\s*$/i);
    if (!m) return { title: '', employer: '' };
    return { title: m[1].trim(), employer: m[2].trim() };
  }

  // ── Page-level title/employer/location (best-effort) ──────────────────
  // Handshake doesn't expose data-hooks for these on the job-detail page.
  // The selectors below are starting points; fix as you observe breakage.
  const TITLE_SELECTORS = [
    'h1',
    '[role="heading"][aria-level="1"]',
  ];
  const EMPLOYER_SELECTORS = [
    'a[href*="/employers/"]',
    'a[href*="/stratus/employers/"]',
  ];
  const LOCATION_SELECTORS = [
    '[aria-label*="Location" i]',
  ];

  function pickFirst(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt) return txt;
    }
    return '';
  }

  function pickRoot() {
    return (
      document.querySelector('[role="dialog"][aria-modal="true"]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  // ── Orchestrator ──────────────────────────────────────────────────────
  async function extract() {
    const root = pickRoot();
    const jdSection = findJdSection();
    await expandIfCollapsed(jdSection);

    let title = pickFirst(root, TITLE_SELECTORS);
    let employer = pickFirst(root, EMPLOYER_SELECTORS);
    const location = pickFirst(root, LOCATION_SELECTORS);
    const description = extractDescription(jdSection);

    if (!title || !employer) {
      const fb = titleAndEmployerFromButton(jdSection);
      if (!title)    title    = fb.title;
      if (!employer) employer = fb.employer;
    }

    return {
      title: clean(title),
      employer: clean(employer),
      location: clean(location),
      description: clean(description),
    };
  }

  function clean(s) {
    if (!s) return '';
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function format(job, currentUrl) {
    const lines = [];
    if (job.title)    lines.push(`Title: ${job.title}`);
    if (job.employer) lines.push(`Company: ${job.employer}`);
    if (job.location) lines.push(`Location: ${job.location}`);
    lines.push(`URL: ${currentUrl}`);
    lines.push('');
    lines.push('JD:');
    lines.push(job.description || '(description not detected — could not find h3 "Job description" anchor)');
    return lines.join('\n');
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────
  function showToast(msg, kind = 'ok') {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      Object.assign(toast.style, {
        position: 'fixed',
        right: '20px',
        bottom: '76px',
        padding: '10px 14px',
        borderRadius: '8px',
        font: '13px/1.4 -apple-system, system-ui, sans-serif',
        color: '#fff',
        zIndex: 2147483647,
        boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        maxWidth: '320px',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
        transition: 'opacity 0.2s ease',
        opacity: '0',
      });
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.background = kind === 'ok' ? '#1f7a3a' : '#a8361a';
    toast.style.opacity = '1';
    clearTimeout(toast.__hide);
    toast.__hide = setTimeout(() => { toast.style.opacity = '0'; }, 2400);
  }

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = 'Copy JD';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      padding: '10px 16px',
      borderRadius: '999px',
      border: 'none',
      background: '#1f1f1f',
      color: '#fff',
      font: '600 13px/1 -apple-system, system-ui, sans-serif',
      letterSpacing: '0.02em',
      cursor: 'pointer',
      zIndex: 2147483647,
      boxShadow: '0 6px 18px rgba(0,0,0,0.24)',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#2c2c2c'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#1f1f1f'; });
    btn.addEventListener('click', onCopyClick);
    document.body.appendChild(btn);
  }

  let busy = false;
  async function onCopyClick() {
    if (busy) return;
    busy = true;
    const btn = document.getElementById(BUTTON_ID);
    const originalLabel = btn?.textContent;
    if (btn) btn.textContent = 'Copying…';
    try {
      const job = await extract();
      if (!job.title && !job.description) {
        showToast('No JD detected.\nOpen a Handshake job first.', 'err');
        return;
      }
      const text = format(job, location.href);
      const ok = await copyToClipboard(text);
      if (ok) {
        const summary = job.title
          ? `Copied: ${job.title}${job.employer ? ' @ ' + job.employer : ''}\n(${(job.description || '').length} chars)`
          : `Copied (${text.length} chars)`;
        showToast(summary, 'ok');
      } else {
        showToast('Copy failed. See console.', 'err');
      }
    } catch (err) {
      console.error('[handshake-jd-copy] extract failed:', err);
      showToast(`Error: ${err.message || err}`, 'err');
    } finally {
      if (btn && originalLabel) btn.textContent = originalLabel;
      busy = false;
    }
  }

  injectButton();
  const obs = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) injectButton();
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
