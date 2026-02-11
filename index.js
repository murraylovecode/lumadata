console.log("Lu.ma attendee bot – UI faithful");

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

  // STEP 1 — Open your profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened Murray profile");

  // Helper to process a section (Hosting / Past Events)
  async function processSection(viewAllText) {
    console.log(`\nProcessing section: ${viewAllText}`);

    await page.getByText(viewAllText, { exact: true }).click();
    await page.waitForLoadState('networkidle');

    // Collect all event cards
    const cards = await page.locator('a[href*="?e=evt-"]').all();
    console.log(`Found ${cards.length} event cards`);

    for (let i = 0; i < cards.length; i++) {
      try {
        console.log(`Opening event card ${i + 1}`);

        await cards[i].click();
        await page.waitForTimeout(1500); // wait popup

        // Click Manage in popup
        await page.getByText('Manage', { exact: true }).click();
        await page.waitForLoadState('networkidle');

        // Extract event id from URL
        const url = page.url();
        const event_id = url.match(/evt-[^/?#]+/i)?.[0];
        console.log("Managing event:", event_id);

        // Click Guests tab
        await page.getByText('Guests', { exact: true }).click();
        await page.waitForTimeout(2000);

        // Click Download as CSV
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.getByText('Download as CSV', { exact: true }).click()
        ]);

        const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
        await download.saveAs(file);
        console.log("Downloaded:", file);

        // Go back to profile list
        await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
        await page.getByText(viewAllText, { exact: true }).click();
        await page.waitForLoadState('networkidle');

      } catch (err) {
        console.log("Error, moving to next card");
        await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
        await page.getByText(viewAllText, { exact: true }).click();
        await page.waitForLoadState('networkidle');
      }
    }
  }

  // STEP 2 — Hosting
  await processSection('View All');

  // Scroll to Past Events
  await page.evaluate(() => window.scrollBy(0, 2000));
  await processSection('View All');

  await browser.close();
  console.log("All done");
})();
