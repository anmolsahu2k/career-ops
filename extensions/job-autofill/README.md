# Job Autofill (career-ops)

Personal Chrome extension. Click-fills job application forms on Workday, Greenhouse, Ashby, Lever, and SuccessFactors, and learns any answer it doesn't know from what you type.

Unpacked only. Never published to the Chrome Web Store, no network calls, no telemetry. Everything stays in `chrome.storage.local` on this machine.

## Install

1. Seed the answer file from the repo's existing data:
   ```
   node scripts/seed-autofill.mjs
   ```
   Writes `extensions/job-autofill/data/answers.json` (gitignored). Add `--dry-run` to preview.

   It reads [config/profile.yml](../../config/profile.yml) for identity, parses `cv.md` for education and work history, adds an answer bank transcribed from `templates/application-tactics.md`, and merges `extensions/job-autofill/data/jobwizard-curated.json` if present. That last file is a hand-curated import from a previous autofill tool and is gitignored because it may hold address, date-of-birth, and demographic answers that must never enter a tracked file.
2. Chrome, `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> pick `extensions/job-autofill/`.
3. Open the extension's options page (`Review saved answers` in the popup) -> **Import JSON** -> pick `data/answers.json`.

## Using it

Open an application form, click the extension icon, click **Fill this page**.

- **Green outline**: filled.
- **Orange outline**: needs you. Either there's no saved answer, or there is one but it doesn't safely pick between this form's options. Type or select it yourself; the extension saves it silently and the outline flips green.
- **Dashed red outline**: a value was written but didn't stick (usually a widget the adapter doesn't drive yet). This is the only outline that means something is broken.

The sponsorship question is the canonical orange case. A stored bare `Yes` maps cleanly onto "Yes, I am authorized to work in the US", but a form offering both "Yes, I will require sponsorship in the future" and "Yes, I require sponsorship now" gets left blank, because a bare Yes doesn't choose between them and picking `now` is a costly wrong answer. Answer it once and the exact wording is learned.

Filling never overwrites anything you already typed. Multi-step Workday flows get a persistent **Fill this step** button on the panel: advance the step, click it again.

**Fill on load** is off by default and can be turned on from the popup (`Fill automatically when a form opens`) or from Settings on the options page. With it on, opening an application form runs a pass with no click: the extension waits for the form to stop growing (boards mount their widgets in stages, and filling the first input to appear would pass over half a form), then fills, then shows the same panel. Every guard still applies, because it is the same pass the button runs: it is serialized with a manual Fill, it never touches a value you typed, and it never rewrites one of ours that you deleted. It also stands down while you are typing, and gives up rather than interrupting if you are still typing 15 seconds later. Multi-step flows are covered too: the pass re-runs when the path changes, capped at eight passes per page so a board that rewrites its own URL cannot loop. The toggle applies from the next page load; on a form already open, use the button.

**The resume uploads itself**, once you have stored one. Store the PDF from the options page (`Resume PDF attached to file uploads`); it is held as base64 in `chrome.storage.local` and rebuilt into a `File` at fill time, then written through a `DataTransfer` onto the input. A board that already holds an upload has it cleared first, so Workday does not end up with the same resume attached twice. With no resume stored the field is reported under **Needs you** and you attach it yourself, which is what always used to happen. On `job-boards.greenhouse.io` the extension does not assign `.files`: that board creates its S3 uploader only after the visible Attach control opens a file chooser, and a synthetic `change` event renders `Cannot read properties of undefined (reading 'uploadFile')` on the Resume slot. The headed Career-Ops runner clicks that Attach control and supplies the hash-verified PDF through Playwright's file chooser instead.

Only the resume slot gets a file. Greenhouse renders Resume/CV and Cover Letter as the same upload control, both with a visually-hidden label `Attach` and the same accept list, so filling every file input attached the resume as the cover letter too, and that file goes to the employer. `isResumeInput` reads the id, name and aria-label first, then the nearest text that names the slot, and answers false when nothing does: an upload left for you is cheap, and the wrong document on an application is not. The real slot name on modern job-boards pages is `#upload-label-resume` / `#upload-label-cover_letter`; the Greenhouse adapter prefers that over the picker verb so Needs-you lists **Cover Letter** instead of a bare **Attach** after the resume has already attached. Cover-letter uploads, transcripts, portfolios and writing samples are reported under **Needs you**. Separately, the Career-Ops runner always reveals Greenhouse's `Enter manually` cover-letter textarea and supplies a validated letter from local prose first, then a configured hosted fallback; the extension itself never generates the letter or uploads a substitute document.

This section previously said the upload could never be automated, on the reasoning that a file only enters an `<input type=file>` through a real gesture on the picker. That was wrong: the gesture rule governs OPENING the picker, while `.files` is writable from a DataTransfer. Every comparable extension does it, and Simplify, Jobright, SpeedyApply and JobWizard were all read to confirm it before this was changed. SpeedyApply does it from an isolated content script, which is why no `world: MAIN` script was needed here.

Some fields are also left blank on purpose rather than guessed: anything asking for a per-role salary number, a company-specific essay, or a legally-loaded status question. `Are you currently on a STEM OPT?` is the standing example, since it carries an explicit disqualification warning and the honest answer changes the month OPT starts.

