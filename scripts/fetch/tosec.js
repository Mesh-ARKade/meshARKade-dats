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

  // Look for download links matching the TOSEC DAT pack pattern.
  // The page uses <a> tags with href pointing to the download.
  // We look for the date pattern (YYYY-MM-DD) in the link text or href.
  const datePattern = /(\d{4}-\d{2}-\d{2})/g;
  const linkPattern = /href="([^"]*?download[^"]*?)"/gi;

  // Extract all download links
  const links = [];
  let linkMatch;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    links.push(linkMatch[1]);
  }

  // Find the most recent date mentioned on the page
  const dates = [];
  let dateMatch;
  while ((dateMatch = datePattern.exec(html)) !== null) {
    dates.push(dateMatch[1]);
  }

  if (dates.length === 0) {
    console.log('[tosec] Could not find any version dates on the downloads page.');
    return null;
  }

  // Sort dates descending to get the latest
  dates.sort().reverse();
  const latestVersion = dates[0];

  // Try to find a download link that contains this date
  const matchingLink = links.find((link) => link.includes(latestVersion));

  // If no direct link found, use the main download page — the curator
  // may need to adjust this if TOSEC changes their page structure.
  const downloadUrl = matchingLink
    ? (matchingLink.startsWith('http') ? matchingLink : `https://www.tosecdev.org${matchingLink}`)
    : TOSEC_DOWNLOADS_URL;

  return { version: latestVersion, downloadUrl };
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
