console.log("Lu.ma attendee bot – UI faithful v2");

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

  async function processViewAllByIndex(index, label) {
    console.log(`\nProcessing: ${label}`);

    await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });

    const viewAllButtons = await page.getByText('View All').all();
    await viewAllButtons[index].click();
    await page.waitForLoadState('networkidle');

    const cards = await page.locator('a[href*="?e=evt-"]').all();
    console.log(`Found ${cards.length} events`);

    for (let i = 0; i < cards.length; i++) {
      try {
        console.log(`Opening event ${i + 1}`);

        await cards[i].click();
        await page.waitForTimeout(1500);

        await page.getByText('Manage').click();
        await page.waitForLoadState('networkidle');

        const event_id = page.url().match(/evt-[^/?#]+/i)?.[0];
        console.log("Managing:", event_id);

        await page.getByText('Guests').click();
        await page.waitForTimeout(2000);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.getByText('Download as CSV').click()
        ]);

        const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
        await download.saveAs(file);
        console.log("Downloaded:", file);

      } catch (e) {
        console.log("Error, moving next");
      }
    }
  }

  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  // 0 = Hosting
  await processViewAllByIndex(0, "Hosting");

  // 1 = Past Events
  await processViewAllByIndex(1, "Past Events");

  await browser.close();
  console.log("All done");
})();
