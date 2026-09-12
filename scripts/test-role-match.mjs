#!/usr/bin/env node
// Regression tests for lib/role-match.mjs — the ai/ml abbreviation
// over-expansion fix (audit 2026-06-08). Exit 0 on pass, 1 on failure.
import { roleFuzzyMatch } from '../lib/role-match.mjs';

let failed = 0;
function expect(a, b, want, why) {
  const got = roleFuzzyMatch(a, b);
  if (got !== want) {
    console.error(`  ❌ roleFuzzyMatch('${a}', '${b}') = ${got}, want ${want} (${why})`);
    failed++;
  } else {
    console.log(`  ✅ '${a}' vs '${b}' → ${got}`);
  }
}

// Over-expansion false positives (must NOT match): 'ai'/'ml' expansion alone
// used to satisfy the 2-token overlap minimum and collapse distinct roles.
expect('AI Engineer', 'AI Research Scientist', false, 'distinct AI roles must not collapse');
expect('AI Engineer', 'AI Product Specialist', false, 'distinct AI roles must not collapse');
expect('ML Engineer', 'Machine Learning Researcher', false, 'engineer vs researcher are different roles');

// Abbreviation rewrites of the SAME role (must match).
expect('SDE', 'Software Development Engineer', true, 'pure abbreviation rewrite');
expect('ML Engineer', 'Machine Learning Engineer', true, 'same role, abbreviated');
expect('AI Engineer', 'Artificial Intelligence Engineer', true, 'same role, abbreviated');
expect('SDE New Grad', 'SWE New Grad', true, 'sde/swe expansions overlap plus organic token');
expect('Software Engineer - New Grad', 'Software Engineer - AI Enablement', false, 'generic software-engineer words cannot collapse different requisitions');

// Pre-fix true positives that must keep matching.
expect('Engineering Intern - C&I', 'Engineer Intern, Commercial and Industrial', true, 'canonical C&I case from ROLE_ABBREVIATIONS comment');
expect('Software Engineer, Backend', 'Backend Software Engineer II', true, 'same role, reordered');
expect('Software Engineer New Grad', 'Software Engineer, New Grad 2026', true, 'same role, year suffix');

// Pre-fix true negatives that must stay negative.
expect('Data Analyst', 'Software Engineer', false, 'unrelated roles');
expect('AI Engineer', 'Data Engineer', false, 'unrelated roles');

// Defects found by the 2026-07-13 adversarial verification pass.
expect('iOS Engineer', 'Web Engineer', false, 'singleton token sets must not match');
expect('ETL Developer', 'iOS Developer', false, 'singleton token sets must not match');
expect('ML Engineer', 'MLE Researcher', false, 'expansion-bundled overlap is one signal unit');
expect('MLE Researcher', 'ML Engineer', false, 'symmetric: argument order must not change the verdict');

if (failed > 0) {
  console.error(`\n${failed} role-match regression(s) failed`);
  process.exit(1);
}
console.log('\nok');
