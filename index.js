console.log("Lu.ma CSV downloader — final stable version");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function scrollToBottom(page) {
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

async function processSection(page, sectionIndex) {
  console.log(`\n=== Processing section ${sectionIndex === 0 ? "Hosting" : "Past Events"} ===`);

  // Click correct "View All"
  const viewAllButtons = await page.getByText('View All', { exact: true }).all();
  await viewAllButtons[sectionIndex].click();

  await page.waitForTimeout(2000);
  await scrollToBottom(page);

  // IMPORTANT: real event cards
  const cards = await page.locator('div[role="button"]:has-text("By ")').all();
  console.log(`Found ${cards.length} event cards`);

  for (let i = 0; i < cards.length; i++) {
    console.log(`\nOpening card ${i + 1}/${cards.length}`);

    try {
      // Always re-query cards after DOM changes
      const card = page.locator('div[role="button"]:has-text("By ")').nth(i);

      await card.scrollIntoViewIfNeeded();
      await card.click();

      // Wait popup
      await page.waitForSelector('text=Manage', { timeout: 0 });

      // Click Manage
      await page.getByText('Manage', { exact: true }).click();
      await page.waitForLoadState('networkidle');

      // Guests tab
      await page.getByRole('tab', { name: 'Guests' }).click();
      await page.waitForTimeout(1500);

      // Download CSV
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 0 }),
        page.getByText('Download as CSV', { exact: true }).click()
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
      await download.saveAs(filePath);
      console.log("Downloaded:", filePath);

      // Go back to popup list
      await page.goBack();
      await page.waitForTimeout(2000);
      await scrollToBottom(page);

    } catch (err) {
      console.log("Error on this card, moving on");
      await page.goBack().catch(() => {});
      await page.waitForTimeout(2000);
      await scrollToBottom(page);
    }
  }

  // Close popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}

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

  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  await processSection(page, 0); // Hosting
  await processSection(page, 1); // Past Events

  console.log("\nAll CSVs downloaded");
  await browser.close();
})();
