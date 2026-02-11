console.log("Lu.ma CSV downloader — API method");

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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
  });

  const page = await context.newPage();

  // 1️⃣ Open your profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  // 2️⃣ Scroll to load all events
  await autoScroll(page);
  await page.waitForTimeout(2000);

  // 3️⃣ Extract ALL evt ids from page
  const evtIds = await page.evaluate(() => {
    const ids = new Set();
    document.querySelectorAll('a[href*="e=evt-"]').forEach(a => {
      const match = a.href.match(/evt-[A-Za-z0-9]+/);
      if (match) ids.add(match[0]);
    });
    return Array.from(ids);
  });

  console.log(`Found ${evtIds.length} events`);

  // 4️⃣ Use same session to call CSV API
  const request = context.request;

  for (const evtId of evtIds) {
    try {
      console.log(`Downloading CSV for ${evtId}`);

      const res = await request.get(
        `https://luma.com/api/event/${evtId}/guests/export`,
        { timeout: 60000 }
      );

      if (!res.ok()) {
        console.log(`No permission or no guests for ${evtId}`);
        continue;
      }

      const buffer = await res.body();
      const filePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
      fs.writeFileSync(filePath, buffer);

      console.log(`Saved: ${filePath}`);
    } catch (err) {
      console.log(`Failed for ${evtId}`);
    }
  }

  await browser.close();
  console.log("All CSVs downloaded");
})();