**Split date boxes are one field.** Workday renders a date as three inputs whose accessible names are "Month", "Day" and "Year". Filled individually they are three questions that are not questions, and the capture loop learns `month -> 8`. They are grouped by the id stem they share (`…-dateSectionMonth-input`), labelled from the question above them, and written together; a stored answer that does not parse as a date is left for you rather than guessed at. Capture declines to learn from them at all, because one box holds a third of an answer.

## What the panel tells you

The panel renders inside a **shadow root**, and its host carries `all: initial`. Ashby sets `line-height: 0` on divs, which reached into the panel and collapsed every line to 4px, stacking the text on top of itself. Patching the specific property would only have lasted until the next board, so page CSS is shut out entirely; `fixtures/hostile-css.html` is a page that attacks anything injected into it, and the e2e asserts the panel survives it. Note that the panel's text is therefore invisible to `innerText` — read it through `host.shadowRoot`, as both live harnesses do.


Each field it could not answer is listed under **Needs you**. Answer one and its row turns green and shows `saved: <your answer>`, with a **saved** count in the header, so the learning loop is visible without opening the review page: a green outline alone cannot tell a correctly stored answer from a mis-read one.

Dropdowns whose answer never reaches `input.value` are learned too, which covers most of a modern application form. react-select (current Greenhouse) and Ashby commit the choice into a rendered label and leave the input empty; Workday builds the control as a button with its options in a detached popup. None of them fires a usable `change` event, so the capture loop watches what each control *displays* and records the committed answer from that.

That scan deliberately does not reuse `detectFields`, which filters on visibility: react-select drops its input to opacity 0 once a value is committed, so an answered question vanishes from the field list at precisely the moment there is something to learn from it.

**A "No" is an answer, not a placeholder.** The check for "is this control showing its placeholder?" must not be the check for "is this text a real question?": the label test rejects anything under three characters, and reusing it on values silently discarded every `No`, so correcting an answer from Yes to No left the Yes stored. `isPlaceholderValue` and `isGenericLabel` are separate for that reason, and both are unit-tested against the other's cases.

A profile-backed question is learned **only when the fill pass could not answer it**. "Country Phone Code" and "Do you have a disability?" abstain on nearly every form, because the stored value does not map onto that form's options, so refusing to learn the user's pick left them manual forever. Name and email never reach this path: they fill successfully.

**Multi-value fields hold every choice.** A skills picker, a check-all-that-apply group, a multi-select of preferred locations: all of them store one answer containing every value, joined with ` | `, and refill every one of them next time. The separator is a pipe rather than a comma or semicolon precisely because option text is full of both ("Yes, I will require sponsorship"), and splitting on those would tear single answers apart. Chips are read from what the widget renders (react-select multi-value labels, Workday selected items, removable pills), and checkbox groups from every ticked member rather than the one that fired the event.

**The outline marks the question, not its first option.** Grouping by the `name` attribute alone is ordinary HTML (Lever's "Language Skill(s) (Check all that apply)" is 33 checkboxes sharing one name), and with no `<fieldset>` to mark, the outline landed on the first checkbox: a question that had been read whole looked like only its first option was recognised. The mark now goes on the group's own box, found as the nearest ancestor shared by every member, and only when that box holds no controls other than choices (otherwise it is a section, and outlining it would claim fields we never touched).

**A blank is an answer.** If you delete a value the extension wrote, an automatic pass must never write it back: that would put something you explicitly removed into a submitted application, wearing a green outline that says it was reviewed. An automatic pass skips any empty field we filled earlier and clears its outline. Pressing Fill is an explicit request, so that path still refills. Passes are also **serialized**: `filling` is one boolean cleared in one place, so two overlapping passes (the automatic one plus you pressing Fill) would have the first to finish clear it while the other was still writing, which is exactly the window where capture starts recording our own writes as your answers.

**A form is not a fixed list of fields.** Lever keeps one EEO survey per country in the page at `display: none` and unhides the matching one when a location is chosen, so filling the location **is what creates** the gender, race and veteran questions. They arrive after the field scan, and with nothing watching they were invisible to the extension: not filled, and not even listed as needing you. After a fill you asked for, a bounded `MutationObserver` watches for controls that are both new and unanswered and runs another pass when it finds them. It is armed only by a pass (a click, or fill-on-load when you have turned it on), capped at three rescans, and a pass now re-reports fields it filled earlier so the counts climb rather than appearing to lose fields. Two things had to be made safe before a pass could run unasked. A pass **blurs everything** to verify what stuck and **learns nothing while it runs**, so one firing under someone mid-sentence would throw them out of the field and discard the answer they were giving: a rescan defers while the caret is in a control. And the panel is rebuilt from scratch each pass, which erased the `saved:` lines and green outlines for questions answered by hand, reporting the learning loop as failed on answers it had stored; captured rows are now carried forward across renders. On Lever the trigger is `select.candidate-location`, which carries no `name` attribute at all, so the adapter maps it by class to `location.country` — without that the survey never appears and the whole block stays unfillable.

**Some checkboxes undo a click.** A board that runs its own handler on the label toggles the box a second time, so the click lands back where it started while still firing a `change`: Spotify's consent box on Lever does exactly that, and the fill was reported as failed even though the answer was right. `fillCheckbox` and `fillRadio` fall back to setting the state and announcing it when the click did not take. Radios are immune (a second activation leaves one set); checkboxes are not.

**A wrapping `<label>` often holds the widget's chrome as well as the question.** Lever's location label contains the autocomplete's whole dropdown, and its "Loading" node is on screen while the search runs, so reading the label whole made the question read "Current location Loading" for exactly as long as it took to answer it. The fill pass and the capture that followed then keyed the same field differently: the panel could not match them up, and `current location loading` went into the bank as a question. A dedicated label element inside the label is the question; the rest is chrome.

**A whole question can be wrapped in one `<label>`.** Lever's EEO blocks are `<label><div class="application-label">Race</div><ul>` one label per option `</ul></label>`. Skipping everything inside a control-bearing label (right for an option's own `<span>`) threw the question away, and the walk then took the *previous* question's heading, so the race group asked "Gender" and both stored under one key. An option's label holds no nested `<label>`; a wrapper's does.

