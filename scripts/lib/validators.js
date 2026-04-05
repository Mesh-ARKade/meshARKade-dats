import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { XMLValidator } from 'fast-xml-parser';

/**
 * Validates XML content.
 * @param {string} content - The XML content to validate
 * @returns {{valid: boolean, error?: string}}
 */
export function validateXml(content) {
  const result = XMLValidator.validate(content);
  
  if (result === true) {
    return { valid: true };
  }
  
  return { valid: false, error: `XML parse error: ${result.err.msg}` };
}

/**
 * Checks if the file has a .dat extension.
 * @param {string} filePath - The file path to check
 * @returns {{valid: boolean, error?: string}}
 */
export function checkExtension(filePath) {
  if (!filePath.toLowerCase().endsWith('.dat')) {
    return { valid: false, error: `File ${filePath} does not have .dat extension` };
  }
  return { valid: true };
}

/**
 * Checks if files are in source subdirectories, not root output/.
 * @param {string} dirPath - The directory to check
 * @returns {{valid: boolean, error?: string}}
 */
export function checkSortPlacement(dirPath) {
  const outputDir = join(dirPath, 'output');
  
  if (!existsSync(outputDir)) {
    return { valid: true };
  }
  
  const files = readdirSync(outputDir);
  const datFiles = files.filter(f => f.toLowerCase().endsWith('.dat'));
  
  if (datFiles.length > 0) {
    return { valid: false, error: `DAT files found in root output/ directory: ${datFiles.join(', ')}` };
  }
  
  return { valid: true };
}
