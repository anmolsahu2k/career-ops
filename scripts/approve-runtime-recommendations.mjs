#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveHistoricalRecommendations,
  writeApprovedRecommendationSet,
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
if (args['human-approved'] !== true) throw new Error('Explicit --human-approved flag is required');
if (!args.attestation) throw new Error('--attestation is required');
const source = resolve(String(args.source || '.career-ops-runtime/label-review/historical-label-review-v1.json'));
const output = resolve(String(args.out || '.career-ops-runtime/qualification-sets/historical-recommendations-v1.json'));
const audit = args.audit ? JSON.parse(readFileSync(resolve(String(args.audit)), 'utf8')) : null;
const pack = JSON.parse(readFileSync(source, 'utf8'));
const set = approveHistoricalRecommendations(pack, {
  attestationId: String(args.attestation),
  audit,
});
const path = writeApprovedRecommendationSet(set, output);
process.stdout.write(`${JSON.stringify({
  schema: set.schema,
  cases: set.cases.length,
  representative: set.representative,
  human_approved: set.human_approved,
  gate_labels_included: set.gate_labels_included,
  audit_decision: set.independent_audit?.decision || null,
  set_digest: set.set_digest,
  path,
}, null, 2)}\n`);
