/**
 * MAME DAT Fetcher
 *
 * Downloads the latest MAME Arcade and Software List DATs from ProgettoSnaps.
 * Tracks the last downloaded version in versions.json to skip unchanged releases.
 *
 * @intent Provide high-quality MAME metadata for arcade and software list collections.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const BASE_URL = 'https://www.progettosnaps.net/dats/MAME/';

function readVersions(versionsPath) {
  const defaults = { mame: { arcade: null, sl: null, lastChecked: null } };
  if (!fs.existsSync(versionsPath)) {
    return defaults;
  }
  try {
    const data = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
    // Migration: if old mame was a string, convert to object
    if (typeof data.mame === 'string') {
        data.mame = { arcade: data.mame, sl: null, lastChecked: null };
    }
    return { ...defaults, ...data };
  } catch {
    return defaults;
  }
}

function writeVersions(versionsPath, current, newMame) {
  const updated = {
    ...current,
    mame: newMame,
  };
  fs.writeFileSync(versionsPath, JSON.stringify(updated, null, 2));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    const request = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download: HTTP ${res.statusCode} from ${currentUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(dest);
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    };
    
    request(url);
  });
}

/**
 * Fetch MAME DAT packs.
 * 
 * Returns path to downloaded files or null if nothing changed.
 */
export async function fetchMame(outputDir, versionsPath) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const html = await fetchPage(BASE_URL);

  // 1. Find Arcade DAT (tipo=dat_mame)
  const arcadeRegex = /href="(https:\/\/www\.progettosnaps\.net\/download\/\?tipo=dat_mame&amp;file=[^"]+MAME_Dats_(\d+)\.7z)"/g;
  let match;
  let highestArcade = -1;
  let arcadeUrl = null;

  while ((match = arcadeRegex.exec(html)) !== null) {
    const versionNum = parseInt(match[2], 10);
    if (versionNum > highestArcade) {
      highestArcade = versionNum;
      arcadeUrl = match[1].replace(/&amp;/g, '&');
    }
  }

  // 2. Find Software List DAT (tipo=dat_sl)
  const slRegex = /href="(https:\/\/www\.progettosnaps\.net\/download\/\?tipo=dat_sl&amp;file=[^"]+SL_Dats_(\d+)\.zip)"/g;
  let highestSl = -1;
  let slUrl = null;

  while ((match = slRegex.exec(html)) !== null) {
    const versionNum = parseInt(match[2], 10);
    if (versionNum > highestSl) {
      highestSl = versionNum;
      slUrl = match[1].replace(/&amp;/g, '&');
    }
  }

  const currentVersions = readVersions(versionsPath);
  const storedArcade = currentVersions.mame?.arcade;
  const storedSl = currentVersions.mame?.sl;

  const newArcade = highestArcade.toString();
  const newSl = highestSl.toString();

  const paths = [];

  if (arcadeUrl && storedArcade !== newArcade) {
    console.log(`[mame] New Arcade version: ${newArcade}`);
    const dest = path.join(outputDir, `MAME_Dats_${newArcade}.7z`);
    await downloadFile(arcadeUrl, dest);
    paths.push(dest);
  }

  if (slUrl && storedSl !== newSl) {
    console.log(`[mame] New Software List version: ${newSl}`);
    const dest = path.join(outputDir, `SL_Dats_${newSl}.zip`);
    await downloadFile(slUrl, dest);
    paths.push(dest);
  }

  if (paths.length === 0) {
    console.log('SKIP');
    writeVersions(versionsPath, currentVersions, {
      ...currentVersions.mame,
      lastChecked: new Date().toISOString(),
    });
    return null;
  }

  writeVersions(versionsPath, currentVersions, {
    arcade: newArcade,
    sl: newSl,
    lastChecked: new Date().toISOString(),
  });

  return paths;
}

// --- CLI Entry Point ---
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  const outputDir = process.argv[2] || path.join(process.cwd(), 'dats', 'mame');
  const versionsPath = process.argv[3] || path.join(process.cwd(), 'versions.json');
  
  fetchMame(outputDir, versionsPath)
    .then((zipPaths) => {
      if (zipPaths) {
        console.log(`[mame] Done. Downloaded: ${zipPaths.join(', ')}`);
      }
    })
    .catch((err) => {
      console.error(`[mame] Failed: ${err.message}`);
      process.exit(1);
    });
}
