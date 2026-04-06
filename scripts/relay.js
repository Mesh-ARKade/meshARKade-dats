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
 *   3. Copy the validated DAT files into `input/{source}/` in the clone
 *   4. Commit, push, and open a PR via the `gh` CLI
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
 * @guarantee A PR is opened on meshARKade-database with the new DAT files.
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
 *   4. Clear the existing `input/{source}/` directory (fresh sync, not merge)
 *   5. Copy all .dat files from inputDir into `input/{source}/`
 *   6. Commit with a descriptive message
 *   7. Push the branch and open a PR via `gh pr create`
 *   8. Clean up the temporary clone
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

    // --- Step 3: Prepare the input/{source}/ directory ---
    // We clear the existing directory first so this is a clean sync,
    // not a merge. Removed DATs (e.g., renamed systems) won't linger.
    const targetDir = path.join(tmpDir, 'input', source);
    if (fs.existsSync(targetDir)) {
      // Remove existing DATs — we're replacing them entirely
      console.log(`[relay] Clearing existing input/${source}/...`);
      fs.rmSync(targetDir, { recursive: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    // --- Step 4: Copy .dat files into the target directory ---
    console.log(`[relay] Copying ${datFiles.length} DAT files to input/${source}/...`);
    for (const datFile of datFiles) {
      const src = path.join(inputDir, datFile);
      const dest = path.join(targetDir, datFile);
      fs.copyFileSync(src, dest);
    }

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
      `Files: ${datFiles.length} DAT files\n` +
      `Date: ${today}`;

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
      `**Files:** ${datFiles.length} DAT files`,
      `**Date:** ${today}`,
      ``,
      `This PR was automatically generated by the meshARKade-dats daily pipeline.`,
      `The DAT files have been fetched from upstream and validated before relay.`,
      ``,
      `### What to review`,
      `- Check that the DAT file count looks reasonable for this source`,
      `- Verify no unexpected file removals (diff tab)`,
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
