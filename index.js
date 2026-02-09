console.log("Script started with saved session");

require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

(async () => {
  // --- Setup Supabase ---
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // --- Launch browser with saved Lu.ma session ---
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    storageState: 'storageState.json',
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // --- Open Lu.ma calendar directly ---
  await page.goto('https://lu.ma/calendar', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  console.log("Opened Lu.ma calendar with stored session");

  const url = page.url();
  console.log("Current URL:", url);

  if (url.includes('login')) {
    throw new Error('Session expired. Regenerate storageState.json');
  }

  // --- TEST: Supabase upsert ---
  console.log("Testing Supabase upsert...");

  const { error } = await supabase
    .from('luma_ui_attendees')
    .upsert({
      email: 'test@example.com',
      event_id: 'test-event',
      event_name: 'Test Event from Bot',
      name: 'Test User',
      raw: { test: true }
    });

  if (error) {
    console.error("Supabase error:", error);
  } else {
    console.log("Supabase upsert success");
  }

  await browser.close();
})();
