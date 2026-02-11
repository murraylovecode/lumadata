console.log("Lu.ma attendee bot – UI faithful FINAL");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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

  // 🔹 STEP 1 — Open your profile page
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  // 🔹 STEP 2 — Click "View All" under Hosting
  const hostingViewAll = page.locator(
    '#__next div:has-text("Hosting") >> text=View All'
  ).first();

  await hostingViewAll.click();
  await page.waitForLoadState('networkidle');

  console.log("Opened Hosting events list");

  // 🔹 STEP 3 — Collect event cards
  const cards = await page.locator('a[href^="/home?e=evt-"]').all();
  console.log(`Found ${cards.length} event cards`);

  // 🔁 LOOP EVENTS
  for (let i = 0; i < cards.length; i++) {
    try {
      console.log(`\nOpening event ${i + 1}`);

      // Click event card → opens popup
      await cards[i].click();

      // 🧠 CRITICAL — wait for popup Manage link
      await page.waitForSelector('a:has-text("Manage")', { timeout: 15000 });

      // Click Manage inside popup
      await page.click('a:has-text("Manage")');
      await page.waitForLoadState('networkidle');

      console.log("Opened Manage page");

      // 🔹 Guests tab
      await page.click('text=Guests');
      await page.waitForSelector('text=Download as CSV');

      console.log("On Guests tab");

      // 🔹 Download CSV
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=Download as CSV')
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
      await download.saveAs(filePath);

      console.log("Downloaded:", filePath);

      // Go back to events list
      await page.goBack(); // back to popup
      await page.goBack(); // back to list
      await page.waitForTimeout(2000);

    } catch (err) {
      console.log("Error on this event, moving on");

      // Return to hosting list if popup got stuck
      await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
      await hostingViewAll.click();
      await page.waitForTimeout(2000);
    }
  }

  console.log("\nAll done");
  await browser.close();
})();
