import { detectSource } from './detect-source.js';

const archivePath = process.argv[2];
if (!archivePath) {
  console.error('Usage: node detect-source-cli.js <archive-path>');
  process.exit(1);
}

try {
  console.log(detectSource(archivePath));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
