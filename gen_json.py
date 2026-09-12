import json
lines = [l for l in open('ft/data/carryover-scan-2026-08-13.tsv', encoding='utf-8') if l.startswith('http')][:30]
objs = []
for i, l in enumerate(lines):
    parts = l.strip().split('\t')
    url = parts[0]
    src = parts[4] if len(parts) > 4 else "unknown"
    report_num = 6169 + i
    prompt = f"Use modes/_shared.md and modes/auto-pipeline.md to evaluate this URL: {url}. Its canonical source id is {src}. Its reserved report number is {report_num}. Write the full Block A-G report to ft/reports/COMPANY_SLUG/{report_num}-ROLE_SLUG.md and write a 1-line TSV to ft/batch/tracker-additions/{report_num}.tsv. Infer the company slug and role slug from the URL/JD. Then finish."
    objs.append({
        "TypeName": "self",
        "Role": "Evaluator",
        "Prompt": prompt
    })
open('tmp_subagents.json','w').write(json.dumps(objs, indent=2))
