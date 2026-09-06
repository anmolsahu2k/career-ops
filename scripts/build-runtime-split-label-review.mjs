#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildHistoricalSplitLabelReviewPack,
  writeHistoricalSplitLabelReviewPack,
} from '../lib/runtime/label-review.mjs';

function flags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
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
const source = resolve(String(args.source || '.career-ops-runtime/qualification-sets/historical-recommendations-v6.json'));
const outputDir = resolve(String(args['out-dir'] || '.career-ops-runtime/split-label-review'));
const recommendationSet = JSON.parse(readFileSync(source, 'utf8'));
const pack = buildHistoricalSplitLabelReviewPack({ target, recommendationSet });
const paths = writeHistoricalSplitLabelReviewPack(pack, outputDir, { target });
process.stdout.write(`${JSON.stringify({
  schema: pack.schema,
  case_count: pack.case_count,
  human_approved: pack.human_approved,
  pack_digest: pack.pack_digest,
  ...paths,
}, null, 2)}\n`);