**One question, one field, however the board ids its options.** Ashby's "select all that apply" blocks give every checkbox its own `name`, so grouping by that attribute split one question into one field per option: answering "How do you identify your sexual orientation?" left `Bisexual`, `Lesbian`, `Gay` and `Queer` each listed as a question still needing an answer, and ticking any of them would have stored the answer under its own option text. Ashby ids its choices `<question-uuid>_<option-uuid>-labeled-checkbox-N`, so the part before `-labeled-` identifies the question; the adapter groups on that. The entry fallback deliberately skips an entry that also holds a real input, because the phone entry holds a tel field AND a consent checkbox, and there the checkbox's own statement is its question.

**A group's question is never one of its own options.** Grouping choices by the `name` attribute alone, with no `<fieldset>` and no ARIA, is ordinary HTML: Lever's pronoun list is nine checkboxes sharing `name="pronouns"` and nothing else. With no container to ask, the question fell back to the first member's own label, so the whole group asked "He/him" and stored the answer under that key. A group container is now derived structurally when the page provides none (the nearest ancestor shared by every member), the question is looked for inside that container before the walk goes outside it, and any candidate matching one of the group's own options is rejected. The rule applies only to real groups: a lone consent checkbox's own sentence **is** its question, and treating it as an option handed it the privacy paragraph printed above it.

Some fields are deliberately never learned. Identity values (name, email, phone, country phone code) belong to the profile, so answering one shows **profile field, edit it in Options** rather than a stored answer. That row is not a capture failure, and it is not counted as saved.

## The learning loop

Capture is armed on every board page, even if you never click Fill. When you finish a field (blur, or change a dropdown), the question text and your answer are saved keyed by a normalized version of the question. Next time a similar question shows up on any board, it fills.

Every captured answer records where it came from: the platform, the employer (parsed from the URL), the posting title, and a link back to the posting. The review page shows that in the "Where it came from" column, keeping the last five postings per answer.

**Never store a widget's internal id as an answer.** Workday radios carry a 32-char GUID in `value`, and an early build fell back to that when it could not read the label, saving entries like `0189e38acb3f0183ab6873effd013717`. `matcher.looksOpaqueId()` now blocks these at capture and again in `upsertAnswer`, and the options page offers a one-click purge for any already saved. If a label cannot be resolved, capture nothing: a missing answer is recoverable, a garbage one silently refills wrong.

Things that are deliberately **not** learned:
- Identity fields (name, email, phone, links, city). Those are deterministic and live in the profile section of the options page.
- Anything you typed that the extension itself just filled. Only genuine edits update a stored answer.
- Passwords and file inputs.

Free-text essay answers (`textarea`) are stored, but only reused on an **exact** question match. Fuzzy matching is disabled for them, because "Why do you want to work at Stripe?" and "Why do you want to work at Anthropic?" score highly against each other and pasting the wrong company's essay is worse than an empty box.

EEO and demographic answers are seeded and do autofill (gender, race, Hispanic/Latino, veteran, disability). They are stored on this machine only, never transmitted, and stay off screen on the options page unless you tick `show EEO answers` or expand the demographics section. This was an explicit choice: the original design kept them learn-only, and it was reversed because these are the most repetitive fields on any application. To go back, clear the `demographics` block in `data/jobwizard-curated.json` and re-seed.

## Backup round trip

The extension writes to `chrome.storage.local`, which no backup script can see. To fold it into the repo's recovery set:

1. Options page -> **Export JSON** (lands in `~/Downloads/answers.json`).
2. `mv ~/Downloads/answers.json extensions/job-autofill/data/answers.json`

That path is gitignored, so `node backup.mjs` archives it with the rest of the personal data. To restore, or to pull in a re-run of the seed script, use **Import JSON**.

Import merges by default: an answer you typed on a real form (`captured`) or edited by hand (`manual`) is never overwritten by a `seed` entry. Tick **replace everything** only for a full restore.

## Smoke test

Automated. Loads the unpacked extension in Chromium, seeds it, fills the fixture, teaches it three answers, and re-fills to prove the loop closed:

```
node extensions/job-autofill/tests/e2e.mjs          # ~15s, headless
node extensions/job-autofill/tests/e2e.mjs --headed # watch it happen
```

