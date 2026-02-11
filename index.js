console.log("Lu.ma CSV downloader — exact human flow");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function slowScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });
}

async function processSection(page, sectionName) {
  console.log(`\n=== Processing ${sectionName} ===`);

  // Click the correct "View All" for Hosting / Past Events
  const viewAllButtons = await page.getByText('View All', { exact: true }).all();
  await viewAllButtons[sectionName === 'Hosting' ? 0 : 1].click();

  await page.waitForTimeout(2000);
  await slowScroll(page); // load all cards

  const cards = await page.locator('div:has-text("By ")').all();
  console.log(`Found ${cards.length} event cards`);

  for (let i = 0; i < cards.length; i++) {
    console.log(`\nOpening card ${i + 1}/${cards.length}`);

    try {
      await cards[i].click({ force: true });
      await page.waitForTimeout(1500);

      // Click Manage in popup
      await page.getByText('Manage').click({ timeout: 0 });
      await page.waitForLoadState('networkidle');

      // Guests tab
      await page.getByRole('tab', { name: 'Guests' }).click({ timeout: 0 });
      await page.waitForTimeout(1500);

      // Download CSV
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 0 }),
        page.getByText('Download as CSV').click()
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
      await download.saveAs(filePath);
      console.log("Downloaded:", filePath);

      // Go back to cards list
      await page.goBack();
      await page.waitForTimeout(2000);
      await slowScroll(page);

    } catch (err) {
      console.log("Error on this card, moving on");
      await page.goBack().catch(() => {});
      await page.waitForTimeout(2000);
      await slowScroll(page);
    }
  }

  // Close the View All popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
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
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  await processSection(page, 'Hosting');
  await processSection(page, 'Past Events');

  console.log("\nAll CSVs downloaded");
  await browser.close();
})();
