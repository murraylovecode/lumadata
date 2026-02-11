/**
 * index.js
 * - Collect event ids from profile (hosting + past)
 * - Probe one event to capture the real CSV-export URL
 * - Download CSV for every event via direct HTTP requests using browser cookies
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function uniq(array) {
  return Array.from(new Set(array));
}

async function slowScroll(page) {
  // small scroll to trigger lazy load
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight - 10) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

(async () => {
  console.log('Start — Luma CSV bulk downloader (fast path)');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: 'storageState.json' // must exist (logged-in session)
  });

  const page = await context.newPage();

  try {
    // 1) Open profile
    await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle', timeout: 60000 });
    console.log('Opened profile page');

    // utility to open View All for a section index (0=Hosting,1=Past)
    async function openViewAll(sectionIndex) {
      // Wait for "View All" buttons to appear, then click the appropriate one
      await page.waitForSelector('text=View All', { timeout: 30000 });
      const buttons = await page.getByText('View All', { exact: true }).all();
      if (!buttons || buttons.length <= sectionIndex) {
        console.warn(`Could not find View All button for section index ${sectionIndex}`);
        return false;
      }
      await buttons[sectionIndex].click();
      await page.waitForTimeout(1200);
      return true;
    }

    // 2) For both sections, open View All, scroll fully and capture page HTML, extract evt- ids
    let allEventIds = [];

    for (const [sectionName, idx] of [['Hosting', 0], ['Past Events', 1]]) {
      console.log(`\nCollecting ids for ${sectionName} (sectionIndex=${idx})`);
      const ok = await openViewAll(idx);
      if (!ok) {
        console.warn(`Skipping ${sectionName} because View All not found`);
        continue;
      }

      // ensure lazy loading triggers
      await slowScroll(page);
      await page.waitForTimeout(800);

      // read page content and extract event ids (pattern evt-xxx)
      const html = await page.content();
      const matches = Array.from(html.matchAll(/evt-[A-Za-z0-9_-]+/g)).map(m => m[0]);
      const ids = uniq(matches);
      console.log(`Found ${ids.length} evt ids in ${sectionName}`);

      allEventIds = allEventIds.concat(ids);

      // close the View All popup (escape)
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }

    allEventIds = uniq(allEventIds).filter(Boolean);
    console.log(`\nTotal unique event ids found: ${allEventIds.length}`);

    if (!allEventIds.length) {
      console.log('No event ids found — exiting.');
      await browser.close();
      return;
    }

    // 3) Probe the real export endpoint using the FIRST event (UI click once)
    console.log('\nProbing export endpoint using first event (will do one UI export to determine template)...');
    const probeId = allEventIds[0];
    let exportUrlTemplate = null;

    try {
      // navigate to manage page for probe event (host pages are accessible)
      const manageUrl = `https://luma.com/event/manage/${probeId}`;
      await page.goto(manageUrl, { waitUntil: 'networkidle', timeout: 60000 });
      console.log('Opened manage page:', manageUrl);

      // ensure Guests tab available and click
      try {
        await page.getByRole('tab', { name: /Guests/i }).click({ timeout: 15000 });
      } catch {
        // fallback: click by text
        await page.getByText('Guests', { exact: true }).click({ timeout: 15000 });
      }
      await page.waitForTimeout(800);

      // Wait for "Download as CSV" to be visible (may be loaded lazily)
      await page.waitForSelector('text=Download as CSV', { timeout: 30000 });

      // Intercept the response triggered by clicking "Download as CSV"
      let csvResponse = null;
      const respPromise = page.waitForResponse(r => {
        const url = r.url();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        // heuristics: url contains "export" or content-type contains csv
        if (url.toLowerCase().includes('export') || ct.includes('csv')) return true;
        return false;
      }, { timeout: 60000 });

      await Promise.all([
        // click the button that triggers CSV
        page.getByText('Download as CSV', { exact: true }).click(),
        respPromise
      ]).then(([, r]) => {
        csvResponse = r;
      });

      if (csvResponse) {
        const respUrl = csvResponse.url();
        console.log('Probe export response URL detected:', respUrl);

        // Build template by replacing probeId with {EVENT}
        if (respUrl.includes(probeId)) {
          exportUrlTemplate = respUrl.replace(probeId, '{EVENT}');
          console.log('Export URL template:', exportUrlTemplate);
        } else {
          // if probe URL did not contain id, try to find an export URL in request headers
          exportUrlTemplate = null;
        }
      } else {
        console.warn('No CSV response detected during probe; will try plausible endpoints later');
      }
    } catch (err) {
      console.warn('Probe export step failed (will fallback to sensible templates):', err.message);
    }

    // 4) Determine cookie header for context.request
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const defaultHeaders = {
      'accept': 'text/csv,application/csv,*/*;q=0.1',
      'user-agent': 'Playwright-Luma-CSV-Agent'
    };

    // 5) Make a list of candidate templates (include discovered one first)
    const candidates = [];
    if (exportUrlTemplate) candidates.push(exportUrlTemplate);
    // Common guesses / fallbacks:
    candidates.push(
      // path style 1 (api)
      `https://luma.com/api/event/{EVENT}/guests/export`,
      // path style 2 (manage route)
      `https://luma.com/event/manage/{EVENT}/guests/export`,
      // path style 3
      `https://luma.com/event/{EVENT}/guests/export`,
      // path style 4
      `https://luma.com/api/v1/event/{EVENT}/guests/export`
    );

    // Function to try one URL and save CSV
    async function tryDownloadForEvent(eventId) {
      // try each candidate template until one works
      for (const tmpl of candidates) {
        const url = tmpl.replace('{EVENT}', eventId);
        try {
          const resp = await context.request.get(url, {
            headers: { ...defaultHeaders, cookie: cookieHeader },
            timeout: 60000
          });
          if (resp && resp.ok()) {
            // get content-type to ensure we have CSV
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            if (ct.includes('csv') || ct.includes('text') || resp.headers()['content-disposition']) {
              const body = await resp.body();
              const outPath = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
              fs.writeFileSync(outPath, body);
              console.log(`Saved CSV for ${eventId} from ${url} -> ${outPath}`);
              return true;
            } else {
              // maybe the server returns JSON with a redirect or token; try reading text
              const txt = await resp.text().catch(() => '');
              if (txt && txt.includes('api_id') && txt.includes('email')) {
                const outPath = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
                fs.writeFileSync(outPath, txt);
                console.log(`Saved CSV-ish response for ${eventId} from ${url} -> ${outPath}`);
                return true;
              }
            }
          } else {
            // log non-ok status for debugging
            // console.log(`Non-ok response for ${url}: ${resp ? resp.status() : 'no response'}`);
          }
        } catch (err) {
          // continue to next candidate
          // console.debug(`Candidate ${url} failed: ${err.message}`);
        }
      }
      return false;
    }

    // 6) Download for each event (parallel with small concurrency)
    const concurrency = 4;
    let idx = 0;
    async function worker() {
      while (idx < allEventIds.length) {
        const i = idx++;
        const evt = allEventIds[i];
        console.log(`\n[${i+1}/${allEventIds.length}] Attempting export for: ${evt}`);
        const ok = await tryDownloadForEvent(evt);
        if (!ok) {
          console.warn(`Failed to download CSV for ${evt} (all templates tried)`);
        }
      }
    }

    // start workers
    const workers = Array.from({ length: Math.min(concurrency, allEventIds.length) }, () => worker());
    await Promise.all(workers);

    console.log('\nAll events processed (check downloads folder).');

  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
