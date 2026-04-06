/**
 * DAT Relay Script
 *
 * Relays validated DAT files from this repo (meshARKade-dats) to the
 * meshARKade-database repo by opening a Pull Request. This is the bridge
 * between the "fetch & validate" pipeline and the "compile & sign" pipeline.
 *
 * How it works:
 *   1. Shallow-clone meshARKade-database using a GitHub PAT
 *   2. Create a new branch named `update-dats/{source}-{YYYY-MM-DD}`
 *   3. Sync .dat files into `input/{source}/` using canonical name diffing
 *   4. Commit, push, and open a PR via the `gh` CLI
 *
 * Canonical name diffing (the smart part):
 *   No-Intro DAT filenames embed the last-updated date as a suffix, e.g.:
 *     "Nintendo - Game Boy (20260405-031740).dat"
 *   The date changes each time No-Intro updates that system's DAT, but the
 *   rest of the name (the "canonical name") stays the same. Without diffing,
 *   we'd end up with both the old and new versions sitting side by side in
 *   the database.
 *
 *   Instead, for each incoming DAT we:
 *     - Strip the trailing date to get the canonical name
 *     - Look for an existing file in input/{source}/ with the same canonical name
 *     - If found with the same date → skip (no change)
 *     - If found with a different date → delete old, copy new (updated)
 *     - If not found → copy (new system)
 *
 *   The files keep their original full names including the date — we only
 *   use the canonical name as a lookup key, not as the stored filename.
 *   This produces clean, surgical PR diffs showing only what actually changed.
 *
 * Why a separate repo?
 *   - meshARKade-dats is the "curator's toolbelt" — fetches, validates, stages
 *   - meshARKade-database is the "archive & factory" — compiles XML DATs into
 *     signed JSONL artifacts for the P2P network
 *   - Separation of concerns: the database repo has its own CI that triggers
 *     when DATs land in `input/`, compiling them into catalog artifacts
 *
 * Authentication:
 *   - Uses MESH_DATABASE_TOKEN env var (fine-grained PAT with contents:write
 *     and pull-requests:write on meshARKade-database)
 *   - The `gh` CLI also uses this token for PR creation
 *
 * @intent Relay validated DATs to meshARKade-database via automated PR.
 * @guarantee Only changed/new DATs are written; stale versions are replaced.
 * @constraint Requires MESH_DATABASE_TOKEN env var and `gh` CLI installed.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * The target repository where DATs get relayed to.
 * This is the "archive & factory" repo that compiles DATs into artifacts.
 */
const TARGET_REPO = 'Mesh-ARKade/meshARKade-database';

/**
 * Strip the trailing date stamp from a No-Intro / TOSEC DAT filename to get
 * the canonical (system) name used as a lookup key for diffing.
 *
 * No-Intro format:  "Nintendo - Game Boy (20260405-031740).dat"
 *                    canonical → "Nintendo - Game Boy"
 *
 * TOSEC format:     "Atari - 2600 (TOSEC-v2025-03-13).dat"
 *                    canonical → "Atari - 2600"
 *
 * Redump format:    "Sony - PlayStation (20251225-195142).dat"
 *                    canonical → "Sony - PlayStation"
 *
 * The pattern matches a final parenthesised group that looks like a date
 * (8+ digits, possibly with hyphens) at the end of the filename before the
 * extension. For names with no date suffix the full stem is returned as-is,
 * so this function is safe to call on any .dat filename.
 *
 * @param {string} filename - The .dat filename (basename, not full path).
 * @returns {string} The canonical name without the date suffix or extension.
 */
function canonicalName(filename) {
  // Remove the .dat extension first
  const stem = filename.replace(/\.dat$/i, '');

  // Match and strip a trailing parenthesised date group, e.g.:
  //   (20260405-031740)   ← No-Intro / Redump timestamp
  //   (TOSEC-v2025-03-13) ← TOSEC version stamp
  // The regex matches the last ` (...)` group whose content starts with
  // digits or "TOSEC-v" — conservative enough not to strip meaningful parts
  // of system names that happen to have parentheses (e.g. "(USA)").
  return stem.replace(/\s+\((?:TOSEC-v)?\d[\d\-]*\)$/, '').trim();
}

/**
 * Build a map of canonical name → full filename for all .dat files in a dir.
 * Used to find existing files in the database that match an incoming DAT.
 *
 * Example result:
 *   {
 *     "Nintendo - Game Boy": "Nintendo - Game Boy (20260404-085253).dat",
 *     "Nintendo - SNES":     "Nintendo - Super Nintendo Entertainment System (20260401-120000).dat",
 *   }
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
 * Run a shell command synchronously and return stdout.
 * Logs the command for debugging in CI logs.
 *
 * @param {string} cmd - The shell command to execute.
 * @param {object} [opts] - Options passed to execSync (e.g., cwd, env).
 * @returns {string} Trimmed stdout output.
 */
