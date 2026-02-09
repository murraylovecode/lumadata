console.log("Script started with saved session");

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });

  // Use the saved logged-in session
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Go directly to calendar (no login)
  await page.goto('https://lu.ma/calendar', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log("Opened Lu.ma calendar with stored session");

  // Small proof that we are really logged in
  const url = page.url();
  console.log("Current URL:", url);

  if (url.includes('login')) {
    throw new Error('Session expired. Need to regenerate storageState.json');
  }

  await browser.close();
})();
