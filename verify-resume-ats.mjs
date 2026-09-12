#!/usr/bin/env node

/**
 * verify-resume-ats.mjs - Audit a submission resume PDF the way an ATS reads it.
 *
 * An ATS does not read the rendered page. It reads the PDF's embedded text
 * layer, and a PDF that looks perfect on screen can extract as garbage: icon
 * glyphs where the email should be, a two-column layout interleaved line by
 * line, ligatures that fuse "fi" into one unsearchable codepoint, hyphens that
 * are really en-dashes. Each one silently costs keyword matches on a resume the
 * user never suspects is broken.
 *
 * READ-ONLY. It audits PDFs the user already made and never generates or
 * modifies one (CLAUDE.md Rule 2).
 *
 * Checks:
 *   1. A real text layer exists (not an image scan / outlined text)
 *   2. Contact details present as LITERAL text, cross-checked against
 *      config/profile.yml
 *   3. No mojibake, replacement chars, or unresolved ligatures
 *   4. No em/en dashes (CLAUDE.md Rule 1 applies to the shipped PDF too)
 *   5. Reading order is sane (no column interleaving)
 *   6. Page count, and the section headers an ATS segments on
 *   7. Optional: JD keyword coverage against the extracted text (--jd <file>)
 *
 * Requires `pdftotext` (poppler). macOS: brew install poppler
 *
 * Usage:
 *   node verify-resume-ats.mjs                        # audit the configured resumes
 *   node verify-resume-ats.mjs path/to/resume.pdf
 *   node verify-resume-ats.mjs --jd ft/jds/acme.md    # + JD keyword coverage
 *   node verify-resume-ats.mjs --self-test
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);

// The active submission resumes come from config/profile.yml -> candidate.resumes
// (the user's own PDFs; career-ops never generates them, CLAUDE.md Rule 2).
// Explicit path arguments override the configured set.

/** Expand a leading ~ so config can stay portable across machines. */
export function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function configuredResumes(candidate) {
  const r = candidate.resumes;
  if (!r) return [];
  return (Array.isArray(r) ? r : Object.values(r)).filter(Boolean).map(expandHome);
}

const MAX_PAGES = 2;   // a new-grad resume past 2 pages is a finding in itself

// == Extraction ======================================================

