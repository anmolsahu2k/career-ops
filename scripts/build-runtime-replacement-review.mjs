#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';
import {
  buildHistoricalReplacementReviewPack,
  resolveHistoricalReport,
} from '../lib/runtime/label-review.mjs';

function flags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith('--') ? argv[++index] : true;
  }
  return parsed;
}

const args = flags(process.argv.slice(2));
const target = resolve(String(args.target || 'ft'));
const source = resolve(String(args.source || '.career-ops-runtime/qualification-sets/historical-recommendations-v1.json'));
const output = resolve(String(args.out || '.career-ops-runtime/label-review/historical-replacement-review-v1.json'));
const replacementCaseIds = String(args.cases || 'HIST-042,HIST-043,HIST-048,HIST-049').split(',').map(value => value.trim());
const replacementTrackerRows = String(args.rows || '5236,5237,5242,5243').split(',').map(Number);
const replacementReason = String(args.reason || 'INCOMPLETE_SOURCE').toUpperCase();
const recommendationSet = JSON.parse(readFileSync(source, 'utf8'));
const pack = buildHistoricalReplacementReviewPack({ target, recommendationSet, replacementCaseIds, replacementTrackerRows, replacementReason });

const trackerLines = readFileSync(resolve(target, 'data/applications.md'), 'utf8').split(/\r?\n/);
const columns = resolveColumns(trackerLines);
const rows = new Map(trackerLines.map(line => parseTrackerRow(line, columns)).filter(Boolean).map(row => [row.num, row]));
const markdownPath = output.replace(/\.json$/i, '.md');
const indexPath = output.replace(/\.json$/i, '-local-index.md');
const outputDir = dirname(output);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const markdown = [
  '# Historical Replacement Review',
  '',
  `These recommendation-only cases replace sources for reason \`${pack.replacement_reason}\`. Each proposed label matches the replacement report's explicit outcome. Gate labels remain out of scope.`,
  '',
  ...pack.replacements.flatMap(item => [
    `## ${item.case_id} (replaces ${item.replaces_case_id})`,
    '',
    `- Proposed recommendation: \`${item.proposed_recommendation}\``,
    `- Tracker row: ${item.source.tracker_row_number}`,
    `- Archetype: ${item.role_archetype}`,
    `- [ ] Approve, or record a correction:`,
    '',
  ]),
].join('\n');
const index = [
  '# Local Replacement Source Index — Do Not Send to Providers',
  '',
  '| Case | Tracker row | Company | Role | Source report |',
  '|---|---:|---|---|---|',
  ...pack.replacements.map(item => {
    const row = rows.get(item.source.tracker_row_number);
    const report = row ? resolveHistoricalReport(target, row.report) : null;
    const link = report
      ? relative(outputDir, report).split(sep).map(encodeURIComponent).join('/')
      : null;
    return `| ${item.case_id} | ${item.source.tracker_row_number} | ${row?.company || 'Missing'} | ${row?.role || 'Missing'} | ${link ? `[Open source](${link})` : 'Missing'} |`;
  }),
].join('\n');
writeFileSync(output, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
writeFileSync(markdownPath, `${markdown}\n`, { flag: 'wx', mode: 0o600 });
writeFileSync(indexPath, `${index}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  schema: pack.schema,
  replacement_count: pack.replacement_count,
  pack_digest: pack.pack_digest,
  output,
  markdown: markdownPath,
  local_index: indexPath,
}, null, 2)}\n`);
