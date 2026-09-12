/**
 * fit-score.mjs — Zero-token heuristic fit score for a job vs. your profile
 *
 * Scores a job TITLE (the only text persisted per job) against the keyword
 * groups in config/profile.yml → scoring. Produces a 0-100 score plus the
 * matched terms (for transparency). This is a fast ranking aid, NOT the deep
 * /career-ops oferta evaluation (which reads the full JD + CV via an LLM).
 *
 * Scoring (clamped 0-100):
 *   +45  title matches a strong_role
 *   +8   per core_skill hit (capped at +32)
 *   +15  title matches a boost_level (intern/new-grad/junior/…)
 *   -40  title matches an off_target term
 *   base 20 so a plain relevant title isn't zero
 *
 * Pure + deterministic → unit-tested in tests/fit-score.test.mjs.
 */

function toMatchers(list, { flex = false } = {}) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // flex allows a trailing "s"/"ing" so role nouns match their variants:
  // "Software Engineer" also matches "Software Engineering".
  const suffix = flex ? '(?:s|ing)?' : '';
  return (list || []).map(k => ({ term: k, re: new RegExp(`\\b${escape(k)}${suffix}\\b`, 'i') }));
}

const BASE = 20;
const ROLE_BONUS = 45;
const SKILL_EACH = 8;
const SKILL_CAP = 32;
const LEVEL_BONUS = 15;
const OFF_PENALTY = 40;

export function buildScorer(scoringCfg = {}) {
  const strong = toMatchers(scoringCfg.strong_roles, { flex: true });
  const skills = toMatchers(scoringCfg.core_skills);
  const levels = toMatchers(scoringCfg.boost_levels);
  const off = toMatchers(scoringCfg.off_target);

  return function score(job) {
    const title = (job && job.title) || '';
    const matched = { role: [], skills: [], level: [], off: [] };

    for (const m of strong) if (m.re.test(title)) matched.role.push(m.term);
    for (const m of skills) if (m.re.test(title)) matched.skills.push(m.term);
    for (const m of levels) if (m.re.test(title)) matched.level.push(m.term);
    for (const m of off) if (m.re.test(title)) matched.off.push(m.term);

    let s = BASE;
    if (matched.role.length) s += ROLE_BONUS;
    s += Math.min(matched.skills.length * SKILL_EACH, SKILL_CAP);
    if (matched.level.length) s += LEVEL_BONUS;
    if (matched.off.length) s -= OFF_PENALTY;

    s = Math.max(0, Math.min(100, s));
    return { score: s, matched };
  };
}

// Convenience: annotate a list of jobs with { score, matched }.
export function scoreJobs(jobs, scoringCfg) {
  const score = buildScorer(scoringCfg);
  return (jobs || []).map(j => ({ ...j, ...score(j) }));
}

// Band label/color key for UI (green / amber / gray).
export function scoreBand(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}
