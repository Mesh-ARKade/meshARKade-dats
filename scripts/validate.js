import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { validateXml, checkExtension, checkSortPlacement } from './lib/validators.js';

/**
 * Validates a single DAT file — extension check then XML parse.
 * @intent Validate one file and return any error string, or null on success.
 * @param {string} file - Filename only
 * @param {string} filePath - Full path to the file
 * @returns {Promise<string|null>}
 */
async function validateFile(file, filePath) {
  const extCheck = checkExtension(file);
  if (!extCheck.valid) return extCheck.error;

  try {
    const content = await readFile(filePath, 'utf-8');
    const xmlCheck = validateXml(content);
    if (!xmlCheck.valid) return `File ${file}: ${xmlCheck.error}`;
  } catch (err) {
    return `File ${file}: ${err.message}`;
  }

  return null;
}

/**
 * Validates all DAT files in a directory in parallel.
 * @intent Walk each known source subdir, validate all files concurrently.
 * @param {string} dirPath - Directory containing source subdirs (no-intro, redump, tosec, mame)
 * @returns {Promise<{valid: boolean, errors: string[]}>}
 */
export async function validate(dirPath) {
  const subdirs = ['no-intro', 'redump', 'tosec', 'mame'];

  const tasks = (
    await Promise.all(
      subdirs.map(async (source) => {
        const sourceDir = join(dirPath, source);
        if (!existsSync(sourceDir)) return [];
        const files = await readdir(sourceDir);
        return files.map((file) => validateFile(file, join(sourceDir, file)));
      })
    )
  ).flat();

  const results = await Promise.all(tasks);
  const errors = results.filter(Boolean);

  const sortCheck = checkSortPlacement(dirPath);
  if (!sortCheck.valid) errors.push(sortCheck.error);

  return { valid: errors.length === 0, errors };
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let inputDir = process.cwd();
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputDir = args[i + 1];
      break;
    }
  }
  
  validate(inputDir).then(result => {
    if (!result.valid) {
      result.errors.forEach(err => console.error(err));
      process.exit(1);
    }
    console.log('Validation passed');
    process.exit(0);
  }).catch(err => {
    console.error(`Validation failed: ${err.message}`);
    process.exit(1);
  });
}
