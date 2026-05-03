#!/usr/bin/env python3
# requirements: stdlib only
"""Bulk-update tracker for Wave E (103 singletons) using agent TSV summaries.

Auto-locates report + cover-letter files under reports/ by row-number prefix.
"""

import re
import sys
from pathlib import Path

CO = Path(__file__).resolve().parent.parent
APPS = CO / "data" / "applications.md"
REPORTS = CO / "reports"

# (row_num, score, status, short_note, has_cover_letter)
WAVE_E = [
    # Batch 00
    (247, 3.2, "Triaged", "Urban Science Detroit MI; sponsorship unknown; SDE PDF; mid-fit auto-data consultancy.", False),
    (248, 0.5, "SKIP", "Parsons Annapolis Junction MD: NSA-adjacent, clearance/citizenship blocker.", False),
    (256, 3.4, "Triaged", "AeroVect Perception Silicon Valley; ROS/lidar gap; MLE PDF; mid-fit autonomous airport vehicles.", False),
    (275, 3.6, "Triaged", "Zettabyte Palo Alto/Taipei AI data-center infra; verify US location; SDE PDF.", False),
    (285, 2.8, "Triaged", "ENFOS environmental SaaS; low brand; verify sponsorship.", False),
    (300, 0.5, "SKIP", "Klaviyo Boston: JD explicitly excludes F-1/OPT/TN. Added to visa-block list.", False),
    (398, 3.4, "Triaged", "TMEIC industrial AI/ML Roanoke VA; MLE PDF; verify export controls.", False),
    (1373, 3.6, "Triaged", "HP SWE Intern Fort Collins CO (DUP of #1374); apply via #1374 only; SDE PDF.", False),
    (1374, 3.6, "Triaged", "HP SWE Intern Fort Collins CO (US-domain version of #1373 — apply HERE).", False),
    (1387, 3.4, "Triaged", "Cadent ad-tech backend NYC; SDE PDF; mid-fit.", False),
    (1393, 0.5, "SKIP", "Globalization Partners UK Northern Ireland; non-US, CPT incompatible.", False),
    (1397, 2.6, "Triaged", "DMA tax-services Fort Wayne IN; sponsorship unlikely.", False),
    (1413, 2.8, "Triaged", "AssetWorks (Volaris) Wayne PA; sponsorship history weak.", False),
    (1428, 3.0, "Triaged", "Wash U IT remote; verify external eligibility.", False),
    (1442, 2.5, "Triaged", "Sandhills Lincoln NE: .NET stack mismatch; in-office; border SKIP.", False),
    (1443, 3.0, "Triaged", "JB&B MEP engineering tooling NYC; $20/hr.", False),
    (1470, 3.4, "Triaged", "Intapp legal SaaS Charlotte NC; SDE PDF.", False),
    (1472, 4.3, "Evaluated", "Cartesian Systems Cambridge MA: Python/PyTorch/Ray/FastAPI/Next.js, MIT-faculty founders, near-perfect ML+systems fit. APPLY.", True),
    (1474, 0.5, "SKIP", "Omnis satellite Venice CA; US-person required.", False),
    (1475, 0.5, "SKIP", "Veeva Pleasanton CA: explicit no H-1B/OPT/TN. Added to visa-block list.", False),
    (1481, 3.6, "Triaged", "Actian Vector AI / RAG fit; MLE PDF; mid-fit.", False),
    (1482, 3.4, "Triaged", "Actian generic SDE; SDE PDF.", False),
    (1492, 1.5, "SKIP", "Applied Materials Huntsville AL: ITAR + Bachelor's-grade mismatch.", False),
    (1493, 3.5, "Triaged", "CIBC bank campus program Chicago IL; verify F-1 sponsorship.", False),
    (1494, 4.1, "Evaluated", "PsiQuantum Palo Alto/Remote: internal Databricks+AWS automation platform, near-mirror of EEG HPC pipeline. APPLY.", True),
    (1496, 0.5, "SKIP", "Teledyne FLIR Newark CA: ITAR/citizenship.", False),

    # Batch 01
    (1505, 4.2, "Triaged", "Judi Health (CapitalRx) Denver/NYC/Remote: UG-targeted (Junior/Senior Fall 2026); confirm Master's route at recruiter screen before applying. CL not pre-staged.", False),
    (1506, 3.4, "Triaged", "Givelify fintech; JD page rendered empty; verify.", False),
    (1507, 3.6, "Triaged", "Creatify Lab gen-AI video startup; sponsorship unsignaled.", False),
    (1508, 3.8, "Triaged", "Baxter International med-device SDE Raleigh NC; Workday JD not fetched, Baxter typically sponsors.", False),
    (1514, 3.7, "Triaged", "Synchrony Financial Canton-Remote OH; verify visa.", False),
    (1517, 4.1, "Evaluated", "Starz US Remote streaming SDE: DRM analog to Byju's reader. APPLY.", True),
    (1518, 1.5, "SKIP", "Neuralink Austin/Fremont: US-citizen-only per CLAUDE.md note.", False),
    (1521, 0.5, "SKIP", "Smiths Detection Edgewood MD: ITAR/EAR US-Person required.", False),
    (1528, 3.5, "Triaged", "Copart auto-auction SDE Dallas TX; Workday JD not fetched.", False),
    (1529, 3.0, "SKIP", "AeroVect DUP of #256; do not double-submit.", False),
    (1530, 4.3, "Evaluated", "Arrowstreet Capital Boston MA quant fund SDE; CMU pipeline. APPLY.", True),
    (1531, 0.5, "SKIP", "Smiths Detection DUP of #1521; ITAR/EAR US-Person.", False),
    (1532, 3.7, "Triaged", "Unwrap.ai full-stack startup; verify CPT.", False),
    (1534, 3.8, "Triaged", "Taara Alphabet X spin-out SDE; sponsorship-friendly historically.", False),
    (1542, 2.8, "Triaged", "Robert Half virtual SDE intern San Ramon; low brand.", False),
    (1565, 2.5, "Triaged", "AAA Mountainwest data analyst Phoenix AZ; visa unlikely.", False),
    (1580, 1.5, "SKIP", "Avride Research Eng Austin TX: explicit 'not offering sponsorship'. Added Avride to visa-block.", False),
    (1581, 1.5, "SKIP", "Avride MLE Austin TX: explicit 'not offering sponsorship'. CLIP track was perfect fit (sad miss).", False),
    (1590, 4.0, "Evaluated", "Bosch ADAS ML Sunnyvale CA: DUP of #1609 already evaluated 4.2/5; cover letter shared.", True),
    (1593, 4.5, "Evaluated", "GM AI/ML Cloud+DevInfra Mountain View CA Master's: bullseye Cloudify+migration fit. PRIMARY GM PICK. APPLY.", True),
    (1607, 2.7, "Triaged", "ConnectPrep edtech data analyst; small org.", False),
    (1612, 3.5, "Triaged", "Mariana Minerals MLE; verify DoD/DoE gating (sister of #177).", False),
    (1613, 4.2, "Evaluated", "Bose ML+DSP Research Framingham MA: EEG signal-processing analog. APPLY.", True),
    (1618, 2.8, "Triaged", "Geosyntec environmental DS/AI; verify federal-contract gating.", False),
    (1619, 3.3, "Triaged", "MSX International Troy MI; auto-consulting tier-2.", False),
    (1627, 4.4, "Evaluated", "SIG (Susquehanna Int'l Group) ML Bala Cynwyd PA/NYC quant fund; CMU pipeline. APPLY.", True),

    # Batch 02
    (1634, 1.5, "SKIP", "Empower AI: federal contractor, clearance/citizenship blocker.", False),
    (1635, 3.0, "Triaged", "Tandem Diabetes QA analyst Barnes CA; medical-device sponsorship risk.", False),
    (1639, 3.6, "Triaged", "iTradeNetwork ML SWE; legit but undergrad-targeted.", False),
    (1648, 2.8, "Triaged", "Triple Ring R&D Newark CA; could not read JD.", False),
    (1661, 1.5, "SKIP", "Realtor.com Austin TX: explicit no-sponsorship clause. Added to visa-block.", False),
    (1673, 4.4, "Evaluated", "Insitro South SF CA top-tier biotech ML; F-1 friendly. APPLY.", True),
    (1681, 3.7, "Triaged", "Zello AI/ML Austin TX speech ML scope; mid-tier.", False),
    (1682, 1.5, "SKIP", "LMI dup of #474; clearance-required.", False),
    (1683, 2.5, "Triaged", "Howden insurance analyst DUAL Dallas; narrow scope.", False),
    (1705, 4.1, "Evaluated", "Juniper Square AI Eng SF CA: Cloudify analog. APPLY.", True),
    (1712, 4.3, "Discarded", "KLA dup of #1713 already in tracker as 4.3/5; do not double-apply.", False),
    (1727, 3.0, "Triaged", "Bose embedded/audio firmware Binghamton NY; weak stack fit.", False),
    (1729, 2.8, "Triaged", "DiDi simulation San Jose CA; C++/CUDA mismatch + China parent risk.", False),
    (1734, 1.0, "SKIP", "Space Kinetic El Segundo CA: ITAR US-person required.", False),
    (1771, 2.2, "Triaged", "Particle Measuring Systems Niwot CO embedded; weak fit.", False),
    (1790, 4.5, "Evaluated", "Adobe AI/ML DS San Jose CA R160440: brand+sponsor green. APPLY (verify no overlap with prior Adobe reqs).", True),
    (1795, 1.0, "Discarded", "NY Life NYC posting filled.", False),
    (1796, 3.8, "Triaged", "Wealth.com Applied Scientist Remote-US; estate-doc NLP; Lever 403 risk.", False),
    (1798, 1.0, "Discarded", "ENGIE Houston TX posting unavailable.", False),
    (1799, 1.0, "Discarded", "ENGIE Columbus OH posting unavailable.", False),
    (1802, 3.7, "Triaged", "Nintendo NTD analytics SWE Redmond WA; Taleo down at fetch.", False),
    (1814, 2.5, "Triaged", "Hyperspectral device SWE SF CA; embedded/firmware mismatch.", False),
    (1820, 1.0, "SKIP", "GTRI CIPHER Atlanta GA: cleared lab + Spring 2026 closed.", False),
    (1822, 3.5, "Triaged", "Tokyo Electron US semicap SWE San Jose CA; F-1 friendly.", False),
    (1824, 4.2, "Evaluated", "Cohesity Santa Clara CA backup/anomaly ML; sponsors. APPLY.", True),
    (1832, 4.6, "Evaluated", "Quora Poe MLE Remote US: STRONGEST Cloudify analog in entire pipeline. APPLY (top pick).", True),

    # Batch 03
    (1839, 3.6, "Triaged", "HCSC DevOps Chicago IL; Highmark hook; sponsor unknown.", False),
    (1851, 3.5, "Triaged", "Copart DevOps Dallas TX; mid-tier; sponsor unknown.", False),
    (1861, 4.2, "Evaluated", "Second Dinner AI/ML (Marvel Snap) verify hybrid/remote; rank-prediction analog. APPLY.", True),
    (1864, 1.5, "SKIP", "Marvell Bachelor's-only Santa Clara; Anmol is Master's.", False),
    (1882, 4.2, "Evaluated", "Nordstrom Corp SWE Seattle WA: e-comm direct match. APPLY.", True),
    (1885, 3.8, "Triaged", "PTC SRE/SWE Boston MA; mid-tier.", False),
    (1890, 1.0, "SKIP", "Alaska Air Seattle WA: 410 Gone + airline US-person likely.", False),
    (1893, 3.6, "Triaged", "Token Metrics Remote crypto LLM; verify W-2 vs 1099 for CPT.", False),
    (1896, 3.7, "Triaged", "ConnectPrep DA edtech overlap with Byju's.", False),
    (1906, 0.0, "Discarded", "AbbVie expired.", False),
    (1918, 0.5, "SKIP", "Veryable UNPAID; CPT non-viable.", False),
    (1921, 0.0, "Discarded", "BMW Salt Lake City filled; Spring 2026 past.", False),
    (1925, 1.0, "SKIP", "Reliable Robotics Mountain View CA: ITAR/US-person.", False),
    (1932, 3.7, "Triaged", "Graco AI Eng Minneapolis MN industrial AI; Cloudify hook.", False),
    (1936, 4.5, "Evaluated", "Marvell AI Platform Engineer Intern Agentic Master's Santa Clara CA: Cloudify 1:1 match. TOP PICK BATCH 03. APPLY.", True),
    (1967, 0.0, "Discarded", "MAG Phoenix AZ closed + .NET stack mismatch.", False),
    (1973, 4.3, "Evaluated", "Point72 Cubist Data Scientist NYC: verify URL (may have moved). APPLY.", True),
    (227, 3.5, "Triaged", "Remedy Scientific small biotech.", False),
    (232, 4.0, "Evaluated", "Farsight AI agentic forecasting fit. APPLY.", True),
    (194, 3.4, "Triaged", "Tessera Labs Frontend-only.", False),
    (198, 4.1, "Evaluated", "BigCommerce TS Full Stack Atlanta GA: e-comm match. APPLY.", True),
    (150, 3.4, "Triaged", "Axway SWE; possible dup of report 024 (existing).", False),
    (106, 3.2, "Triaged", "Altom Transport petrochemical hazmat; small Indianapolis area.", False),
    (112, 3.5, "Triaged", "Rainmaker; verify which company; Lever 403.", False),
    (131, 3.7, "Triaged", "AssetMark wealth-tech Austin TX; Spring Boot match.", False),
]


