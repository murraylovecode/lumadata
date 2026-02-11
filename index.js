console.log("Lu.ma attendee bot — stable final");

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
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // STEP 1 — Open your profile
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened Murray profile");

  // Click BOTH "View All" buttons (Hosting + Past Events)
  const viewAllButtons = page.getByText('View All', { exact: true });
  const count = await viewAllButtons.count();
  for (let i = 0; i < count; i++) {
    await viewAllButtons.nth(i).click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // STEP 2 — Collect ALL event links (the only selector that matters)
  const eventLinks = await page.$$eval(
    'a[href^="/home?e=evt-"]',
    els => [...new Set(els.map(e => e.href))]
  );

  console.log(`Found ${eventLinks.length} hosted events`);

  for (const link of eventLinks) {
    try {
      console.log("\nOpening event popup:", link);

      // Open popup page
      await page.goto(link, { waitUntil: 'networkidle' });

      // Click MANAGE inside popup
      await page.getByText('Manage').click({ timeout: 10000 });

      await page.waitForLoadState('networkidle');

      const manageUrl = page.url();
      const event_id = manageUrl.match(/evt-[^/?#]+/i)?.[0];
      console.log("Managing:", event_id);

      // STEP 3 — Guests tab
      await page.getByText('Guests').click();
      await page.waitForTimeout(2000);

      // STEP 4 — Download CSV
      await page.getByText('Download as CSV').click();

      const download = await page.waitForEvent('download', { timeout: 60000 });

      const filePath = path.join(DOWNLOAD_DIR, `${event_id}.csv`);
      await download.saveAs(filePath);

      console.log("Downloaded:", filePath);

      // STEP 5 — Parse CSV
      const csv = fs.readFileSync(filePath, 'utf8');
      const records = parse(csv, { columns: true, skip_empty_lines: true });

      let event_name = event_id;
      try {
        event_name = await page.locator('h1').first().innerText();
      } catch {}

      const now = new Date().toISOString();
      const rows = [];

      for (const r of records) {
        if (!r.email) continue;

        rows.push({
          email: r.email.toLowerCase(),
          event_id,
          event_name,
          name: r.name || null,
          ticket_type: r.ticket_name || null,
          status: r.approval_status || null,
          registered_at: r.created_at
            ? new Date(r.created_at).toISOString()
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

      // Go back to profile for next event
      await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });

    } catch (err) {
      console.log("Skipping event due to error:", err.message);
      await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
    }
  }

  await browser.close();
  console.log("All done");
})();
