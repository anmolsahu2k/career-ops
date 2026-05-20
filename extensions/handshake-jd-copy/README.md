# Handshake JD Copy

Tiny Chrome extension that adds a floating **Copy JD** button on every Handshake page. Click it on a job posting (full page or in-context preview) and the title, company, location, URL, and description are written to your clipboard as one structured text block. Paste into `/career-ops` to ask for a cover letter or to answer application questions.

## Why

Handshake job pages are auth-gated, so the auto-pipeline can't fetch the JD itself. This extension closes the gap with a one-click manual copy that produces a Claude-Code-friendly format.

## Install (load unpacked)

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the folder: `extensions/handshake-jd-copy/` from this workspace.

The extension is now active on `https://app.joinhandshake.com/*`.

## Use

1. Open a Handshake job — either the dedicated page (`/job-search/{id}`, e.g. `/job-search/11013856`) or click a card in the search results so the preview panel opens.
2. Click the dark **Copy JD** pill at the bottom-right of the page.
3. A green toast confirms what was copied (title + company + char count).
4. Switch to your terminal running Claude Code, run `/career-ops`, paste, and ask for what you need:
   - "Write a cover letter for this role."
   - "Draft answers for these application questions: ..."
   - "Score this role and write the eval report."

## Output format

```
Title: <job title>
Company: <employer>
Location: <city / remote tag>
URL: <current page URL>

JD:
<full description text>
```

## Selectors / fixing breakage

Handshake's job-detail page is React + Styled Components. There are no `data-hook` / `data-testid` attributes, and class names (`sc-hYiwpA edAVTz` etc.) are hashed and rotate on every deploy. The script anchors on the only stable thing — the `<h3>Job description</h3>` heading — then walks up to the wrapper, clicks the **Show more** button (`class*="view-more-button"`, `aria-label` starting with `Show more`) if the JD is collapsed, polls until it expands, and copies the rest.

Title and company have no stable selector either. The script falls back to parsing the view-more button's `aria-label`, which Handshake formats as `"Show more (What does a {Title} do at {Company}?)"`. That covers most pages even when the page-level `h1` selector misses.

If a field comes back empty:

1. Open DevTools on the broken page, inspect the field you want.
2. Find a stable text anchor (a heading with literal text), an `aria-label` pattern, or a semantic tag — class names are useless.
3. Add the new selector / text-anchor lookup to the matching section at the top of `content.js`.
4. Reload the extension at `chrome://extensions` (click the circular reload icon on the card).

## Permissions

- `host_permissions`: `https://app.joinhandshake.com/*` only. The extension does not run on other sites.
- No network requests. No background script. No storage. No telemetry.
- Clipboard write is performed only on your button click (user-gesture context).
