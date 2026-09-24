/**
 * Handshake Quick Apply cover letters use the same grounded generator as
 * Greenhouse, then a PDF because Handshake attaches a document rather than a textarea.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { generateBoundedAnswers } from '../applications/answers.mjs';
import { markCoverLetter } from '../applications/tracker.mjs';
import { applicationVoiceProfile } from '../applications/voice.mjs';

const execFileAsync = promisify(execFile);

export function handshakeCoverLetterMissing(text = '') {
  return /attach your cover letter\s+or\s+upload new/i.test(String(text || '').replace(/\s+/g, ' '));
}

export function handshakeCoverLetterSelected(text = '', fileName = '') {
  const clean = String(text || '').replace(/\s+/g, ' ');
  const stem = String(fileName || '').replace(/\.pdf$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!stem) return false;
  return new RegExp(`attach your cover letter\\s+${stem}`, 'i').test(clean);
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) || '';
}

function reportMarkdown(target, reportId) {
  const rel = String(reportId || '').match(/\]\(([^)]+\.md)\)/)?.[1]
    || (String(reportId || '').endsWith('.md') ? String(reportId) : '');
  if (!rel || rel.includes('..')) return '';
  const abs = resolve(target, rel);
  return existsSync(abs) ? abs : '';
}

async function printCoverPdf(markdownPath) {
  const chrome = chromeExecutable();
  if (!chrome) throw new Error('Chrome is required to print a Handshake cover letter PDF');
  const pdfPath = markdownPath.replace(/\.md$/i, '.pdf');
  const htmlPath = markdownPath.replace(/\.md$/i, '.html');
  const paragraphs = readFileSync(markdownPath, 'utf8').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const body = paragraphs.map(part => `<p>${part.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))}</p>`).join('');
  writeFileSync(htmlPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.45;margin:0.9in;color:#111}p{margin:0 0 12pt}</style></head><body>${body}</body></html>`);
  const profile = join(dirname(pdfPath), `.pdf-print-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  await execFileAsync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ], { timeout: 25000 });
  if (!existsSync(pdfPath)) throw new Error('Cover letter PDF was not written');
  return pdfPath;
}

async function generateCoverPdf({ target, config, reportId, trackerNumber }) {
  const evidence = (config?.applications?.answer_evidence_files || [])
    .filter(path => typeof path === 'string' && existsSync(path))
    .map(path => ({ kind: 'trusted-local', text: readFileSync(path, 'utf8').slice(0, 12000) }));
  const report = reportMarkdown(target, reportId);
  if (report) evidence.push({ kind: 'current-job-report', text: readFileSync(report, 'utf8').slice(0, 12000) });
  if (!evidence.length) throw new Error('No cover letter evidence');
  const result = await generateBoundedAnswers({
    questions: [{ field_id: 'cover letter', question: 'cover letter', type: 'textarea', required: true }],
    evidence,
    runtimeConfig: config,
    voiceProfile: applicationVoiceProfile(),
  });
  const text = String(result.answers?.[0]?.text || '').trim();
  if (!text) throw new Error(result.detail || result.blocker || 'Cover letter was empty');
  const dir = report ? dirname(report) : resolve(target, 'reports', 'handshake');
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, `${Number(trackerNumber) || 'handshake'}-cover-letter.md`);
  writeFileSync(mdPath, `${text}\n`);
  const pdfPath = await printCoverPdf(mdPath);
  const rel = relative(target, mdPath).replace(/\\/g, '/');
  await markCoverLetter(target, trackerNumber, rel).catch(() => {});
  return { mdPath, pdfPath, name: pdfPath.split(/[/\\]/).pop() };
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function chooseSavedCoverLetter(page, fileName) {
  const stem = String(fileName || '').replace(/\.pdf$/i, '');
  const search = await page.evaluate(() => {
    const el = [...document.querySelectorAll('input')].find((item) => {
      const label = `${item.getAttribute('aria-label') || ''} ${item.getAttribute('placeholder') || ''}`;
      const rect = item.getBoundingClientRect();
      return /cover letter/i.test(label) && rect.width > 40;
    });
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x + 24, y: rect.y + rect.height / 2 };
  });
  if (!search || typeof page.trustedClick !== 'function') return false;
  await page.trustedClick(search.x, search.y);
  await new Promise(resolveWait => setTimeout(resolveWait, 800));
  const option = await page.evaluate((wanted) => {
    const el = [...document.querySelectorAll('[role="option"]')].find(item => (item.innerText || '').includes(wanted));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + Math.min(rect.width / 2, 80), y: rect.y + rect.height / 2, text: (el.innerText || '').trim() };
  }, stem);
  if (!option) return false;
  await page.trustedClick(option.x, option.y);
  return true;
}

/** Attach a generated cover letter when the Handshake dialog still says the slot is empty. */
export async function ensureHandshakeCoverLetter(page, context = {}) {
  const before = await pageText(page);
  if (!handshakeCoverLetterMissing(before)) return { attached: true, generated: false };
  const file = await generateCoverPdf(context);
  const marked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('input[type="file"]')].find((item) => {
      const blob = `${item.name || ''} ${item.id || ''} ${item.getAttribute('aria-label') || ''} ${item.closest('div')?.innerText || ''}`;
      return /cover letter/i.test(blob);
    });
    if (!el) return false;
    el.setAttribute('data-career-ops-cover', '1');
    return true;
  });
  if (marked && typeof page.setInputFiles === 'function') {
    await page.setInputFiles('input[data-career-ops-cover="1"]', file.pdfPath);
  }
  const deadline = Date.now() + 20000;
  let selected = false;
  while (Date.now() < deadline && !selected) {
    const text = await pageText(page);
    const clean = text.replace(/\s+/g, ' ');
    if (!/converting/i.test(clean) && handshakeCoverLetterSelected(clean, file.name)) {
      selected = true;
      break;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  if (!selected) await chooseSavedCoverLetter(page, file.name);
  const confirmBy = Date.now() + 8000;
  while (Date.now() < confirmBy && !selected) {
    const text = await pageText(page);
    if (handshakeCoverLetterSelected(text, file.name)) selected = true;
    else await new Promise(resolveWait => setTimeout(resolveWait, 400));
  }
  return { attached: selected, generated: true, name: file.name };
}
