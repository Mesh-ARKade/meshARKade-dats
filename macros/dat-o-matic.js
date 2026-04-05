import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.resolve(__dirname, '../output/raw-downloads');

/**
 * Downloads the No-Intro Daily DAT pack using Playwright.
 */
async function downloadNoIntro() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('🚀 Launching headless browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    console.log('🌐 Navigating to Dat-o-Matic...');
    await page.goto('https://datomatic.no-intro.org/?page=download&op=daily', { waitUntil: 'load' });

    console.log('⚙️ Applying filter settings...');
    // Ensure all required checkboxes are checked
    const filters = [
      'Main',
      'Aftermarket',
      'Unofficial',
      'Non-Redump',
      'Redump BIOS'
    ];

    for (const text of filters) {
      // Find checkbox by label text containing the filter name
      const labels = await page.locator('label').all();
      for (const label of labels) {
        const labelText = await label.innerText();
        if (labelText.includes(text)) {
          const id = await label.getAttribute('for');
          if (id) {
            const checkbox = page.locator(`input#${id}`);
            if (!(await checkbox.isChecked())) {
              console.log(`Checking ${text}...`);
              await checkbox.check();
            }
          } else {
            const checkbox = label.locator("input[type='checkbox']");
            if (await checkbox.count() > 0 && !(await checkbox.isChecked())) {
              console.log(`Checking ${text}...`);
              await checkbox.check();
            }
          }
        }
      }
    }

    console.log('⏳ Requesting archive generation...');
    await page.locator("button:has-text('Request'), input[value='Request']").first().click();
    
    // Wait for the download button to appear
    const downloadButton = page.locator("button:has-text('Download!!'), input[value='Download!!']").first();
    await downloadButton.waitFor({ state: 'visible', timeout: 120000 }); // 2 minutes max processing time
    
    console.log('⬇️ Starting download...');
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    
    const download = await downloadPromise;
    const finalPath = path.join(outputDir, download.suggestedFilename());
    
    // Give download time to complete
    await download.saveAs(finalPath);
    console.log(`✅ Success! Downloaded: ${finalPath}`);
    return finalPath;

  } catch (error) {
    console.error('❌ Failed to download No-Intro DATs:', error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

downloadNoIntro();
