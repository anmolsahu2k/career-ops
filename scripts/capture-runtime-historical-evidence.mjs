#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';
import { captureHistoricalEvidence, writeHistoricalEvidenceCache } from '../lib/runtime/historical-evidence.mjs';
import { resolveHistoricalReport } from '../lib/runtime/label-review.mjs';

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
if (args.apply !== true) throw new Error('Evidence capture writes local cache files and requires --apply');
const target = resolve(String(args.target || 'ft'));
const source = resolve(String(args.source || '.career-ops-runtime/qualification-sets/historical-recommendations-v3.json'));
const outputDir = resolve(String(args.out || '.career-ops-runtime/historical-evidence'));
const set = JSON.parse(readFileSync(source, 'utf8'));
const tracker = readFileSync(join(target, 'data', 'applications.md'), 'utf8').split(/\r?\n/);
const columns = resolveColumns(tracker);
const rows = new Map(tracker.map(line => parseTrackerRow(line, columns)).filter(Boolean).map(row => [row.num, row]));
const candidates = set.cases.flatMap(item => {
  const row = rows.get(item.source?.tracker_row_number);
  const reportPath = row ? resolveHistoricalReport(target, row.report) : null;
  if (!row || !reportPath || !/Pending Evaluation Stub/i.test(readFileSync(reportPath, 'utf8'))) return [];
  const url = String(row.notes || '').match(/\bURL:\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[.)]+$/, '');
  if (!url) throw new Error(`Missing source URL for ${item.case_id}`);
  return [{ caseId: item.case_id, sourceUrl: url, expectedTitle: row.role }];
});
const entries = await Promise.all(candidates.map(item => captureHistoricalEvidence(item)));
writeHistoricalEvidenceCache(entries, outputDir);
process.stdout.write(`${JSON.stringify({
  schema: 'HistoricalEvidenceCaptureResultV1',
  schema_version: 1,
  captured: entries.length,
  complete: entries.filter(item => item.complete).length,
  incomplete: entries.filter(item => !item.complete).length,
  results: entries.map(item => ({
    case_id: item.case_id,
    source_type: item.source_type,
    complete: item.complete,
    error_code: item.error_code,
    http_status: item.http_status || null,
  })),
  output_dir: outputDir,
}, null, 2)}\n`);
