#!/usr/bin/env node

/**
 * workday-upload.mjs — proves the Resume/CV upload is found on Workday's real
 * "My Experience" markup even though the native control is hidden.
 *
 * Workday renders a "Drop files here / Select files" zone and hides the actual
 * <input type="file"> behind it, so `isVisible` discarded the field and the
 * resume was never attached on any Workday application. The extension's own
 * page diagnostics reported `fieldCount: 1` on a step plainly showing a
 * Resume/CV box.
 *
 * The captured fixture loads without Workday's stylesheet, so the input is NOT
 * hidden there and the fixture alone proves nothing about visibility — that
 * mistake was made once already. Each of the three ways a stylesheet can hide a
 * control is therefore applied explicitly.
 *
 * Usage:  node extensions/job-autofill/tests/workday-upload.mjs [--headed]
 *
 * Not part of test-all.mjs: it launches a browser.
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const PORT = 8132;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const server = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const file = rel === '/' ? '/fixtures/workday-experience.html' : rel;
  try {
    const body = readFileSync(join(EXT, file));
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures++;
};

await new Promise(r => server.listen(PORT, r));
const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`);

// Every way a stylesheet hides a control it still wants submitted.
for (const css of ['display:none', 'visibility:hidden', 'opacity:0',
                   'width:0;height:0;position:absolute']) {
  const out = await page.evaluate(async style => {
    const bust = '?' + Math.random();
    const eng = await import('/content/engine.js' + bust);
    const { isResumeInput } = await import('/content/filler.js' + bust);
    const wd = (await import('/content/adapters/workday.js' + bust)).default;
    const input = document.querySelector('input[type="file"]');
    input.setAttribute('style', style);
    const field = eng.detectFields(document, wd).find(f => f.kind === 'file');
    return {
      detected: !!field,
      label: field?.rawLabel || null,
      isResume: field ? isResumeInput(field.control, field.rawLabel) : false,
    };
  }, css);
  check(`found behind "${css}"`, out.detected, `label=${JSON.stringify(out.label)}`);
  check(`  labelled Resume/CV`, out.label === 'Resume/CV', `got ${JSON.stringify(out.label)}`);
  check(`  recognised as the resume slot`, out.isResume);
}

// The rule must not let every hidden input through.
const decoy = await page.evaluate(async () => {
  const eng = await import('/content/engine.js?' + Math.random());
  const host = document.createElement('div');
  host.innerHTML = '<div><input type="file" style="display:none"></div>';
  document.body.appendChild(host);
  return eng.isVisible(host.querySelector('input'));
});
check('a hidden file input with no upload shell stays excluded', decoy === false);

await browser.close();
server.close();
console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