35 assertions covering: identity fill, option mapping, abstention, blanks that must stay blank, outline colors, the summary panel, EEO answers hidden by default in the review UI, capture (including identity fields never captured), and that a value you typed is never overwritten. Expected result is `12 filled / 3 unknown / 0 failed` on the first pass and `14 filled / 1 unknown / 0 failed` on the second.

Not wired into `test-all.mjs` because it launches a browser. Needs
`node scripts/seed-autofill.mjs` to have run.

The browser e2e harness starts its own local fixture server. Run
`node extensions/job-autofill/tests/e2e.mjs` for the supported fixture smoke
test; the repository has no `npm run autofill:fixtures` script.

### Against a real posting

```
node extensions/job-autofill/tests/live.mjs <application-url> [--headed] [--keep]
```

Loads the extension, seeds it, and reports the detected fields with their resolved labels, what filled, what needs you, and whether any value reverted after blur. **It never clicks a submit control**, so nothing reaches the employer. Do not add such a click to that file.

Verified 2026-07-26 against a Greenhouse posting (Precisely, Associate Software Engineer): 38 fields detected, 13 filled, all surviving blur. Findings from that run are baked into the code:

- The application form is a **Greenhouse iframe embedded in the company's careers page**. The manifest only grants the iframe's origin, so nothing is injected into the host page and the popup gets no answer. The popup now falls back to an `activeTab` injection automatically after your click, which is why opening the popup is what makes an embedded form work.
- Current Greenhouse renders every dropdown as **react-select**: an `<input role="combobox">`, not a `<select>`. It opens on **mousedown** (a bare `.click()` does nothing), its options must be read from that control's own menu, and a committed value lives in a rendered label rather than `input.value`.
- A page can hold option lists that are permanently in the DOM. Greenhouse's phone widget keeps a full country list mounted, so a document-wide `[role=option]` query matches the wrong menu.

### Workday, verified 2026-07-26 (CrowdStrike tenant)

Two renders of the "My Information" step were tested live: **7/8 and 9/13 fields filled, 0 failures, every value surviving blur.** What that run taught, now encoded:

- **The form is behind a mandatory account gate**, and Workday serves Create Account from the *same* `/apply` URL as the application, so a URL-based skip never fires. `skipPage` tests page content instead.
- **That gate carries a honeypot** (`data-automation-id="beecatcher"`). See the honeypot note above; filling one marks the submission as a bot.
- **A dropdown's `aria-label` is "&lt;question&gt; &lt;current value&gt; Required"** ("Country India Required"). `questionFromAriaLabel()` subtracts the trigger's own text and the state words. Unit-tested against the real strings.
- **`Given Name(s)`** needs `(s)` stripped in normalization or it scores just under the fuzzy threshold against `given name`.
- **Workday regenerates DOM ids on every re-render**, so nothing may key off them; it also re-renders inputs after a write, which drops our outline classes while the value stays. Verify by value, never by class or id.

**The questionnaire step had two bugs, found from a user screenshot** showing `0 filled / 5 unknown` with four rows all reading "Select One Required":

- **An unanswered dropdown's entire accessible name is "Select One Required."** `questionFromAriaLabel` used to fall back to that raw name when subtracting the current value left nothing, so every question on the step keyed identically. Four different questions sharing one stored answer is worse than none: whichever was saved last would fill the rest. It now returns nothing, and `labelForTrigger` falls through to the question Workday renders above the widget. `resolveLabel` ignores a generic `aria-label` for the same reason, matched whole rather than by prefix so a real question like "Select your country" survives.
- **Answering one was never learned.** These dropdowns are `button[aria-haspopup=listbox]`, and capture only listened on `input`/`select`/`textarea`, so a whole step could be answered by hand with nothing saved. Capture now also watches widget triggers, reading the committed answer from the trigger's own text on mousedown/click/keyup, with the baseline recorded at page load so the first answer registers as a change.

**Known gap: the multiselect widgets** (`How Did You Hear About Us?`, `Country Phone Code`), identifiable only by their `multiselectInputContainer` parent. They are detected as dropdowns and correctly *abstain* rather than typing text that Workday discards, so nothing is filled wrongly, but they are not auto-filled either. Pointer events were added to the open sequence as the most likely cause; that specific fix is **unverified**, since reaching the widget needs a live login. Pick those two by hand.

### Workday questionnaire steps, verified 2026-08-11 (Rocket / quickenloans tenant)

The steps past the account gate had never been seen live; the note above about
the multiselect widgets says as much. Walking all six with
`tests/workday-walk.mjs` found the worst defect this tool has had.

