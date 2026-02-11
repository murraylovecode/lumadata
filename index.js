console.log("Lu.ma CSV downloader — UI only");

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Open your profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  async function processSection(sectionIndex) {
    // 0 = Hosting, 1 = Past Events
    const viewAll = page.getByRole('button', { name: 'View All' });
    await viewAll.nth(sectionIndex).click();

    await page.waitForSelector('a[href^="/home?e=evt-"]');

    const cards = await page.locator('a[href^="/home?e=evt-"]').all();
    console.log(`Found ${cards.length} events`);

    for (let i = 0; i < cards.length; i++) {
      try {
        console.log(`Opening event ${i + 1}/${cards.length}`);

        // Open popup
        await cards[i].click();

        // Click Manage in popup
        await page.getByText('Manage', { exact: true }).click();

        await page.waitForSelector('text=Guests');

        // Go to Guests tab
        await page.getByText('Guests', { exact: true }).click();

        // Download CSV
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.getByText('Download as CSV', { exact: true }).click()
        ]);

        const eventUrl = page.url();
        const eventId = eventUrl.match(/evt-[^/?#]+/i)?.[0] || Date.now();

        const filePath = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
        await download.saveAs(filePath);

        console.log("Downloaded:", filePath);

        // Go back to profile for next event
        await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'View All' }).nth(sectionIndex).click();
        await page.waitForSelector('a[href^="/home?e=evt-"]');

      } catch (e) {
        console.log("Skipping event due to error:", e.message);
        await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
      }
    }
  }

  // Hosting
  await processSection(0);

  // Past Events
  await processSection(1);

  console.log("All CSVs downloaded");
  await browser.close();
})();
