require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const parse = require('csv-parse/sync').parse;

const DOWNLOAD_DIR = path.resolve('downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Open Murray profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened Murray profile");

  // Get all event cards
  const eventCards = await page.locator('a[href^="/"]').filter({ hasText: /./ }).all();
  console.log("Event cards found:", eventCards.length);

  for (let i = 0; i < eventCards.length; i++) {
    try {
      console.log(`Opening event card ${i + 1}`);

      await eventCards[i].click();
      await page.waitForTimeout(2000);

      // Click Manage in popup
      await page.click('text=Manage');
      await page.waitForLoadState('networkidle');

      const manageUrl = page.url();
      if (!manageUrl.includes('/event/manage/evt-')) {
        console.log("Not a hosted event. Skipping.");
        await page.goBack();
        continue;
      }

      const event_id = manageUrl.match(/evt-[^/]+/)[0];

      // Go to guests
      await page.goto(`${manageUrl}/guests`, { waitUntil: 'networkidle' });

      console.log("Exporting CSV for", event_id);

      await page.click('text=Export');

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=Export CSV')
      ]);

      const filePath = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
      await download.saveAs(filePath);

      const csv = fs.readFileSync(filePath);
      const records = parse(csv, { columns: true });

      const now = new Date().toISOString();
      const rows = records
        .filter(r => r.Email)
        .map(r => ({
          email: r.Email.toLowerCase(),
          event_id,
          name: r.Name,
          raw: r,
          first_seen_at: now,
          last_seen_at: now
        }));

      if (rows.length) {
        await supabase.from('luma_ui_attendees').upsert(rows);
        console.log(`Upserted ${rows.length}`);
      }

      await page.goto('https://luma.com/user/murray');
      await page.waitForTimeout(2000);

    } catch (err) {
      console.log("Error, moving to next card");
      await page.goto('https://luma.com/user/murray');
    }
  }

  await browser.close();
})();