- **Every dropdown on "Application Questions" was labelled with the question
  belonging to the widget above it.** Workday renders each question inside the
  control's OWN container (`<div data-automation-id="formField-<id>"
  data-fkit-id="primaryQuestionnaire--<id>"><fieldset><legend>`), and nothing
  read it there: `labelForTrigger` fell through to `nearestQuestionText`, which
  only inspects previous siblings and ancestors. A clean off-by-one across all
  eleven questions.

  This is not a cosmetic mislabel. It put **"Yes" into "Do you have an account
  with the National Mortgage Licensing System (NMLS)?"** while the extension
  believed it was answering "Are you willing to relocate?" — a wrong answer
  written into a live application, at a mortgage company, about a licensing
  registry. It also collapsed **work authorization and visa sponsorship onto one
  stored key**, so teaching either would have auto-answered the other on the
  next Workday form.

  `questionnaireQuestion()` now reads the legend from the widget's own
  container, preferring the bolded question over any preamble ("Military
  affiliation self-identification is voluntary..."). It is scoped by
  `data-fkit-id*="uestionnaire--"` and **must stay scoped**: on My Information,
  First, Middle and Last Name share one `<legend>Legal Name</legend>`, so an
  unscoped version collapses three fields onto one key — the same damage in the
  other direction.

- **The date group was keyed "Month".** Its own container holds no `<legend>`,
  so the group walk fell back to the spinbutton's `aria-label`. Routing
  `questionnaireQuestion` through `labelOverride`, which `resolveLabel` and
  `resolveLabelForGroup` both consult first, recovers "When would you be
  available to start full-time employment?".

- **Validation errors were being absorbed into labels.** After a failed Save and
  Continue, a key became `what is your pronoun error the field what is your
  pronoun is required and must have a value`, so anything taught before the
  error stopped matching. Workday renders the error as a
  `<p data-automation-id="inputAlert">` **sibling** of the legend, so reading the
  legend alone keeps it out.

- **"I have a preferred name" was keyed as "Legal Name"** (`engine.js`). The
  checkbox carries an explicit `<label for>`, but `resolveLabelForGroup`
  consulted the enclosing `role=group`'s `aria-labelledby` first and won with the
  section heading — the key three name inputs already answer to. An explicit
  `label[for]` now outranks the container, **for `lone` groups only**: a real
  group's members are its options ("Yes - I consent..."), never its question.

- **Nothing wrong ever reached the employer.** Confirmed by reading the saved
  draft back with no extension loaded: every questionnaire dropdown was still
  `Select One`. The step never passed validation, so it was never persisted. If
  you hit this before the fix, check any Workday application you did push
  through.

### Walking a login-walled Workday flow

```
node extensions/job-autofill/tests/workday-walk.mjs <apply-url> --headed [--shots dir]
```

Runs detect + fill on every step and dumps each field's resolved label and DOM
identity, plus a screenshot and the step's markup with `--shots` — which is what
turns a login-walled step into something fixable offline.

It advances with **Save and Continue**, because that is what walking a
multi-step form means, and **stops dead at Review: it matches button text and
refuses to click anything reading "Submit"**. Do not add such a click.

It pauses once for a human at the account gate, then writes the session to
`~/.cache/job-autofill-workday-state.json`, so later runs are fully headless.
Workday's candidate session is a **session cookie**, so the persistent profile
alone does not keep you signed in — that file is what does, and it holds a live
session, so it stays in the user cache and never in the repo.

Two traps this harness fell into first, both worth knowing:

- **Do not act on the first render.** `live.mjs` used to continue the moment 6
  controls existed and reported "My Information" as 7 address fields, with name,
  phone and every dropdown still unmounted. Both harnesses now wait for the
  control count to hold steady across two polls.
- **Workday serves two gate variants at the same `/apply` URL.** Create Account
  has `verifyPassword` and the consent checkbox; **Sign In has neither**. Detect
  the gate by a visible password box, the same signal
  `engine.isCredentialScreen()` uses.

### Work authorization and sponsorship are matched by concept, not wording

The two questions every US application asks were falling through every route
the matcher had, on a form where the bank held both answers.

Rocket asks "Are you legally authorized to **begin immediate employment** in the
United States?" against a stored "are you legally authorized to **work** in the
united states". Jaccard scores that **0.43** against a 0.75 threshold, and
`coveredAnswer` needs every stored token to appear, which "work" does not. Same
for sponsorship: the bank's wordings all carry "require"/"visa"/"status", and
Rocket's phrasing ("need any immigration-related support or sponsorship") has
none of them.

The bank is a wording index and these two are asked in unlimited wordings, so
listing them can never catch up — the same lesson the EEO block already learned
for gender and race. `matcher.conceptOf()` now recognises both by pattern, and
`conceptAnswer()` answers from whichever stored entries share the concept.

Four things keep it from doing damage, and each is pinned by a test:

- **A question matching BOTH concepts has no concept.** "Authorized to work
  WITHOUT sponsorship" is Yes-to-one and No-to-the-other; answering it from
  either is how you tell an employer you need no visa.
- **`sponsorship` does not key off "visa" alone.** The bank stores "No" for "are
  you currently on a TN visa" and "F-1 (OPT)" for others, which would either
  poison the agreement check or answer with a status string.
- **Only plain yes/no readings vote**, and they must agree, or it abstains.
- **"For all employers" / "unrestricted" / "permanent" vetoes work
  authorization.** On F-1 or OPT that is a different question with a different
  honest answer, and it is a legal attestation. It stays with the user.

Concept matching is the loosest route in the matcher, so it runs last, never
overrides an exact or fuzzy hit, and switches off when a caller raises the
threshold.

### Testing the questionnaire without signing in

```
node extensions/job-autofill/tests/workday-questionnaire.mjs [--headed]
```

Runs the real `detectExtraFields`, label resolution and `findAnswer` over
`fixtures/workday-questionnaire.html`, which is Workday's actual "Application
Questions" markup captured verbatim from the Rocket tenant. Asserts that every
dropdown is labelled with the question its own container states, that no two
share a label, that work authorization and sponsorship resolve, and that a
question the bank knows nothing about (NMLS) is left for the user.

This exists because that step is behind an account gate, and for as long as it
was only reachable by signing in, it went untested — which is exactly where the
worst defect this extension has had was living. Capture a new fixture with
`workday-walk.mjs --shots <dir>` when a tenant renders something new.

### A field with no question is never surfaced

`findAnswer` needs a key, so an unlabelled field can never be filled; `capture`
refuses an empty key, so it can never be learned; and the panel renders it as a
bullet with no text. Eight of those on Workday's "My Experience" step read as a
completely dead extension.

Every branch of `detectFields` guarded this except the radio/checkbox one, and
`resolveLabelForGroup` can return `{text: '', source: 'none'}` outright, so the
guard now sits once at the end of `detectFields` and covers every producer.
File inputs are exempt: an unlabelled upload is still worth prompting for,
because the user can see which box it is and we cannot fill it for them.

### Debugging a board you cannot reproduce

The popup's **Copy page diagnostics** button copies the verbose `detect` payload
as JSON: every field's label, where the label came from, its kind, its
normalized key, what it resolved to, and the control's DOM identity.

This exists because Workday and SuccessFactors sit behind a login, so "it fills
nothing" cannot be reproduced from outside. Before it, the only way to answer
such a report was to borrow the user's session. Ask for a paste of this instead.

### Repeated blocks must never use the answer bank

Education and employment sections repeat, and every entry reuses the same label: three "Start date year" fields on one page. A single global answer cannot represent all of them, and one did exactly the damage you would expect, filling a master's entry with a bachelor's 2019 to 2023.

The rules that prevent it:

- `engine.groupIndexOf()` recovers the block index from the control (`school--0`, `end-year--1`).
- Adapters route indexed controls straight at `profile.education[N]` (`greenhouse.educationPath()`).
- `resolveCandidates` **refuses the answer bank entirely** for any field with a `groupIndex`. Blank beats a plausible wrong date on someone's history.
- Capture skips them too, so a stale global key can never be created again.

Because boards offer their own vocabulary, each education entry carries `degreeOption` ("Master's Degree") and `fieldOption` ("Information Systems") next to the truthful `degree` and `field` from `cv.md`, plus `startYear` / `startMonthName` / `endYear` / `endMonthName` for split date pickers.

### Ashby, verified 2026-07-26 (Kayak posting)

**11 fields detected, 9 filled, 0 needs-you, 0 failures, every value surviving blur.** Three things this board taught:

- **"Start typing..." is not a label.** Ashby's comboboxes carry it as a placeholder, and taking it as the question collapsed several distinct fields onto one key while hiding the real label just above. `isGenericPlaceholder()` now skips widget-describing placeholders and falls through to the nearest heading, keeping the placeholder only as a last resort.
- **Type-to-search wants a prefix, not the answer.** The location search returns nothing for "Pittsburgh, Pennsylvania, United States" and everything for "Pittsburgh". `searchQuery()` sends the leading segment while matching still uses the complete stored answer, so "Pittsburgh, Pennsylvania, United States" is picked over Pittsburg Kansas, Texas, California and Illinois.
- **The menu renders in a portal.** It is never an ancestor of the input, so the scoped walk cannot see it. The document-level fallback now includes `[role="option"]`, made safe by snapshotting which options existed *before* opening and excluding them. That exclusion is what keeps Greenhouse's permanently-mounted phone country list from being mistaken for the menu.

### Ashby's Yes/No questions are buttons, not controls

Work authorization, sponsorship and onsite questions render as a pair of `<button>`s backed by one hidden checkbox. Four things that cost real coverage:

- **The adapter keyed off a hashed CSS-module class** (`._container_ux2kt_1`), which matched some earlier build and nothing since, so every one of these questions was invisible. Ashby ships a stable `ashby-application-form-field-entry` class beside the hashed ones; use that.
- **The hidden checkbox is the widget's own storage**, not a field. Treating it as "this entry already has an input" kept the group undetected even after the container selector was right.
- **Selection carries no ARIA**: the chosen button just gains an `_active_<hash>` class. `engine.selectedButton()` checks ARIA, then that class, then falls back to "exactly one button has a class its siblings lack" so a stylesheet rename does not break it. It ignores our own `ja-` classes, because `markUnknown` lands one on the first button and that made an unanswered question read as "Yes".
- **A checkbox's own label is its option text** ("Yes - I consent to receiving text messages"). The question is on the entry, but only for entries that are purely a choice: the phone entry holds a tel input *and* a consent box, and there the option text really is the question.

### EEO questions hide their inputs, and their labels are elsewhere

Ashby's equal-opportunity block put every question out of reach at once:

- **The native radio sits at `opacity: 0`** under a custom control. Treating transparent as hidden is right for a decoy and wrong here, so `isVisible` now makes an exception for a radio or checkbox whose visible shell has a real box. Gender, race, veteran and disability were all skipped before it.
- **The labels are not near the inputs.** Their fieldset has no usable legend, so the DOM walk called the gender group "Male" and handed the race group the entire gender block as its question. Ashby names these `<uuid>__systemfield_eeoc_<field>`, which is stable and semantic, so the adapter maps that to "Gender" / "Race" / "Veteran Status" / "Disability Status" — the exact wording the profile's demographics answer to.
- **`resolveLabelForGroup` now consults the adapter first**, as `resolveLabel` already did. Consulting it last is what let the DOM walk win.

That covers the EEOC block, whose fields are named for us. The **self-identification block a company writes itself** is not: it asks about gender and ethnicity in whatever sentence it likes, and the synonym table is an exact-match index, so those two resolved to nothing and were handed to the user on a form the profile could already answer. Listing each new sentence as it turns up only ever catches the wording already met once, so gender and race are now matched by pattern (`\bgender\b`, `\brac(e|ial)\b|\bethnic`) rather than by wording. Two guards keep it honest: a `textarea` is excluded, because a free-text box asking about these is its own question, and text longer than eight significant words is treated as prose — otherwise the equal-opportunity acknowledgement every board ships ("...without regard to race, color, religion, sex, gender identity...") would be offered the applicant's race as its answer. Only these two: hispanic/latino, veteran and disability are worded consistently enough for the exact table, and transgender, pronouns and sexual orientation have no profile field to answer from, so the panel should keep asking. Nothing here can put a wrong answer on a form by itself — a matched question only *offers* the profile value, and `matchOption` still has to land it on one of that form's options or abstain, which is what makes "Asian" reach "Asian or Asian American" and "Male" correctly give up in front of "Man / Woman / Non-binary".

### Baselines must be recorded before the click, not at page load

Capture compares what a control shows now against what it showed before. On an SPA the form renders long after the content script arms, so the first sighting of a control was the moment the user answered it, and that answer became the baseline instead of being learned. It cost the sponsorship question on an Ashby form. `seedBaselines()` now runs synchronously on mousedown, while the control still shows its previous state.

Related: a value is claimed **before** it is written (a blur fires focusout mid-write), and the claim is **released** when the write does not happen. Without the release, a question the matcher abstained on could never be learned, because the value the user picked was the one we had considered and rejected. That is precisely the sponsorship case.

### Lever, verified 2026-07-26 (11 postings)

**11 of 11 postings: 127 fields filled, 0 failures.** Every one of them had failed the same field before, and Lever's own `retrieveLocations.js` explained why:

- **The search runs on `keydown`**, debounced 500ms. A value written through the native setter, which dispatches `input` and `change`, never queries anything.
- **`blur` deletes the field.** While its dropdown is open, blurring clears both the visible input and the hidden `#selected-location` that the form actually submits. The captcha iframe takes focus a moment after the field is touched, so an announced write is destroyed before its own search returns. The fix is to write **silently** (`adapter.typeahead.announceInput: false`): the dropdown never opens, so the blur handler is a no-op, while `keydown` still runs the search.
- **A result commits on `mousedown`** against a `.dropdown-location`, which fills that hidden field. Nothing else commits it.
- **Its results are spelled differently from the answer**: `Pittsburgh, PA, USA` against a stored `Pittsburgh, Pennsylvania, United States`, with `Pittsburgh, ND, USA` sitting in the same list. `matcher.js` reconciles country spellings and US state names to their abbreviations at comparison time only, so stored keys keep their original wording. Indiana, Oregon and Maine abbreviate to stopwords, so cities differing only by those states abstain instead of resolving, which is the correct failure.
- **The label had swallowed the widget's status text**, producing the question "Current location No location found. Try entering a different locationLoading". `textOf()` now walks the live DOM and skips hidden and live-region nodes rather than reading a clone whole.
- `jobs.eu.lever.co` was matched by neither the manifest nor the adapter, so EU postings got no content script at all.

