console.log("Lu.ma DOM debug run");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
  });

  const page = await context.newPage();

  await page.goto('https://lu.ma/calendar', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log("URL after open:", page.url());

  // Scroll whole page to force lazy load
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });

  console.log("Page scrolled");

  // Dump anchors
  const anchors = await page.$$eval('a', els =>
    els.map(a => ({
      href: a.getAttribute('href'),
      text: (a.innerText || '').trim().replace(/\s+/g, ' ')
    }))
  );

  console.log("===== ANCHORS FOUND =====");
  anchors.slice(0, 80).forEach((a, i) => {
    console.log(`#${i + 1} href=${a.href} | text="${a.text}"`);
  });

  // Save HTML
  const html = await page.content();
  const htmlPath = path.join(OUT_DIR, 'debug.html');
  fs.writeFileSync(htmlPath, html);
  console.log("Saved HTML to:", htmlPath);

  // Save screenshot
  const imgPath = path.join(OUT_DIR, 'debug.png');
  await page.screenshot({ path: imgPath, fullPage: true });
  console.log("Saved screenshot to:", imgPath);

  await browser.close();
})();
