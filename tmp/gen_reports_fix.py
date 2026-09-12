import os

DATE = "2026-09-02"
TRACKER_DIR = "/Users/anmolsahu2k/Stuff/Create/career-ops/ft/batch/tracker-additions"

jobs = [
    {
        "num": "5270", "company": "RedLattice", "role": "Software Engineer", 
        "url": "https://redlattice.hrmdirect.com/employment/job-opening.php?req=3754640&req_loc=1388400",
        "score": "0.0/5", "status": "Rejected-at-eval", "notes": "CITIZEN-ONLY: yes. Clearance required. N/A (off-target). SRC: freehire", "resume": "N/A"
    },
    {
        "num": "5271", "company": "Pantherx Specialty LLC", "role": "Software Engineer", 
        "url": "https://pantherxrare.hrmdirect.com/employment/job-opening.php?req=3781190&req_loc=1421331",
        "score": "1.0/5", "status": "Rejected-at-eval", "notes": "Off-target tech stack (C#/.NET). N/A (off-target). SRC: freehire", "resume": "N/A"
    },
    {
        "num": "5272", "company": "Orbis Operations", "role": "Software Engineer", 
        "url": "https://orbisoperations.hrmdirect.com/employment/job-opening.php?req=3694466&req_loc=1296582",
        "score": "0.0/5", "status": "Rejected-at-eval", "notes": "CITIZEN-ONLY: yes. Clearance required. N/A (off-target). SRC: freehire", "resume": "N/A"
    },
    {
        "num": "5273", "company": "AmpliFI Loyalty Solutions", "role": "Software Engineer", 
        "url": "https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=8a7883d07acff70f017aea16411d064b&id=8a7885a89f8b940c019f90b8021853a4",
        "score": "1.5/5", "status": "Rejected-at-eval", "notes": "Level mismatch (Architect level). N/A (off-target). SRC: freehire", "resume": "N/A"
    },
    {
        "num": "5274", "company": "RevSpring", "role": "Software Engineer", 
        "url": "https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=8a7883d0798f66af0179905b7890010b&id=8a7887a19fd3ba90019ffb6cf2f35e4e",
        "score": "4.5/5", "status": "Evaluated", "notes": "Submit SDE resume. Stack match. SRC: freehire", "resume": "SDE"
    }
]

os.makedirs(TRACKER_DIR, exist_ok=True)

for job in jobs:
    indiv_tsv = os.path.join(TRACKER_DIR, f"{job['num']}.tsv")
    
    # recreate slugs identical to what we used for report path
    # actually let's re-generate the reports as well to be safe with correct URLs and content
    company_slug = job["company"].replace(" ", "-").lower()
    role_slug = job["role"].replace(" ", "-").lower()
    
    report_path = f"reports/{company_slug}/{job['num']}-{role_slug}-{DATE}.md"
    
    with open(indiv_tsv, "w") as ind_f:
        ind_f.write(f"{job['num']}\t{DATE}\t{job['company']}\t{job['role']}\t{job['score']}\t{job['status']}\t{job['url']}\t[{job['num']}]({report_path})\t{job['notes']}\n")
