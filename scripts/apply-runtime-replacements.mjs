#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyHistoricalRecommendationReplacements,
  writeApprovedRecommendationSet,
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
if (args['human-approved'] !== true || !args.attestation) {
  throw new Error('Replacement apply requires --human-approved and --attestation');
}
const source = resolve(String(args.source || '.career-ops-runtime/qualification-sets/historical-recommendations-v1.json'));
const packPath = resolve(String(args.pack || '.career-ops-runtime/label-review/historical-replacement-review-v1.json'));
const output = resolve(String(args.out || '.career-ops-runtime/qualification-sets/historical-recommendations-v2.json'));
const audit = args.audit ? JSON.parse(readFileSync(resolve(String(args.audit)), 'utf8')) : null;
const set = applyHistoricalRecommendationReplacements({
  recommendationSet: JSON.parse(readFileSync(source, 'utf8')),
  replacementPack: JSON.parse(readFileSync(packPath, 'utf8')),
  attestationId: String(args.attestation),
  audit,
});
const path = writeApprovedRecommendationSet(set, output);
process.stdout.write(`${JSON.stringify({
  schema: set.schema,
  evaluation_set_version: set.evaluation_set_version,
  cases: set.cases.length,
  replaced_case_ids: set.revision.replaced_case_ids,
  set_digest: set.set_digest,
  path,
}, null, 2)}\n`);
