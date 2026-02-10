console.log("Lu.ma attendee bot");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const parse = require('csv-parse/sync').parse;

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

(async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  await page.goto('https://lu.ma/home/calendars', { waitUntil: 'networkidle' });
  await page.waitForSelector('a[href^="/calendar/manage/"]');

  const calendarLinks = await page.$$eval(
    'a[href^="/calendar/manage/"]',
    els => [...new Set(els.map(e => e.getAttribute('href')))]
  );

  for (const calHref of calendarLinks) {
    const calUrl = new URL(calHref, 'https://lu.ma').toString();
    await page.goto(calUrl, { waitUntil: 'networkidle' });

    const eventLinks = await page.$$eval(
      'a[href^="/event/manage/evt-"]',
      els => [...new Set(els.map(e => e.getAttribute('href')))]
    );

    for (const evtHref of eventLinks) {
      const eventUrl = new URL(evtHref, 'https://lu.ma').toString();
      const event_id = eventUrl.match(/evt-[^/?#]+/i)?.[0] || Date.now();

      console.log("Opening event:", eventUrl);
      await page.goto(eventUrl, { waitUntil: 'networkidle' });

      // 🔴 THIS IS THE KEY STEP YOU WERE MISSING
      console.log("Opening Guests drawer...");
      await page.locator('text=/\\d+ Guests/').first().click();

      await page.waitForSelector('text=All Guests');

      console.log("Exporting CSV...");

      await page.click('text=Export');

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.click('text=Export CSV')
      ]);

      const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
      await download.saveAs(file);
      console.log("Downloaded:", file);

      // Parse CSV
      const csv = fs.readFileSync(file, 'utf8');
      const records = parse(csv, { columns: true, skip_empty_lines: true });

      const now = new Date().toISOString();
      const rows = [];

      for (const r of records) {
        if (!r.Email) continue;

        rows.push({
          email: r.Email.toLowerCase(),
          event_id,
          event_name: event_id,
          name: r.Name || null,
          ticket_type: r['Ticket Type'] || null,
          status: r.Status || null,
          registered_at: r['Registered At']
            ? new Date(r['Registered At']).toISOString()
            : null,
          raw: r,
          enriched: null,
          first_seen_at: now,
          last_seen_at: now,
        });
      }

      if (rows.length) {
        await supabase.from('luma_ui_attendees').upsert(rows);
        console.log(`Upserted ${rows.length} attendees`);
      }

      await page.keyboard.press('Escape'); // close drawer
    }
  }

  await browser.close();
})();
