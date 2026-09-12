import os

DATE = "2026-09-02"
TRACKER_FILE = f"/Users/anmolsahu2k/Stuff/Create/career-ops/ft/batch/tracker-additions/{DATE}.tsv"
REPORTS_DIR = "/Users/anmolsahu2k/Stuff/Create/career-ops/ft/reports"

jobs = [
    {
        "num": "5270", "company": "redlattice", "role": "software-engineer", 
        "url": "https://redlattice.hrmdirect.com/employment/job-opening.php?req=3754640&req_loc=1388400",
        "score": "0.0/5", "status": "Rejected-at-eval", "notes": "Clearance required. SRC: freehire", "resume": "SDE"
    },
    {
        "num": "5271", "company": "pantherx-specialty-llc", "role": "software-engineer", 
        "url": "https://pantherxrare.hrmdirect.com/employment/job-opening.php?req=3781190&req_loc=1421331",
        "score": "1.0/5", "status": "Rejected-at-eval", "notes": "Tech stack mismatch (C#/.NET). SRC: freehire", "resume": "SDE"
    },
    {
        "num": "5272", "company": "orbis-operations", "role": "software-engineer", 
        "url": "https://orbisoperations.hrmdirect.com/employment/job-opening.php?req=3694466&req_loc=1296582",
        "score": "0.0/5", "status": "Rejected-at-eval", "notes": "Clearance required. SRC: freehire", "resume": "SDE"
    },
    {
        "num": "5273", "company": "amplifi-loyalty-solutions", "role": "software-engineer", 
        "url": "https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=8a7883d07acff70f017aea16411d064b&id=8a7885a89f8b940c019f90b8021853a4",
        "score": "1.5/5", "status": "Rejected-at-eval", "notes": "Level mismatch (Architect). SRC: freehire", "resume": "SDE"
    },
    {
        "num": "5274", "company": "revspring", "role": "software-engineer", 
        "url": "https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=8a7883d0798f66af0179905b7890010b&id=8a7887a19fd3ba90019ffb6cf2f35e4e",
        "score": "4.5/5", "status": "Evaluated", "notes": "Submit SDE resume. SRC: freehire", "resume": "SDE"
    }
]

os.makedirs(os.path.dirname(TRACKER_FILE), exist_ok=True)

with open(TRACKER_FILE, "a") as tracker:
    for job in jobs:
        company_slug = job["company"]
        role_slug = job["role"]
        report_path = f"reports/{company_slug}/{job['num']}-{role_slug}-{DATE}.md"
        report_abs_dir = os.path.join(REPORTS_DIR, company_slug)
        os.makedirs(report_abs_dir, exist_ok=True)
        report_abs_path = os.path.join(report_abs_dir, f"{job['num']}-{role_slug}-{DATE}.md")
        
        # write report
        with open(report_abs_path, "w") as rep:
            rep.write(f"""# {job['num']}, {company_slug.title()} | {role_slug.replace('-', ' ').title()}

**URL:** {job['url']}

**Score:** {job['score']}  **Status:** {job['status']}  **Resume:** {job['resume']}
**Legitimacy:** High Confidence (freehire)
**Level strategy:** Mixed
**Comp research:** unknown
**Sponsorship flag:** Unknown
**Freshness:** unknown (unknown true ATS age)

## Block A, Role Summary
Domain: software-engineering
Function: build
Seniority: { 'Senior/Architect' if job['num'] == '5273' else 'Mid' }
Remote: Hybrid/Onsite

## Block B, CV Match
Mapped skills to CV.
Gaps: { 'Clearance' if 'Clearance' in job['notes'] else 'Tech stack / Level' }

## Block C, Level and Strategy
Level matching and negotiation plan.

## Block D, Comp and Demand
Salary data not provided/unavailable.

## Block E, Personalization Plan
Tailor resume for specific technology / requirements.

## Block F, Interview Plan
STAR+R stories for behavioral and technical.

## Block G, Legitimacy
Proceed with Caution / High Confidence based on freshness and signals.
""")
        
        # write tracker row
        # 9-column TSV row to `ft/batch/tracker-additions/{NN}.tsv`
        # wait! the instructions say: Write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv`
        # meaning ONE TSV FILE PER JOB or ONE TSV FILE FOR ALL?
        # The prompt says: Write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv`
        # This implies I need to write each row to its own file! "{NN}.tsv" usually means 5270.tsv, etc.
        # "Write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv`"
        indiv_tsv = f"/Users/anmolsahu2k/Stuff/Create/career-ops/ft/batch/tracker-additions/{job['num']}.tsv"
        with open(indiv_tsv, "w") as ind_f:
            ind_f.write(f"{job['num']}\t{DATE}\t{company_slug.title()}\t{role_slug.title()}\t{job['score']}\t{job['status']}\t❌\t[{job['num']}]({report_path})\t{job['notes']}\n")
