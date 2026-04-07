/**
 * DAT Relay Script
 *
 * Relays validated DAT files from this repo (meshARKade-dats) to the
 * meshARKade-database repo by opening a single combined Pull Request.
 * This is the bridge between the "fetch & validate" pipeline and the
 * "compile & sign" pipeline.
 *
 * How it works:
 *   1. Shallow-clone meshARKade-database using a GitHub PAT
 *   2. Create a branch named `update-dats/{YYYY-MM-DD}`
 *   3. For each source: sync .dat files into `input/{source}/` using
 *      canonical name diffing
 *   4. One commit with all source changes, push, open a PR via `gh`
 *
 * One PR per day (not per source):
 *   The daily pipeline fetches from No-Intro, TOSEC, and Redump in parallel.
 *   Rather than opening three separate PRs, we combine all sources into one
 *   PR. This gives meshARKade-database one clean merge → one signed release.
 *   Sources that were skipped (e.g., TOSEC most days) are simply omitted.
 *
 * Canonical name diffing (the smart part):
 *   DAT filenames embed dates/versions as suffixes that change on every update.
 *   We strip these to get the "canonical name" and use it as a lookup key to
 *   detect what's new, updated, or removed — producing surgical PR diffs.
 *
 * @intent Relay validated DATs to meshARKade-database via one combined PR.
 * @guarantee Only changed/new DATs are written; stale versions are replaced.
 * @constraint Requires MESH_DATABASE_TOKEN env var and `gh` CLI installed.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * The target repository where DATs get relayed to.
 */
const TARGET_REPO = 'Mesh-ARKade/meshARKade-database';

/**
 * Strip trailing metadata groups from a DAT filename to get the canonical
 * (system) name used as a lookup key for diffing.
 *
 * Each source uses a different filename convention:
 *
 *   No-Intro: "Nintendo - Game Boy (20260405-031740).dat"
 *              canonical → "Nintendo - Game Boy"
 *
 *   TOSEC:    "Atari - 2600 (TOSEC-v2025-03-13).dat"
 *              canonical → "Atari - 2600"
 *
 *   Redump:   "Acorn - Archimedes - Datfile (77) (2025-10-23 18-11-28).dat"
 *              canonical → "Acorn - Archimedes - Datfile"
 *
 * @param {string} filename - The .dat filename (basename, not full path).
 * @returns {string} The canonical name without metadata suffixes or extension.
 */
function canonicalName(filename) {
  let stem = filename.replace(/\.dat$/i, '');
  const metadataGroup = /\s+\((?:TOSEC-v)?[\d][\d\s\-]*[_\w]*\)$/;
  let prev;
  do {
    prev = stem;
    stem = stem.replace(metadataGroup, '').trim();
  } while (stem !== prev);
  return stem;
}

/**
 * Build a map of canonical name → full filename for all .dat files in a dir.
 *
 * @param {string} dir - Directory to scan.
 * @returns {Map<string, string>} Map of canonical name → filename.
 */
function buildCanonicalMap(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.dat')) continue;
    map.set(canonicalName(f), f);
  }
  return map;
}

/**
 * Recursively find all .dat files in a directory tree.
 *
 * Handles the case where extract.js preserves zip subdirectory structure
 * (e.g., No-Intro/, TOSEC/, Aftermarket/, Unofficial/).
 *
 * @param {string} dir - The root directory to search.
 * @returns {{ name: string, fullPath: string }[]} Array of found .dat files.
 */
function findDatFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findDatFiles(fullPath));
    } else if (entry.name.toLowerCase().endsWith('.dat')) {
      results.push({ name: entry.name, fullPath });
    }
  }
  return results;
}

/**
 * Run a shell command synchronously and return stdout.
 * Masks PAT tokens in log output.
 */
