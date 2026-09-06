#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { reinterpretHistoricalRecommendationTruth } from '../lib/runtime/shadow.mjs';

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

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJson(value, path) {
  const output = resolve(path);
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, output);
  } catch (error) {
    throw new Error(`Could not write recommendation shadow: ${error.message}`);
  }
  return output;
}

const args = flags(process.argv.slice(2));
if (args['accept-final-outcomes-as-recommendations'] !== true) {
  throw new Error('Explicit --accept-final-outcomes-as-recommendations flag is required');
}
if (args['labels-personally-reviewed'] !== true) {
  throw new Error('Explicit --labels-personally-reviewed flag is required');
}
if (!args.suite || !args.run || !args.out || !args.attestation) {
  throw new Error('--suite, --run, --out, and --attestation are required');
}
const result = reinterpretHistoricalRecommendationTruth({
  definition: readJson(args.suite),
  run: readJson(args.run),
  attestationId: String(args.attestation),
  labelsPersonallyReviewed: true,
});
const path = writeJson(result, args.out);
process.stdout.write(`${JSON.stringify({
  schema: result.schema,
  provider_id: result.provider_id,
  model_snapshot: result.model_snapshot,
  sample_count: result.metrics.sample_count,
  recommendation_agreement: result.metrics.recommendation_agreement,
  component_passed: result.component_passed,
  promotion_blockers: result.promotion_blockers,
  path,
}, null, 2)}\n`);
