console.log("Script started");

require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  // Go to login and WAIT properly
  await page.goto('https://lu.ma/login', { waitUntil: 'networkidle' });

  // Lu.ma uses name="email" and name="password"
  await page.waitForSelector('input[name="email"]', { timeout: 60000 });

  await page.fill('input[name="email"]', process.env.LUMA_EMAIL);
  await page.fill('input[name="password"]', process.env.LUMA_PASSWORD);

  await page.click('button[type="submit"]');

  // Wait until login completes and dashboard loads
  await page.waitForLoadState('networkidle');

  console.log("Logged into Lu.ma");

  // Go to calendar
  await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle' });

  console.log("On calendar page");

  await browser.close();
})();
