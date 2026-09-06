#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  buildHistoricalQualificationFixtures,
  writeHistoricalQualificationFixtures,
} from '../lib/runtime/historical-fixtures.mjs';
import { readHistoricalEvidenceCache } from '../lib/runtime/historical-evidence.mjs';

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
const source = resolve(String(args.source || '.career-ops-runtime/qualification-sets/historical-recommendations-v3.json'));
const output = resolve(String(args.out || '.career-ops-runtime/qualification-sets/historical-prepared-v5.json'));
const evidenceDir = resolve(String(args['evidence-dir'] || '.career-ops-runtime/historical-evidence'));
const recommendationSet = JSON.parse(readFileSync(source, 'utf8'));
let profile = {};
try { profile = yaml.load(readFileSync(resolve(String(args.profile || 'config/profile.yml')), 'utf8')) || {}; } catch { /* optional local profile */ }
const candidateEvidence = [
  profile.narrative?.headline,
  profile.narrative?.exit_story,
  ...(profile.narrative?.superpowers || []),
  profile.location?.onsite_availability,
  profile.ft_constraints?.work_auth,
].filter(Boolean).join(' ');
const set = buildHistoricalQualificationFixtures({
  target,
  recommendationSet,
  externalEvidenceByCase: readHistoricalEvidenceCache(evidenceDir),
  candidateEvidence,
});
const path = writeHistoricalQualificationFixtures(set, output, { replace: args.replace === true });
process.stdout.write(`${JSON.stringify({
  schema: set.schema,
  case_count: set.case_count,
  incomplete_source_count: set.incomplete_source_count,
  live_ats_source_count: set.live_ats_source_count,
  live_ats_label_review_required_count: set.live_ats_label_review_required_count,
  label_evidence_conflict_count: set.label_evidence_conflict_count,
  promotion_eligible: set.promotion_eligible,
  promotion_blockers: set.promotion_blockers,
  set_digest: set.set_digest,
  path,
}, null, 2)}\n`);
