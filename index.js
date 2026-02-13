console.log("Lu.ma Event ID Extractor & CSV Downloader + Supabase Sync (Robust & Sequential)");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

// Clean listeners
require('events').EventEmitter.defaultMaxListeners = 20;

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// 1. Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
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

// Helper: Upsert CSV to Supabase with Enhanced Mapping
async function upsertGuestsToSupabase(filePath, eventId, eventName) {
  if (!supabase) return;

  const guests = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv({
        mapHeaders: ({ header }) => header.trim().replace(/^\ufeff/, '') // Strip BOM & whitespace
      }))
      .on('data', (row) => {
        // Flexible column lookup helper
        // Tries: Exact -> Case-insensitive -> Fuzzy content
        const getVal = (possibleKeys) => {
          const keys = Array.isArray(possibleKeys) ? possibleKeys : [possibleKeys];
          // 1. Exact match
          for (const k of keys) {
            if (row[k] !== undefined && row[k] !== '') return row[k];
          }
          // 2. Case-Insensitive (strict key name)
          for (const k of keys) {
            const hit = Object.keys(row).find(x => x.toLowerCase() === k.toLowerCase());
            if (hit && row[hit] !== '') return row[hit];
          }
          // 3. Fuzzy match (key containing substring, e.g. "LinkedIn")
          for (const k of keys) {
            const hit = Object.keys(row).find(x => x.toLowerCase().includes(k.toLowerCase()));
            // Avoid overly broad matches like 'a' matching everything
            if (hit && k.length > 3 && row[hit] !== '') return row[hit];
          }
          return null;
        };

        const email = getVal(['email', 'Email Address']);
        if (email) {
          guests.push({
            event_id: eventId,
            event_name: eventName || 'Unknown Event',
            email: email,
            // Priority Mapping
            api_id: getVal(['api_id', 'Guest ID']),
            name: getVal(['name', 'Guest Name', 'Full Name']),
            status: getVal(['approval_status', 'registration_status', 'status']) || 'registered',
            ticket_type: getVal(['ticket_name', 'ticket_type', 'Ticket Type']),
            created_at: getVal(['created_at', 'Registration Date']) || new Date().toISOString(),
            checked_in_at: getVal(['checked_in_at', 'Check-in Time']),

            // Metadata / Enhanced Fields with broad search
            linkedin_url: getVal(['linkedin', 'What is your LinkedIn profile?', 'LinkedIn Profile']),
            company: getVal(['company', 'What company do you work for?', 'Organization']),
            job_title: getVal(['job_title', 'What is your job title?', 'Role']),
            phone: getVal(['phone_number', 'phone']),

            synced_at: new Date().toISOString(),
            // Store full row
            raw_data: row
          });
        }
      })
      .on('end', async () => {
        if (guests.length === 0) {
          resolve();
          return;
        }

        // Chunk upserts
        const BATCH_SIZE = 500;
        for (let i = 0; i < guests.length; i += BATCH_SIZE) {
          const batch = guests.slice(i, i + BATCH_SIZE);
          const { error } = await supabase
            .from('luma_guests')
            .upsert(batch, { onConflict: 'event_id, email' });

          if (error) {
            console.log(`   ❌ Supabase Upsert Error (${eventId}): ${error.message}`);
          }
        }
        resolve();
      })
      .on('error', (err) => {
        console.log(`   ❌ CSV Read Error: ${err.message}`);
        resolve(); // Don't crash worker
      });
  });
}

