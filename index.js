console.log("Lu.ma attendee bot – exact UI flow");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Step 1 — Open your profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  async function processSection(viewAllButtonSelector, sectionName) {
    console.log(`\nProcessing ${sectionName}`);

    await page.click(viewAllButtonSelector);
    await page.waitForTimeout(3000);

    // Find all event cards by the "By Murray" text
    const cards = await page.locator('div:has-text("By Murray")').all();
    console.log(`Found ${cards.length} events`);

    for (let i = 0; i < cards.length; i++) {
      try {
        console.log(`Opening event ${i + 1}`);

        await cards[i].click();
        await page.waitForTimeout(2000);

        // Popup → click Manage
        await page.click('text=Manage');
        await page.waitForLoadState('networkidle');

        // Click Guests tab
        await page.click('text=Guests');
        await page.waitForTimeout(2000);

        // Click Download as CSV
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.click('text=Download as CSV')
        ]);

        const filePath = path.join(DOWNLOAD_DIR, `event-${Date.now()}.csv`);
        await download.saveAs(filePath);

        console.log("Downloaded:", filePath);

        await page.goBack();
        await page.goBack();
        await page.waitForTimeout(2000);

      } catch (err) {
        console.log("Error on this event, moving on");
        await page.goBack().catch(()=>{});
      }
    }

    await page.goto('https://luma.com/user/murray');
    await page.waitForTimeout(2000);
  }

  // Hosting → View All
  await processSection(
    '#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(1) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button',
    'Hosting'
  );

  // Past Events → View All
  await processSection(
    '#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(2) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button',
    'Past Events'
  );

  console.log("All done");
  await browser.close();
})();
