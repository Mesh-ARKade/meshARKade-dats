import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, rmSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { detectSource } from './lib/detect-source.js';
import { extract } from './extract.js';
import { pathToFileURL } from 'url';

/**
 * Recursively find all files in a directory.
 */
function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!existsSync(dirPath)) return arrayOfFiles;
  const files = readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = join(dirPath, file);
    if (statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

/**
 * Validates a file's extension and XML content.
 */
async function validateFile(filePath) {
  const fileLower = filePath.toLowerCase();
  
  // 1. Extension check (.dat)
  if (!fileLower.endsWith('.dat')) {
    return { valid: false, skip: true }; // Just skip non-dat files without error (like readmes)
  }

  // 2. XML check (well-formed XML only)
  try {
    const content = await readFile(filePath, 'utf-8');
    const result = XMLValidator.validate(content);
    if (result !== true) {
      return { valid: false, error: `XML parse error in file '${filePath}': ${result.err?.msg || 'invalid xml'}` };
    }
  } catch (err) {
    return { valid: false, error: `Error reading file '${filePath}': ${err.message}` };
  }

  return { valid: true };
}

/**
 * Main logical processor:
 * - Extracts zips in dats/ subdirs
 * - RECURSIVELY walks and validates .dat files
 * - Moves validated files to output/{source}/
 * - Cleans up source sub-directories
 */
async function processAll() {
  const baseDir = process.cwd();
  const datsDir = join(baseDir, 'dats');
  const outputBase = join(baseDir, 'output');
  const sources = ['no-intro', 'tosec', 'redump', 'mame'];

  if (!existsSync(datsDir)) {
    console.error(`Error: 'dats/' directory not found in ${baseDir}`);
    process.exit(1);
  }

  const overallResults = { success: 0, skipped: 0, failed: 0 };

  for (const sourceName of sources) {
    const sourceDir = join(datsDir, sourceName);
    if (!existsSync(sourceDir)) continue;

    console.log(`\n🔍 Source folder: ${sourceName}...`);

    // 1. Check for ANY remaining zips/archives first
    const items = readdirSync(sourceDir);
    const archives = items.filter(f => f.match(/\.(zip|7z|rar)$/i));

    for (const archive of archives) {
      const archivePath = join(sourceDir, archive);
      console.log(`   📦 Extracting ${archive}...`);
      try {
        await extract(archivePath); 
        unlinkSync(archivePath); // Clean up zip immediately after extraction
      } catch (err) {
        console.error(`   ❌ Failed extraction for ${archive}: ${err.message}`);
      }
    }

    // 2. RECURSIVELY finds all files (including inside extracted folders)
    const allExtractedFiles = getAllFiles(sourceDir);
    
    if (allExtractedFiles.length === 0) {
      console.log(`   (No files found to process in ${sourceName})`);
      continue;
    }

    // Parallelize file validation and moving
    console.log(`   ⚙️  Processing ${allExtractedFiles.length} candidate files in parallel...`);
    const fileTasks = allExtractedFiles.map(async (filePath) => {
      const fileName = filePath.split(/[\\/]/).pop();
      const result = await validateFile(filePath);
      
      if (result.valid) {
        // 3. Move to target output/{source}/ (Flattening any extraction subdirs)
        const finalSubdir = join(outputBase, sourceName);
        if (!existsSync(finalSubdir)) mkdirSync(finalSubdir, { recursive: true });

        const finalPath = join(finalSubdir, fileName);
        renameSync(filePath, finalPath);
        return { type: 'success' };
      } else if (result.skip) {
        return { type: 'skipped' };
      } else {
        console.log(`   🧪 [FAIL] ${fileName}: ${result.error}`);
        return { type: 'failed' };
      }
    });

    const taskResults = await Promise.all(fileTasks);
    taskResults.forEach(res => {
      if (res.type === 'success') overallResults.success++;
      if (res.type === 'skipped') overallResults.skipped++;
      if (res.type === 'failed') overallResults.failed++;
    });

    // 4. CLEANUP SOURCE SUBDIR: Remove all remaining subdirs/files in dats/{source}
    // (Only empty folders or leftover readmes should be left)
    const leftovers = readdirSync(sourceDir);
    for (const item of leftovers) {
      const itemPath = join(sourceDir, item);
      rmSync(itemPath, { recursive: true, force: true });
    }
  }

  console.log(`\n🏁 Done! Results:`);
  console.log(`   ✅ Success: ${overallResults.success}`);
  console.log(`   ⏩ Skipped: ${overallResults.skipped} (non-dat)`);
  console.log(`   ❌ Failed:  ${overallResults.failed}`);
  
  if (overallResults.failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  processAll().catch(err => {
    console.error(`Fatal Error: ${err.stack || err.message}`);
    process.exit(1);
  });
}
