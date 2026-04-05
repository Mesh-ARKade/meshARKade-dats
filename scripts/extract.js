import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import { detectSource } from './lib/detect-source.js';

/**
 * Extracts an archive to the output directory.
 * @param {string} archivePath - Path to the archive file
 * @param {string} baseDir - Base directory for extraction
 * @returns {Promise<{source: string, outputDir: string}>}
 */
export async function extract(archivePath, baseDir) {
  const ext = archivePath.toLowerCase().split('.').pop();
  
  if (ext !== 'zip' && ext !== '7z' && ext !== 'rar') {
    throw new Error(`Unknown archive format: .${ext}`);
  }
  
  const source = detectSource(archivePath);
  // If baseDir is provided, use it for output/source, otherwise use archive's parent
  const outputDir = baseDir ? join(baseDir, 'output', source) : archivePath.split(/[\\/]/).slice(0, -1).join('/');
  
  if (outputDir && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  if (ext === 'zip') {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(outputDir, true);
  } else if (ext === '7z' || ext === 'rar') {
    const sevenZipPath = '7z';
    execSync(`${sevenZipPath} x -y -o"${outputDir}" "${archivePath}"`, { stdio: 'ignore' });
  }
  
  return { source, outputDir };
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const archivePath = args[0] || process.cwd();
  const baseDir = args[1] || process.cwd();
  
  try {
    const result = await extract(archivePath, baseDir);
    console.log(`Extracted ${result.source} to ${result.outputDir}`);
    process.exit(0);
  } catch (err) {
    console.error(`Extraction failed: ${err.message}`);
    process.exit(1);
  }
}
