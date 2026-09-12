import fs from 'fs';

const tsv = fs.readFileSync('tmp/pilot-50.tsv', 'utf-8').trim().split('\n');
const rows = tsv.slice(1);
let num = 5180;

const subagents = [];

for (let i = 0; i < 50; i += 5) {
  const batch = rows.slice(i, i + 5);
  let prompt = "You are a Codex eval worker. Evaluate these URLs following `modes/auto-pipeline.md`. Fetch each JD. Write the full Block A-G report to `ft/reports/{company-slug}/{NN}-{role-slug}-{date}.md` with a `**URL:**` header. Write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv`. Pass the source value into the Notes column with `SRC: {source}` using the canonical ID. End with a summary of the 5 results.\n\n";
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

fs.writeFileSync('tmp/subagents.json', JSON.stringify({ Subagents: subagents }, null, 2));
