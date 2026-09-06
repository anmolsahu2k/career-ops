# Mode: pdf — Resume Review and Selection

This mode name is retained as a compatibility alias. CV PDF generation is disabled in this workspace. The user maintains and submits the SDE and MLE source PDFs identified in the root shared rules file. Read their current paths from `CLAUDE.md`; do not duplicate machine-specific paths here.

## Allowed work

1. Read the relevant job description, `cv.md`, and `modes/_profile.md`.
2. Select the maintained SDE resume for software, backend, infrastructure, SRE, and QA roles.
3. Select the maintained MLE resume for AI, ML, data science, data engineering, and applied scientist roles.
4. Inspect a supplied resume for ATS parsing, factual consistency, readability, or role fit.
5. Recommend source-text changes for the user to consider. If the user explicitly asks to update a source document, preserve every existing bullet in the append-only master resume and follow the synchronization rules in `CLAUDE.md`.
6. Report the recommended existing PDF path. Do not copy, regenerate, or overwrite it.

## Prohibited work

- Do not run `generate-pdf.mjs`, `generate-latex.mjs`, Canva export, or any equivalent PDF-generation flow.
- Do not create files under `output/` for a resume.
- Do not silently edit `cv.md`, the portfolio, or the master resume.
- Do not invent skills, titles, dates, or metrics.

## Output

Return:

1. `Resume pick: SDE PDF` or `Resume pick: MLE PDF`.
2. A short explanation tied to the role requirements.
3. Any high-impact gaps or corrections the user should consider before submitting.
4. The exact maintained PDF path to upload.

If no job description is available, review the requested resume on its own and state that role-specific matching was not assessed.
