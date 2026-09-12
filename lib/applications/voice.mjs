import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ANSWER_FILE = /(?:application-(?:questions|answers)|form-answers)\.md$/i;
const SKIP_SECTION = /pre-submit|do not use|reusable hooks|tone calibration|notes$/i;
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|my|me)\b/i;

function walk(root, files = []) {
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && ANSWER_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

function answerSections(text) {
  return String(text).split(/^##\s+/m).slice(1).flatMap(section => {
    const [heading = '', ...body] = section.split('\n');
    if (SKIP_SECTION.test(heading.trim())) return [];
    const answer = body.join('\n')
      .replace(/```[\s\S]*?```/g, block => block.replace(/```/g, ''))
      .replace(/^>\s?/gm, '')
      .trim();
    const words = answer.match(/[A-Za-z0-9][A-Za-z0-9'/-]*/g) || [];
    // Headings such as "Resume" or empty worksheet prompts are not samples.
    return words.length >= 12 ? [{ answer, words: words.length }] : [];
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Derive voice constraints from maintained historic application answers without
 * exposing their company names, claims, metrics, or prose to the generator.
 * Historic answers teach tone and length only; the current CV/report remains
 * the only factual source for a new answer.
 */
export function applicationVoiceProfile({ roots = [resolve('ft/reports'), resolve('reports')] } = {}) {
  const samples = roots.flatMap(root => walk(root)).flatMap(path => {
    try { return answerSections(readFileSync(path, 'utf8')); } catch { return []; }
  });
  if (!samples.length) {
    return 'Write direct, concise, first-person application prose. For an optional Additional Information field, use one short paragraph with one relevant proof point.';
  }
  const firstPerson = samples.filter(sample => FIRST_PERSON.test(sample.answer)).length;
  const words = median(samples.map(sample => sample.words));
  const shortOpenFieldTarget = Math.max(55, Math.min(100, Math.round(words * 0.45)));
  return [
    `Derived from ${samples.length} maintained local application-answer sections; ${Math.round((firstPerson / samples.length) * 100)}% use first-person voice.`,
    'Use a direct first-person voice. Lead with a specific motivation or relevant work, then connect one concrete, current-evidence-backed proof to the role.',
    `For an optional Additional Information field, write one focused paragraph of about ${shortOpenFieldTarget} words, not a cover letter.`,
    'This profile is style-only: never reuse its historical company names, projects, numbers, dates, or claims.',
  ].join(' ');
}
