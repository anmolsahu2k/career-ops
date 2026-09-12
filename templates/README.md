# Templates

System-layer template files used by career-ops scripts and modes. These files are auto-updated when you run `npm run update` -- put user customizations in the user-layer files instead (see DATA_CONTRACT.md).

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `cv-template.html` | Legacy | Retained for upstream compatibility; CV PDF generation is disabled |
| `cv-template.tex` | Legacy | Retained for upstream compatibility; CV PDF generation is disabled |
| `portals.example.yml` | Onboarding | Example portal scanner configuration (copy to `portals.yml` to activate) |
| `states.yml` | `verify-pipeline.mjs`, `normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical application states and their aliases |

### cv-template.html

Legacy HTML template that the upstream tool rendered with Playwright. It remains
for compatibility only; the active workspace supplies maintained resume PDFs and
does not generate a CV PDF.

**Design:** Space Grotesk headings + DM Sans body, single-column ATS-safe layout, self-hosted fonts from `fonts/`.

**Reference only:** Do not customize this file expecting the active runtime to
produce a resume. The historical placeholder tokens are documented in
`batch/batch-prompt.md` under "Template placeholders."

### cv-template.tex

Legacy LaTeX template for Overleaf-compatible CV generation. It remains for
reference only; the active workspace does not generate or rebuild resume PDFs.

**Design:** Single-column ATS-safe layout using standard CTAN packages (`fontawesome5`, `enumitem`, `hyperref`, `titlesec`). No custom fonts or external dependencies — uploads directly to Overleaf.

**Usage:** The upstream compile commands are intentionally not available in the
active workspace. Do not run `generate-latex.mjs`, `pdflatex`, or `tectonic` for
Career-Ops resume generation.

**Prerequisites:** `pdflatex` via [MiKTeX](https://miktex.org/) (Windows) or TeX Live (Linux/macOS). First compilation may auto-install missing LaTeX packages. Alternatively, upload the `.tex` file directly to [Overleaf](https://www.overleaf.com) — no local install needed.

**Reference only:** The placeholder tokens and formatting commands are retained
for historical compatibility. Resume source changes require an explicit user
request and must follow `CAREER_OPS.md`.

### portals.example.yml

Starter portal scanner configuration. It contains title filters, company career
URLs, structured ATS settings, external feeds, and search queries. The user's
ignored `portals.yml` controls the active set.

**To activate:** Copy to project root as `portals.yml` and customize `title_filter.positive` keywords for your target roles. Add or remove companies as needed.

### states.yml

Defines the 11 canonical application states (`Triaged`, `Evaluated`, `Applied`,
`Responded`, `Interview`, `Offer`, `Rejected`, `Rejected-at-eval`, `Purged`,
`Discarded`, `SKIP`) with aliases for common variants. All pipeline scripts
validate statuses against this file.

**Do not rename states** -- the dashboard and all scripts depend on these exact IDs. You can add aliases if you encounter new variants that should map to an existing state.