### SuccessFactors: applications are login-walled

Tested against SAP's own board and seven tenant sites. The posting page carries no application form: **Apply** redirects to `career5.successfactors.eu`, which is a sign-in screen. That is the same shape as Workday, so expect to sign in first and fill afterwards.

Two things came out of it:

- **A visible password box now vetoes the whole page**, for filling *and* for capture (`engine.isCredentialScreen()`). No application form has one, and without this the capture loop would learn a username as the answer to "Email".
- SAP serves these sites from `successfactors.*`, `sapsf.*` and `jobs2web.com`, all now in the manifest. Employer-branded domains (`mhicareers.com`, `jobs.farmersinsurance.com`) cannot be enumerated, so those still need the popup's inject-on-this-page button.

### A dead posting is not a form

Expired postings do not 404. Ashby serves the page with no fields, and Greenhouse redirects to `job-boards.greenhouse.io/{company}?error=true`, a job list whose only controls are its search box and filter dropdowns. Filling those is wrong, and worse, a filter the user then touches would be learned as the answer to a question called "Department". Two guards: `greenhouse.skipPage()` treats anything without `/jobs/{id}` (or `/embed/job_app`) as not an application, and `engine.isSearchControl()` excludes search and filter controls on any board.

### Why the fill pass re-reads every value

