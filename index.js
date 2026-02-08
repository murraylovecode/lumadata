require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto('https://lu.ma/login');

  await page.fill('input[type="email"]', process.env.LUMA_EMAIL);
  await page.fill('input[type="password"]', process.env.LUMA_PASSWORD);
  await page.click('button[type="submit"]');

  await page.waitForLoadState('networkidle');

  // Go to calendar
  await page.goto('https://lu.ma/calendar');

  console.log("Logged in and on calendar");

  await browser.close();
})();
