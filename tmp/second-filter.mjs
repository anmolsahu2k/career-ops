import fs from 'fs';
import path from 'path';

const tsvPath = 'ft/data/scan-results-2026-09-02.tsv';
const historyPath = 'ft/data/scan-history.tsv';
const urlsPath = 'tmp/scan-urls.txt';
const resultsOutPath = 'ft/data/scan-results-2026-09-02-filtered.tsv';

const content = fs.readFileSync(tsvPath, 'utf8').trim().split('\n');
const header = content[0];
const rows = content.slice(1);

const denyKeywords = [
  'intern', 'co-op', 'apprentice', 'sales', 'gtm', 'marketing', 'hr', 'legal', 
  'finance', 'senior', 'staff', 'principal', 'caregiver', 'manager', 'director', 
  'vp', 'president', 'lead'
];

const historyLines = [];
const keepRows = [];
const urls = [];

for (const row of rows) {
  const cols = row.split('\t');
  if (cols.length < 5) continue;
  const url = cols[0];
  const title = cols[2].toLowerCase();
  
  const badWord = denyKeywords.find(kw => {
      // basic word boundary check
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(title);
  });
  
  if (badWord || title.includes('sr.') || title.includes('sr ') || title.includes('ii') || title.includes('iii') || title.includes(' iv')) {
    const reason = badWord ? badWord : 'seniority/level';
    historyLines.push(`${url}\t2026-09-02\tsecond_filter\t${cols[2]}\t${cols[1]}\tskipped_filter\t${reason}`);
  } else {
    keepRows.push(row);
    urls.push(url);
  }
}

fs.writeFileSync(resultsOutPath, [header, ...keepRows].join('\n') + '\n');
fs.writeFileSync(urlsPath, urls.join('\n') + '\n');
fs.appendFileSync(historyPath, historyLines.length > 0 ? '\n' + historyLines.join('\n') + '\n' : '');

console.log(`Filtered out ${historyLines.length} rows.`);
console.log(`Kept ${keepRows.length} rows. URLs written to ${urlsPath}`);
