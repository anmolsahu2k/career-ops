import fs from 'fs';
const content = fs.readFileSync('ft/batch/tracker-additions/merged/5215.tsv', 'utf-8').trim();
let parts = content.split('\t').map(s => s.trim());
console.log(parts);
