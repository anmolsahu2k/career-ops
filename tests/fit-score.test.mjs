import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScorer, scoreJobs, scoreBand } from '../lib/fit-score.mjs';

const CFG = {
  strong_roles: ['AI Engineer', 'Software Engineer', 'Full Stack', 'Backend', 'Data Engineer'],
  core_skills: ['AI', 'ML', 'LLM', 'GenAI', 'Agent', 'Python', 'React'],
  boost_levels: ['Intern', 'New Grad', 'Junior', 'Co-op'],
  off_target: ['Firmware', 'Hardware', 'ASIC', 'Sales'],
};
const score = buildScorer(CFG);
const s = t => score({ title: t }).score;

test('strong role + skill + level scores high', () => {
  // base20 + role45 + AI(+8) + level15 = 88
  assert.equal(s('Applied AI Engineer Intern'), 88);
});

test('role matching is suffix-flexible (Engineer ↔ Engineering)', () => {
  assert.equal(s('Software Engineering Intern'), s('Software Engineer Intern')); // both match role
  assert.ok(s('AI Engineering Intern') >= 70);
});

test('off-target term tanks the score', () => {
  // base20 + level15 - off40, clamped to 0
  assert.equal(s('Firmware Engineer Intern'), 0);
  assert.ok(s('Software Engineer Intern') > s('ASIC Design Engineer Intern'));
});

test('plain relevant title gets base + role + level, no skills', () => {
  // base20 + role45 + level15 = 80
  assert.equal(s('Software Engineer Intern'), 80);
});

test('skill hits are capped', () => {
  // role + 7 skills + level: base20 + role45 + cap32 + level15 = 112 → clamp 100
  assert.equal(s('Software Engineer Intern — AI ML LLM GenAI Agent Python React'), 100);
});

test('many skills but no strong role: base + skill-cap only (no role bonus)', () => {
  // base20 + cap32 = 52 (no role phrase, no level)
  assert.equal(s('AI ML LLM GenAI Agent Python React specialist'), 52);
});

test('generic title with no matches gets base only', () => {
  assert.equal(s('Underwriting Analyst'), 20);
});

test('whole-word skill matching (no substring false positives)', () => {
  // "AI" must not match inside "Retail"
  assert.equal(score({ title: 'Retail Associate' }).matched.skills.includes('AI'), false);
});

test('matched terms are reported for transparency', () => {
  const r = score({ title: 'Backend Software Engineer, New Grad — Python' });
  assert.ok(r.matched.role.length >= 1);
  assert.ok(r.matched.skills.includes('Python'));
  assert.ok(r.matched.level.includes('New Grad'));
});

test('scoreJobs annotates and scoreBand labels', () => {
  const out = scoreJobs([{ title: 'AI Engineer Intern', url: 'x', company: 'c' }], CFG);
  assert.ok(out[0].score > 0 && out[0].matched);
  assert.equal(scoreBand(85), 'high');
  assert.equal(scoreBand(50), 'mid');
  assert.equal(scoreBand(30), 'low');
});
