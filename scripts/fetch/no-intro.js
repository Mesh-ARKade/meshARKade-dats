/**
 * No-Intro DAT Fetcher
 *
 * Downloads the daily DAT pack from No-Intro's Dat-o-Matic using Playwright.
 * Playwright is needed because Dat-o-Matic requires form interaction —
 * you select filter checkboxes, click "Request", wait for the server to
 * generate the archive, then click "Download!!". No direct download URL exists.
 *
 * Filter settings applied (matching the project's curation requirements):
 *   - Main ✓
 *   - Aftermarket ✓
 *   - Unofficial ✓
 *   - Non-Redump ✓
 *   - Redump BIOS ✓
 *
 * @intent Download the daily No-Intro DAT pack with correct filter settings.
 * @guarantee The downloaded zip is saved to the specified output directory.
 * @constraint Requires Playwright with Chromium installed.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

/** The Dat-o-Matic daily download page URL. */
const DAT_O_MATIC_URL = 'https://datomatic.no-intro.org/?page=download&op=daily';

/**
 * Checkbox configuration for the Dat-o-Matic daily download page.
 *
 * The page uses a table with checkboxes named `set1`–`set8` (no <label> elements).
 * Each checkbox controls inclusion of a DAT category in the download pack.
 * We explicitly set every checkbox to the desired state — not just the ones we
 * want checked, but also unchecking ones we don't want, in case defaults change.
 *
 * Mapping (discovered via page inspection, April 2026):
 *   set1 = Main (No-Intro verified dumps)
 *   set2 = Source Code
 *   set8 = Aftermarket (homebrew, repros, etc.)
 *   set4 = Unofficial (community-contributed, not yet fully verified)
 *   set3 = Non-Redump (disc-based systems not covered by Redump)
 *   set6 = Redump Custom (custom Redump configurations)
 *   set7 = Redump BIOS (BIOS dumps verified against Redump)
 *   set5 = Non-Game (BIOS, firmware, apps — non-game software)
 *
 * The project's curation requirements (per ADR-0021):
 *   ✓ Main, Aftermarket, Unofficial, Non-Redump, Redump BIOS
 *   ✗ Source Code, Redump Custom, Non-Game
 */
const CHECKBOX_CONFIG = {
  set1: true,   // Main — core No-Intro verified dumps. Always want this.
  set2: false,  // Source Code — not needed for ROM preservation.
  set8: true,   // Aftermarket — homebrew, repros. Valuable for completeness.
  set4: true,   // Unofficial — community dumps not yet fully verified. Include.
  set3: true,   // Non-Redump — disc systems outside Redump's scope. Include.
  set6: false,  // Redump Custom — custom configs, not standard. Skip.
  set7: true,   // Redump BIOS — BIOS files verified against Redump. Need these.
  set5: false,  // Non-Game — firmware/apps. Skip for now.
};

/**
 * Download the No-Intro daily DAT pack from Dat-o-Matic.
 *
 * The flow:
 *   1. Open a headless browser to the Dat-o-Matic daily download page
 *   2. Ensure all required filter checkboxes are checked
 *   3. Click "Request" to ask the server to generate the archive
 *   4. Wait for the "Download!!" button (server-side generation, up to 2 min)
 *   5. Click "Download!!" and save the zip to outputDir
 *
 * @param {string} outputDir - Directory to save the downloaded zip into.
 * @returns {Promise<string>} Full path to the downloaded zip file.
 * @throws If the page structure changes or the download times out.
 */
export async function fetchNoIntro(outputDir) {
  // Ensure the output directory exists before we try to save anything
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('[no-intro] Launching headless browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // --- Step 1: Navigate to the daily download page ---
    console.log('[no-intro] Navigating to Dat-o-Matic...');
    
    // Add retry logic for initial navigation - sometimes the site is slow to wake up
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      try {
        await page.goto(DAT_O_MATIC_URL, { waitUntil: 'load', timeout: 60_000 });
        break; // Success
      } catch (err) {
        attempt++;
        if (attempt === maxAttempts) throw err;
        console.warn(`[no-intro]   Navigation attempt ${attempt} failed. Retrying...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // --- Step 2: Apply filter settings ---
    // The page uses checkboxes named `set1`–`set8` in a table (no <label> elements).
    // We explicitly set each checkbox to the desired state using our CHECKBOX_CONFIG.
    // This ensures we get exactly the DAT categories we want, regardless of defaults.
    console.log('[no-intro] Applying filter settings...');
    for (const [name, shouldBeChecked] of Object.entries(CHECKBOX_CONFIG)) {
      // Locate the checkbox by its `name` attribute
      const checkbox = page.locator(`input[type='checkbox'][name='${name}']`);

      // Verify the checkbox exists on the page — if Dat-o-Matic changes their
      // form structure, we want to know about it rather than silently skipping.
      if ((await checkbox.count()) === 0) {
        throw new Error(`Checkbox "${name}" not found on page! Form structure changed.`);
      }

      const isChecked = await checkbox.isChecked();

      if (shouldBeChecked && !isChecked) {
        // Need to check this box — it's required but currently unchecked
        console.log(`[no-intro]   Checking "${name}" (was unchecked)...`);
        await checkbox.check();
      } else if (!shouldBeChecked && isChecked) {
        // Need to uncheck this box — it's checked but we don't want it
        console.log(`[no-intro]   Unchecking "${name}" (was checked)...`);
        await checkbox.uncheck();
      } else {
        // Already in the desired state
        console.log(`[no-intro]   "${name}" already ${isChecked ? 'checked' : 'unchecked'} ✓`);
      }
    }

    // --- Step 3: Request the archive ---
    // The "Request" button tells the server to start building the zip.
    console.log('[no-intro] Requesting archive generation...');
    await page.locator("button:has-text('Request'), input[value='Request']").first().click();

    // --- Step 4: Wait for "Download!!" ---
    // Server-side generation can take a while for large packs.
    // We give it up to 2 minutes before timing out.
    const downloadButton = page.locator("button:has-text('Download!!'), input[value='Download!!']").first();
    await downloadButton.waitFor({ state: 'visible', timeout: 120_000 });

    // --- Step 5: Download the file ---
    console.log('[no-intro] Starting download...');
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    const finalPath = path.join(outputDir, filename);

    await download.saveAs(finalPath);
    console.log(`[no-intro] Downloaded: ${finalPath}`);

    return finalPath;
  } finally {
    // Always close the browser, even if something goes wrong
    await browser.close();
  }
}

// --- CLI entry point ---
// Usage: node scripts/fetch/no-intro.js <outputDir>
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const outputDir = process.argv[2] || 'output/raw';
  fetchNoIntro(outputDir)
    .then((zipPath) => {
      console.log(`[no-intro] Done. Archive at: ${zipPath}`);
    })
    .catch((err) => {
      console.log(`[no-intro] SKIP: ${err.message}`);
      process.exit(0);
    });
}
