console.log("Lu.ma attendee bot — FIXED overlay issue");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Open profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  // Click Hosting → View All (your exact selector)
  await page.click('#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(1) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button');
  await page.waitForTimeout(1000);

  // Grab all event cards
  const cards = page.locator('div:has-text("By Murray")');
  const count = await cards.count();
  console.log("Total cards:", count);

  for (let i = 0; i < count; i++) {
    try {
      console.log(`\nOpening event ${i + 1}`);

      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      await card.click();

      // Wait popup
      await page.waitForSelector('text=Manage', { timeout: 10000 });

      // Click Manage
      await page.click('text=Manage');
      await page.waitForLoadState('networkidle');

      // Go to Guests
      await page.click('text=Guests');
      await page.waitForTimeout(1500);

      // Download CSV
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('text=Download as CSV')
      ]);

      const url = page.url();
      const eventId = url.match(/evt-[^/]+/)[0];
      const file = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
      await download.saveAs(file);
      console.log("Saved:", file);

      // Go back to profile
      await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
      await page.click('#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(1) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button');
      await page.waitForTimeout(1000);

      // 🔥 THIS LINE FIXES EVERYTHING
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

    } catch (err) {
      console.log("Error, moving on:", err.message);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  await browser.close();
})();
