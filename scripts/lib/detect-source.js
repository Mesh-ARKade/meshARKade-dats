/**
 * Detects the source name from an archive filename or path.
 * @param {string} archivePath - The full path or filename of the archive
 * @returns {string} The source name (e.g., 'no-intro', 'redump', 'tosec', 'mame')
 */
export function detectSource(archivePath) {
  const basename = archivePath.split(/[\\/]/).pop().toLowerCase();
  
  if (basename.includes('no-intro') || basename.includes('nointro')) {
    return 'no-intro';
  }
  if (basename.includes('redump')) {
    return 'redump';
  }
  if (basename.includes('tosec')) {
    return 'tosec';
  }
  if (basename.includes('mame') || basename.includes('sl_dats')) {
    return 'mame';
  }
  
  throw new Error(`Unknown source: cannot detect source from '${archivePath}'`);
}
