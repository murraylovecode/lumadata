console.log("Lu.ma — Extract all hosted events (stable)");

require('dotenv').config();
const { chromium } = require('playwright');

async function scrollFully(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

async function collectEventsFromSection(page, sectionIndex) {
  console.log(`\nProcessing section index ${sectionIndex} (0=Hosting, 1=Past)`);

  // Click correct "View All"
  const viewAllButtons = await page.getByText('View All', { exact: true }).all();
  await viewAllButtons[sectionIndex].click();

  await page.waitForTimeout(2000);
  await scrollFully(page);

  // Extract event ids from popup links
  const eventIds = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="evt-"]'));
    const ids = links
      .map(a => {
        const match = a.href.match(/evt-[A-Za-z0-9]+/);
        return match ? match[0] : null;
      })
      .filter(Boolean);

    return [...new Set(ids)];
  });

  console.log(`Found ${eventIds.length} events in section ${sectionIndex}`);

  // Close popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  return eventIds;
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json'
  });

  const page = await context.newPage();

  await page.goto('https://luma.com/user/murray', {
    waitUntil: 'networkidle'
  });

  console.log("Opened profile page");

  const hostingEvents = await collectEventsFromSection(page, 0);
  const pastEvents = await collectEventsFromSection(page, 1);

  const allEvents = [...new Set([...hostingEvents, ...pastEvents])];

  console.log("\n===============================");
  console.log("TOTAL UNIQUE EVENTS FOUND:", allEvents.length);
  console.log("===============================");

  console.log(allEvents);

  await browser.close();
})();
