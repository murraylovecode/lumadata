console.log("Script started");

require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto('https://lu.ma/login', { waitUntil: 'networkidle' });

  // STEP 1 — Click "Continue with email"
  await page.waitForSelector('text=Continue with email', { timeout: 60000 });
  await page.click('text=Continue with email');

  // STEP 2 — Now the real inputs appear
  await page.waitForSelector('input[name="email"]', { timeout: 60000 });

  await page.fill('input[name="email"]', process.env.LUMA_EMAIL);
  await page.fill('input[name="password"]', process.env.LUMA_PASSWORD);

  await page.click('button[type="submit"]');

  await page.waitForLoadState('networkidle');

  console.log("Logged into Lu.ma");

  await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle' });

  console.log("On calendar page");

  await browser.close();
})();
