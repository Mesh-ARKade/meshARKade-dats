# meshARKade-dats

The automated metadata aggregation pipeline for [Mesh ARKade](https://github.com/Mesh-ARKade). 

This repository is responsible for fetching, validating, and standardizing DAT files (game ROM preservation metadata) from primary preservation groups (such as No-Intro, TOSEC, and Redump).

## Overview

`meshARKade-dats` acts as the upstream ingestion point for the Mesh ARKade catalog ecosystem. It runs automated jobs to continuously monitor primary sources for new metadata releases. 

When upstream changes are detected, this pipeline:
1. Fetches the raw release archives.
2. Extracts and validates the XML DAT structures against known schemas.
3. Stages the validated metadata for downstream compilation by the `meshARKade-database` repository.

## Prerequisites

- **Node.js 22** (LTS)
- **Git** 

## Setup & Testing

```bash
# Install dependencies
npm install

# Run the test suite
npm test
```

## Architecture

This repository is part of a two-stage data pipeline:
- **Stage 1: `meshARKade-dats`** (this repo) — Data ingestion, validation, and staging.
- **Stage 2: `meshARKade-database`** — Compilation, dictionary compression, and cryptographic signing for P2P distribution.
