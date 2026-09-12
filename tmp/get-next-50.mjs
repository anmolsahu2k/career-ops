import fs from 'fs';

const apps = fs.readFileSync('ft/data/applications.md', 'utf-8');
const scanTsv = fs.readFileSync('ft/data/scan-results-2026-09-02.tsv', 'utf-8').trim().split('\n');

const next50 = [];
// skip header
for (let i = 1; i < scanTsv.length; i++) {
  const row = scanTsv[i];
  const cols = row.split('\t');
  const url = cols[0];
  const company = cols[1];
  
  // simple check: if company is already in applications.md for today's date, we MIGHT have evaluated it.
  // actually, since we only did Decagon, Anyscale, Langchain, ElevenLabs, let's just skip those companies for now to be safe and get 50 others.
  if (apps.includes(company)) {
     // skip to avoid duplicates for now
     continue;
  }
  
  next50.push(row);
  if (next50.length === 50) break;
}

fs.writeFileSync('tmp/next-50.tsv', next50.join('\n'));