function pdfToText(pdfPath, mode) {
  // -layout preserves visual columns; -raw emits content-stream order, which is
  // closer to what a naive ATS parser sees. Divergence between the two IS the
  // column-interleaving signal, so both are extracted.
  const args = mode === 'raw' ? ['-raw'] : ['-layout'];
  try {
    return execFileSync('pdftotext', [...args, pdfPath, '-'], {
      encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('pdftotext not found. Install poppler (macOS: brew install poppler).');
    }
    throw new Error(`pdftotext failed: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

function pdfPageCount(pdfPath) {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf-8' });
    const m = out.match(/^Pages:\s+(\d+)\s*$/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;   // pdfinfo is optional; its absence is not a finding
  }
}

// == Damage classes ==================================================
//
// Built with explicit escapes rather than literal glyphs: a literal U+FFFD or
// zero-width char in this source is invisible in review and in diffs, which is
// exactly the failure mode this file exists to catch.

const ZERO_WIDTH = new RegExp('[\\u200B-\\u200F\\uFEFF]', 'g');
const LIGATURES = new RegExp('[\\uFB00-\\uFB06]', 'g');
const REPLACEMENT = new RegExp('\\uFFFD', 'g');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
const DASHES = new RegExp('[\\u2013\\u2014]', 'g');          // en dash, em dash
const SMART_QUOTES = new RegExp('[\\u2018\\u2019\\u201C\\u201D]', 'g');
// Private Use Area: where icon fonts (Font Awesome and friends) live. This is
// the literal "icon glyph where the email should be" failure - the page renders
// a mail icon, the text layer holds an unmapped codepoint, and the ATS gets
// nothing where the contact method was supposed to be.
const PRIVATE_USE = new RegExp('[\\uE000-\\uF8FF]', 'g');

// == Checks (pure, unit-testable) ====================================

/** Normalize for matching: strip zero-width chars, collapse whitespace. */
export function normalize(text) {
  return text.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** Digits only, so "+1-412-689-3928" matches "(412) 689-3928". */
export function digitsOnly(s) {
  return String(s).replace(/\D/g, '');
}

/**
 * Is the contact value findable in the extracted text?
 * Phones compare on the last 10 digits because formatting always differs.
 * Returns null when nothing is configured, so "unset" never reads as "missing".
 */
export function findsContact(text, kind, value) {
  if (!value) return null;
  const flat = normalize(text).toLowerCase();
  if (kind === 'phone') {
    const want = digitsOnly(value).slice(-10);
    return want.length === 10 && digitsOnly(flat).includes(want);
  }
  return flat.includes(String(value).toLowerCase().replace(/^https?:\/\//, ''));
}

export function glyphFindings(text) {
  const found = [];
  const count = (re) => (text.match(re) || []).length;

  const lig = count(LIGATURES);
  if (lig) found.push({ level: 'fail', msg: `${lig} unresolved ligature glyph(s) (U+FB00-FB06). An "fi" or "fl" fused into one codepoint will not match an ATS keyword search, so "profile" silently stops matching.` });

  const rep = count(REPLACEMENT);
  if (rep) found.push({ level: 'fail', msg: `${rep} replacement char(s) U+FFFD. The encoding is lossy: some characters did not survive extraction.` });

  const ctl = count(CONTROL);
  if (ctl) found.push({ level: 'warn', msg: `${ctl} control character(s) in the text layer.` });

  const pua = count(PRIVATE_USE);
  if (pua) found.push({ level: 'fail', msg: `${pua} private-use glyph(s) (U+E000-F8FF). These are icon-font characters: they render as an icon but extract as nothing meaningful, which is how a contact line disappears from an ATS while looking perfect on the page.` });

  const dash = count(DASHES);
  if (dash) found.push({ level: 'fail', msg: `${dash} em/en dash(es) in the shipped PDF. CLAUDE.md Rule 1 bans them in candidate-facing content.` });

  const sq = count(SMART_QUOTES);
  if (sq) found.push({ level: 'warn', msg: `${sq} smart quote(s). Older ATS parsers mangle these; ASCII quotes are safer.` });

  // Zero-width chars are the invisible version of the ligature problem, and the
  // reason this check exists at all: normalize() strips them for matching, so
  // without an explicit count they would never surface. One INSIDE a word is
  // fatal (a zero-width space in "Soft|ware" means no ATS search for "Software"
  // ever matches); trailing ones are cosmetic but signal a lossy export path.
  const zwInWord = (text.match(new RegExp('\\w[\\u200B-\\u200F\\uFEFF]\\w', 'g')) || []).length;
  const zwTotal = count(ZERO_WIDTH);
  if (zwInWord) {
    found.push({ level: 'fail', msg: `${zwInWord} zero-width char(s) INSIDE a word (of ${zwTotal} total). The word is split for any ATS keyword search while looking perfect on the page.` });
  } else if (zwTotal) {
    found.push({ level: 'warn', msg: `${zwTotal} zero-width char(s), none inside a word. Harmless for matching, but they mark a lossy export path worth fixing at the source.` });
  }

  return found;
}

/**
 * Detect column interleaving: the classic two-column-resume failure where the
 * text layer alternates between sidebar and body line by line, so the parser
 * reads "Skills Experience Python Software Engineer" as one stream.
 */
export function readingOrderFinding(layoutText, rawText) {
  const layoutLines = layoutText.split('\n').filter(l => l.trim());
  const rawLines = rawText.split('\n').filter(l => l.trim());
  if (layoutLines.length < 5 || rawLines.length < 5) return null;

  // A -layout line holding a big run of spaces is two columns side by side.
  const gapped = layoutLines.filter(l => /\S {6,}\S/.test(l)).length;
  const gapRatio = gapped / layoutLines.length;
  if (gapRatio > 0.35) {
    return {
      level: 'warn',
      msg: `${Math.round(gapRatio * 100)}% of lines have wide internal gaps, which looks like a multi-column layout. ATS parsers follow content-stream order, not the visual columns, so confirm the resume still reads coherently top to bottom.`,
    };
  }
  return null;
}

/**
 * Word-count drift between the two extraction modes.
 * -layout and -raw should surface the SAME words in a different arrangement.
 * A large divergence means one mode is dropping content, which is a sign the
 * text layer is fragile and a third-party parser may drop it too.
 */
export function extractionDriftFinding(layoutText, rawText) {
  const words = (t) => (normalize(t).toLowerCase().match(/[a-z0-9]+/g) || []).length;
  const a = words(layoutText), b = words(rawText);
  if (a < 50 || b < 50) return null;
  const drift = Math.abs(a - b) / Math.max(a, b);
  if (drift > 0.10) {
    return { level: 'warn', msg: `Extraction modes disagree by ${Math.round(drift * 100)}% on word count (-layout ${a}, -raw ${b}). One mode is losing content, so a third-party parser may lose it too.` };
  }
  return null;
}

// Section headers an ATS segments a resume on.
const EXPECTED_SECTIONS = ['experience', 'education', 'skills'];

export function sectionFindings(text) {
  const flat = normalize(text).toLowerCase();
  const missing = EXPECTED_SECTIONS.filter(s => !flat.includes(s));
  return missing.length
    ? [{ level: 'warn', msg: `Section header(s) not found in the text layer: ${missing.join(', ')}. An ATS segments a resume by these words; if they are images or letter-spaced, it cannot.` }]
    : [];
}

/**
 * JD keyword coverage against what the parser actually sees.
 * Honesty rule: this reports coverage. It never suggests stuffing a keyword the
 * resume does not genuinely support - that stays the user's call, per role.
 */
export function keywordCoverage(text, jdText) {
  const flat = normalize(text).toLowerCase();
  const stop = new Set(['and','the','for','with','you','our','are','will','have','this','that','from','your','all','who','can','not','but','has','their','they','them','its','been','than','then','into','out','use','using','work','team','role','job','years','year','plus','strong','experience','ability','skills','preferred','required','qualifications']);
  const counts = new Map();
  for (const w of normalize(jdText).toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) || []) {
    const t = w.replace(/[.\-]+$/, '');
    if (t.length < 3 || stop.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t]) => t);
  const present = terms.filter(t => flat.includes(t));
  const missing = terms.filter(t => !flat.includes(t));
  return { total: terms.length, present, missing, pct: terms.length ? Math.round(present.length / terms.length * 100) : 0 };
}

// == Audit one PDF ===================================================

function auditPdf(pdfPath, candidate, jdText) {
  const findings = [];
  const layout = pdfToText(pdfPath, 'layout');
  const raw = pdfToText(pdfPath, 'raw');
  const chars = normalize(layout).length;

  if (chars < 200) {
    findings.push({ level: 'fail', msg: `Only ${chars} characters extracted. This PDF has no usable text layer (image scan or fully outlined text), so an ATS reads nothing from it at all.` });
    return { findings, layout, raw, chars, pages: pdfPageCount(pdfPath), coverage: null };
  }

  for (const [kind, value] of [['email', candidate.email], ['phone', candidate.phone],
                               ['linkedin', candidate.linkedin], ['github', candidate.github]]) {
    if (findsContact(layout, kind, value) === false) {
      findings.push({ level: 'fail', msg: `${kind} not found as literal text ("${value}"). If it renders on the page it is an icon glyph or an outlined image, so the ATS cannot extract it, and some reject a resume with no parseable contact method.` });
    }
  }

  findings.push(...glyphFindings(layout));
  findings.push(...sectionFindings(layout));
  const order = readingOrderFinding(layout, raw);
  if (order) findings.push(order);
  const drift = extractionDriftFinding(layout, raw);
  if (drift) findings.push(drift);

  const pages = pdfPageCount(pdfPath);
  if (pages && pages > MAX_PAGES) {
    findings.push({ level: 'warn', msg: `${pages} pages. New-grad resumes are expected at 1-2; past that, later pages are often skimmed or dropped.` });
  }

  return { findings, layout, raw, chars, pages, coverage: jdText ? keywordCoverage(layout, jdText) : null };
}

// == Self-test =======================================================

function selfTest() {
  let failures = 0;
  const check = (name, cond) => { if (!cond) { failures++; console.log(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };
  const ch = (code) => String.fromCharCode(code);

  console.log('contact matching:');
  check('email found case-insensitively', findsContact('Mail: ANMOL@X.COM here', 'email', 'anmol@x.com') === true);
  check('phone matches across formats', findsContact('(412) 689-3928', 'phone', '+1-412-689-3928') === true);
  check('phone absence detected', findsContact('no digits here', 'phone', '+1-412-689-3928') === false);
  check('linkedin matches without scheme', findsContact('see linkedin.com/in/anmolsahu2k', 'linkedin', 'https://linkedin.com/in/anmolsahu2k') === true);
  check('unset value is skipped, not failed', findsContact('anything', 'github', '') === null);
  check('zero-width char does not hide a match', findsContact('anmol' + ch(0x200B) + '@x.com', 'email', 'anmol@x.com') === true);

  check('expands a leading tilde', expandHome('~/x.pdf').startsWith('/') && !expandHome('~/x.pdf').includes('~'));
  check('leaves an absolute path alone', expandHome('/a/b.pdf') === '/a/b.pdf');

  console.log('glyph findings:');
  check('flags ligature glyphs', glyphFindings('pro' + ch(0xFB01) + 'le').some(f => /ligature/.test(f.msg) && f.level === 'fail'));
  check('flags replacement chars', glyphFindings('bad' + ch(0xFFFD) + 'char').some(f => /replacement/.test(f.msg) && f.level === 'fail'));
  check('flags em dash as a failure', glyphFindings('a ' + ch(0x2014) + ' b').some(f => /dash/.test(f.msg) && f.level === 'fail'));
  check('flags en dash as a failure', glyphFindings('2024 ' + ch(0x2013) + ' 2026').some(f => /dash/.test(f.msg)));
  check('flags smart quotes as a warning', glyphFindings(ch(0x201C) + 'hi' + ch(0x201D)).some(f => f.level === 'warn'));
  check('flags control chars as a warning', glyphFindings('a' + ch(0x0007) + 'b').some(f => /control/.test(f.msg)));
  check('flags a zero-width char inside a word as a failure', glyphFindings('Soft' + ch(0x200B) + 'ware').some(f => /INSIDE a word/.test(f.msg) && f.level === 'fail'));
  check('flags a trailing zero-width char as a warning only', glyphFindings('Software ' + ch(0x200B)).some(f => /none inside a word/.test(f.msg) && f.level === 'warn'));
  check('clean ascii text yields nothing', glyphFindings('Software Engineer, 2024 to 2026. Built things.').length === 0);

  console.log('sections:');
  check('missing sections reported', sectionFindings('Just a name').length === 1);
  check('all sections present is clean', sectionFindings('Experience Education Skills').length === 0);

  console.log('reading order:');
  const twoCol = Array.from({ length: 10 }, () => 'Skills        Experience').join('\n');
  check('flags wide-gap column layout', readingOrderFinding(twoCol, twoCol)?.level === 'warn');
  const oneCol = Array.from({ length: 10 }, () => 'Built a thing that did a thing well').join('\n');
  check('single-column layout is clean', readingOrderFinding(oneCol, oneCol) === null);
  check('too-short input is not judged', readingOrderFinding('a\nb', 'a\nb') === null);

  console.log('keyword coverage:');
  const cov = keywordCoverage('python kubernetes docker', 'We need Python and Kubernetes and Terraform experience with the team');
  check('counts present keywords', cov.present.includes('python') && cov.present.includes('kubernetes'));
  check('counts missing keywords', cov.missing.includes('terraform'));
  check('drops stopwords', !cov.present.includes('the') && !cov.missing.includes('the'));
  check('percentage computed', cov.pct > 0 && cov.pct <= 100);

  console.log('end-to-end (generated fixture pdf):');
  let madePdf = null;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ats-'));
    const ps = join(dir, 'f.ps');
    writeFileSync(ps, '%!PS\n/Helvetica findfont 12 scalefont setfont\n72 720 moveto (Anmol Sahu anmolsahu2k@gmail.com 412 689 3928) show\n72 700 moveto (Experience Education Skills) show\nshowpage\n');
    execFileSync('ps2pdf', [ps, join(dir, 'f.pdf')], { stdio: 'ignore' });
    madePdf = join(dir, 'f.pdf');
  } catch { /* ghostscript absent: skip, not a failure of this tool */ }

  if (madePdf && existsSync(madePdf)) {
    const r = auditPdf(madePdf, { email: 'anmolsahu2k@gmail.com', phone: '+1-412-689-3928', linkedin: '', github: '' }, null);
    check('extracts a real pdf text layer', r.chars > 20);
    check('finds the email in a real pdf', !r.findings.some(f => /email not found/.test(f.msg)));
    check('finds the phone in a real pdf', !r.findings.some(f => /phone not found/.test(f.msg)));
    check('finds the section headers in a real pdf', !r.findings.some(f => /Section header/.test(f.msg)));
  } else {
    console.log('  skip  end-to-end pdf test (ghostscript/ps2pdf not installed)');
  }

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// == Main ============================================================

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const jdFlag = args.indexOf('--jd');
  const jdPath = jdFlag !== -1 ? args[jdFlag + 1] : null;
  let jdText = null;
  if (jdPath) {
    if (!existsSync(jdPath)) { console.error(`JD file not found: ${jdPath}`); process.exit(1); }
    jdText = readFileSync(jdPath, 'utf-8');
  }

  const profile = yaml.load(readFileSync(join(P.root, 'config/profile.yml'), 'utf-8'));
  const candidate = profile.candidate || {};

  const explicit = args.filter(a => !a.startsWith('--') && a !== jdPath);
  const targets = explicit.length ? explicit : configuredResumes(candidate);
  if (targets.length === 0) {
    console.error('No resumes to audit. Set config/profile.yml -> candidate.resumes, or pass a path:');
    console.error('  node verify-resume-ats.mjs <file.pdf>');
    process.exit(1);
  }
  const bar = '='.repeat(70);

  let totalFail = 0, totalWarn = 0, audited = 0;

  for (const pdfPath of targets) {
    console.log(bar);
    console.log(pdfPath.split('/').pop());
    console.log(bar);
    if (!existsSync(pdfPath)) {
      console.log(`  SKIP - file not found at ${pdfPath}\n`);
      continue;
    }

    let r;
    try {
      r = auditPdf(pdfPath, candidate, jdText);
    } catch (err) {
      console.log(`  ERROR - ${err.message}\n`);
      totalFail++;
      continue;
    }
    audited++;

    console.log(`  text layer: ${r.chars} chars${r.pages ? `, ${r.pages} page(s)` : ''}`);
    const fails = r.findings.filter(f => f.level === 'fail');
    const warns = r.findings.filter(f => f.level === 'warn');
    totalFail += fails.length;
    totalWarn += warns.length;

    if (!r.findings.length) {
      console.log('  OK - no ATS extraction problems found');
    } else {
      for (const f of fails) console.log(`  FAIL  ${f.msg}`);
      for (const f of warns) console.log(`  WARN  ${f.msg}`);
    }

    if (r.coverage) {
      console.log(`\n  JD keyword coverage: ${r.coverage.pct}% (${r.coverage.present.length}/${r.coverage.total} top terms)`);
      if (r.coverage.missing.length) {
        console.log(`  not in the text layer: ${r.coverage.missing.join(', ')}`);
        console.log('  (A missing term the resume genuinely supports is worth adding. One it does');
        console.log('   not support is a gap to state honestly, never a keyword to stuff.)');
      }
    }
    console.log();
  }

  console.log(bar);
  console.log(`${audited} PDF(s) audited - ${totalFail} failure(s), ${totalWarn} warning(s)`);
  if (audited === 0) {
    console.log('Nothing audited. Pass a path explicitly: node verify-resume-ats.mjs <file.pdf>');
    process.exit(1);
  }
  process.exit(totalFail > 0 ? 1 : 0);
}

main();
