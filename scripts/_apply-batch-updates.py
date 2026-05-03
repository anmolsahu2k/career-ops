#!/usr/bin/env python3
# requirements: stdlib only
"""One-shot updater for the 13 rows completed across Wave A and partial Wave B."""

import re
from pathlib import Path

CO = Path(__file__).resolve().parent.parent
APPS = CO / "data" / "applications.md"

# (row_num, score, status, report_link, cl_link_or_None, summary_note)
UPDATES = [
    (712, "4.4/5", "Evaluated",
     "[712](reports/712-aurora-innovation-2026-05-01.md)",
     "[712-aurora-innovation-cover-letter.md](reports/712-aurora-innovation-cover-letter.md)",
     "ACTIVE Bay Area/Mountain View/Pittsburgh/Bozeman/Dallas multi-office. Sponsorship GREEN (F-1 CPT fine, J-1 only excluded). DevX + Systems-Safety strong fit; Autonomy Sensing C++ stretch. ~$57/hr master's tier. Late in cycle: warm-intro CMU alumni outreach within 48h is high-leverage. SDE PDF."),
    (976, "1.0/5", "Discarded",
     "[976](reports/976-openai-swe-intern-2026-05-01.md)", None,
     "DEAD: Ashby ID 401, posting delisted. KEY FINDING: OpenAI does maintain active Ashby slug `openai` (672 jobs) — re-enable in portals.yml for future scanning."),
    (983, "3.5/5", "Discarded",
     "[983](reports/983-duolingo-swe-2026-05-01.md)", None,
     "DEAD: Greenhouse 404. Pittsburgh HQ. Cover letter shared at #984 (Thrive, stronger fit) for re-post. Watch for re-listing in next cycle."),
    (984, "4.0/5", "Discarded",
     "[984](reports/984-duolingo-swe-thrive-2026-05-01.md)",
     "[984-duolingo-swe-thrive-cover-letter.md](reports/984-duolingo-swe-thrive-cover-letter.md)",
     "DEAD: Greenhouse 404. Pittsburgh HQ. Stronger Duolingo fit (Thrive = retention/habit-loop, maps to Byju's edtech). CL pre-staged for re-post. Monitor careers.duolingo.com."),
    (1205, "2.0/5", "Discarded",
     "[1205](reports/1205-abridge-fullstack-2026-05-01.md)", None,
     "DEAD: Ashby ID 401, posting delisted. PIVOT: Apply to Abridge 'Full Stack Engineering (New Grad)' Ashby ID 55958eb5-109f-4e88-9793-ed2327fc753a — matches Dec 2026 graduation. CMU founder Shiv Rao + Pittsburgh East Liberty office, alumni outreach high-yield."),
    (1395, "4.5/5", "Evaluated",
     "[1395](reports/1395-tiktok-aiml-data-platform-2026-05-01.md)", None,
     "LIVE San Jose. Strong fit (3rd choice within TikTok cluster). #226 Discarded precedent unresolved — user must decide TikTok-family before applying. Cover letter shared at #1818. MLE PDF. CAP: max 2 TikTok apps total."),
    (1503, "3.4/5", "Evaluated",
     "[1503](reports/1503-bytedance-network-security-2026-05-01.md)", None,
     "LIVE San Jose CA. Security-stack stretch (no AppSec coursework, no CTF, Go pivot needed). #226 TikTok Discarded precedent applies (same parent). $45-60/hr + housing. SDE PDF."),
    (1504, "4.0/5", "Evaluated",
     "[1504](reports/1504-bytedance-security-data-2026-05-01.md)",
     "[1504-bytedance-security-data-cover-letter.md](reports/1504-bytedance-security-data-cover-letter.md)",
     "LIVE San Jose CA. AI-agent-safety + security-analytics framing rescues AppSec gap (Cloudify + Highmark + EEG map directly). #226 TikTok-parent precedent applies — user decision needed before submit. SDE PDF."),
    (1818, "4.7/5", "Evaluated",
     "[1818](reports/1818-tiktok-recsys-infra-2026-05-01.md)",
     "[1818-tiktok-recsys-infra-cover-letter.md](reports/1818-tiktok-recsys-infra-cover-letter.md)",
     "STRONGEST TikTok pick. LIVE Seattle/San Jose. EEG CLIP retrieval + Byju's rank-prediction + 200K+ DAU = bullseye for recsys infra. Title says '2025 Summer/Fall' — verify currency before apply. CAP: max 2 TikTok apps. #226 precedent. SDE PDF."),
    (1819, "4.5/5", "Evaluated",
     "[1819](reports/1819-tiktok-mle-risk-2026-05-01.md)", None,
     "LIVE San Jose. 2nd-choice TikTok pick (BRIC = Highmark XGBoost on noisy data analog). Cover letter shared at #1818. CAP applies. #226 precedent. MLE PDF."),
    (1842, "4.5/5", "Evaluated",
     "[1842](reports/1842-tiktok-mle-monetization-2026-05-01.md)", None,
     "LIVE San Jose. Verified JD enforces 2-app cap TikTok-wide. Monetization ML — adjacent fit. Cover letter shared at #1818. #226 precedent. MLE PDF."),
    (1401, "4.0/5", "Evaluated",
     "[1401](reports/1401-cadence-swe-san-jose-2026-05-01.md)",
     "[1401-cadence-swe-cover-letter.md](reports/1401-cadence-swe-cover-letter.md)",
     "Cadence SAN JOSE, R54365 C++ thermal-analysis. Sponsorship GREEN (myvisajobs top employer). Verification: unconfirmed (Workday SPA empty). C++ refresh needed before phone screen — Anmol's prod stack is Java. Apply via External_Careers; #1402 is SKIP-dup. SDE PDF."),
    (1402, "1.0/5", "SKIP",
     "[1401](reports/1401-cadence-swe-san-jose-2026-05-01.md)", None,
     "SKIP-dup of #1401 (Univ_Careers mirror of R54365). Workday flags duplicate applications across portals. Use External_Careers (#1401) only."),
    (1447, "3.9/5", "Evaluated",
     "[1447](reports/1447-cadence-swe-boston-2026-05-01.md)",
     "[1401-cadence-swe-cover-letter.md](reports/1401-cadence-swe-cover-letter.md)",
     "Cadence BOSTON, R52450 generalist SWE, $32-59/hr. Sponsorship GREEN. Apply as secondary to #1401 with one-line city swap on shared cover letter. #1448 is SKIP-dup. SDE PDF."),
    (1448, "1.0/5", "SKIP",
     "[1447](reports/1447-cadence-swe-boston-2026-05-01.md)", None,
     "SKIP-dup of #1447 (Univ_Careers mirror of R52450). Use External_Careers (#1447) only."),
    (1853, "2.0/5", "SKIP",
     "[1853](reports/1853-highmark-data-analyst-summer-2026-2026-05-01.md)", None,
     "UG-ONLY: JD verbatim 'baccalaureate program', preferred 2027 grad. Anmol is Master's. Two BETTER moves: (1) pursue J270605 'Summer 2026 Data Analytics GRADUATE Intern' (correct cohort) — open new tracker row. (2) Route via existing CMU-Heinz Highmark cancer-staging collaboration — warm intro highest-EV."),
    (1854, "2.0/5", "SKIP",
     "[1854](reports/1854-highmark-data-analyst-summer-2025-2026-05-01.md)", None,
     "Same UG-only Highmark req as #1853 (twin sub-team, Penn Avenue Place). 'Summer-2025' in URL is Workday slug-recycling — body is actually Summer 2026. SKIP — pursue J270605 grad-track instead."),
    (1468, "1.5/5", "SKIP",
     "[1468](reports/1468-earnin-swe-backend-2026-05-01.md)", None,
     "EARNIN VISA-BLOCK: JD verbatim 'We are unable to provide visa sponsorship or immigration support'. Mountain View hybrid $30/hr. Strong Spring/Java fit if not blocked. Added EarnIn to pre-filter."),
    (1484, "4.4/5", "Evaluated",
     "[1484](reports/1484-snyk-swe-container-2026-05-01.md)",
     "[1484-snyk-cover-letter.md](reports/1484-snyk-cover-letter.md)",
     "Snyk SWE Intern Container Boston, LIVE, sponsorship GREEN (silent — verify at screen). PRIMARY Snyk pick. Cloudify multi-agent + AWS-to-GCP + cloud-native maps line-for-line to JD. Boston relocation required (Office Based, no remote). SDE PDF. APPLY."),
    (1512, "4.2/5", "Evaluated",
     "[1512](reports/1512-snyk-swe-2026-05-01.md)",
     "[1484-snyk-cover-letter.md](reports/1484-snyk-cover-letter.md)",
     "Snyk SWE Intern Boston, LIVE, broader scope than #1484. Apply as secondary with one-paragraph cover letter swap. Same Boston Office Based. SDE PDF."),
    (1630, "1.5/5", "SKIP",
     "[1630](reports/1630-earnin-mle-2026-05-01.md)", None,
     "EARNIN VISA-BLOCK (see #1468). MLE role $40/hr Mountain View. Painful SKIP since Highmark+EEG Transformer+Cloudify hit preferred quals exactly."),
    # Bulk SKIP: defense/clearance-required clusters (no agent eval needed)
    (309, "1.0/5", "SKIP", "[309](reports/pending.md)", None,
     "Bulk SKIP: LMI Innovation USPS contracts require US citizenship / public-trust clearance. Defense-adjacent. F-1/CPT not eligible."),
    (474, "1.0/5", "SKIP", "[474](reports/pending.md)", None,
     "Bulk SKIP: LMI Innovation Passport Demand Forecasting (USPS) requires US citizen / clearance."),
    (542, "1.0/5", "SKIP", "[542](reports/pending.md)", None,
     "Bulk SKIP: LMI Innovation USPS AI Engineer requires US citizen / clearance."),
    (1520, "1.0/5", "SKIP", "[1520](reports/pending.md)", None,
     "Bulk SKIP: KBR National Security Solutions (NSS) = active clearance mandatory. F-1/CPT auto-rejected."),
    (1731, "1.0/5", "SKIP", "[1731](reports/pending.md)", None,
     "Bulk SKIP: KBR NSS Software Engineering = active clearance mandatory. F-1/CPT auto-rejected."),
    (399, "1.5/5", "SKIP", "[399](reports/pending.md)", None,
     "Bulk SKIP: HNTB GIS Data Scientist Tallahassee. No GIS background; civil-eng consulting domain mismatch. Anmol's stack is web/ML not geospatial."),
    (1576, "1.5/5", "SKIP", "[399](reports/pending.md)", None,
     "Bulk SKIP-dup of #399 (HNTB GIS DS, different ATS portal mirror)."),
    (1577, "1.5/5", "SKIP", "[399](reports/pending.md)", None,
     "Bulk SKIP-dup of #399 (HNTB GIS DS, university_careers portal mirror)."),
    (1390, "4.4/5", "Evaluated",
     "[1390](reports/1390-quadric-compiler-2026-05-01.md)", None,
     "Quadric Compiler Intern Burlingame CA on-site, $45-60/hr, $30M Series C. LIVE. Sponsorship CLEAN (no ITAR/US-Person/no-sponsorship). C++ undergrad gap — needs 2-week prep before screen. Apply ONLY to #1725 (stronger fit) FIRST, fall back to this if rejected. SDE PDF."),
    (1725, "4.5/5", "Evaluated",
     "[1725](reports/1725-quadric-kernels-2026-05-01.md)",
     "[1725-quadric-kernels-cover-letter.md](reports/1725-quadric-kernels-cover-letter.md)",
     "Quadric Kernels Intern Burlingame CA on-site, $45-60/hr. PRIMARY Quadric pick (EEG/PSC HPC maps tighter to kernels than to compiler IR). Sponsorship clean. C++ gap honestly disclosed in CL with 2-week prep plan. SDE PDF. APPLY."),
    (1476, "1.5/5", "Discarded",
     "[1476](reports/1476-preferred-risk-fullstack-csharp-2026-05-01.md)", None,
     "Preferred Risk C#/.NET Bedford Park IL: CLOSED ('THIS POSITION HAS BEEN CLOSED'). Same employer template likely visa-block."),
    (1477, "1.8/5", "SKIP",
     "[1477](reports/1477-preferred-risk-fullstack-java-2026-05-01.md)", None,
     "Preferred Risk Java Intern Bedford Park IL: HARD VISA-BLOCK 'Must be able to work in U.S. without sponsorship'. Tech fit was 3.6 (Spring Boot match) but blocked. $16-20/hr seasonal. Added PRIS to pre-filter."),
    (1793, "4.4/5", "Evaluated",
     "[1793](reports/1793-vsp-vision-swe-eyefinity-2026-05-01.md)",
     "[1793-vsp-vision-swe-eyefinity-cover-letter.md](reports/1793-vsp-vision-swe-eyefinity-cover-letter.md)",
     "VSP Vision SWE Eyefinity, Remote-US. LIVE (cross-confirmed Prosple/Talentify). Sponsorship low risk (H-1B history, no citizenship-only language). Highmark direct healthcare analog. SDE PDF. APPLY."),
    (1794, "2.8/5", "SKIP",
     "[1794](reports/1794-vsp-vision-sap-swe-2026-05-01.md)", None,
     "VSP Vision SAP SWE Remote-US: SKIP. SAP-specific stack mismatch. Cover letter shared at #1793 if forced apply (don't double-apply within VSP)."),
    (1930, "1.5/5", "Discarded",
     "[1930](reports/1930-lumen-devops-2026-05-01.md)", None,
     "Lumen DevOps Intern: CLOSED ('This job requisition is no longer posted')."),
    (1938, "1.5/5", "Discarded",
     "[1938](reports/1938-lumen-data-analyst-2026-05-01.md)", None,
     "Lumen Data Analyst Intern: CLOSED."),
    (1651, "2.7/5", "SKIP",
     "[1651](reports/1651-kla-data-analyst-2026-05-01.md)", None,
     "KLA Marketing Analyst Intern Milpitas: SKIP (marketing scope mismatch). $25-36/hr."),
    (1713, "4.3/5", "Evaluated",
     "[1713](reports/1713-kla-aiml-2026-05-01.md)",
     "[1713-kla-aiml-cover-letter.md](reports/1713-kla-aiml-cover-letter.md)",
     "KLA AI/ML Intern Milpitas CA onsite, $34-56/hr. LIVE. ITAR/EAR scope MUST be verified at recruiter screen (KLA wafer-inspection IP export-controlled). AI/ML+agentic scope likely non-restricted. MLE PDF. APPLY (with caveat)."),
    (1609, "4.2/5", "Evaluated",
     "[1609](reports/1609-bosch-automated-driving-mle-2026-05-01.md)",
     "[1609-bosch-automated-driving-mle-cover-letter.md](reports/1609-bosch-automated-driving-mle-cover-letter.md)",
     "Bosch ADAS MLE Sunnyvale CA (Bosch RTC-NA, NOT Venture Capital — aggregator misclass). LIVE. Sponsorship: F-1 history present, no explicit language; verify at recruiter screen. Cloudify multi-agent + EEG sequence/HPC + AWS-to-GCP. MLE PDF. APPLY."),
    (1740, "1.5/5", "SKIP",
     "[1740](reports/1740-bosch-swe-coop-2026-05-01.md)", None,
     "Bosch Rexroth SC SWE Co-op: HARD VISA-BLOCK. JD verbatim 'Indefinite U.S. work authorized individuals only. Future sponsorship for work authorization unavailable.' F-1 = NO."),
    (1579, "2.4/5", "SKIP",
     "[1579](reports/1579-pennstate-data-analyst-2026-05-01.md)", None,
     "Penn State Part-Time Data Analyst (Words as Tools IES grant, College of Education). University Park PA. CPT viable but: low pay, education-research scope mismatch, prefer CMU-internal research instead. Defer to May 8 checkpoint fallback only."),
    (1650, "1.0/5", "SKIP",
     "[1650](reports/1650-pennstate-aiml-rd-2026-05-01.md)", None,
     "Penn State AI/ML R&D: at Applied Research Lab (ARL), a Navy UARC. US citizen + clearance mandatory. F-1 categorically ineligible. Recommend adding arl.psu.edu / 'Applied Research Lab' to pre-filter SKIP-on-sight."),
    (1441, "4.0/5", "Evaluated",
     "[1441](reports/1441-hyundai-infotainment-swe-2026-05-01.md)",
     "[1441-hyundai-infotainment-swe-cover-letter.md](reports/1441-hyundai-infotainment-swe-cover-letter.md)",
     "Hyundai HATCI Infotainment SWE Intern, Superior Charter Township MI hybrid. CPT-eligible (lighter 'must be authorized' wording, NOT 'no future sponsorship'). Cloudify multi-agent (vehicle agent UX) + EEG real-time HMI angle. C++ rampup honestly framed. SDE PDF. APPLY within 48h."),
    (1746, "1.0/5", "SKIP",
     "[1441](reports/1441-hyundai-infotainment-swe-2026-05-01.md)", None,
     "SKIP-dup of #1441 (same Hyundai HATCI req via different aggregator URL)."),
    (1804, "1.5/5", "SKIP",
     "[1804](reports/1804-spglobal-swe-2026-05-01.md)", None,
     "S&P GLOBAL VISA-BLOCK: standard intern policy 'must be authorized to work in the U.S. without current or future visa sponsorship'. NYC. Added to pre-filter."),
    (1805, "1.5/5", "SKIP",
     "[1805](reports/1805-spglobal-de-2026-05-01.md)", None,
     "S&P Global Data Engineer NYC, same visa-block as #1804."),
    (1897, "2.0/5", "SKIP",
     "[1897](reports/1897-sap-ixp-data-scientist-2026-05-01.md)", None,
     "SAP iXp Data Scientist Chicago: CLOSED ('position has been filled') AND visa-block (iXp policy 'no visa sponsorship, requires US permanent'). Added SAP to pre-filter."),
    (1909, "2.0/5", "SKIP",
     "[1909](reports/1909-sap-ixp-ai-engineer-2026-05-01.md)", None,
     "SAP iXp AI Engineer Chicago: CLOSED + visa-block (see #1897)."),
    (1716, "4.2/5", "Evaluated",
     "[1716](reports/1716-skydio-gtm-de-2026-05-01.md)",
     "[1716-skydio-gtm-de-cover-letter.md](reports/1716-skydio-gtm-de-cover-letter.md)",
     "Skydio GTM Data Engineer Intern, San Mateo onsite, $53/hr. SPONSORSHIP CLEAR (no ITAR, CPT-eligible, only E-Verify). JD bullet 'structured datasets that power LLM workflows and AI agents' is direct Cloudify hook. SDE PDF. APPLY."),
    (1878, "0.0/5", "Discarded",
     "[1878](reports/1878-skydio-swe-2026-05-01.md)", None,
     "DEAD: Greenhouse + skydio.com both 404. Not in current Skydio careers listing. Sibling live alternatives: Mobile / Middleware / Embedded / Boston SWE intern reqs."),
    (1879, "0.0/5", "Discarded",
     "[1879](reports/1879-skydio-cloud-swe-2026-05-01.md)", None,
     "DEAD: Greenhouse 404, Ashby UUID 'Job not found', BuiltIn cache says removed 2025-12-15."),
    (1829, "0.0/5", "Discarded",
     "[1829](reports/1829-experian-ml-engineer-2026-05-01.md)", None,
     "EXPIRED: entire Experian Summer 2026 intern wave closed (1829, 1845-1849). Verified via Playwright snapshot 'This job has expired'. ML Engineer would have been strongest fit (Highmark XGBoost analog) if revived. Set SmartRecruiters alert for next cycle. MLE PDF when re-opened."),
    (1845, "0.0/5", "Discarded",
     "[1845](reports/1845-experian-data-analyst-2026-05-01.md)", None,
     "EXPIRED Experian (see #1829). Data Analyst variant."),
    (1846, "0.0/5", "Discarded",
     "[1846](reports/1846-experian-ml-engineer-dup-2026-05-01.md)", None,
     "EXPIRED Experian (see #1829). Dup of ML Engineer slot."),
    (1847, "0.0/5", "Discarded",
     "[1847](reports/1847-experian-platform-data-analyst-2026-05-01.md)", None,
     "EXPIRED Experian (see #1829). Platform Solutions DA variant."),
    (1848, "0.0/5", "Discarded",
     "[1848](reports/1848-experian-fullstack-swe-2026-05-01.md)", None,
     "EXPIRED Experian (see #1829). Full-Stack SWE variant."),
    (1849, "0.0/5", "Discarded",
     "[1849](reports/1849-experian-frontend-swe-2026-05-01.md)", None,
     "EXPIRED Experian (see #1829). Frontend SWE variant."),
    (1900, "1.0/5", "SKIP",
     "[1900](reports/1900-visa-mle-global-data-2026-05-01.md)", None,
     "HARD VISA-BLOCK: Visa JD verbatim 'Will not sponsor applicants for work visas... Future sponsorship will not be considered'. EXPIRED. Added Visa to pre-filter visa-block list."),
    (1903, "1.0/5", "SKIP",
     "[1900](reports/1900-visa-mle-global-data-2026-05-01.md)", None,
     "Visa visa-block applies (see #1900). EXPIRED. Foster City."),
    (1904, "1.0/5", "SKIP",
     "[1900](reports/1900-visa-mle-global-data-2026-05-01.md)", None,
     "Visa visa-block applies (see #1900). EXPIRED. Austin."),
    (1905, "1.0/5", "SKIP",
     "[1900](reports/1900-visa-mle-global-data-2026-05-01.md)", None,
     "Visa visa-block applies (see #1900). EXPIRED. Bellevue."),
]


def main():
    text = APPS.read_text(encoding="utf-8")
    lines = text.split("\n")
    by_num = {}
    for n, score, status, report, cl, note in UPDATES:
        by_num[n] = (score, status, report, cl, note)

    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        cells = line.split("|")
        if len(cells) < 10:
            continue
        try:
            num = int(cells[1].strip())
        except (ValueError, IndexError):
            continue
        if num not in by_num:
            continue
        score, status, report, cl, note = by_num[num]

        # Preserve date + company + role; replace score/status/report/notes.
        cells[5] = score
        cells[6] = status
        cells[7] = "❌"
        cells[8] = report

        # Pull URL from existing notes for preservation.
        m = re.search(r"https?://\S+", cells[9])
        url = m.group(0).rstrip(".,;)") if m else ""

        if cl:
            cells[9] = f"CL: {cl}. {note} URL: {url}"
        else:
            cells[9] = f"{note} URL: {url}"

        lines[i] = "|".join(cells)

    APPS.write_text("\n".join(lines), encoding="utf-8")
    print(f"updated {len(UPDATES)} rows in {APPS}")


if __name__ == "__main__":
    main()