React widgets accept a write and then revert it on blur. Before this was handled, a run reported 14 filled while 10 had silently emptied, which is the worst possible failure here: you would submit an application trusting a green outline over an empty field. `runFill` now blurs, waits, and re-reads every field it wrote; anything that did not stick is downgraded to failed and listed in the panel under "Did not stick, fill by hand". Never relax that check. On React boards (Workday, Ashby, new Greenhouse), the thing to watch is whether values **survive blur**: if a field visually clears when you click elsewhere, the framework rejected the write and `filler.js` needs the MAIN-world fallback in `background.js` wired up for that control.

### End to end: does the loop actually close?

```
node extensions/job-autofill/tests/live-loop.mjs <application-url>
node extensions/job-autofill/tests/live-loop-batch.mjs <urls-file> [--jobs 2]
```

Fills the form, answers by hand everything it could not, reloads, and fills again, asserting that what was taught comes back. It never clicks submit, and only clicks option elements inside a menu it opened.

This is the check the fixture cannot make. The fixture proves the loop in miniature against markup written for the test; the boards ship something else entirely, and every capture defect so far has come from that gap.

**Verified 2026-07-27 across 39 live postings** (Greenhouse 14, Ashby 14, Lever 11): **38/38 with a live form clean, 35/35 learning loops closed, 0 fill failures.** Greenhouse 188 -> 310 filled after teaching, Lever 132 -> 223, Ashby 56 -> 96.

