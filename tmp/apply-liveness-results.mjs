import fs from 'fs';
import path from 'path';

const tsvPath = 'ft/data/scan-results-2026-09-02.tsv';
const historyPath = 'ft/data/scan-history.tsv';
const livenessPath = 'tmp/scan-liveness.tsv';
const resultsOutPath = 'ft/data/scan-results-2026-09-02-live.tsv';

if (!fs.existsSync(livenessPath)) {
  console.log("Liveness results not found.");
  process.exit(1);
}

const livenessLines = fs.readFileSync(livenessPath, 'utf8').trim().split('\n');
const expiredUrls = new Set();
for (const line of livenessLines) {
  const [url, status, _1, err] = line.split('\t');
  if (status === 'expired') {
    expiredUrls.add(url);
  }
}

const content = fs.readFileSync(tsvPath, 'utf8').trim().split('\n');
const header = content[0];
const rows = content.slice(1);

const historyLines = [];
const keepRows = [];

for (const row of rows) {
  const cols = row.split('\t');
  if (cols.length < 5) continue;
  const url = cols[0];
  
  if (expiredUrls.has(url)) {
    historyLines.push(`${url}\t2026-09-02\tliveness\t${cols[2]}\t${cols[1]}\tskipped_expired\tliveness-gate`);
  } else {
    keepRows.push(row);
  }
}

fs.writeFileSync(resultsOutPath, [header, ...keepRows].join('\n') + '\n');
fs.appendFileSync(historyPath, historyLines.length > 0 ? '\n' + historyLines.join('\n') + '\n' : '');

console.log(`Filtered out ${historyLines.length} expired rows.`);
console.log(`Kept ${keepRows.length} active/uncertain rows.`);
