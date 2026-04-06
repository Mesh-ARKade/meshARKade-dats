/**
 * TOSEC DAT Fetcher
 *
 * Downloads the latest TOSEC DAT pack from tosecdev.org.
 * TOSEC only releases ~2x per year, so most daily runs will be a no-op.
 * We track the last-downloaded version in versions.json at the repo root
 * and skip the download if the version hasn't changed.
 *
 * The download page at https://www.tosecdev.org/downloads/category/22-datfiles
 * lists releases with version strings like "TOSEC-v2025-03-13". We parse the
 * page HTML to find the latest release link.
 *
 * @intent Download the latest TOSEC DAT pack, skipping if already up to date.
 * @guarantee versions.json is updated when a new version is downloaded.
 * @constraint Outputs "SKIP" to stdout if no new version is available.
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

/** The TOSEC datfiles download category page. */
const TOSEC_DOWNLOADS_URL = 'https://www.tosecdev.org/downloads/category/22-datfiles';

/**
 * Read the versions.json file, or return a default if it doesn't exist.
 *
 * @param {string} versionsPath - Path to versions.json.
 * @returns {{ tosec: { version: string|null, lastChecked: string|null } }}
 */
function readVersions(versionsPath) {
  if (!fs.existsSync(versionsPath)) {
    return { tosec: { version: null, lastChecked: null } };
  }
  return JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
}

/**
 * Write updated version info back to versions.json.
 *
 * @param {string} versionsPath - Path to versions.json.
 * @param {object} versions - The full versions object.
 */
function writeVersions(versionsPath, versions) {
  fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
}

/**
 * Fetch the TOSEC downloads page and parse it for the latest release.
 *
 * We're looking for the most recent datfile entry. The page has download
 * links with filenames like "TOSEC - DAT Pack - Complete (XXXX-XX-XX).zip".
 * We extract the version date from the filename.
 *
 * @returns {Promise<{ version: string, downloadUrl: string } | null>}
 *   The latest release info, or null if the page can't be parsed.
 */
async function findLatestRelease() {
  console.log('[tosec] Fetching downloads page...');
  const response = await fetch(TOSEC_DOWNLOADS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch TOSEC downloads page: ${response.status}`);
  }

  const html = await response.text();

  // The TOSEC downloads page lists releases as category links, e.g.:
  //   /downloads/category/59-2025-03-13
  // Each slug ends with the release date. We find the one with the latest date.
  const categoryPattern = /href="(\/downloads\/category\/\d+-(\d{4}-\d{2}-\d{2}))"/gi;
  const categories = [];
  let catMatch;
  while ((catMatch = categoryPattern.exec(html)) !== null) {
    categories.push({ path: catMatch[1], date: catMatch[2] });
  }

  if (categories.length === 0) {
    console.log('[tosec] Could not find any release categories on the downloads page.');
    return null;
  }

  // Sort by date descending and take the most recent
  categories.sort((a, b) => b.date.localeCompare(a.date));
  const latest = categories[0];
  console.log(`[tosec] Latest category: ${latest.path} (${latest.date})`);

  // --- Step 2: Visit the release category page to find the zip download link ---
  // The category page has a link like:
  //   /downloads/category/59-2025-03-13?download=117:tosec-dat-pack-complete-...
  const categoryUrl = `https://www.tosecdev.org${latest.path}`;
  console.log(`[tosec] Fetching release page: ${categoryUrl}`);
  const categoryResponse = await fetch(categoryUrl);
  if (!categoryResponse.ok) {
    throw new Error(`Failed to fetch TOSEC release page: ${categoryResponse.status}`);
  }

  const categoryHtml = await categoryResponse.text();

  // Find the ?download= link — this is the actual zip download trigger
  const downloadPattern = /href="(\/downloads\/category\/[^"]*\?download=[^"]+)"/i;
  const downloadMatch = downloadPattern.exec(categoryHtml);

  if (!downloadMatch) {
    console.log('[tosec] Could not find a download link on the release page.');
    return null;
  }

  const downloadUrl = `https://www.tosecdev.org${downloadMatch[1]}`;
  return { version: latest.date, downloadUrl };
}

/**
 * Download a file from a URL and save it to disk.
 *
 * @param {string} url - The URL to download.
 * @param {string} destPath - Where to save the file.
 */
async function downloadFile(url, destPath) {
  console.log(`[tosec] Downloading from: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);
  console.log(`[tosec] Saved to: ${destPath}`);
}

/**
 * Fetch the latest TOSEC DAT pack if a newer version is available.
 *
 * Flow:
 *   1. Parse the TOSEC downloads page for the latest release version
 *   2. Compare against the version stored in versions.json
 *   3. If same version → output "SKIP" and return null
 *   4. If new version → download the zip, update versions.json, return path
 *
 * @param {string} outputDir - Directory to save the downloaded zip into.
 * @param {string} versionsPath - Path to versions.json for version tracking.
 * @returns {Promise<string|null>} Path to downloaded zip, or null if skipped.
 */
export async function fetchTosec(outputDir, versionsPath) {
  const versions = readVersions(versionsPath);
  const latest = await findLatestRelease();

  if (!latest) {
    console.log('[tosec] Could not determine latest release. Skipping.');
    console.log('SKIP');
    return null;
  }

  console.log(`[tosec] Latest version: ${latest.version}`);
  console.log(`[tosec] Stored version: ${versions.tosec.version || 'none'}`);

  // Check if we already have this version
  if (versions.tosec.version === latest.version) {
    console.log('[tosec] Already up to date. Skipping.');
    console.log('SKIP');
    return null;
  }

  // New version available — download it
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `TOSEC-${latest.version}.zip`;
  const destPath = path.join(outputDir, filename);
  await downloadFile(latest.downloadUrl, destPath);

  // Update versions.json so we don't re-download next time
  versions.tosec.version = latest.version;
  versions.tosec.lastChecked = new Date().toISOString();
  writeVersions(versionsPath, versions);

  console.log(`[tosec] Updated versions.json: ${latest.version}`);
  return destPath;
}

// --- CLI entry point ---
// Usage: node scripts/fetch/tosec.js [outputDir] [versionsPath]
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const outputDir = process.argv[2] || 'output/raw';
  const versionsPath = process.argv[3] || 'versions.json';
  fetchTosec(outputDir, versionsPath)
    .then((zipPath) => {
      if (zipPath) {
        console.log(`[tosec] Done. Archive at: ${zipPath}`);
      }
    })
    .catch((err) => {
      console.error(`[tosec] Failed: ${err.message}`);
      process.exit(1);
    });
}
