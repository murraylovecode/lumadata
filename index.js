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
  // --- Supabase setup ---
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  ensureDownloadDir();

  // --- Browser with saved Lu.ma session ---
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // --- Open calendar dashboard ---
  await page.goto('https://lu.ma/calendar', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log("Opened Lu.ma calendar:", page.url());

  if (page.url().includes('login')) {
    throw new Error('Session expired. Recreate storageState.json');
  }

  // --- Wait for event cards ---
  console.log("Waiting for event cards...");
  await page.waitForSelector('a[href^="/event/"]', { timeout: 60000 });

  const eventLinks = await page.$$eval('a[href^="/event/"]', els =>
    [...new Set(els.map(e => e.getAttribute('href')))]
  );

console.log(`Found ${eventLinks.length} events`);


  // --- Loop through events ---
  for (let i = 0; i < eventButtons.length; i++) {
    console.log(`\n=== Processing event ${i + 1}/${eventButtons.length} ===`);

    // Re-fetch buttons each loop (DOM refreshes after navigation)
    const buttons = await page.$$('text=View event');
    await buttons[i].click();

    await page.waitForLoadState('networkidle');

    const eventUrl = page.url();
    console.log("Event URL:", eventUrl);

    const match = eventUrl.match(/\/event\/([^/?#]+)/i);
    const event_id = match ? match[1] : `evt-${Date.now()}`;

    // Get event name
    let event_name = event_id;
    try {
      const h1 = await page.$('h1');
      if (h1) {
        event_name = (await h1.innerText()).trim();
      }
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
      console.warn("Export button not found. Skipping event.");
      await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle' });
      await page.waitForSelector('text=View event');
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
      else console.log(`Upserted ${rows.length} rows to Supabase`);
    }

    // --- Back to calendar for next event ---
    await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=View event');
  }

  console.log("All events processed");
  await browser.close();
})();
