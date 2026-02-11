console.log("Lu.ma CSV downloader — exact UI flow, stable selectors");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function autoScroll(page) {
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
  // 0 = Hosting, 1 = Past Events
  console.log(`\n=== Opening section ${sectionIndex === 0 ? 'Hosting' : 'Past Events'} ===`);

  // Click the correct "View All"
  const viewAllBtns = await page.getByRole('button', { name: 'View All' }).all();
  await viewAllBtns[sectionIndex].click();

  // Wait for popup
  await page.waitForTimeout(2000);

  // Scroll to load ALL events
  await autoScroll(page);

  // Collect ALL event links inside popup
  const eventLinks = await page.$$eval(
    'a[href*="/home?e=evt-"]',
    links => [...new Set(links.map(a => a.href))]
  );

  console.log(`Found ${eventLinks.length} events`);

  for (const link of eventLinks) {
    try {
      const evtId = link.match(/evt-[^&]+/)[0];
      console.log(`\nProcessing ${evtId}`);

      // Open popup by visiting link (same as clicking card)
      await page.goto(link, { waitUntil: 'networkidle' });

      // Click Manage
      await page.getByText('Manage', { exact: true }).click();
      await page.waitForLoadState('networkidle');

      // Guests tab
      await page.getByRole('tab', { name: 'Guests' }).click();
      await page.waitForTimeout(1500);

      // Download CSV
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByText('Download as CSV').click()
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
      await download.saveAs(filePath);

      console.log(`Downloaded CSV for ${evtId}`);

      // Go back to popup list
      await page.goBack();
      await page.waitForTimeout(1500);

    } catch (err) {
      console.log(`Skipping ${link} — ${err.message}`);
    }
  }

  // Close popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Open profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile page");

  // Hosting
  await processSection(page, 0);

  // Past Events
  await processSection(page, 1);

  await browser.close();
  console.log("\nAll CSVs downloaded successfully");
})();