// Sequential Logic
(async () => {
  let sessionFile = 'storageState.json';
  if (!fs.existsSync(sessionFile) && fs.existsSync('session.json')) sessionFile = 'session.json';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Discovery Phase
  const context = await browser.newContext({ storageState: sessionFile, userAgent: 'Mozilla/5.0...' });
  const page = await context.newPage();

  console.log("🔍 Discovering events on profile...");
  await page.goto('https://lu.ma/user/murray', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const allEventUrls = new Set();
  async function scrapeModal() {
    const modal = page.locator('.lux-modal-body');
    if (await modal.count() > 0 && await modal.isVisible()) {
      process.stdout.write("   Scrolling modal");
      let previousHeight = 0;
      let currentHeight = await modal.evaluate(el => el.scrollHeight);
      // Wait for lazy load
      let attempts = 0;
      while (previousHeight !== currentHeight && attempts < 30) {
        previousHeight = currentHeight;
        await modal.evaluate(el => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(1000);
        currentHeight = await modal.evaluate(el => el.scrollHeight);
        // Double check for lagging load
        if (previousHeight === currentHeight) {
          await page.waitForTimeout(1000);
          currentHeight = await modal.evaluate(el => el.scrollHeight);
        }
        attempts++;
        process.stdout.write(`.`);
      }
      console.log("\n   Done scrolling.");

      const eventUrls = await page.evaluate(() => {
        const modal = document.querySelector('.lux-modal-body');
        const anchors = Array.from(modal.querySelectorAll('a[href^="/"]'));
        return anchors.map(a => a.getAttribute('href')).filter(href => {
          if (!href || href.length < 2) return false;
          const ignore = ['/user', '/home', '/create', '/signin', '/calendar', '/discover', '/explore'];
          if (ignore.some(prefix => href.startsWith(prefix))) return false;
          return true;
        });
      });
      eventUrls.forEach(url => allEventUrls.add(url));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  const viewAllBtns = await page.getByText('View All').all();
  if (viewAllBtns.length > 0) {
    console.log(`   Clicking 'View All' (Hosting)...`);
    if (await viewAllBtns[0].isVisible()) {
      await viewAllBtns[0].click();
      await page.waitForTimeout(1000);
      await scrapeModal();
    }
    if (viewAllBtns.length > 1) {
      console.log(`   Clicking 'View All' (Past)...`);
      if (await viewAllBtns[1].isVisible()) {
        await viewAllBtns[1].click();
        await page.waitForTimeout(1000);
        await scrapeModal();
      }
    }
  }

  await context.close();

  const uniqueSlugs = [...allEventUrls];
  console.log(`\n📋 Found ${uniqueSlugs.length} unique events. Starting sequential processing...`);

  const queue = [...uniqueSlugs];
  let processedCount = 0;

  // Processing Logic
  const processEventItem = async (workerPage, slug) => {
    try {
      // console.log(`   Processing ${slug}...`);
      await workerPage.goto(`https://lu.ma${slug}`, { waitUntil: 'domcontentloaded' });
      await workerPage.waitForTimeout(500);

      let eventName = null;
      try {
        const h1 = workerPage.locator('h1').first();
        if (await h1.isVisible()) eventName = await h1.innerText();
      } catch (e) { }

      let evtId = null;
      const curUrl = workerPage.url();
      if (curUrl.match(/evt-[A-Za-z0-9]+/)) evtId = curUrl.match(/evt-[A-Za-z0-9]+/)[0];

      if (!evtId) {
        const mBtn = workerPage.locator('a[href*="/event/manage/"], a[href*="evt-"]').first();
        if (await mBtn.isVisible()) {
          const href = await mBtn.getAttribute('href');
          if (href && href.match(/evt-[A-Za-z0-9]+/)) evtId = href.match(/evt-[A-Za-z0-9]+/)[0];
        }
      }
      if (!evtId) {
        const html = await workerPage.content();
        const m = html.match(/evt-[A-Za-z0-9]{10,}/);
        if (m) evtId = m[0];
      }

      if (!evtId) {
        console.log(`   ⚠️ No ID for ${slug}`);
        return;
      }

      await workerPage.goto(`https://lu.ma/event/manage/${evtId}/guests`, { waitUntil: 'domcontentloaded' });
      await workerPage.waitForTimeout(1500);

      const selectors = [
        'button[aria-label*="Download"]', 'button[aria-label*="Export"]',
        'button:has(svg path[d*="M19"])', 'div[role="button"][aria-label*="Download"]'
      ];
      let btn = null;
      for (const s of selectors) {
        const b = workerPage.locator(s).first();
        if (await b.isVisible()) { btn = b; break; }
      }

      if (btn) {
        let download = null;
        // Retry
        for (let i = 1; i <= 3; i++) {
          try {
            const p = workerPage.waitForEvent('download', { timeout: 30000 }); // 30s
            await btn.click({ timeout: 5000, force: true });
            download = await p;
            break;
          } catch (e) { if (i < 3) await workerPage.waitForTimeout(2000); }
        }

        if (download) {
          const p = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
          await download.saveAs(p);
          processedCount++;
          process.stdout.write(`✅`); // Success Marker
          if (supabase) await upsertGuestsToSupabase(p, evtId, eventName);
        } else {
          console.log(`   ❌ Timeout DL ${evtId}`);
        }
      } else {
        // console.log(`   ⚠️ No DL Btn ${evtId}`);
      }

    } catch (e) {
      console.log(`   ❌ Err ${slug}: ${e.message}`);
    }
  };

  // Run Sequential
  const workerContext = await browser.newContext({
    storageState: sessionFile ? sessionFile : undefined,
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 }
  });
  const workerPage = await workerContext.newPage();

  for (const slug of uniqueSlugs) {
    await processEventItem(workerPage, slug);
  }

  await workerContext.close();
  console.log(`\n\n🎉 Done! Processed ${processedCount} events.`);
  await browser.close();
})();
