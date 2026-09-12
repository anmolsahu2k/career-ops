# Cover Letter Template (body-only, paste-ready)

This is the canonical format for every cover letter generated in this workspace,
whether by a `$career-ops` request in Codex, a compatibility `/career-ops`
request, or a direct user request. The dashboard does not generate letters. It
is body-only by design so the file's contents can be pasted directly into an
application form's "Cover letter" text field with zero pre-trim. The form
already collects the candidate's name, contact info, and company name in
separate fields; repeating them in the letter body is noise.

## Hard rules

1. **No header metadata block.** Do not include the `# NN Cover Letter, Company | Role` heading, do not include `**URL:**`, `**Resume:**`, or the `---` separator, do not include the `## Cover Letter` section heading. The file starts directly with the first body paragraph.
2. **No contact block, no date, no recipient address.** Do not write the candidate's name, phone, email, LinkedIn, GitHub, or location. Do not write the date line. Do not write the recipient's name, company, or email. The application form has these fields.
3. **No greeting.** Do not write `Hi Sinfonik team,`, `Dear Hiring Manager,`, `Hello,`, or any equivalent opening salutation. The letter opens on the first substantive sentence.
4. **No closing line.** Do not write `Resume attached.` or any equivalent meta-line about what is being submitted alongside.
5. **No sign-off.** Do not write `Sincerely,`, `Thanks for the consideration,`, `Thanks,`, `Best,`, the candidate's name at the bottom, or any equivalent valediction. The letter ends on the last substantive sentence of the body.
6. **No internal-tooling footer.** Do not append a `## Things deliberately NOT included` audit checklist or any meta-commentary about what was scrubbed. Scrubbing is the writer's job, not the user's.
7. **Length cap: body <= 200 words.** Keep the whole body at or under 200 words. This cap exists to reduce the AI-tell of an over-long letter; short and specific reads as human, long and even reads as generated. The historical examples under the frozen root `reports/` tree are voice references only.

## Body shape

The body is 4 to 6 flowing paragraphs, capped at 200 words total (see hard rule 7), one continuous line per paragraph in the markdown file (blank line between paragraphs, no hard wraps, no ```` ``` ```` code fence).

Recommended structure (treat as a default, not a rigid template):

1. **Opening hook.** Strongest single match between candidate and the JD's headline ask, named concretely. Lead with a built artifact, not a sentiment. If the application is for an AI / automation / agentic role and the career-ops workspace itself is a defensible match, the self-referential opener ("this letter exists because I pressed that key") is a strong default.
2. **Pillar 2.** Second-strongest portfolio asset, mapped to a different specific piece of the JD. Usually Cloudify for agentic / multi-agent / orchestration / LLM-tooling asks. Usually Highmark cancer-staging for regulated-data / healthcare / fintech / clinical asks. Usually EEG Classification for research / contrastive / multimodal / vision-or-signal asks.
3. **Production credibility.** Byju's 2.5y SDE bullets, picked to match the JD's full-stack / scale / shipping-velocity claims. Pick 2 to 3 numbers, never all of them.
4. **Optional supporting block.** Only if the JD asks for something the first three pillars do not naturally cover (scoring models, recommendation systems, multimodal fusion, hackathon-velocity work, edtech overlap, etc.).
5. **"Why this company specifically" close.** The single highest-leverage paragraph in the letter. Names something true about the company that is not in their marketing copy, then ties it to what the candidate would do differently because of it.

## Style rules (inherited from `modes/_shared.md` and memory)

- No em-dashes, no en-dashes (CLAUDE.md Rule 1). Use commas, periods, colons, or rephrase.
- No F-1, OPT, H-1B, Heinz, OIE, or visa/sponsorship explainer (CLAUDE.md Rule 3).
- No proactive availability statement (`feedback_no_availability_phrases.md`). Do not write "Available January 2027", "ready to start in...", etc.
- No internal snake_case tracker tokens (`feedback_no_internal_jargon.md`). `on_site`, `in_person`, `remote_us`, etc. never appear in candidate-facing prose.
- No clichés: `passionate about`, `leveraged`, `spearheaded`, `facilitated`, `synergies`, `robust`, `seamless`, `cutting-edge`, `innovative`, `proven track record`, `results-oriented`.
- Reference past tense for finished work, present tense for ongoing (`project_highmark_idl_state.md`: Highmark cancer-staging pipeline is FINISHED, IDL coursework is COMPLETE).
- Flowing paragraphs, one paragraph = one continuous markdown line, blank line between paragraphs, no ```` ``` ``` ```` code fence (`feedback_cover_letter_paragraph_format.md`).

## Reference letters

- **Historical voice references**: the frozen root `reports/` archive contains older examples. Copy voice only, not their greetings, sign-offs, headers, or paths.

## Filename convention (unchanged)

Path: `ft/reports/{company-slug}/{NN}-{company-slug}-{role-slug}-cover-letter.md` by default, or the corresponding `reports/` path under the explicitly selected `CAREER_OPS_DATA_DIR`. `{NN}` is the tracker row number or evaluation number, and `{company-slug}` matches the slugifier in `scripts/reorg-reports-by-company.py`. Cover letters are created only on explicit request.