function run(cmd, opts = {}) {
  // Mask the token in logs so it doesn't leak into CI output
  const safeCmd = cmd.replace(/https:\/\/x-access-token:[^@]+@/, 'https://x-access-token:***@');
  console.log(`[relay] $ ${safeCmd}`);
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

/**
 * Parse CLI arguments into a simple key-value map.
 * Supports `--key value` and `--key=value` formats.
 *
 * @param {string[]} argv - The process.argv array (typically slice(2)).
 * @returns {object} Parsed arguments as { key: value } pairs.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    // Handle --key=value format
    if (arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.join('=');
    } else {
      // Handle --key value format (next arg is the value)
      args[arg.slice(2)] = argv[i + 1];
      i++; // skip the value in next iteration
    }
  }
  return args;
}

/**
 * Relay DAT files to meshARKade-database by opening a PR.
 *
 * Flow:
 *   1. Validate inputs — source name and input directory must be provided
 *   2. Shallow-clone meshARKade-database with the PAT (depth=1 for speed)
 *   3. Create a feature branch: `update-dats/{source}-{YYYY-MM-DD}`
 *   4. Sync DATs using canonical name diffing (add new, replace updated, skip unchanged)
 *   5. Commit with a descriptive message (lists added/updated/removed counts)
 *   6. Push the branch and open a PR via `gh pr create`
 *   7. Clean up the temporary clone
 *
 * @param {object} options
 * @param {string} options.source - The DAT source name (e.g., "redump", "no-intro", "tosec").
 * @param {string} options.inputDir - Path to directory containing validated .dat files.
 * @param {string} [options.token] - GitHub PAT. Defaults to MESH_DATABASE_TOKEN env var.
 * @returns {Promise<string>} The URL of the created PR.
 */
export async function relay({ source, inputDir, token }) {
  // --- Validate inputs ---
  if (!source) {
    throw new Error('Missing required argument: --source (e.g., "redump", "no-intro", "tosec")');
  }
  if (!inputDir) {
    throw new Error('Missing required argument: --input (path to directory with .dat files)');
  }

  // The PAT is required for pushing to the target repo and creating PRs.
  // It should be stored as a GitHub Actions secret (MESH_DATABASE_TOKEN).
  const githubToken = token || process.env.MESH_DATABASE_TOKEN;
  if (!githubToken) {
    throw new Error(
      'Missing MESH_DATABASE_TOKEN. Set it as an environment variable or pass --token.\n' +
      'This is a fine-grained PAT with contents:write and pull-requests:write\n' +
      'on the Mesh-ARKade/meshARKade-database repository.'
    );
  }

  // Make sure the input directory actually has .dat files to relay
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }
  const datFiles = fs.readdirSync(inputDir).filter((f) => f.toLowerCase().endsWith('.dat'));
  if (datFiles.length === 0) {
    throw new Error(`No .dat files found in: ${inputDir}`);
  }
  console.log(`[relay] Found ${datFiles.length} DAT files to relay for source: ${source}`);

  // --- Set up the temporary clone ---
  // We clone into a temp directory that gets cleaned up at the end.
  // The clone URL includes the PAT for authentication (x-access-token pattern).
  const tmpDir = path.join(process.cwd(), `.relay-clone-${Date.now()}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${TARGET_REPO}.git`;

  // Today's date for branch naming and commit messages
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const branchName = `update-dats/${source}-${today}`;

  try {
    // --- Step 1: Shallow clone the target repo ---
    // depth=1 means we only fetch the latest commit — no history needed.
    // This keeps the clone fast, especially as the database repo grows.
    console.log(`[relay] Cloning ${TARGET_REPO} (shallow)...`);
    run(`git clone --depth=1 "${cloneUrl}" "${tmpDir}"`);

    // Configure git identity for the automated commit.
    // This shows up in the PR as the commit author.
    run('git config user.name "meshARKade-dats[bot]"', { cwd: tmpDir });
    run('git config user.email "dats-bot@mesharkade.dev"', { cwd: tmpDir });

    // --- Step 2: Create the feature branch ---
    // Each relay creates its own branch so PRs don't conflict.
    // Branch name includes source + date for easy identification.
    console.log(`[relay] Creating branch: ${branchName}`);
    run(`git checkout -b "${branchName}"`, { cwd: tmpDir });

    // --- Step 3: Sync DATs using canonical name diffing ---
    // We don't wipe and replace — instead we diff each incoming DAT against
    // what's already in the database using the canonical name as a key.
    const targetDir = path.join(tmpDir, 'input', source);
    fs.mkdirSync(targetDir, { recursive: true });

    // Build a map of what's already in the database for this source.
    // Key = canonical name (no date), Value = current filename with date.
    const existingMap = buildCanonicalMap(targetDir);

    // Track what we do for the commit message summary
    const stats = { added: 0, updated: 0, skipped: 0 };

    for (const datFile of datFiles) {
      const incoming = canonicalName(datFile);
      const existing = existingMap.get(incoming);

      if (!existing) {
        // New DAT — system wasn't in the database before
        fs.copyFileSync(path.join(inputDir, datFile), path.join(targetDir, datFile));
        console.log(`[relay]   + ${datFile} (new)`);
        stats.added++;
      } else if (existing === datFile) {
        // Same filename = same date = no change, skip
        console.log(`[relay]   = ${datFile} (unchanged)`);
        stats.skipped++;
      } else {
        // Same canonical name, different date = updated DAT.
        // Delete the old version and copy the new one.
        fs.rmSync(path.join(targetDir, existing));
        fs.copyFileSync(path.join(inputDir, datFile), path.join(targetDir, datFile));
        console.log(`[relay]   ~ ${datFile} (updated, replaced ${existing})`);
        stats.updated++;
      }

      // Remove from the map as we process — anything left at the end
      // was in the database but not in the incoming set (deleted upstream)
      existingMap.delete(incoming);
    }

    // Any remaining entries in existingMap are DATs that were in the database
    // but didn't appear in today's download — they've been removed upstream.
    // Delete them so the database stays in sync.
    for (const [, removedFile] of existingMap) {
      fs.rmSync(path.join(targetDir, removedFile));
      console.log(`[relay]   - ${removedFile} (removed upstream)`);
    }
    const removedCount = existingMap.size;

    console.log(`[relay] Sync complete: +${stats.added} new, ~${stats.updated} updated, =${stats.skipped} unchanged, -${removedCount} removed`);

    // --- Step 5: Stage and commit ---
    // We stage everything in input/{source}/ — both new files and deletions.
    // The `--all` flag on `git add` captures removals too (from our rmSync above).
    run(`git add "input/${source}/"`, { cwd: tmpDir });

    // Check if there are actually changes to commit.
    // If the DATs are identical to what's already in the database, skip.
    const status = run('git status --porcelain', { cwd: tmpDir });
    if (!status) {
      console.log(`[relay] No changes detected for ${source}. DATs are already up to date.`);
      console.log('SKIP');
      return null;
    }

    const commitMsg = `chore(dats): update ${source} DATs (${today})\n\n` +
      `Automated relay from meshARKade-dats pipeline.\n` +
      `Source: ${source}\n` +
      `Date: ${today}\n` +
      `Added: ${stats.added} | Updated: ${stats.updated} | Removed: ${removedCount} | Unchanged: ${stats.skipped}`;

    run(`git commit -m "${commitMsg}"`, { cwd: tmpDir });

    // --- Step 6: Push the branch ---
    console.log(`[relay] Pushing branch: ${branchName}`);
    run(`git push origin "${branchName}"`, { cwd: tmpDir });

    // --- Step 7: Open a PR via the `gh` CLI ---
    // We use `gh pr create` with the PAT set as GH_TOKEN so it authenticates.
    // The --repo flag targets the database repo specifically.
    console.log(`[relay] Opening PR on ${TARGET_REPO}...`);
    const prTitle = `Update ${source} DATs — ${today}`;
    const prBody = [
      `## Automated DAT Relay`,
      ``,
      `**Source:** ${source}`,
      `**Date:** ${today}`,
      ``,
      `| Change | Count |`,
      `|--------|-------|`,
      `| New systems | ${stats.added} |`,
      `| Updated (new date) | ${stats.updated} |`,
      `| Removed (gone upstream) | ${removedCount} |`,
      `| Unchanged (skipped) | ${stats.skipped} |`,
      ``,
      `This PR was automatically generated by the meshARKade-dats daily pipeline.`,
      `DAT files are fetched from upstream, validated, and diffed against the`,
      `current database contents before relay — only changed files appear in this diff.`,
      ``,
      `### What to review`,
      `- Updated DATs: verify the new date looks recent`,
      `- Removed DATs: confirm the system was intentionally dropped upstream`,
      `- New DATs: new system coverage being added`,
      ``,
      `---`,
      `🤖 Generated by meshARKade-dats automation`,
    ].join('\n');

    // The `gh pr create` command returns the PR URL on success.
    // We pass the body via stdin to avoid shell escaping issues.
    const prUrl = run(
      `gh pr create --repo "${TARGET_REPO}" --title "${prTitle}" --body "${prBody}" --head "${branchName}"`,
      {
        cwd: tmpDir,
        env: { ...process.env, GH_TOKEN: githubToken },
      }
    );

    console.log(`[relay] PR created: ${prUrl}`);
    return prUrl;
  } finally {
    // --- Cleanup: remove the temporary clone ---
    // Always clean up, even if something failed above.
    console.log('[relay] Cleaning up temporary clone...');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[relay] Warning: could not remove temp dir: ${cleanupErr.message}`);
    }
  }
}

// --- CLI entry point ---
// Usage: node scripts/relay.js --source <name> --input <dir> [--token <pat>]
//
// Examples:
//   node scripts/relay.js --source redump --input output/raw/redump
//   node scripts/relay.js --source no-intro --input output/raw/no-intro
//   node scripts/relay.js --source tosec --input output/raw/tosec
//
// Environment:
//   MESH_DATABASE_TOKEN — GitHub PAT (can also pass via --token)
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));

  relay({
    source: args.source,
    inputDir: args.input,
    token: args.token,
  })
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
