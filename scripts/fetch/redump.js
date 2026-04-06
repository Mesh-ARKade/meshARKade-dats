/**
 * Redump DAT Fetcher
 *
 * Pulls raw Redump DAT files from the Fresh1G1R repository on GitHub.
 * Fresh1G1R (https://github.com/UnluckyForSome/Fresh1G1R) maintains
 * daily-updated Redump DATs via their own GitHub Actions pipeline.
 *
 * We use a git sparse checkout to grab only the `daily-virgin-dat/`
 * directory, which contains the unfiltered, raw Redump DATs. These are
 * the archivally correct, preservation-grade dumps — no 1G1R filtering
 * applied. (1G1R filtering can be done client-side in Hyperbee later.)
 *
 * Why Fresh1G1R instead of redump.org directly?
 *   - Redump.org requires login + manual download per system
 *   - Fresh1G1R aggregates all systems into one repo, updated daily
 *   - The `daily-virgin-dat/` folder is a clean mirror of raw Redump DATs
 *
 * Commit SHA tracking:
 *   Before doing the expensive sparse checkout, we query the GitHub API
 *   for the latest commit SHA on the `daily-virgin-dat/redump/` path.
 *   If it matches what's stored in versions.json, we output "SKIP" and
 *   exit — no clone needed. This mirrors the TOSEC version-check pattern.
 *
 * @intent Pull the latest raw Redump DATs from Fresh1G1R's daily-virgin-dat.
 * @guarantee All .dat files from daily-virgin-dat/ are copied to outputDir.
 * @constraint Requires git to be installed and available on PATH.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Node's built-in fetch is available in Node 18+.
// We use it to query the GitHub API for the latest commit SHA.
const fetch = globalThis.fetch;

/**
 * The Fresh1G1R GitHub repo URL — this is a public repo, no auth needed.
 * We clone it shallowly with sparse checkout to avoid pulling the entire
 * history and all directories (the repo also has 1G1R filtered DATs that
 * we don't need).
 */
const FRESH1G1R_REPO = 'https://github.com/UnluckyForSome/Fresh1G1R.git';

/**
 * The owner/repo for the GitHub API commit-SHA check.
 * We use the Commits API with `path=daily-virgin-dat/redump` to get the
 * SHA of the most recent commit that touched that directory — if it hasn't
 * changed since our last run, there's nothing new to fetch.
 */
const FRESH1G1R_OWNER = 'UnluckyForSome';
const FRESH1G1R_REPO_NAME = 'Fresh1G1R';

/**
 * The directory inside Fresh1G1R that contains raw, unfiltered Redump DATs.
 * This is the only directory we sparse-checkout — everything else is ignored.
 *
 * Structure inside Fresh1G1R:
 *   daily-virgin-dat/
 *     no-intro/   ← No-Intro DATs (we get these from Dat-o-Matic instead)
 *     redump/     ← Raw Redump DATs (60 systems, this is what we want)
 */
const RAW_DAT_DIR = 'daily-virgin-dat';
const REDUMP_SUBDIR = 'daily-virgin-dat/redump';

/**
 * Run a shell command synchronously and return stdout as a string.
 * Throws if the command exits with a non-zero status.
 *
 * @param {string} cmd - The shell command to execute.
 * @param {object} [opts] - Options passed to execSync (e.g., cwd).
 * @returns {string} Trimmed stdout output.
 */
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

/**
 * Query the GitHub API for the latest commit SHA that touched the
 * `daily-virgin-dat/redump` path in Fresh1G1R.
 *
 * Uses the Commits API with `?path=` to filter to only commits that
 * modified files under that directory — so the SHA changes only when
 * Redump DATs actually change, not when Fresh1G1R updates other things.
 *
 * Returns null on any error (network failure, rate limit, etc.) so the
 * caller can fall back to a full fetch rather than silently skipping.
 *
 * @returns {Promise<string|null>} The latest commit SHA, or null on error.
 */