Both harnesses fail the run on any error thrown by **our own** content script, filtered to ours because boards throw plenty of their own. This exists because a `ReferenceError` fired on every page load while 39 live postings and 46 fixture assertions all passed: an unhandled rejection loses only the scan it happens in, so nothing downstream noticed.

Occasional flake to know about: a Greenhouse posting once reported 3 text fields failed under 2-way parallelism and ran clean twice standalone, which is React hydration racing the fill, not a defect. Re-run a single posting before believing a failure.

Two harness rules worth keeping, both learned by getting a false report: compare stored keys with the extension's own `normalizeKey` (it strips "Please indicate", so a naive compare called four good captures misses), and verify each hand-answer actually took, since a number input silently rejects "N/A" and that reads as a capture failure.

### Sweeping many postings at once

```
node extensions/job-autofill/tests/live-batch.mjs <urls-file> [--jobs 4] [--out dir]
```

One line per posting (board, filled / needs-you / failed), a log per URL, and a `summary.json`. It shells out to `live.mjs`, so it inherits the no-submit rule. Lever and Ashby posting URLs are rewritten to their application paths automatically.

**Ashby throttles concurrency.** At `--jobs 4` a run of Ashby postings can come back with "frames containing form controls: none" on pages that are perfectly alive; re-running the same URLs at `--jobs 1` fills them normally. Before treating an Ashby `no-form` as a regression, re-run it serially.

This is what catches per-company variation: the same board renders differently depending on which optional questions an employer switched on, and single-posting testing had left a field failing on every Lever posting in the tracker. Expect a large share of `no-form` on older rows, since expired postings still serve a page.

**Tracker sweep, 2026-07-26** (82 FT postings): 55 forms filled, **556 fields, 0 failures**. Plus 79 archive postings: 12 live, 121 fields, 0 failures. The rest were dead postings, or iCIMS / SmartRecruiters / Workable, which are not supported boards and need the popup's inject button.

## Unit tests

```
node --test extensions/job-autofill/tests/*.test.mjs
```

All run as part of `node test-all.mjs`. `content/matcher.js` is the pure decision layer (normalization, fuzzy scoring, option mapping, answer/control type fit) and holds every rule that could cause a wrong answer to be typed into a real application, so anything a live posting teaches gets pinned here. `guards.test.mjs` covers the never-fill rules. The DOM layers are verified against the fixture and live pages instead.

## Layout

```
manifest.json          MV3, board host permissions + localhost for fixtures
background.js          badge text; MAIN-world escape hatch
content/
  bootstrap.js         classic content script; dynamic-imports main.js as ESM
  main.js              orchestration: detect -> resolve -> fill -> report
  engine.js            field detection + label resolution (board-agnostic)
  matcher.js           pure matching logic; the only unit-tested module
  filler.js            value setting (native setter, listbox clicks, typeahead)
  capture.js           the learning loop
  store.js             chrome.storage.local schema + merge rules
  panel.js             outlines and the summary panel
  adapters/            per-board overrides; generic.js is the fallback
popup/                 board status + Fill button
options/               answer review, profile editor, import/export
fixtures/              local smoke-test forms
tests/                 matcher.test.mjs (node --test) + e2e.mjs (real browser)
data/                  gitignored; answers.json lives here
```

### Adding or fixing a board

Adapters are thin on purpose. Every hook is optional and falls through to generic behavior:

- `matches(url)` — claim the page.
- `canonicalAttr(el)` — map a stable attribute (Workday's `data-automation-id`, Lever's `name`) straight to a profile path, skipping label resolution entirely. This is the most reliable hook; prefer it.
- `labelOverride(el)` — supply question text when the DOM gives no accessible name.
- `detectExtraFields(root)` — surface widgets that aren't `input`/`select`/`textarea` (Workday listbox buttons, Ashby's Yes/No button pairs).
- `needsTyping(field)` — the control is a typeahead and free text gets discarded on submit.
- `typeahead` — options for that path. `{ announceInput: false }` drives it without firing `input`, which is what Lever needs: its dropdown opens on `input`, and its blur handler erases the field while that dropdown is open.
- `skipPage(url)` — sign-in and account-creation steps.
- `afterFill(field)` — cosmetic sync for widgets that shadow a native control.

When a board breaks, check label resolution first: open devtools, run the extension's detect, and see whether the field came back with the right `rawLabel`. Most breakage is a missing accessible name, not a broken filler.
