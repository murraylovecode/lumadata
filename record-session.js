const { chromium } = require('playwright');
const readline = require('readline');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("\n===============================");
  console.log(" Lu.ma REAL host session recorder");
  console.log("===============================\n");

  console.log("Do these steps EXACTLY in the browser:\n");
  console.log("1) Login to Lu.ma");
  console.log("2) Go to: https://luma.com/user/murray");
  console.log("3) Click ANY event you are hosting");
  console.log("4) Click 'Manage'");
  console.log("5) Click 'Guests'");
  console.log("6) Make sure you see the guest list + Export button\n");

  await page.goto('https://luma.com/signin');

  // Wait for you to finish manual steps
  await new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('When you are on the Guests page, press ENTER here... ', () => {
      rl.close();
      resolve();
    });
  });

  await context.storageState({ path: 'storageState.json' });

  console.log("\n✅ storageState.json saved with TRUE host privileges.");
  console.log("Commit this file to GitHub.\n");

  await browser.close();
})();
