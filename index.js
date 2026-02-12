console.log("Lu.ma Event ID Extractor & CSV Downloader + Supabase Sync");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// 1. Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase Client Initialized");
  } catch (e) {
    console.log("⚠️ Supabase Init Failed:", e.message);
  }
} else {
  console.log("⚠️ SUPABASE_URL or SUPABASE_KEY missing. Skipping sync.");
}

// Helper: Upsert CSV to Supabase
async function upsertGuestsToSupabase(filePath, eventId) {
  if (!supabase) return;

  const guests = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        // Map CSV columns to DB columns
        // Adjust keys based on actual CSV headers from Luma
        // Common headers: "Name", "Email", "Status", "Ticket Type", "Approval Status"
        const email = row['Email'] || row['email'];
        if (email) { // Email is required for upsert key
          guests.push({
            event_id: eventId,
            email: email,
            name: row['Name'] || row['name'] || row['Guest Name'] || null,
            status: row['Status'] || row['status'] || 'registered',
            ticket_type: row['Ticket Type'] || row['Ticket'] || null,
            approval_status: row['Approval Status'] || null,
            synced_at: new Date().toISOString()
          });
        }
      })
      .on('end', async () => {
        if (guests.length === 0) {
          console.log(`   ℹ️ No guests found in ${eventId}.csv`);
          resolve();
          return;
        }

        console.log(`   🔄 Syncing ${guests.length} guests to Supabase...`);

        // Batch upsert (1000 items is a safe limit)
        const BATCH_SIZE = 1000;
        for (let i = 0; i < guests.length; i += BATCH_SIZE) {
          const batch = guests.slice(i, i + BATCH_SIZE);
          const { error } = await supabase
            .from('luma_guests')
            .upsert(batch, { onConflict: 'event_id, email' });

          if (error) {
            console.log(`   ❌ Supabase Upsert Error (Batch ${Math.floor(i / BATCH_SIZE) + 1}): ${error.message}`);
          }
        }
        console.log(`   ✅ Synced batch for ${eventId}`);
        resolve();
      })
      .on('error', (err) => {
        console.log(`   ❌ CSV Read Error: ${err.message}`);
        resolve(); // Don't crash main loop
      });
  });
}

