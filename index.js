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

  // Open calendars hub
  await page.goto('https://lu.ma/home/calendars', { waitUntil: 'networkidle' });
  console.log("Opened calendars hub");

  await page.waitForSelector('a[href^="/calendar/manage/"]');

  const calendarLinks = await page.$$eval(
    'a[href^="/calendar/manage/"]',
    els => [...new Set(els.map(e => e.getAttribute('href')))]
  );

  console.log(`Found ${calendarLinks.length} calendars`);

  for (const calHref of calendarLinks) {
    const calUrl = new URL(calHref, 'https://lu.ma').toString();
    console.log("\nOpening calendar:", calUrl);

    await page.goto(calUrl, { waitUntil: 'networkidle' });

    // Scroll to load events
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

    // Get events
    const eventLinks = await page.$$eval(
      'a[href^="/event/manage/evt-"]',
      els => [...new Set(els.map(e => e.getAttribute('href')))]
    );

    console.log(`Found ${eventLinks.length} events`);

    for (const evtHref of eventLinks) {
      const eventUrl = new URL(evtHref, 'https://lu.ma').toString();
      const guestsUrl = `${eventUrl}/guests`;
      const event_id = eventUrl.match(/evt-[^/?#]+/i)?.[0] || Date.now();

      console.log("Opening Guests page:", guestsUrl);

      await page.goto(guestsUrl, { waitUntil: 'networkidle' });

      console.log("Searching for element that triggers CSV download...");

      let download = null;

      // Try clicking anything clickable until a download starts
      const candidates = await page.locator('button, a, [role="button"]').all();

      for (const el of candidates) {
        try {
          [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 2000 }),
            el.click({ force: true })
          ]);
          break;
        } catch {}
      }

      if (!download) {
        const hasText = await page.content();
        if (hasText.includes("No guests yet") || hasText.includes("0 guests")) {
          console.log("Event has no attendees. Skipping.");
        } else {
          console.log("No export permission for this event. Skipping.");
        }
        continue;
      }


      const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
      await download.saveAs(file);
      console.log("Downloaded CSV:", file);

      // Parse CSV
      const csv = fs.readFileSync(file, 'utf8');
      const records = parse(csv, { columns: true, skip_empty_lines: true });

      let event_name = event_id;
      try {
        const h1 = await page.$('h1');
        if (h1) event_name = (await h1.innerText()).trim();
      } catch {}

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
