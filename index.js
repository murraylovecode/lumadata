// index.js
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

function normalizeHeader(h) {
  return (h || '').toString().trim().toLowerCase();
}

// Try to find best matching column from CSV headers
function pickColumn(headers, candidates) {
  for (const c of candidates) {
    for (const h of headers) {
      if (h.includes(c)) return h;
    }
  }
  return null;
}

(async () => {
  // --- Setup Supabase ---
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
    process.exit(1);
  }

  ensureDownloadDir();

  // --- Launch Playwright with saved session ---
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // --- Go straight to calendar ---
  await page.goto('https://lu.ma/calendar', { waitUntil: 'networkidle', timeout: 60000 });
  console.log("Opened Lu.ma calendar page:", page.url());
  if (page.url().includes('login')) {
    console.error('Session expired or not logged in. Regenerate storageState.json locally and re-add it.');
    await browser.close();
    process.exit(1);
  }

  // --- Collect event links (hrefs) from calendar page ---
  console.log("Collecting event links...");
  // This selector looks for anchors containing "/event/" in the href attribute.
  // If your calendar uses a different pattern, change this selector.
  console.log("Waiting for event cards to load...");

// Wait for event cards
await page.waitForSelector('text=View event', { timeout: 60000 });

// Get all "View event" buttons
const eventButtons = await page.$$('text=View event');

console.log(`Found ${eventButtons.length} events`);

for (let i = 0; i < eventButtons.length; i++) {
  console.log(`Opening event ${i + 1}`);

  await eventButtons[i].click();
  await page.waitForLoadState('networkidle');

  const eventUrl = page.url();
  console.log("Event URL:", eventUrl);


  console.log(`Found ${eventHrefElements.length} event links`);
  if (!eventHrefElements.length) {
    console.log("No events found, exiting.");
    await browser.close();
    return;
  }

  // Normalize to absolute URLs and dedupe again
  const eventUrls = eventHrefElements.map(href => {
    if (href.startsWith('http')) return href;
    // make absolute relative to lu.ma
    return new URL(href, 'https://lu.ma').toString();
  });

  // Iterate events
  for (let i = 0; i < eventUrls.length; i++) {
    const eventUrl = eventUrls[i];
    console.log(`\n=== Processing event ${i + 1}/${eventUrls.length}: ${eventUrl} ===`);

    try {
      // navigate to event page
      await page.goto(eventUrl, { waitUntil: 'networkidle', timeout: 60000 });

      // Extract an event id or slug from URL for use as event_id
      const eventIdMatch = eventUrl.match(/\/event\/([^/?#]+)/i);
      const event_id = eventIdMatch ? eventIdMatch[1] : `evt-${Date.now()}`;

      // Try to get event name from the page (best-effort). If not found, fallback to event_id
      let event_name = event_id;
      try {
        const titleHandle = await page.$('h1');
        if (titleHandle) {
          const txt = (await titleHandle.innerText()) || '';
          if (txt.trim()) event_name = txt.trim();
        }
      } catch (err) {
        // ignore
      }
      console.log("Event id:", event_id, "Event name:", event_name);

      // Wait for "Export attendees" button/text (adjust text if necessary)
      // Some Lu.ma UIs may show "Export attendees" or "Export" - be flexible
      const exportSelectors = ['text=Export attendees', 'text=Export', 'text=Download attendees'];
      let foundExport = false;
      for (const sel of exportSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 5000 });
          // click and wait for download
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 60000 }),
            page.click(sel)
          ]);
          // save file in downloads dir with event id
          const filename = path.join(DOWNLOAD_DIR, `${event_id}-${Date.now()}.csv`);
          await download.saveAs(filename);
          console.log("Downloaded CSV to:", filename);

          // --- Parse CSV ---
          const csvContent = fs.readFileSync(filename, 'utf8');
          const records = parse(csvContent, { columns: true, skip_empty_lines: true });

          console.log(`Parsed ${records.length} CSV rows from ${filename}`);

          if (!records.length) {
            console.log("CSV had no rows, continuing to next event.");
            foundExport = true;
            break;
          }

          // Determine CSV header names normalized
          const rawHeaders = Object.keys(records[0]).map(normalizeHeader);
          // pick column names (original header strings) by scanning the first record's keys
          const firstRecord = records[0];
          const originalHeaders = Object.keys(firstRecord);

          // pick best header keys for common fields
          function findOriginalHeader(candidates) {
            const lowerCandidates = candidates.map(c => c.toLowerCase());
            for (const h of originalHeaders) {
              const lh = normalizeHeader(h);
              for (const c of lowerCandidates) {
                if (lh.includes(c)) return h;
              }
            }
            return null;
          }

          const emailHeader = findOriginalHeader(['email', 'e-mail']);
          const nameHeader = findOriginalHeader(['full name', 'name', 'fullname', 'first_name']);
          const ticketHeader = findOriginalHeader(['ticket', 'ticket type']);
          const statusHeader = findOriginalHeader(['status', 'approval_status', 'attended']);
          const registeredAtHeader = findOriginalHeader(['registered', 'registered_at', 'created_at', 'joined_at']);

          // Build upsert rows
          const upsertRows = [];
          const now = new Date().toISOString();

          for (const rec of records) {
            const email = emailHeader ? (rec[emailHeader] || '').toString().trim() : null;
            if (!email) {
              // skip rows without email
              continue;
            }

            const name = nameHeader ? (rec[nameHeader] || '').toString().trim() : null;
            const ticket_type = ticketHeader ? (rec[ticketHeader] || '').toString().trim() : null;
            const status = statusHeader ? (rec[statusHeader] || '').toString().trim() : null;

            let registered_at = null;
            if (registeredAtHeader && rec[registeredAtHeader]) {
              const d = new Date(rec[registeredAtHeader]);
              if (!isNaN(d)) registered_at = d.toISOString();
            }

            upsertRows.push({
              email: email.toLowerCase(),
              event_id,
              event_name,
              name,
              ticket_type,
              status,
              registered_at,
              raw: rec,
              enriched: null,
              first_seen_at: now,
              last_seen_at: now
            });
          }

          if (upsertRows.length === 0) {
            console.log("No valid rows to upsert (no emails).");
            foundExport = true;
            break;
          }

          // Batch upsert: supabase will dedupe by primary key (email, event_id)
          const { error: upsertError } = await supabase
            .from('luma_ui_attendees')
            .upsert(upsertRows);

          if (upsertError) {
            console.error("Supabase upsert error for event", event_id, upsertError);
          } else {
            console.log(`Upserted ${upsertRows.length} rows for event ${event_id}`);
          }

          foundExport = true;
          break; // break exportSelectors loop for this event
        } catch (err) {
          // selector not found or download failed for this selector — try next selector
          // For debugging, show which selector failed and why.
          // Note: many selectors will timeout until one matches; that's expected.
          // console.log(`Selector ${sel} did not work:`, err.message);
        }
      }

      if (!foundExport) {
        console.warn("Could not find an export/download button on this event page. Skipping event.");
      }

      // small pause to be polite and avoid tripping protections
      await page.waitForTimeout(1500);
    } catch (err) {
      console.error(`Error processing event ${eventUrl}:`, err.message || err);
      // continue with next event
    }
  } // end events loop

  console.log("\nAll events processed. Closing browser.");
  await browser.close();
  console.log("Done.");
})();
