import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

config();
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

const shared = readFileSync('modes/_shared.md', 'utf-8');
const pipeline = readFileSync('modes/auto-pipeline.md', 'utf-8');
const cv = readFileSync('cv.md', 'utf-8');

const tsv = readFileSync('tmp/next-50.tsv', 'utf-8').trim().split('\n');
const today = '2026-09-02';
let num = 5230;

for (const row of tsv) {
  const cols = row.split('\t');
  if (cols.length < 5) continue;
  const url = cols[0];
  const source = cols[4];
  
  console.log(`\n======================================================`);
  console.log(`[${num}] Processing: ${url}`);
  
  let html;
  try {
    // using the exact fetch script the user approved
    html = execSync(`python3 tmp/fetch-jd.py "${url}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err) {
    console.error(`Failed to fetch ${url}`);
    // write a failed row
    const failRow = `${num}\t${today}\tUnknown\tUnknown\t0.0/5\tRejected-at-eval\t❌\t[${num}](reports/unknown.md)\tFetch failed. SRC: ${source}`;
    writeFileSync(`ft/batch/tracker-additions/${num}.tsv`, failRow);
    num++;
    continue;
  }
  
  if (!html || html.trim().length < 50) {
    console.error(`Empty fetch for ${url}`);
    const failRow = `${num}\t${today}\tUnknown\tUnknown\t0.0/5\tRejected-at-eval\t❌\t[${num}](reports/unknown.md)\tEmpty fetch. SRC: ${source}`;
    writeFileSync(`ft/batch/tracker-additions/${num}.tsv`, failRow);
    num++;
    continue;
  }
  
  const systemPrompt = `You are a Career Ops Eval Worker. Evaluate the job description below.
Rules:
1. Follow the Block A-G evaluation rubrics in modes/_shared.md and modes/auto-pipeline.md.
2. The user resume is provided below.
3. At the very end, output a machine-readable summary block in this EXACT format:

---SCORE_SUMMARY---
COMPANY: <company name>
ROLE: <role title>
SCORE: <global score as decimal, e.g. 4.5>
---END_SUMMARY---

Context:
_shared.md:
${shared}

auto-pipeline.md:
${pipeline}

cv.md:
${cv}
`;

  console.log(`Calling Gemini...`);
  try {
    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `JOB URL: ${url}\n\nJOB HTML:\n${html.substring(0, 30000)}` }
    ]);
    const text = result.response.text();
    
    let company = 'Unknown';
    let role = 'Unknown';
    let score = '0.0';
    
    const summaryMatch = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
    if (summaryMatch) {
      const block = summaryMatch[1];
      const ex = (key) => {
        const m = block.match(new RegExp(`${key}:\\s*(.+)`));
        return m ? m[1].trim() : 'Unknown';
      };
      company = ex('COMPANY');
      role = ex('ROLE');
      score = ex('SCORE');
    }
    
    const cslug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    const rslug = role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
    
    const reportDir = `ft/reports/${cslug}`;
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    
    const reportPath = `${reportDir}/${num}-${rslug}-${today}.md`;
    
    const finalReport = `**URL:** ${url}

${text.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;
    writeFileSync(reportPath, finalReport);
    
    const status = parseFloat(score) >= 3.5 ? 'Evaluated' : 'Rejected-at-eval';
    const tsvRow = `${num}\t${today}\t${company}\t${role}\t${score}/5\t${status}\t❌\t[${num}](reports/${cslug}/${num}-${rslug}-${today}.md)\tSRC: ${source}`;
    writeFileSync(`ft/batch/tracker-additions/${num}.tsv`, tsvRow);
    
    console.log(`Saved report ${num} for ${company} - ${role} (Score: ${score}/5)`);
  } catch (err) {
    console.error(`Gemini Error on ${num}:`, err.message);
  }
  
  num++;
  // Wait 4 seconds for rate limit
  await new Promise(r => setTimeout(r, 8000));
}
console.log("Done processing batch.");
