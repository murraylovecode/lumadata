console.log("Lu.ma CSV downloader — popup aware");

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

  await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });
  console.log("Opened profile");

  async function processSection(viewAllIndex, name) {
    console.log(`\n=== ${name} ===`);

    // Open the View All popup
    await page.locator('button:has-text("View All")').nth(viewAllIndex).click();
    await page.waitForTimeout(3000);

    // This is the overlay container
    const overlay = page.locator('.lux-overlay');

    // Find event cards INSIDE overlay
    const cards = await overlay.locator('div:has-text("By")').all();
    console.log(`Found ${cards.length} events`);

    for (let i = 0; i < cards.length; i++) {
      console.log(`Opening event ${i + 1}/${cards.length}`);

      try {
        // Click card inside popup
        await cards[i].click();
        await page.waitForTimeout(2000);

        // Click Manage
        await page.locator('text=Manage').click();
        await page.waitForLoadState('domcontentloaded');

        // Guests tab
        await page.locator('text=Guests').click();
        await page.waitForTimeout(2000);

        // Download CSV
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.locator('text=Download as CSV').click()
        ]);

        const file = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
        await download.saveAs(file);
        console.log("Downloaded:", file);

        // Go back to profile
        await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // Reopen popup for next event
        await page.locator('button:has-text("View All")').nth(viewAllIndex).click();
        await page.waitForTimeout(3000);

      } catch (err) {
        console.log("Error, moving on");
        await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });
        await page.locator('button:has-text("View All")').nth(viewAllIndex).click();
        await page.waitForTimeout(3000);
      }
    }

    // Close overlay (press ESC)
    await page.keyboard.press('Escape');
  }

  // Hosting section
  await processSection(0, "Hosting");

  // Past Events section
  await processSection(1, "Past Events");

  console.log("\nAll done");
  await browser.close();
})();
