console.log("Lu.ma CSV downloader — correct selector");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const PROFILE = 'https://luma.com/user/murray';

async function slowScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

async function processSection(page, index) {
  await page.goto(PROFILE, { waitUntil: 'networkidle' });

  const viewAll = page.getByText('View All', { exact: true }).nth(index);
  await viewAll.click();
  await page.waitForTimeout(1500);

  await slowScroll(page);

  const eventLinks = page.locator('a[href^="/home?e=evt-"]');
  const count = await eventLinks.count();

  console.log(`Found ${count} events`);

  for (let i = 0; i < count; i++) {
    try {
      console.log(`Opening event ${i + 1}/${count}`);

      await eventLinks.nth(i).click();
      await page.waitForTimeout(1200);

      await page.getByText('Manage', { exact: true }).click();
      await page.waitForLoadState('networkidle');

      await page.getByText('Guests', { exact: true }).click();
      await page.waitForTimeout(1000);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        page.getByText('Download as CSV', { exact: true }).click()
      ]);

      const url = page.url();
      const evt = url.match(/evt-[^/?#]+/i)?.[0] || Date.now();
      const file = path.join(DOWNLOAD_DIR, `${evt}.csv`);
      await download.saveAs(file);

      console.log("Downloaded:", file);

      await page.goBack(); // back to popup list
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log("Skipping event:", e.message);
      await page.goto(PROFILE);
    }
  }

  await page.keyboard.press('Escape');
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  console.log("Opened profile");

  await processSection(page, 0); // Hosting
  await processSection(page, 1); // Past Events

  console.log("All CSVs downloaded");
  await browser.close();
})();
