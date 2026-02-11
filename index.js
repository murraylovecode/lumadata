/**
 * index.js
 * Lu.ma attendee exporter (UI-faithful + API fallback)
 *
 * Usage:
 * - Ensure storageState.json exists (produced by local record-session run).
 * - Set SUPABASE_URL and SUPABASE_SERVICE_KEY in environment (GitHub Secrets).
 * - Run locally or in CI (use xvfb-run in GitHub Actions if headless:false).
 */

console.log("Lu.ma attendee bot — final UI-faithful with API fallback");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const parse = require('csv-parse/sync').parse;

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Supabase client
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Helpers
function normalizeKey(k = '') {
  return (k || '').toString().trim().toLowerCase();
}
function pickField(record, candidates) {
  // candidates: ['email','e-mail']
  const keys = Object.keys(record);
  for (const c of candidates) {
    const lc = c.toLowerCase();
    for (const k of keys) {
      if (normalizeKey(k).includes(lc)) return record[k];
    }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({
    headless: false, // use xvfb-run in CI; makes popup behavior reliable
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // The two View All selectors you provided (exact DOM anchors)
  const HOSTING_VIEW_ALL_SELECTOR = '#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(1) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button';
  const PAST_VIEW_ALL_SELECTOR = '#__next > div > div.jsx-114924862.jsx-2149634693.page-content.sticky-topnav > div > div:nth-child(2) > div:nth-child(2) > div.jsx-55dd68548432feb0.mb-1.flex-baseline.spread.gap-2 > button > div';

  console.log("Opening profile page...");
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
  console.log("Opened profile");

  // Generic function to process a section by a provided View All selector
  async function processSection(viewAllSelector, sectionName) {
    console.log(`\n--- Processing section: ${sectionName} ---`);
    try {
      // Click View All
      await page.waitForSelector(viewAllSelector, { timeout: 10000 });
      await page.click(viewAllSelector);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800); // small pause to allow cards to render

      // Find event cards (cards include text "By Murray")
      const cardLocator = page.locator('div:has-text("By Murray")');
      const cardCount = await cardLocator.count();
      console.log(`Found ${cardCount} event cards in ${sectionName}`);

      for (let idx = 0; idx < cardCount; idx++) {
        console.log(`\nProcessing event ${idx + 1}/${cardCount} in ${sectionName}`);
        try {
          // Re-query locator for stability, then click the card (the whole card is clickable)
          const cards = page.locator('div:has-text("By Murray")');
          const card = cards.nth(idx);
          await card.scrollIntoViewIfNeeded();
          await card.click();
          // Wait for popup to appear with a Manage link
          await page.waitForSelector('a:has-text("Manage"), button:has-text("Manage")', { timeout: 15000 });

          // Click Manage inside the popup (link or button)
          const manageLink = page.locator('a:has-text("Manage"), button:has-text("Manage")').first();
          await manageLink.click();
          await page.waitForLoadState('networkidle');

          // Extract event id from manage URL
          const manageUrl = page.url();
          const match = manageUrl.match(/evt-[^/?#]+/i);
          if (!match) {
            console.warn("Could not extract event id from manage URL, skipping event");
            // go back to list
            await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
            // re-open section to maintain state
            await page.click(viewAllSelector);
            await page.waitForLoadState('networkidle');
            continue;
          }
          const eventId = match[0];
          console.log("Event id:", eventId);

          // Click Guests tab on the manage page (this reveals guest UI)
          // guest tab might be a tab or button; try both patterns
          const guestsTabSelectors = ['a:has-text("Guests")', 'button:has-text("Guests")', 'text=Guests'];
          let guestsClicked = false;
          for (const sel of guestsTabSelectors) {
            try {
              await page.waitForSelector(sel, { timeout: 5000 });
              await page.click(sel);
              guestsClicked = true;
              break;
            } catch (err) {
              // try next
            }
          }

          if (!guestsClicked) {
            console.warn("Guests tab not found; attempting to open the guests drawer by clicking the counts area");
            // Try the numeric counts (e.g., "39 Going") to open the drawer
            await page.click('text=/\\d+ Going/', { timeout: 5000 }).catch(()=>{});
          }

          // Wait a short time for Guests UI to settle
          await page.waitForTimeout(900);

          // Attempt UI-download: click 'Download as CSV' (preferred)
          let csvText = null;
          let downloadedFilePath = null;
          try {
            // Wait for the Download as CSV button to appear
            await page.waitForSelector('text=Download as CSV, text=Download CSV, text=Export CSV, text=Export as CSV', { timeout: 7000 });
            // Try to trigger a download event
            const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(e => null);
            // click whichever label exists (try multiple variations)
            const downloadButton = page.locator('text=Download as CSV, text=Download CSV, text=Export CSV, text=Export as CSV').first();
            await downloadButton.click({ force: true }).catch(()=>{});
            const download = await downloadPromise;
            if (download) {
              const filename = `${eventId}-${Date.now()}.csv`;
              downloadedFilePath = path.join(DOWNLOAD_DIR, filename);
              await download.saveAs(downloadedFilePath);
              console.log("Saved download to:", downloadedFilePath);
            } else {
              console.log("No download event caught (UI-click may have used XHR). Will attempt API fallback.");
            }
          } catch (err) {
            console.log("Download UI-click failed or not present:", err.message || err);
          }

          // If we didn't get a browser download, call the API endpoint directly (authenticated with cookies)
          if (!downloadedFilePath) {
            console.log("Attempting direct API fetch for CSV (fallback).");
            // Extract cookies from Playwright context
            const cookies = await context.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            // API endpoint pattern inferred from UI
            const apiUrl = `https://luma.com/api/event/${eventId}/guests/export`;

            // Use fetch in node available via global (Playwright provides fetch via page.evaluate)
            // We'll use node's built-in fetch if available, else use page.evaluate to fetch inside browser
            let text = null;
            try {
              // Try node's fetch if present
              if (typeof fetch === 'function') {
                const resp = await fetch(apiUrl, { headers: { cookie: cookieHeader, 'user-agent': 'Mozilla/5.0' } });
                if (resp.ok) text = await resp.text();
                else {
                  console.warn("API fetch returned", resp.status);
                }
              } else {
                // Fallback: perform fetch inside the logged-in browser context, which carries credentials
                text = await page.evaluate(async (apiUrl) => {
                  const r = await fetch(apiUrl, { credentials: 'include' });
                  if (!r.ok) return null;
                  return await r.text();
                }, apiUrl);
              }
            } catch (err) {
              console.warn("API fetch failed:", err.message || err);
            }

            if (text && text.length > 50) {
              // write to file and treat as downloaded
              downloadedFilePath = path.join(DOWNLOAD_DIR, `${eventId}-${Date.now()}.csv`);
              fs.writeFileSync(downloadedFilePath, text, 'utf8');
              console.log("Wrote API CSV to:", downloadedFilePath);
            } else {
              console.warn("No CSV available for event (no permission or empty). Skipping event.");
            }
          }

          // If we have a file, parse and upsert
          if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            try {
              const csv = fs.readFileSync(downloadedFilePath, 'utf8');
              const records = parse(csv, { columns: true, skip_empty_lines: true });

              // Build upsert rows robustly mapping columns
              const now = new Date().toISOString();
              const rows = [];
              for (const rec of records) {
                const email = (pickField(rec, ['email', 'e-mail', 'work email', 'work_email']) || '').toString().trim();
                if (!email) continue;

                const name = (pickField(rec, ['name', 'full_name', 'full name', 'first_name']) || '').toString().trim();
                const ticket_name = pickField(rec, ['ticket_name', 'ticket name', 'ticket', 'ticket_type']) || null;
                const approval_status = pickField(rec, ['approval_status', 'status']) || null;
                const created_at = pickField(rec, ['created_at', 'registered_at', 'registered at']) || null;
                let registered_at = null;
                if (created_at) {
                  const d = new Date(created_at);
                  if (!Number.isNaN(d.getTime())) registered_at = d.toISOString();
                }

                rows.push({
                  email: email.toLowerCase(),
                  event_id: eventId,
                  event_name: (pickField(rec, ['name', 'event_name', 'event name']) || null),
                  name: name || null,
                  ticket_type: ticket_name || null,
                  status: approval_status || null,
                  registered_at: registered_at,
                  raw: rec,
                  enriched: null,
                  first_seen_at: now,
                  last_seen_at: now
                });
              }

              if (rows.length) {
                // upsert with conflict keys; adjust onConflict to match your Supabase table PK/unique constraint
                const { error } = await supabase.from('luma_ui_attendees').upsert(rows, { onConflict: ['email', 'event_id'] });
                if (error) console.error("Supabase upsert error:", error);
                else console.log(`Upserted ${rows.length} attendees for ${eventId}`);
              } else {
                console.log("No rows to upsert from CSV.");
              }
            } catch (err) {
              console.warn("Failed to parse/upsert CSV:", err.message || err);
            }
          }

          // after finishing this event, return to the section listing
          await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
          await page.waitForTimeout(800);
          // re-open the same View All so subsequent indices align
          await page.click(viewAllSelector);
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(800);

        } catch (eventErr) {
          console.log("Error on this event, moving on:", (eventErr && eventErr.message) ? eventErr.message : eventErr);
          // best-effort recovery: go back to profile and re-open section
          try {
            await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });
            await page.waitForTimeout(800);
            await page.click(viewAllSelector);
            await page.waitForTimeout(800);
          } catch (f) {
            // ignore
          }
        }
      }
    } catch (err) {
      console.log(`Failed to process section ${sectionName}:`, err.message || err);
    }
  }

  // Process both sections using the selectors you provided
  await processSection(HOSTING_VIEW_ALL_SELECTOR, 'Hosting');
  await processSection(PAST_VIEW_ALL_SELECTOR, 'Past Events');

  console.log("\nAll done — closing browser.");
  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
