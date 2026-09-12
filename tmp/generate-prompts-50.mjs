import fs from 'fs';

const rows = fs.readFileSync('tmp/next-50.tsv', 'utf-8').trim().split('\n');
let num = 5230;

const subagents = [];

for (let i = 0; i < 50; i += 5) {
  const batch = rows.slice(i, i + 5);
  if (batch.length === 0) break;
  let prompt = "You are a Codex eval worker. Evaluate these URLs following `modes/auto-pipeline.md`. To fetch the JD, you MUST use the `run_command` tool with `BypassSandbox: true` and run EXACTLY: `python3 tmp/fetch-jd.py \"<url>\"`. This will fetch the JD HTML. Write the full Block A-G report to `ft/reports/{company-slug}/{NN}-{role-slug}-{date}.md` with a `**URL:**` header. Write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv` where the columns are EXACTLY: ID, Date, Company, Role, Score, Status, Link, Report, Notes. IMPORTANT: Make sure the Score column ends with `/5` (e.g., `4.5/5`). Pass the source value into the Notes column with `SRC: {source}` using the canonical ID. End with a summary of the 5 results.\n\n";
  for (const row of batch) {
    const cols = row.split('\t');
    const url = cols[0];
    const src = cols[4];
    prompt += `- URL: ${url}\n  Source: ${src}\n  Report Num: ${num}\n`;
    num++;
  }
  
  subagents.push({
    TypeName: 'career_ops_eval_worker',
    Role: 'Career Ops Evaluator',
    Prompt: prompt
  });
}

fs.writeFileSync('tmp/subagents-50.json', JSON.stringify({ Subagents: subagents }, null, 2));
