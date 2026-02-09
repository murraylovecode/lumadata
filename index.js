console.log("Script started with saved session");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const parse = require('csv-parse/sync').parse;

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');

function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

(async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  ensureDownloadDir();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // --- Open Lu.ma dashboard ---
  await page.goto('https://lu.ma/calendar', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log("Opened Lu.ma:", page.url());

  if (page.url().includes('login')) {
    throw new Error('Session expired. Recreate storageState.json');
  }

  // --- Scroll to load lazy events ---
  console.log("Scrolling page to load events...");
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

  // --- Collect event links ---
  await page.waitForSelector('a[href*="/event/evt-"]', { timeout: 60000 });

  const eventLinks = await page.$$eval('a[href*="/event/evt-"]', els =>
    [...new Set(els.map(e => e.getAttribute('href')))]
  );

  console.log(`Found ${eventLinks.length} events`);

  // --- Process each event ---
  for (let i = 0; i < eventLinks.length; i++) {
    const eventUrl = new URL(eventLinks[i], 'https://lu.ma').toString();

    console.log(`\n=== Processing event ${i + 1}/${eventLinks.length} ===`);
    console.log("Opening:", eventUrl);

    await page.goto(eventUrl, { waitUntil: 'networkidle' });

    const event_id = eventUrl.match(/evt-[^/?#]+/i)?.[0] || `evt-${Date.now()}`;

    let event_name = event_id;
    try {
      const h1 = await page.$('h1');
      if (h1) event_name = (await h1.innerText()).trim();
    } catch {}

    console.log("Event:", event_name);

    // --- Export attendees ---
    const exportSelectors = ['text=Export attendees', 'text=Export', 'text=Download attendees'];
    let downloadedFile = null;

    for (const sel of exportSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.click(sel)
        ]);

        const filename = path.join(DOWNLOAD_DIR, `${event_id}-${Date.now()}.csv`);
        await download.saveAs(filename);

        downloadedFile = filename;
        console.log("Downloaded:", filename);
        break;
      } catch {}
    }

    if (!downloadedFile) {
      console.warn("Could not find export button, skipping event");
      continue;
    }

    // --- Parse CSV ---
    const csv = fs.readFileSync(downloadedFile, 'utf8');
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
      const { error } = await supabase.from('luma_ui_attendees').upsert(rows);
      if (error) console.error(error);
      else console.log(`Upserted ${rows.length} attendees`);
    }

    // --- Return to dashboard before next event ---
    await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle' });

    // Scroll again to reload cards
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
  }

  console.log("All events processed");
  await browser.close();
})();
