console.log("Lu.ma Event ID Extractor & CSV Downloader");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
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
    console.log("Warning: No storage state file found. You might need to log in.");
    sessionFile = null;
  }

  const browser = await chromium.launch({
    headless: true, // Run headless for CI/Background
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: sessionFile ? sessionFile : undefined,
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // 1️⃣ Open profile page
  console.log("Opening profile: https://lu.ma/user/murray");
  await page.goto('https://lu.ma/user/murray', {
    waitUntil: 'domcontentloaded'
  });

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // 2️⃣ Find "Hosting" section and click "View All"
  console.log("Looking for 'Hosting' section...");

  let viewAllClicked = false;

  try {
    // Strategy: Find a section containing text "Hosting" and then find "View All" within or near it.
    // We look for a container that has both "Hosting" and a button "View All"
    // Or simply find the first "View All" button on the page if "Hosting" is the primary section.

    const hostingText = page.getByText('Hosting', { exact: true });
    if (await hostingText.count() > 0) {
      console.log("Found 'Hosting' text.");
      // Assuming 'Hosting' is a header, we want the 'View All' associated with it.
      // Usually they are siblings in a flex container or parent/child.
      // Let's try to click the FIRST "View All" button on the page, as Hosting is usually the top section.

      const viewAllBtns = page.getByText('View All');
      if (await viewAllBtns.count() > 0) {
        console.log(`Found ${await viewAllBtns.count()} 'View All' buttons. Clicking header one...`);
        // Usually the first one corresponds to the top section (Hosting)
        await viewAllBtns.first().click();
        viewAllClicked = true;
      } else {
        console.log("Hosting text found but no 'View All' button visible.");
      }
    } else {
      console.log("'Hosting' section text not found. Checking if we are already seeing a list or if structure is different.");
    }

  } catch (err) {
    console.log("Error finding/clicking View All:", err.message);
  }

  if (!viewAllClicked) {
    console.log("⚠️ Could not click 'View All'. Will try to scrape whatever events are visible on main page.");
  } else {
    console.log("Waiting for modal/list to load...");
    // Wait for modal transition
    await page.waitForTimeout(2000);

    // 3️⃣ Scroll to end of list
    // Luma usually opens a modal with class .lux-modal-body OR redirects to a page.
    // If it's a modal:
    const modal = page.locator('.lux-modal-body');
    if (await modal.count() > 0 && await modal.isVisible()) {
      console.log("Modal found. Scrolling to load all events...");

      let previousHeight = 0;
      let currentHeight = await modal.evaluate(el => el.scrollHeight);
      let attempts = 0;

      // Scroll loop
      while (previousHeight !== currentHeight && attempts < 30) {
        previousHeight = currentHeight;
        // Scroll to bottom
        await modal.evaluate(el => el.scrollTo(0, el.scrollHeight));
        // Wait for network/render
        await page.waitForTimeout(1500);
        // Check new height
        currentHeight = await modal.evaluate(el => el.scrollHeight);
        // Also check if height hasn't changed but we might be waiting for loader
        if (previousHeight === currentHeight) {
          // Wait a bit longer just in case
          await page.waitForTimeout(1500);
          currentHeight = await modal.evaluate(el => el.scrollHeight);
        }
        attempts++;
        process.stdout.write(`.`); // progress indicator
      }
      console.log("\nFinished scrolling modal.");
    } else {
      console.log("No modal found. Maybe 'View All' didn't open one, or page redirected?");
    }
  }

  // 4️⃣ Extract all event links
  console.log("Extracting event links...");
  // We want links that look like event slugs.
  // We should extract from the modal if it's open, otherwise from the page.

  const eventUrls = await page.evaluate(() => {
    // If modal is open, scope to modal
    const modal = document.querySelector('.lux-modal-body');
    const root = modal || document;

    const anchors = Array.from(root.querySelectorAll('a[href^="/"]'));
    return anchors
      .map(a => a.getAttribute('href'))
      .filter(href => {
        if (!href || href.length < 2) return false;
        // Blocklist common non-event paths
        const ignore = ['/user', '/home', '/create', '/signin', '/calendar', '/discover', '/explore', '/pricing', '/legal'];
        if (ignore.some(prefix => href.startsWith(prefix))) return false;
        // Filter out IDs that are clearly not events (if any)
        if (href.startsWith('?')) return false;
        // Event slugs strictly start with / usually and don't have multiple segments unless it's /event/evt-...
        // Allow /slug and /event/evt-...
        return true;
      });
  });

  const uniqueSlugs = [...new Set(eventUrls)]; // Deduplicate
  console.log(`Found ${uniqueSlugs.length} unique event links.`);
  // console.log(uniqueSlugs); // Debug

  if (uniqueSlugs.length === 0) {
    console.log("No events found. Exiting.");
    await browser.close();
    return;
  }

  // Close modal if open
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 5️⃣ Process each event
  for (let i = 0; i < uniqueSlugs.length; i++) {
    const slug = uniqueSlugs[i];
    const fullUrl = `https://lu.ma${slug}`;

    console.log(`\n[${i + 1}/${uniqueSlugs.length}] Processing: ${slug}`);

    try {
      // Go to the event page
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Resolve Event ID
      // 1. Check URL for evt-...
      // 2. Check for "Manage Event" button href
      // 3. Check page source/metadata

      let evtId = null;
      let currentUrl = page.url();

      let match = currentUrl.match(/evt-[A-Za-z0-9]+/);
      if (match) {
        evtId = match[0];
      } else {
        // Check for Manage Button
        // Usually text "Manage Event" or "Manage"
        const manageBtn = page.locator('a').filter({ hasText: /Manage( Event)?/i }).first();
        if (await manageBtn.isVisible()) {
          const href = await manageBtn.getAttribute('href');
          if (href) {
            match = href.match(/evt-[A-Za-z0-9]+/);
            if (match) {
              evtId = match[0];
              console.log("   Found ID via Manage Button.");
            }
          }
        }

        if (!evtId) {
          // Check page content (brute force)
          // Use a strictly bounded regex to avoid false positives if possible, but evt- is usually unique enough
          const content = await page.content();
          match = content.match(/evt-[A-Za-z0-9]{10,}/); // IDs are usually reasonably long
          if (match) evtId = match[0];
        }
      }

      if (!evtId) {
        console.log(`   ❌ Could not resolve Event ID for ${slug}. Skipping.`);
        continue;
      }

      console.log(`   Resolved Event ID: ${evtId}`);

      // Construct Guests URL
      const manageGuestsUrl = `https://lu.ma/event/manage/${evtId}/guests`;
      console.log(`   Navigating to guests page...`);

      await page.goto(manageGuestsUrl, { waitUntil: 'networkidle' });

      // 6️⃣ Click "Download as CSV"
      // We look for the button specifically
      const downloadBtn = page.getByText('Download as CSV');

      // Wait for it
      try {
        await downloadBtn.waitFor({ state: 'visible', timeout: 5000 });
      } catch (e) { }

      if (await downloadBtn.isVisible()) {
        console.log("   Found 'Download as CSV'. Clicking...");

        // Setup download listener
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
        await downloadBtn.click();
        const download = await downloadPromise;

        const savePath = path.join(DOWNLOAD_DIR, `${evtId}.csv`);
        await download.saveAs(savePath);
        console.log(`   ✅ Successfully saved: ${savePath}`);

      } else {
        console.log("   ⚠️ 'Download as CSV' button not found. You might not have permission, be logged out, or have no guests.");
        // Debug: check title
        console.log(`   Page Title: ${await page.title()}`);
      }

    } catch (err) {
      console.log(`   ❌ Error processing event ${slug}: ${err.message}`);
    }
  }

  console.log("\nAll processing complete.");
  await browser.close();
})();
