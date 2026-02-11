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

  // STEP 1 — Go to Murray profile (hosted events list)
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened Murray profile");

  // Collect event links from profile page
  const eventLinks = await page.$$eval('a[href*="/event/manage/evt-"]',
    els => [...new Set(els.map(e => e.href))]
  );

  console.log("Found hosted events:", eventLinks.length);

  for (const eventUrl of eventLinks) {
    const event_id = eventUrl.match(/evt-[^/]+/)[0];
    const guestsUrl = `${eventUrl}/guests`;

    console.log("Opening Guests:", guestsUrl);
    await page.goto(guestsUrl, { waitUntil: 'networkidle' });

    // Click Export → Export CSV
    await page.click('text=Export');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text=Export CSV')
    ]);

    const filePath = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
    await download.saveAs(filePath);
    console.log("Downloaded:", filePath);

    // Parse CSV
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
      console.log(`Upserted ${rows.length} attendees`);
    }
  }

  await browser.close();
})();
