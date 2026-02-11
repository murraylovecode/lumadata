// index.js
console.log("Lu.ma fast CSV exporter — API-export using Playwright session");

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function cookieHeaderFromCookies(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function downloadToFile(url, headers, destPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      port: u.port || 443,
      headers,
    };

    const req = https.request(opts, (res) => {
      const status = res.statusCode || 0;
      if (status >= 400) {
        // collect body for debug then reject
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          reject(new Error(`Status ${status}; body-preview: ${body}`));
        });
        return;
      }

      // Accept many CSV content-types; also accept octet-stream
      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => resolve({ status, contentType }));
      fileStream.on('error', (err) => reject(err));
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    storageState: 'storageState.json'
  });
  const page = await context.newPage();

  console.log("Opening profile page...");
  await page.goto('https://luma.com/user/murray', { waitUntil: 'networkidle' });

  // click both "View All" buttons (if present) to cause client to render more cards
  try {
    const viewAllButtons = await page.getByText('View All', { exact: true }).all();
    for (let i = 0; i < viewAllButtons.length; i++) {
      try {
        await viewAllButtons[i].click({ timeout: 5000 });
        // give client time to render popup contents
        await page.waitForTimeout(800);
        // close popup by pressing Escape so second View All not blocked
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      } catch (e) {
        // ignore single-click failures
      }
    }
  } catch (e) {
    // ignore
  }

  // scroll a bit to let lazy content render
  await page.evaluate(async () => {
    window.scrollTo({ top: 0 });
    await new Promise(r => setTimeout(r, 300));
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, document.body.scrollHeight / steps);
      // small delay
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo({ top: 0 });
  });

  // Grab page HTML and extract evt- IDs
  const html = await page.content();
  // match evt- followed by letters/numbers/-,_ (tuned to typical ids)
  const matches = Array.from(html.matchAll(/evt-[A-Za-z0-9_-]+/g)).map(m => m[0]);
  const uniqueIds = [...new Set(matches)];
  if (uniqueIds.length === 0) {
    console.log("No evt- IDs found on profile page. Trying a broader regex for 'evt' tokens.");
    // fallback: find tokens like evt\S{6,}
    const matches2 = Array.from(html.matchAll(/evt-[^\s"'<>{}]+/g)).map(m => m[0]);
    for (const m of matches2) if (!uniqueIds.includes(m)) uniqueIds.push(m);
  }

  console.log(`Found ${uniqueIds.length} unique event ids (evt-...)`);

  // Prepare cookie header from Playwright context cookies
  const cookies = await context.cookies();
  const cookieHeader = cookieHeaderFromCookies(cookies);
  const headers = {
    'Cookie': cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Playwright script)',
    'Accept': '*/*',
    'Referer': 'https://luma.com/user/murray'
  };

  // endpoints to try (ordered). We'll try common variants.
  function endpointsForEvent(ev) {
    return [
      // common pattern we observed / suggested
      `https://luma.com/api/event/${ev}/guests/export`,
      `https://luma.com/api/events/${ev}/guests/export`,
      // manage path (sometimes servers handle same route)
      `https://luma.com/event/manage/${ev}/guests/export`,
      `https://luma.com/event/manage/${ev}/guests/csv`,
      `https://luma.com/event/manage/${ev}/guests/download`,
      // fallback: event path used by UI to download
      `https://luma.com/event/${ev}/guests/export`,
      // last-ditch: query param style
      `https://luma.com/home?e=${ev}&export=guests`
    ];
  }

  for (const ev of uniqueIds) {
    const eventId = ev;
    const tryUrls = endpointsForEvent(eventId);
    let saved = false;

    for (const url of tryUrls) {
      const dest = path.join(DOWNLOAD_DIR, `${eventId}.csv`);
      try {
        console.log(`Trying ${url} ...`);
        const result = await downloadToFile(url, headers, dest, 30000).catch(err => { throw err; });
        // quick sanity: ensure file size > 0 and content-type indicates csv or plain text
        const stats = fs.statSync(dest);
        if (stats.size > 10) {
          const ct = (result.contentType || '').toLowerCase();
          if (ct.includes('csv') || ct.includes('text') || ct.includes('octet-stream') || dest.endsWith('.csv')) {
            console.log(`Saved CSV for ${eventId} from ${url} (${stats.size} bytes, content-type=${result.contentType})`);
            saved = true;
            break;
          } else {
            // If content-type is unexpected, still accept if file appears like CSV
            const sample = fs.readFileSync(dest, 'utf8', { encoding: 'utf8' }).slice(0, 200);
            if (sample.includes('api_id') || sample.includes('email') || sample.includes('name') || sample.includes(',')) {
              console.log(`Saved CSV-like file for ${eventId} from ${url} (heuristic match)`);
              saved = true;
              break;
            } else {
              // not CSV — remove and continue trying
              fs.unlinkSync(dest);
              console.log(`Downloaded file not CSV-like (content-type=${result.contentType}). Trying next endpoint.`);
            }
          }
        } else {
          // empty; remove and continue
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          console.log(`Downloaded zero-byte response from ${url}.`);
        }
      } catch (err) {
        // log and try next
        console.log(`Failed ${url}: ${err.message ? err.message : err}`);
        // remove partially written file if any
        try { if (fs.existsSync(path.join(DOWNLOAD_DIR, `${eventId}.csv`))) fs.unlinkSync(path.join(DOWNLOAD_DIR, `${eventId}.csv`)); } catch (_) {}
      }
    } // end tryUrls loop

    if (!saved) {
      console.log(`Could not export CSV for ${eventId} (all endpoints failed).`);
    }
  } // end events loop

  await browser.close();
  console.log("Done — CSV export attempts complete.");
})();