def find_report(num):
    """Find a report file matching {num}-*-2026-05-02.md or older dates."""
    candidates = sorted(REPORTS.glob(f"{num}-*-2026-05-0*.md"))
    candidates = [c for c in candidates if "cover-letter" not in c.name]
    if candidates:
        return candidates[0].name
    return None


def find_cover_letter(num):
    candidates = sorted(REPORTS.glob(f"{num}-*-cover-letter.md"))
    if candidates:
        return candidates[0].name
    return None


def main():
    text = APPS.read_text(encoding="utf-8")
    lines = text.split("\n")
    by_num = {}
    for n, score, status, note, cl in WAVE_E:
        by_num[n] = (score, status, note, cl)

    updated = 0
    missing_reports = []

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
        score, status, note, has_cl = by_num[num]

        report_file = find_report(num)
        if not report_file:
            missing_reports.append(num)
            report_link = "[" + str(num) + "](reports/pending.md)"
        else:
            report_link = f"[{num}](reports/{report_file})"

        # Pull URL from existing notes
        m = re.search(r"https?://\S+", cells[9])
        url = m.group(0).rstrip(".,;)") if m else ""

        cells[5] = f"{score:.1f}/5"
        cells[6] = status
        cells[7] = "❌"
        cells[8] = report_link

        if has_cl:
            cl_file = find_cover_letter(num)
            if cl_file:
                cells[9] = f"CL: [{cl_file}](reports/{cl_file}). {note} URL: {url}"
            else:
                cells[9] = f"{note} URL: {url}"
        else:
            cells[9] = f"{note} URL: {url}"

        lines[i] = "|".join(cells)
        updated += 1

    APPS.write_text("\n".join(lines), encoding="utf-8")
    print(f"updated {updated} rows in {APPS}")
    if missing_reports:
        print(f"WARNING: missing report files for {len(missing_reports)} rows: {missing_reports}")


if __name__ == "__main__":
    main()
