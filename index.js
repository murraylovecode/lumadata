console.log("Lu.ma CSV downloader — stable UI flow");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function safeClick(locator) {
  await locator.waitFor({ state: 'visible', timeout: 60000 });
  await locator.click({ timeout: 60000 });
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

  // Open profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });
  console.log("Opened profile");

  async function processSection(sectionIndex) {
    console.log(`Processing section ${sectionIndex === 0 ? 'Hosting' : 'Past Events'}`);

    // Click correct "View All"
    const viewAll = page.locator('text=View All').nth(sectionIndex);
    await safeClick(viewAll);

    // Wait for event cards to appear
    await page.locator('text=By ').first().waitFor({ timeout: 60000 });

    let eventCount = await page.locator('text=By ').count();
    console.log(`Found ${eventCount} events`);

    for (let i = 0; i < eventCount; i++) {
      console.log(`Event ${i + 1}/${eventCount}`);

      try {
        // Always re-query cards (DOM refreshes)
        const card = page.locator('text=By ').nth(i);
        await safeClick(card);

        // Wait for popup Manage button
        const manageBtn = page.locator('text=Manage');
        await safeClick(manageBtn);

        // Guests tab
        const guestsTab = page.locator('text=Guests');
        await safeClick(guestsTab);

        // Wait for CSV button to exist
        const csvBtn = page.locator('text=Download as CSV');
        await csvBtn.waitFor({ timeout: 60000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          csvBtn.click()
        ]);

        const file = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
        await download.saveAs(file);
        console.log("Downloaded:", file);

        // Go back to profile
        await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });

        // Re-enter section
        await safeClick(page.locator('text=View All').nth(sectionIndex));
        await page.locator('text=By ').first().waitFor({ timeout: 60000 });

      } catch (err) {
        console.log("Skipping problematic event");

        await page.goto('https://luma.com/user/murray', { waitUntil: 'domcontentloaded' });
        await safeClick(page.locator('text=View All').nth(sectionIndex));
        await page.locator('text=By ').first().waitFor({ timeout: 60000 });
      }
    }
  }

  await processSection(0); // Hosting
  await processSection(1); // Past Events

  console.log("All done");
  await browser.close();
})();
