# Mode: latex - Legacy Resume Export Compatibility

This mode name is retained for upstream and compatibility-client routing. Resume
PDF generation is disabled in this workspace. The user supplies the maintained
SDE and MLE resume PDFs; Career-Ops may select or review one, but it must not
generate, compile, copy, or overwrite a resume artifact.

## Allowed work

- Inspect the legacy LaTeX template or an existing user-supplied `.tex` file when
  the user explicitly asks for a review.
- Recommend source-text corrections for the user to make in the maintained
  resume materials.
- Report which maintained resume PDF matches the role, using the rules in
  `modes/pdf.md` and `CAREER_OPS.md`.

## Prohibited work

- Do not run `generate-latex.mjs`, `generate-pdf.mjs`, `pdflatex`, `tectonic`,
  Canva export, or an equivalent generation flow.
- Do not write generated resume files under `ft/output/` or the legacy root
  `output/` directory.
- Do not invent skills, metrics, dates, titles, or achievements.
- Do not silently edit `cv.md`, the portfolio, or the maintained resume source.

## Current output

Return a resume selection or review, the role-fit rationale, any factual or ATS
issues the user should consider, and the exact existing PDF path when available.
If the user explicitly asks to change a source resume, follow the append-only
and synchronization rules in `CAREER_OPS.md` before editing it.

The upstream export workflow is historical compatibility material only; it is
not part of the active Career-Ops runtime.