(async () => {
  // Handle storage state file selection
  let sessionFile = 'storageState.json';
  if (!fs.existsSync(sessionFile) && fs.existsSync('session.json')) {
    sessionFile = 'session.json';
    console.log("Using session.json as storage state.");
  } else if (fs.existsSync(sessionFile)) {
    console.log("Using storageState.json as storage state.");
  } else {
    console.log("Warning: No storage state file found. You might need to log in manually first.");
    sessionFile = null;
  }

  const browser = await chromium.launch({
    headless: true, // Run headless for CI/Background
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Set Desktop Viewport
  const context = await browser.newContext({
    storageState: sessionFile ? sessionFile : undefined,
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 }, // Force desktop size
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // 1️⃣ Open profile page
  console.log("Opening profile: https://lu.ma/user/murray");
  await page.goto('https://lu.ma/user/murray', {
    waitUntil: 'domcontentloaded'
  });

  // Wait for login check
  await page.waitForTimeout(3000);
  const isGuest = await page.locator('button:has-text("Sign in"), a[href*="/signin"]').count() > 0;
  console.log("Is logged in (estimated):", !isGuest);

  const allEventUrls = new Set();

  async function scrapeModal() {
    const modal = page.locator('.lux-modal-body');
    if (await modal.count() > 0 && await modal.isVisible()) {
      console.log("Modal found. Scrolling to load all events...");
      let previousHeight = 0;
      let currentHeight = await modal.evaluate(el => el.scrollHeight);
      let attempts = 0;
      while (previousHeight !== currentHeight && attempts < 30) {
        previousHeight = currentHeight;
        await modal.evaluate(el => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(1500);
        currentHeight = await modal.evaluate(el => el.scrollHeight);
        if (previousHeight === currentHeight) {
          await page.waitForTimeout(1500);
          currentHeight = await modal.evaluate(el => el.scrollHeight);
        }
        attempts++;
        process.stdout.write(`.`);
      }
      console.log("\nFinished scrolling modal.");

      const eventUrls = await page.evaluate(() => {
        const modal = document.querySelector('.lux-modal-body');
        const anchors = Array.from(modal.querySelectorAll('a[href^="/"]'));
        return anchors
          .map(a => a.getAttribute('href'))
          .filter(href => {
            if (!href || href.length < 2) return false;
            const ignore = ['/user', '/home', '/create', '/signin', '/calendar', '/discover', '/explore', '/pricing', '/legal'];
            if (ignore.some(prefix => href.startsWith(prefix))) return false;
            if (href.startsWith('?')) return false;
            return true;
          });
      });
      eventUrls.forEach(url => allEventUrls.add(url));

      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  // 2️⃣ Find "Hosting" section and click "View All"
  console.log("Looking for 'Hosting' section...");

  try {
    const hostingHeader = page.locator('h2, h3, div').filter({ hasText: /^Hosting$/ }).first();
    // Heuristic: The first "View All" usually belongs to Hosting if it exists.
    // But let's try to be precise if possible.

    const viewAllBtns = await page.getByText('View All').all();

    if (viewAllBtns.length > 0) {
      console.log(`Found ${viewAllBtns.length} 'View All' buttons.`);
      // Click the first one (usually Hosting)
      console.log("Clicking 'View All' #1 (Hosting)...");
      if (await viewAllBtns[0].isVisible()) {
        await viewAllBtns[0].click();
        await page.waitForTimeout(1000);
        await scrapeModal();
      }

      // Check for second one (Past Events)
      if (viewAllBtns.length > 1) {
        console.log("Clicking 'View All' #2 (Past Events)...");
        if (await viewAllBtns[1].isVisible()) {
          await viewAllBtns[1].click();
          await page.waitForTimeout(1000);
          await scrapeModal();
        }
      }
    } else {
      console.log("No 'View All' buttons found.");
    }
  } catch (err) {
    console.log("Error processing View All buttons:", err.message);
  }

  const uniqueSlugs = [...allEventUrls]; // Deduplicate
  console.log(`Found ${uniqueSlugs.length} unique event links.`);

  // 5️⃣ Process each event
  for (let i = 0; i < uniqueSlugs.length; i++) {
    const slug = uniqueSlugs[i];
    const fullUrl = `https://lu.ma${slug}`;

    console.log(`\n[${i + 1}/${uniqueSlugs.length}] Processing: ${slug}`);

    try {
      // Go to the event page
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      let evtId = null;

      // 1. Check if we are already on a manage page or if URL has ID
      const currentUrl = page.url();
      const urlMatch = currentUrl.match(/evt-[A-Za-z0-9]+/);
      if (urlMatch) {
        evtId = urlMatch[0];
      }

      // 2. Check "Manage Event" button href
      if (!evtId) {
        const manageBtn = page.locator('a[href*="/event/manage/"], a[href*="evt-"]').first();
        if (await manageBtn.isVisible()) {
          const href = await manageBtn.getAttribute('href');
          // console.log("   Manage Btn Href:", href);
          const hrefMatch = href.match(/evt-[A-Za-z0-9]+/);
          if (hrefMatch) {
            evtId = hrefMatch[0];
            console.log("   Found ID via Manage Button Href:", evtId);
          }
        }
      }

      // 3. Check specific metadata / next data
      if (!evtId) {
        const content = await page.content();
        // Be conservative: evt- followed by alphanumeric, at least 10 chars
        const match = content.match(/evt-[A-Za-z0-9]{10,}/);
        if (match) {
          evtId = match[0];
          console.log("   Found ID via Page Source scrape:", evtId);
        }
      }

      if (!evtId) {
        console.log("   ❌ Could not resolve Event ID. Skipping.");
        continue;
      }

      // Construct Guests URL directly
      const guestsUrl = `https://lu.ma/event/manage/${evtId}/guests`;
      console.log(`   Navigating to: ${guestsUrl}`);
      await page.goto(guestsUrl, { waitUntil: 'domcontentloaded' });

      // Wait for potential redirect or load
      await page.waitForTimeout(2500);

      // 6️⃣ Click "Download as CSV"
      // Inspection revealed it's an ICON button in the header toolbar, often without text "Download as CSV".
      // We look for aria-labels or known classes.

      // Try multiple selectors
      const potentialSelectors = [
        'button[aria-label*="Download"]',
        'button[aria-label*="Export"]',
        'button:has(svg path[d*="M19"])', // Common download icon path start (brittle but tries)
        'div[role="button"][aria-label*="Download"]',
        'button:has-text("Download")', // Fallback if text exists
        'button:has-text("Export")',
        '.content-header button:last-child' // Often the last button in header
      ];

      let downloadBtn = null;
      for (const selector of potentialSelectors) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible()) {
          downloadBtn = btn;
          console.log(`   Found potential download button via selector: ${selector}`);
          break;
        }
      }

      if (downloadBtn) {
        console.log("   Found Download button. Attempting to click...");

        let download = null;
        // Retry mechanism for clicking
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`   Attempt ${attempt}: Clicking...`);
            const downloadPromise = page.waitForEvent('download', { timeout: 45000 }); // Increased timeout to 45s

            // Ensure button is stable and clickable
            await downloadBtn.scrollIntoViewIfNeeded();
            await downloadBtn.click({ timeout: 5000, force: true }); // Force click to bypass overlays

            download = await downloadPromise;
            break; // Success
          } catch (e) {
            console.log(`   ⚠️ Attempt ${attempt} failed (timeout or error): ${e.message}`);
            // Maybe it needs a moment?
            if (attempt < 3) await page.waitForTimeout(3000);
          }
        }

        if (download) {
          const savePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
          await download.saveAs(savePath);
          console.log(`   ✅ Successfully saved: ${savePath}`);

          // Trigger Supabase Sync
          if (supabase) {
            await upsertGuestsToSupabase(savePath, evtId);
          }

        } else {
          console.log("   ❌ Failed to capture download after 3 attempts.");
          // Screenshot for debugging
          await page.screenshot({ path: `debug_timeout_${slug.replace(/\//g, '')}.png` });
        }

      } else {
        console.log("   ⚠️ 'Download/Export' button not found.");
        // await page.screenshot({ path: `debug_no_btn_${slug.replace(/\//g, '')}.png` });
      }

    } catch (err) {
      console.log(`   ❌ Error processing event ${slug}: ${err.message}`);
    }
  }

  console.log("\nAll processing complete.");
  await browser.close();
})();
