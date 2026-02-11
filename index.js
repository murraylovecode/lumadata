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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // ✅ STEP 1 — Open your hosted events page
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened hosted events page");

  // Scroll to load all events
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 500;
      const t = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total > document.body.scrollHeight) {
          clearInterval(t);
          resolve();
        }
      }, 300);
    });
  });

  // ✅ Grab all event cards
  const eventCards = await page.$$('[data-testid="event-card"]');
  console.log(`Found ${eventCards.length} hosted events`);

  for (let i = 0; i < eventCards.length; i++) {
    console.log(`\nOpening event card ${i + 1}`);

    const cards = await page.$$('[data-testid="event-card"]');
    await cards[i].click();

    // Wait for popup
    await page.waitForSelector('text=Manage', { timeout: 30000 });

    // Click Manage
    await page.click('text=Manage');

    // Now on real manage page
    await page.waitForLoadState('networkidle');

    const eventUrl = page.url();
    const event_id = eventUrl.match(/evt-[^/?#]+/i)?.[0];

    console.log("Manage page:", eventUrl);

    // ✅ Find Guests card and Export CSV
    await page.waitForSelector('text=All Guests', { timeout: 60000 });

    const guestsCard = page.locator('text=All Guests').locator('..').locator('..');

    await guestsCard.locator('text=Export').click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      guestsCard.locator('text=Export CSV').click()
    ]);

    const file = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
    await download.saveAs(file);
    console.log("Downloaded:", file);

    // Parse CSV
    const csv = fs.readFileSync(file, 'utf8');
    const records = parse(csv, { columns: true, skip_empty_lines: true });

    const event_name = await page.locator('h1').innerText();
    const now = new Date().toISOString();

    const rows = records
      .filter(r => r.Email)
      .map(r => ({
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
      }));

    if (rows.length) {
      await supabase.from('luma_ui_attendees').upsert(rows);
      console.log(`Upserted ${rows.length} attendees`);
    }

    // Go back to hosted events page
    await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  }

  await browser.close();
  console.log("All done");
})();
