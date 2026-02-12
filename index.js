console.log("Lu.ma Event ID Extractor & CSV Downloader");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

(async () => {
  const browser = await chromium.launch({
    headless: true, // Set to false if you want to see the browser
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true
  });

  const page = await context.newPage();

  // 1️⃣ Open profile page
  console.log("Opening profile...");
  await page.goto('https://lu.ma/user/murray', {
    waitUntil: 'networkidle'
  });

  // Verify login status (optional but helpful)
  const isLoggedIn = await page.evaluate(() => !!document.querySelector('.user-avatar') || !!document.querySelector('.avatar-wrapper'));
  console.log("Is logged in (estimated):", isLoggedIn);

  async function extractIdsFromModal() {
    // Wait for modal to appear and load content
    await page.waitForTimeout(2000);

    // Scroll modal logic if needed
    await page.evaluate(async () => {
      const modal = document.querySelector('.lux-modal-body');
      if (modal) {
        let lastHeight = modal.scrollHeight;
        for (let i = 0; i < 5; i++) {
          modal.scrollTop = modal.scrollHeight;
          await new Promise(r => setTimeout(r, 1000));
          if (modal.scrollHeight === lastHeight) break;
          lastHeight = modal.scrollHeight;
        }
      }
    });

    const content = await page.content();
    const matches = content.match(/evt-[A-Za-z0-9]+/g) || [];

    // Close modal
    const closeButton = page.locator('.lux-modal-close, .close-button').first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(1000);
    } else {
      // Press Escape as fallback
      await page.keyboard.press('Escape');
    }

    return matches;
  }

  const allEvtIds = new Set();

  // Find all "View All" buttons
  const viewAllButtons = page.getByText('View All');
  const count = await viewAllButtons.count();
  console.log(`Found ${count} "View All" buttons.`);

  for (let i = 0; i < count; i++) {
    const btn = viewAllButtons.nth(i);
    try {
      console.log(`Clicking "View All" button #${i + 1}...`);
      await btn.click();
      const ids = await extractIdsFromModal();
      ids.forEach(id => allEvtIds.add(id));
      console.log(`Updated unique IDs count: ${allEvtIds.size}`);
    } catch (err) {
      console.log(`Error processing "View All" button #${i + 1}: ${err.message}`);
    }
  }

  // Also extract IDs from the main page directly (in case some are visible)
  const mainPageIds = (await page.content()).match(/evt-[A-Za-z0-9]+/g) || [];
  mainPageIds.forEach(id => allEvtIds.add(id));

  const uniqueEvtIds = [...allEvtIds];
  console.log(`Total unique events found: ${uniqueEvtIds.length}`);

  if (uniqueEvtIds.length === 0) {
    console.log("No events found. Exiting.");
    await browser.close();
    return;
  }

  // 3️⃣ Loop through each event ID and download CSV
  for (let i = 0; i < uniqueEvtIds.length; i++) {
    const evtId = uniqueEvtIds[i];
    const guestsUrl = `https://luma.com/event/manage/${evtId}/guests`;

    console.log(`\n[${i + 1}/${uniqueEvtIds.length}] Processing: ${evtId}`);

    try {
      await page.goto(guestsUrl, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      console.log(`Page title: ${await page.title()}`);

      const downloadButton = page.getByText('Download as CSV', { exact: true });

      // Wait for it to be visible or at least present
      await downloadButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);

      if (await downloadButton.isVisible()) {
        console.log("Found download button. Clicking...");

        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            downloadButton.click()
          ]);

          const filePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
          await download.saveAs(filePath);
          console.log(`✅ Saved: ${filePath}`);
        } catch (downloadErr) {
          console.log(`❌ Download failed for ${evtId}: ${downloadErr.message}`);
        }
      } else {
        console.log(`⚠️ Download button not found for ${evtId}. Access might be restricted or no guests.`);
      }

    } catch (err) {
      console.log(`❌ Error visiting ${evtId}: ${err.message}`);
    }
  }

  console.log("\nAll events processed.");
  await browser.close();
})();
