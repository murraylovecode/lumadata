const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://luma.com/signin');
  console.log("Login manually...");

  await page.waitForURL('https://luma.com/home', { timeout: 0 });

  // NOW go to your profile page
  await page.goto('https://luma.com/user/murray');

  console.log("Saving session...");
  await context.storageState({ path: 'storageState.json' });

  await browser.close();
})();
