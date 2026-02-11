// index.js
console.log("Lu.ma CSV downloader — fixed, UI-faithful");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const PROFILE_URL = 'https://luma.com/user/murray';

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

async function robustClick(locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await locator.click({ timeout: 10000 });
    return true;
  } catch (e1) {
    try {
      // fallback to DOM click
      await locator.evaluate((el) => el.click && el.click());
      return true;
    } catch (e2) {
      try {
        // final fallback: dispatch mouse event
        await locator.evaluate((el) => {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          el.dispatchEvent(ev);
        });
        return true;
      } catch (e3) {
        return false;
      }
    }
  }
}

async function processSection(page, sectionIndex) {
  console.log(`\n=== Processing section index ${sectionIndex} (0=Hosting,1=Past Events) ===`);

  // open profile and click the right View All (0 or 1)
  await page.goto(PROFILE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const viewAllButtons = page.getByText('View All', { exact: true });
  const viewAllCount = await viewAllButtons.count();
  if (viewAllCount <= sectionIndex) {
    console.log(`No View All button at index ${sectionIndex} (found ${viewAllCount}). Skipping section.`);
    return;
  }

  await robustClick(viewAllButtons.nth(sectionIndex));
  await page.waitForTimeout(1200);

  // scroll to load everything
  await slowScroll(page);
  await page.waitForTimeout(600);

  // find event cards by text pattern that exists inside each card ("By <host>")
  // we re-query inside the loop to avoid stale handles
  let cardCount = await page.locator('div:has-text("By ")').count();
  console.log(`Found ${cardCount} event cards`);

  for (let i = 0; i < cardCount; i++) {
    console.log(`\nOpening card ${i + 1}/${cardCount}`);
    try {
      // re-query locator each iteration (avoid stale element handles)
      const cards = page.locator('div:has-text("By ")');
      const card = cards.nth(i);

      const clicked = await robustClick(card);
      if (!clicked) throw new Error('Failed to click event card');

      // wait a little for popup to appear
      await page.waitForTimeout(800);

      // click Manage (popup contains Manage link/button)
      const manageLocator = page.getByText('Manage', { exact: true });
      await manageLocator.waitFor({ timeout: 30000 });
      const manageClicked = await robustClick(manageLocator);
      if (!manageClicked) throw new Error('Failed to click Manage');

      // now on the manage page: wait for Guests tab
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);

      const guestsLocator = page.getByText('Guests', { exact: true });
      await guestsLocator.waitFor({ timeout: 30000 });
      await robustClick(guestsLocator);
      await page.waitForTimeout(800);

      // Trigger CSV download
      // use a generous timeout for download (API + generation may be slow)
      const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
      const downloadButton = page.getByText('Download as CSV', { exact: true }).first();
      await downloadButton.waitFor({ timeout: 30000 });
      await robustClick(downloadButton);

      const download = await downloadPromise;
      if (!download) throw new Error('Download did not start');

      // build filename using event id from URL if available
      const currentUrl = page.url();
      const eventIdMatch = currentUrl.match(/evt-[^/?#]+/i);
      const eventId = eventIdMatch ? eventIdMatch[0] : `evt-unknown-${Date.now()}`;
      const outFile = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
      await download.saveAs(outFile);
      console.log('Downloaded CSV to:', outFile);

      // after finishing, return to profile popup list: navigate to profile and re-open same section
      await page.goto(PROFILE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      // reopen the same View All popup
      await robustClick(viewAllButtons.nth(sectionIndex));
      await page.waitForTimeout(800);
      await slowScroll(page);
      await page.waitForTimeout(600);

      // re-calc cardCount in case it changed (we iterate on original cardCount to avoid infinite loop)
      // but keep original count to process same indices
    } catch (err) {
      console.log('Error on this card, moving on:', err.message || err);
      // attempt to recover: go to profile and reopen popup to continue
      try {
        await page.goto(PROFILE_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        const v = page.getByText('View All', { exact: true });
        if ((await v.count()) > sectionIndex) {
          await robustClick(v.nth(sectionIndex));
          await page.waitForTimeout(800);
          await slowScroll(page);
        }
      } catch (e) {
        // ignore recovery errors
      }
    }
  }

  // Close the popup if still open (Escape)
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(600);
}

(async () => {
  const browser = await chromium.launch({
    headless: false, // set to true in CI if you prefer
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // go to profile once and then process sections
  await page.goto(PROFILE_URL, { waitUntil: 'networkidle' });
  console.log('Opened profile');

  // Hosting (index 0) and Past Events (index 1)
  await processSection(page, 0);
  await processSection(page, 1);

  console.log('\nAll done — CSVs downloaded in', DOWNLOAD_DIR);
  await browser.close();
})();
