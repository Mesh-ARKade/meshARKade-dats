# meshARKade-dats

Automated DAT pipeline for [Mesh ARKade](https://github.com/Mesh-ARKade) — fetches, validates, and relays DAT files from No-Intro, TOSEC, and Redump to `meshARKade-database` for compilation into signed catalog artifacts.

## How It Works

A daily GitHub Actions cron job runs three fetch jobs in parallel, then relays the results:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ No-Intro     │  │ TOSEC        │  │ Redump       │
│ (Playwright) │  │ (version chk)│  │ (Fresh1G1R)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                  │
       │    (fetch → extract → validate)   │
       │                 │                  │
       └────────┬────────┴──────────┬───────┘
                │                   │
                ▼                   ▼
           ┌─────────────────────────────┐
           │           relay             │
           │  (PR to meshARKade-database │
           │   per source)               │
           └─────────────────────────────┘
```

### Sources

| Source | Method | Skip Logic |
|--------|--------|------------|
| **No-Intro** | Playwright automates [Dat-o-Matic](https://datomatic.no-intro.org/?page=download&op=daily) form — applies filters, requests archive, downloads zip | Relay skips PR if DATs unchanged |
| **TOSEC** | Parses [tosecdev.org](https://www.tosecdev.org/downloads/category/22-datfiles) for latest release date, compares against `versions.json` | Skips download entirely if version matches |
| **Redump** | Sparse git checkout of [Fresh1G1R](https://github.com/UnluckyForSome/Fresh1G1R) `daily-virgin-dat/` directory | Relay skips PR if DATs unchanged |

### No-Intro Filter Settings

The Playwright fetcher applies these filters on Dat-o-Matic:

- **Main** ✓
- **Aftermarket** ✓
- **Unofficial** ✓
- **Non-Redump** ✓
- **Redump BIOS** ✓
- All others off

### Relay

For each source that produced new DATs, `relay.js` opens a PR on `meshARKade-database`:
- Shallow clones the database repo using `MESH_DATABASE_TOKEN`
- Copies validated DATs into `input/{source}/`
- Opens a PR: `update-dats/{source}-{YYYY-MM-DD}`
- If the DAT contents are identical to what's already in the database, the PR is skipped

---

## Prerequisites

- **Node.js 22** (LTS)
- **Playwright** — installed automatically (`npx playwright install chromium --with-deps`)
- **Git** — required for the Redump fetcher (sparse checkout)
- **7-Zip** — only needed if processing `.7z` or `.rar` archives locally

## Setup

```bash
npm install
```

## Local Development

You can run any fetch script locally for testing:

```bash
# Fetch No-Intro (requires Playwright + Chromium installed)
npx playwright install chromium
node scripts/fetch/no-intro.js output/raw/no-intro

# Fetch TOSEC (checks version, skips if unchanged)
node scripts/fetch/tosec.js output/raw/tosec versions.json

# Fetch Redump from Fresh1G1R
node scripts/fetch/redump.js output/raw/redump

# Extract an archive
node scripts/extract.js path/to/archive.zip .

# Validate DATs in a directory
node scripts/validate.js output/no-intro

# Relay to meshARKade-database (requires MESH_DATABASE_TOKEN env var)
MESH_DATABASE_TOKEN=ghp_xxx node scripts/relay.js --source redump --input output/redump

# Run tests
npm test
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run fetch:no-intro` | Fetch No-Intro daily DAT pack via Playwright |
| `npm run fetch:tosec` | Fetch TOSEC DATs (skips if version unchanged) |
| `npm run fetch:redump` | Fetch raw Redump DATs from Fresh1G1R |
| `npm run extract -- <archive>` | Extract archive to `output/{source}/` |
| `npm run validate -- <dir>` | Validate DATs in a directory |
| `npm run relay -- --source <name> --input <dir>` | Relay DATs to meshARKade-database |
| `npm test` | Run test suite |

## Source Detection

The extract script detects the DAT source from the archive filename:

| Filename contains | Extracted to |
|-------------------|-------------|
| `no-intro` or `nointro` | `output/no-intro/` |
| `redump` | `output/redump/` |
| `tosec` | `output/tosec/` |
| `mame` | `output/mame/` |

## GitHub Secrets

| Secret | Repo | Purpose |
|--------|------|---------|
| `MESH_DATABASE_TOKEN` | meshARKade-dats | Fine-grained PAT for cross-repo push + PR on meshARKade-database |
| `MESH_SIGNING_KEY` | meshARKade-database | Ed25519 private key for signing catalog artifacts |

## Version Tracking

`versions.json` tracks the last-downloaded version for sources that don't update daily:

```json
{
  "tosec": { "version": "2025-03-13", "lastChecked": "2026-04-05T06:00:00.000Z" }
}
```

When the TOSEC job detects a new version, it downloads it, updates `versions.json`, and the workflow commits the change back to this repo.

## Architecture

- **meshARKade-dats** (this repo) — Fetches, validates, and relays raw DAT files
- **meshARKade-database** — Receives DATs via PR, compiles XML → signed JSONL artifacts for the P2P network
