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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // STEP 1 — calendars hub
  await page.goto('https://lu.ma/home/calendars', { waitUntil: 'networkidle' });
  console.log("Opened calendars hub");

  await page.waitForSelector('a[href^="/calendar/manage/"]');

  const calendarLinks = await page.$$eval(
    'a[href^="/calendar/manage/"]',
    els => [...new Set(els.map(e => e.getAttribute('href')))]
  );

  console.log(`Found ${calendarLinks.length} calendars`);

  // LOOP CALENDARS
  for (const calHref of calendarLinks) {
    const calUrl = new URL(calHref, 'https://lu.ma').toString();
    console.log("\nOpening calendar:", calUrl);

    await page.goto(calUrl, { waitUntil: 'networkidle' });

    // scroll to load events
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
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

    // collect events
    const eventLinks = await page.$$eval(
      'a[href^="/event/manage/evt-"]',
      els => [...new Set(els.map(e => e.getAttribute('href')))]
    );

    console.log(`Found ${eventLinks.length} events`);

    // LOOP EVENTS
    for (const evtHref of eventLinks) {
      const eventUrl = new URL(evtHref, 'https://lu.ma').toString();
      console.log("Opening event:", eventUrl);

      await page.goto(eventUrl, { waitUntil: 'networkidle' });

      const event_id = eventUrl.match(/evt-[^/?#]+/i)?.[0] || Date.now();

      let event_name = event_id;
      try {
        const h1 = await page.$('h1');
        if (h1) event_name = (await h1.innerText()).trim();
      } catch {}

      // STEP — open Guests tab (final correct way)
      const guestsTab = page.locator('a.tab[href$="/guests"]').first();

      await guestsTab.scrollIntoViewIfNeeded();
      await guestsTab.click({ force: true });

      console.log("Guests tab clicked");

      // Wait until Export button appears
      await page.waitForSelector('text=Export attendees', { timeout: 30000 });

      // Export CSV
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.click('text=Export attendees')
      ]);

      const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
      await download.saveAs(file);

      console.log("Downloaded CSV:", file);

      // Parse CSV
      const csv = fs.readFileSync(file, 'utf8');
      const records = parse(csv, { columns: true, skip_empty_lines: true });

      console.log(`Parsed ${records.length} attendees`);

      const now = new Date().toISOString();
      const rows = [];

      for (const r of records) {
        if (!r.Email) continue;

        rows.push({
          email: r.Email.toLowerCase(),
          event_id,
          event_name,
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
    }
  }

  await browser.close();
  console.log("All done");
})();
