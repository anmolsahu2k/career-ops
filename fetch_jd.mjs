import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2];
const outFile = process.argv[3];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    const content = await page.evaluate(() => {
        return document.body.innerText;
    });
    fs.writeFileSync(outFile, content);
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