async function getLatestCommitSha() {
  try {
    const url = `https://api.github.com/repos/${FRESH1G1R_OWNER}/${FRESH1G1R_REPO_NAME}/commits?path=${REDUMP_SUBDIR}&per_page=1`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // If a GITHUB_TOKEN is available (running in Actions), use it to
        // get a higher rate limit (5000/hr vs 60/hr for unauthenticated).
        ...(process.env.GITHUB_TOKEN && {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        }),
      },
    });

    if (!res.ok) {
      console.warn(`[redump] GitHub API returned ${res.status} — will do full fetch`);
      return null;
    }

    const commits = await res.json();
    if (!Array.isArray(commits) || commits.length === 0) {
      console.warn('[redump] GitHub API returned no commits — will do full fetch');
      return null;
    }

    return commits[0].sha;
  } catch (err) {
    console.warn(`[redump] GitHub API check failed: ${err.message} — will do full fetch`);
    return null;
  }
}

/**
 * Read the stored Redump commit SHA from versions.json, if any.
 * Returns null if the file doesn't exist, can't be parsed, or has no SHA.
 *
 * @param {string} versionsPath - Absolute path to versions.json.
 * @returns {string|null} The stored SHA, or null.
 */
function readStoredSha(versionsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
    return data?.redump?.commitSha ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the latest Redump commit SHA back to versions.json.
 * Preserves all existing fields (e.g., tosec version).
 *
 * @param {string} versionsPath - Absolute path to versions.json.
 * @param {string} sha - The commit SHA to store.
 */
function writeStoredSha(versionsPath, sha) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
  } catch {
    // File doesn't exist or is malformed — start fresh
  }
  data.redump = { commitSha: sha, lastChecked: new Date().toISOString() };
  fs.writeFileSync(versionsPath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Fetch raw Redump DAT files from Fresh1G1R via sparse checkout.
 *
 * Flow:
 *   0. (Skip check) Query GitHub API for latest commit SHA on the redump dir.
 *      If it matches the stored SHA in versions.json, output "SKIP" and return.
 *   1. Create a temporary directory for the sparse clone
 *   2. Initialize a git repo with sparse checkout enabled
 *   3. Configure sparse checkout to only pull `daily-virgin-dat/`
 *   4. Add the Fresh1G1R remote and fetch just the latest commit (depth=1)
 *   5. Checkout the default branch — only `daily-virgin-dat/` materializes
 *   6. Copy all .dat files from `daily-virgin-dat/` into outputDir
 *   7. Update versions.json with the new commit SHA
 *   8. Clean up the temporary clone directory
 *
 * @param {string} outputDir - Directory to copy the raw Redump .dat files into.
 * @param {string} [versionsPath] - Path to versions.json for SHA tracking.
 *   Defaults to versions.json in the current working directory.
 * @returns {Promise<string[]>} Array of full paths to the copied .dat files.
 *   Returns empty array if skipped (already up to date).
 * @throws If git commands fail or no .dat files are found.
 */
export async function fetchRedump(outputDir, versionsPath) {
  // Resolve versions.json path — default to repo root (cwd)
  const vPath = versionsPath || path.join(process.cwd(), 'versions.json');

  // --- Step 0: Commit SHA check ---
  // Query GitHub API to see if the redump directory has changed since our
  // last run. If not, there's nothing to fetch — output SKIP and return.
  console.log('[redump] Checking Fresh1G1R for updates via GitHub API...');
  const latestSha = await getLatestCommitSha();

  if (latestSha) {
    const storedSha = readStoredSha(vPath);
    if (storedSha && storedSha === latestSha) {
      console.log(`[redump] No changes since last fetch (SHA: ${latestSha.slice(0, 8)})`);
      console.log('SKIP');
      return [];
    }
    console.log(`[redump] New commits detected (${storedSha ? storedSha.slice(0, 8) : 'none'} → ${latestSha.slice(0, 8)}). Fetching...`);
  } else {
    console.log('[redump] SHA check unavailable — proceeding with full fetch');
  }
  // Ensure the output directory exists before we start copying files
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // We clone into a temporary directory alongside the output dir.
  // Using a timestamp ensures we don't collide with previous runs.
  const tmpDir = path.join(outputDir, '..', `.fresh1g1r-clone-${Date.now()}`);

  try {
    // --- Step 1: Initialize a bare repo with sparse checkout ---
    // Sparse checkout lets us tell git "only materialize these paths"
    // so we don't download the entire repo contents — just the DAT dir.
    console.log('[redump] Setting up sparse checkout...');
    fs.mkdirSync(tmpDir, { recursive: true });

    // Initialize an empty git repo in our temp directory
    run('git init', { cwd: tmpDir });

    // Enable sparse checkout mode — this tells git to only check out
    // the paths we explicitly list, ignoring everything else
    run('git sparse-checkout init --cone', { cwd: tmpDir });

    // Tell sparse checkout we only want the daily-virgin-dat directory.
    // Everything else (1G1R filtered DATs, scripts, docs) stays un-materialized.
    run(`git sparse-checkout set ${RAW_DAT_DIR}`, { cwd: tmpDir });

    // --- Step 2: Add the remote and fetch (shallow, depth=1) ---
    // depth=1 means we only fetch the latest commit — no history needed.
    // We explicitly fetch `main` by name so we can reference it as
    // origin/main — checking out FETCH_HEAD in detached state doesn't
    // work correctly with sparse checkout (leaves the working tree empty).
    console.log('[redump] Fetching from Fresh1G1R (shallow, sparse)...');
    run(`git remote add origin ${FRESH1G1R_REPO}`, { cwd: tmpDir });
    run('git fetch --depth=1 origin main', { cwd: tmpDir });

    // --- Step 3: Checkout via origin/main ---
    // Using origin/main (not FETCH_HEAD) ensures sparse checkout correctly
    // materializes only the configured paths (daily-virgin-dat/) on disk.
    run('git checkout origin/main', { cwd: tmpDir });

    // --- Step 4: Copy .dat files to the output directory ---
    // The raw Redump DATs live in daily-virgin-dat/redump/ — we copy
    // every .dat file from there into our output directory (flat).
    const srcDir = path.join(tmpDir, REDUMP_SUBDIR);

    if (!fs.existsSync(srcDir)) {
      throw new Error(
        `Expected directory "${REDUMP_SUBDIR}" not found in Fresh1G1R clone. ` +
        'The repo structure may have changed.'
      );
    }

    // Read all entries from the source directory.
    // We filter for .dat files only — Fresh1G1R might have READMEs or
    // other files in there that we don't want to relay downstream.
    const entries = fs.readdirSync(srcDir);
    const datFiles = entries.filter((f) => f.toLowerCase().endsWith('.dat'));

    if (datFiles.length === 0) {
      throw new Error(
        `No .dat files found in "${REDUMP_SUBDIR}". ` +
        'Fresh1G1R may have restructured or the fetch failed silently.'
      );
    }

    console.log(`[redump] Found ${datFiles.length} DAT files. Copying...`);

    // Copy each .dat file into the output directory
    const copiedPaths = [];
    for (const datFile of datFiles) {
      const src = path.join(srcDir, datFile);
      const dest = path.join(outputDir, datFile);
      fs.copyFileSync(src, dest);
      copiedPaths.push(dest);
    }

    console.log(`[redump] Copied ${copiedPaths.length} DAT files to: ${outputDir}`);

    // --- Step 7: Update versions.json with the new SHA ---
    // Only write if we got a SHA from the API — if the API was unavailable
    // we don't want to store null and accidentally skip next time.
    if (latestSha) {
      writeStoredSha(vPath, latestSha);
      console.log(`[redump] Updated versions.json with SHA: ${latestSha.slice(0, 8)}`);
    }

    return copiedPaths;
  } finally {
    // --- Step 5: Clean up the temporary clone ---
    // Always remove the temp directory, even if something failed above.
    // We use rm -rf equivalent (fs.rmSync with recursive + force).
    // This prevents leftover clones from piling up on repeated runs.
    console.log('[redump] Cleaning up temporary clone...');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // Non-fatal — warn but don't throw. The DATs are already copied.
      console.warn(`[redump] Warning: could not remove temp dir: ${cleanupErr.message}`);
    }
  }
}

// --- CLI entry point ---
// Usage: node scripts/fetch/redump.js [outputDir] [versionsPath]
//
// Examples:
//   node scripts/fetch/redump.js output/raw/redump
//   node scripts/fetch/redump.js output/raw/redump versions.json
//
// Outputs "SKIP" to stdout if the SHA in versions.json matches the latest
// commit — same pattern as tosec.js so the workflow can detect skips.
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const outputDir = process.argv[2] || 'output/raw/redump';
  const versionsPath = process.argv[3] || undefined;
  fetchRedump(outputDir, versionsPath)
    .then((files) => {
      if (files.length === 0) {
        console.log('[redump] Done. No new DATs (skipped — already up to date).');
      } else {
        console.log(`[redump] Done. ${files.length} DAT files fetched.`);
      }
    })
    .catch((err) => {
      console.error(`[redump] Failed: ${err.message}`);
      process.exit(1);
    });
}
