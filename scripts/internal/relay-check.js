import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, basename } from 'path';
import { extract } from '../extract.js';
import { checkExtension, validateXml } from '../lib/validators.js';

/**
 * Relay Check Script
 * Usage: node scripts/internal/relay-check.js <archive-path> <output-dir>
 * 
 * Performs:
 * 1. Extraction of the archive to a temporary staging area.
 * 2. Recursive validation of all extracted files (.dat suffix + XML).
 * 3. Copying of validated DATs to the final output directory.
 */

async function main() {
  const [archivePath, outputDir] = process.argv.slice(2);
  
  if (!archivePath || !outputDir) {
    console.error('Usage: node scripts/internal/relay-check.js <archive-path> <output-dir>');
    process.exit(1);
  }

  const stagingDir = resolve('staging_temp');
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  console.log(`📦 Extracting archive: ${archivePath}...`);
  await extract(resolve(archivePath), stagingDir);

  const validatedFiles = [];
  
  function walkSync(dir, callback) {
    readdirSync(dir).forEach(file => {
      const filePath = join(dir, file);
      if (statSync(filePath).isDirectory()) {
        walkSync(filePath, callback);
      } else {
        callback(filePath);
      }
    });
  }

  console.log(`🔍 Validating contents...`);
  walkSync(stagingDir, (filePath) => {
    const fileName = basename(filePath);
    
    // 1. Basic extension check
    const extRef = checkExtension(fileName);
    if (!extRef.valid) {
      console.log(`   ⏩ Skipping non-DAT: ${fileName}`);
      return;
    }

    // 2. XML validation
    try {
      const content = readFileSync(filePath, 'utf8');
      const xmlRef = validateXml(content);
      if (!xmlRef.valid) {
        console.error(`   ❌ [FAIL] XML validation failed for: ${fileName}`);
        process.exit(1);
      }
      
      console.log(`   ✅ [PASS] ${fileName}`);
      validatedFiles.push(filePath);
    } catch (err) {
      console.error(`   ❌ [ERROR] Could not read file: ${fileName}`, err);
      process.exit(1);
    }
  });

  if (validatedFiles.length === 0) {
    console.error('   ❌ [ERROR] No valid DAT files found in archive.');
    process.exit(1);
  }

  console.log(`➡️  Copying ${validatedFiles.length} files to final output...`);
  mkdirSync(resolve(outputDir), { recursive: true });
  for (const filePath of validatedFiles) {
    const fileName = basename(filePath);
    const destPath = join(resolve(outputDir), fileName);
    const content = readFileSync(filePath);
    writeFileSync(destPath, content);
  }

  console.log('✨ Relay check complete!');
}

main().catch(err => {
  console.error('Relay verification crashed:', err);
  process.exit(1);
});
