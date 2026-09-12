import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://adventservices.bamboohr.com/careers/361', { waitUntil: 'networkidle' });
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => a.href);
  });
  console.log(links);
  await browser.close();
})();