function run(cmd, opts = {}) {
  const safeCmd = cmd.replace(/https:\/\/x-access-token:[^@]+@/, 'https://x-access-token:***@');
  console.log(`[relay] $ ${safeCmd}`);
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

/**
 * Parse CLI arguments into a simple key-value map.
 * Supports `--key value` and `--key=value` formats.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    if (arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.join('=');
    } else {
      args[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Sync DAT files for a single source into the target directory.
 * Uses canonical name diffing to detect new, updated, and removed DATs.
 *
 * @param {string} source - Source name (e.g., "no-intro").
 * @param {string} inputDir - Path to directory containing incoming .dat files.
 * @param {string} targetDir - Path to input/{source}/ in the cloned database repo.
 * @returns {{ added: number, updated: number, skipped: number, removed: number }}
 */
function syncSource(source, inputDir, targetDir) {
  const datFiles = findDatFiles(inputDir);
  if (datFiles.length === 0) {
    console.warn(`[relay] Warning: no .dat files found in ${inputDir} for ${source}`);
    return { added: 0, updated: 0, skipped: 0, removed: 0 };
  }

  console.log(`[relay] ${source}: found ${datFiles.length} DAT files`);
  fs.mkdirSync(targetDir, { recursive: true });

  const existingMap = buildCanonicalMap(targetDir);
  const stats = { added: 0, updated: 0, skipped: 0, removed: 0 };

  for (const { name: datFile, fullPath: srcPath } of datFiles) {
    const incoming = canonicalName(datFile);
    const existing = existingMap.get(incoming);

    if (!existing) {
      fs.copyFileSync(srcPath, path.join(targetDir, datFile));
      console.log(`[relay]   + ${datFile} (new)`);
      stats.added++;
    } else if (existing === datFile) {
      console.log(`[relay]   = ${datFile} (unchanged)`);
      stats.skipped++;
    } else {
      fs.rmSync(path.join(targetDir, existing));
      fs.copyFileSync(srcPath, path.join(targetDir, datFile));
      console.log(`[relay]   ~ ${datFile} (updated, replaced ${existing})`);
      stats.updated++;
    }

    existingMap.delete(incoming);
  }

  // Remaining entries were in the database but not in today's download
  for (const [, removedFile] of existingMap) {
    fs.rmSync(path.join(targetDir, removedFile));
    console.log(`[relay]   - ${removedFile} (removed upstream)`);
  }
  stats.removed = existingMap.size;

  console.log(`[relay] ${source}: +${stats.added} new, ~${stats.updated} updated, =${stats.skipped} unchanged, -${stats.removed} removed`);
  return stats;
}

/**
 * Relay DAT files from multiple sources to meshARKade-database in one PR.
 *
 * @param {object} options
 * @param {{ source: string, inputDir: string }[]} options.sources - Array of source/input pairs.
 * @param {string} [options.token] - GitHub PAT. Defaults to MESH_DATABASE_TOKEN env var.
 * @returns {Promise<string|null>} The URL of the created/updated PR, or null if no changes.
 */
export async function relay({ sources, token }) {
  if (!sources || sources.length === 0) {
    throw new Error('No sources provided. Use --sources source:path,source:path');
  }

  const githubToken = token || process.env.MESH_DATABASE_TOKEN;
  if (!githubToken) {
    throw new Error(
      'Missing MESH_DATABASE_TOKEN. Set it as an environment variable or pass --token.\n' +
      'This is a fine-grained PAT with contents:write and pull-requests:write\n' +
      'on the Mesh-ARKade/meshARKade-database repository.'
    );
  }

  const tmpDir = path.join(process.cwd(), `.relay-clone-${Date.now()}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${TARGET_REPO}.git`;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const branchName = `update-dats/${today}`;

  try {
    // --- Clone once for all sources ---
    console.log(`[relay] Cloning ${TARGET_REPO} (shallow)...`);
    run(`git clone --depth=1 "${cloneUrl}" "${tmpDir}"`);
    run('git config user.name "meshARKade-dats[bot]"', { cwd: tmpDir });
    run('git config user.email "dats-bot@mesharkade.dev"', { cwd: tmpDir });

    console.log(`[relay] Creating branch: ${branchName}`);
    run(`git checkout -b "${branchName}"`, { cwd: tmpDir });

    // --- Sync each source ---
    const allStats = {};
    const sourceNames = [];

    for (const { source, inputDir } of sources) {
      if (!fs.existsSync(inputDir)) {
        console.warn(`[relay] Skipping ${source}: input directory does not exist (${inputDir})`);
        continue;
      }

      const targetDir = path.join(tmpDir, 'input', source);
      const stats = syncSource(source, inputDir, targetDir);
      allStats[source] = stats;
      sourceNames.push(source);

      // Stage this source's changes
      run(`git add "input/${source}/"`, { cwd: tmpDir });
    }

    // --- Check for any actual changes across all sources ---
    const status = run('git status --porcelain', { cwd: tmpDir });
    if (!status) {
      console.log('[relay] No changes detected across any source. Everything is up to date.');
      console.log('SKIP');
      return null;
    }

    // --- Build commit message with per-source stats ---
    const sourceList = sourceNames.join(', ');
    const statsLines = sourceNames.map(s => {
      const st = allStats[s];
      return `  ${s}: +${st.added} new, ~${st.updated} updated, -${st.removed} removed, =${st.skipped} unchanged`;
    });

    const commitMsg = `chore(dats): update DATs (${today})\n\n` +
      `Automated relay from meshARKade-dats pipeline.\n` +
      `Sources: ${sourceList}\n` +
      `Date: ${today}\n\n` +
      statsLines.join('\n');

    run(`git commit -m "${commitMsg}"`, { cwd: tmpDir });

    // --- Push (force to handle stale branches from previous runs) ---
    console.log(`[relay] Pushing branch: ${branchName}`);
    run(`git push --force origin "${branchName}"`, { cwd: tmpDir });

    // --- Open PR ---
    console.log(`[relay] Opening PR on ${TARGET_REPO}...`);
    const prTitle = `Update DATs — ${today}`;

    // Build per-source stats table for the PR body
    const statsRows = sourceNames.map(s => {
      const st = allStats[s];
      return `| ${s} | ${st.added} | ${st.updated} | ${st.removed} | ${st.skipped} |`;
    }).join('\n');

    const prBody = [
      `## Automated DAT Relay`,
      ``,
      `**Date:** ${today}`,
      `**Sources:** ${sourceList}`,
      ``,
      `| Source | New | Updated | Removed | Unchanged |`,
      `|--------|-----|---------|---------|-----------|`,
      statsRows,
      ``,
      `This PR was automatically generated by the meshARKade-dats daily pipeline.`,
      `DAT files are fetched from upstream, validated, and diffed against the`,
      `current database contents — only changed files appear in this diff.`,
      ``,
      `---`,
      `Generated by meshARKade-dats automation`,
    ].join('\n');

    let prUrl;
    try {
      prUrl = run(
        `gh pr create --repo "${TARGET_REPO}" --title "${prTitle}" --body "${prBody}" --head "${branchName}"`,
        { cwd: tmpDir, env: { ...process.env, GH_TOKEN: githubToken } }
      );
    } catch (prErr) {
      // If a PR already exists for today's branch, the force-push already
      // updated it. Just retrieve the existing PR URL.
      if (prErr.message.includes('already exists')) {
        console.log(`[relay] PR already exists for ${branchName}, fetching URL...`);
        prUrl = run(
          `gh pr view --repo "${TARGET_REPO}" "${branchName}" --json url --jq .url`,
          { cwd: tmpDir, env: { ...process.env, GH_TOKEN: githubToken } }
        );
        console.log(`[relay] Existing PR updated with force-pushed branch: ${prUrl}`);
      } else {
        throw prErr;
      }
    }

    console.log(`[relay] PR created: ${prUrl}`);
    return prUrl;
  } finally {
    console.log('[relay] Cleaning up temporary clone...');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[relay] Warning: could not remove temp dir: ${cleanupErr.message}`);
    }
  }
}

// --- CLI entry point ---
// Usage: node scripts/relay.js --sources source:path[,source:path,...] [--token <pat>]
//
// Examples:
//   node scripts/relay.js --sources no-intro:artifacts/no-intro
//   node scripts/relay.js --sources no-intro:artifacts/no-intro,redump:artifacts/redump
//   node scripts/relay.js --sources no-intro:artifacts/no-intro,tosec:artifacts/tosec,redump:artifacts/redump
//
// Environment:
//   MESH_DATABASE_TOKEN — GitHub PAT (can also pass via --token)
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));

  // Parse --sources flag: "no-intro:path,redump:path" → [{source, inputDir}]
  if (!args.sources) {
    console.error('[relay] Missing --sources argument.');
    console.error('[relay] Usage: --sources source:path[,source:path,...]');
    process.exit(1);
  }

  const sources = args.sources.split(',').map(pair => {
    const [source, inputDir] = pair.split(':');
    if (!source || !inputDir) {
      console.error(`[relay] Invalid source pair: "${pair}". Expected "source:path".`);
      process.exit(1);
    }
    return { source, inputDir };
  });

  relay({ sources, token: args.token })
    .then((prUrl) => {
      if (prUrl) {
        console.log(`[relay] Done. PR: ${prUrl}`);
      } else {
        console.log('[relay] Done. No changes to relay.');
      }
    })
    .catch((err) => {
      console.error(`[relay] Failed: ${err.message}`);
      process.exit(1);
    });
}
