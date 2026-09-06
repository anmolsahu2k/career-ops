#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  buildHistoricalReviewPack,
  writeHistoricalReviewPack,
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
const outputDir = resolve(String(args.out || '.career-ops-runtime/label-review'));
const pack = buildHistoricalReviewPack({ target });
const written = writeHistoricalReviewPack(pack, outputDir, { target });
process.stdout.write(`${JSON.stringify({
  schema: pack.schema,
  cases: pack.cases.length,
  representative: pack.representative,
  human_approved: pack.human_approved,
  pack_digest: pack.pack_digest,
  files: written,
}, null, 2)}\n`);
