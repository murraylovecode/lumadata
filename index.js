console.log("Lu.ma CSV downloader — direct evt extraction");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

async function autoScroll(page) {
  let previousHeight = 0;

  while (true) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;

    previousHeight = currentHeight;
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(1000);
  }
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

  // 1️⃣ Open profile page
  await page.goto('https://luma.com/user/murray', {
    waitUntil: 'networkidle'
  });

  console.log("Opened profile");

  // 2️⃣ Scroll fully to load Hosting + Past Events
  await autoScroll(page);

  // 3️⃣ Extract all evt IDs from page HTML
  const html = await page.content();

  const evtMatches = html.match(/evt-[A-Za-z0-9]+/g) || [];
  const uniqueEvtIds = [...new Set(evtMatches)];

  console.log("Total unique events found:", uniqueEvtIds.length);

  if (uniqueEvtIds.length === 0) {
    console.log("No events found. Exiting.");
    await browser.close();
    return;
  }

  // 4️⃣ Loop through each event ID
  for (let i = 0; i < uniqueEvtIds.length; i++) {
    const evtId = uniqueEvtIds[i];

    console.log(`\nProcessing ${i + 1}/${uniqueEvtIds.length}: ${evtId}`);

    try {
      const guestsUrl = `https://luma.com/event/manage/${evtId}/guests`;

      await page.goto(guestsUrl, {
        waitUntil: 'networkidle'
      });

      // Wait for Download button
      const downloadButton = page.getByText('Download as CSV', { exact: true });
      await downloadButton.waitFor({ timeout: 10000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        downloadButton.click()
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
      await download.saveAs(filePath);

      console.log("Downloaded:", filePath);

    } catch (err) {
      console.log("Skipping (no permission or no guests):", evtId);
    }
  }

  console.log("\nAll events processed");
  await browser.close();
})();
