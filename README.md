# meshARKade-dats

Curator's local toolbelt for the Mesh ARKade firehose pipeline. Downloads, extracts, sorts, and validates raw DAT files from primary sources before they enter `meshARKade-database`.

**This repo is local only — no GitHub Actions, no automated scraping.**

## Prerequisites

- **Node.js v24** (see `.nvmrc`)
- **7-Zip** — required for `.7z` and `.rar` archives (install from https://7-zip.org)
- **Antigravity** — optional, used to assist with downloads (see below)

## Setup

```bash
npm install
```

## Curator Workflow

### Step 1 — Download DATs

1. Download the source dat files from...

- Download https://datomatic.no-intro.org/?page=download&op=daily ,
at the top of the page set the filters as follows:
Type: Standard Dat
    - with filter set:
        - Main ✓
        - Aftermarket ✓
        - Unofficial ✓
        - Non-Redump ✓
        - Redump BIOS ✓
        - All Others Toggle Off

Click the "Request" button then wait for the page to load the "Download" button. Click that to get the `.zip` archive.

### Step 2 — Collect

Place your archives in the source-specific staging folders:
- `dats/no-intro/*.zip`
- `dats/tosec/*.zip`
- `dats/redump/*.zip`

### Step 3 — Ingest or Relay

**Option A: Automated Relay (Recommended)**
Push your archives to a dedicated branch, and the Relay GitHub Action will handle everything:
1. Create a branch: `git checkout -b upload-dats/your-update-name`
2. Commit your archives into `dats/`
3. Push: `git push -u origin upload-dats/your-update-name`

**Option B: Local Processing**
If you want to process and validate locally before pushing:
```bash
npm run process
```
This will extract, validate, and move "clean" files to the `output/` directory and cleanup the staging area.

### Step 4 — Review & Ship
Once processed:
- If using **Relay (A)**: A PR will be opened on `meshARKade-database` automatically.
- If using **Local (B)**: Copy the files to `meshARKade-database/input/` and open a PR.
  ```bash
  # Example for local hand-off
  cp -r ../meshARKade-dats/output/no-intro/* input/no-intro/
  git checkout -b update-dats/no-intro-2026-04-05
  git add input/
  git commit -m "feat: update No-Intro DATs"
  git push -u origin update-dats/no-intro-2026-04-05
  ```

---

## No-Intro Dat-o-Matic Filter Settings

When downloading manually at https://www.no-intro.org/dat-o-matic/download_pack.php:

- **Pack**: Love Pack (Standard)
- **Format**: XML
- **Header variant**: No-Intro

The Love Pack includes all systems. Individual system DATs are also available if you only need specific ones.

---

## Source Detection

The extract script detects the source from the archive filename:

| Filename contains | Extracted to |
|-------------------|-------------|
| `no-intro` or `nointro` | `output/no-intro/` |
| `redump` | `output/redump/` |
| `tosec` | `output/tosec/` |
| `mame` | `output/mame/` |

If the filename doesn't match any known source, extraction fails with an `Unknown source` error. Rename the file to include the source name before running extract.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run extract -- <archive>` | Extract archive to `output/{source}/` |
| `npm run validate` | Validate all DATs in `output/` |
| `npm test` | Run test suite |

---

## validate.js — GitHub Action reuse

The validate script is also used as the pre-flight check in the `meshARKade-database` GitHub Action. It accepts an `--input` flag so it can point at any directory:

```bash
node scripts/validate.js --input ./input
```

Exit codes: `0` = passed, `1` = failed.

---

## Planned: Playwright automation

A Playwright script (`macros/dat-o-matic.js`) will eventually automate Dat-o-Matic downloads with the correct filter settings — useful for contributors without Antigravity. Playwright will also serve as the e2e test infrastructure for the broader project.
