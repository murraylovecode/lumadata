console.log("Lu.ma CSV downloader — stable UI flow");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

async function autoScroll(page) {
  let previous = 0;

  while (true) {
    const current = await page.locator('div:has-text("By ")').count();
    if (current === previous) break;

    previous = current;
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(1000);
  }
}

async function processSection(page, sectionIndex) {
  console.log(`\n=== Processing section ${sectionIndex} (0=Hosting,1=Past) ===`);

  const viewAllButtons = await page.getByText('View All', { exact: true }).all();
  if (!viewAllButtons[sectionIndex]) {
    console.log("View All button not found");
    return;
  }

  await viewAllButtons[sectionIndex].click();
  await page.waitForTimeout(2000);

  await autoScroll(page);

  const cards = page.locator('a[href^="/event/manage/evt-');
  const total = await cards.count();

  console.log(`Found ${total} event cards`);

  for (let i = 0; i < total; i++) {
    console.log(`\nOpening card ${i + 1}/${total}`);

    try {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      const card = cards.nth(i);
      await card.click();
      
      // Wait for Manage button in popup
      const manageBtn = page.getByText('Manage', { exact: true });
      await manageBtn.waitFor({ timeout: 5000 });
      await manageBtn.click();

      // Now on manage page
      await page.waitForLoadState('networkidle');

      // Click Guests tab
      await page.getByRole('tab', { name: 'Guests' }).click();
      await page.waitForTimeout(1500);

      // Download CSV
      const downloadButton = page.getByText('Download as CSV', { exact: true });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        downloadButton.click()
      ]);

      const filePath = path.join(
        DOWNLOAD_DIR,
        `event-${Date.now()}.csv`
      );

      await download.saveAs(filePath);
      console.log("Downloaded:", filePath);

      // Go back to popup list
      await page.goBack();
      await page.waitForTimeout(2000);

      // Scroll again to restore lazy content
      await autoScroll(page);

    } catch (err) {
      console.log("Error on this card, moving on:", err.message);

      try {
        await page.goBack();
        await page.waitForTimeout(2000);
        await autoScroll(page);
      } catch {}
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
    acceptDownloads: true
  });

  const page = await context.newPage();

  await page.goto('https://luma.com/user/murray', {
    waitUntil: 'networkidle'
  });

  console.log("Opened profile");

  await processSection(page, 0); // Hosting
  await processSection(page, 1); // Past Events

  console.log("\nAll CSVs processed");
  await browser.close();
})();
