import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';

describe('extract script', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts zip to correct /output/{source}/ directory', async () => {
    const { extract } = await import('../scripts/extract.js');
    const zipPath = join(tempDir, 'test-no-intro.zip');
    
    const zip = new AdmZip();
    zip.addFile('game.dat', Buffer.from('<?xml version="1.0"?><data></data>'));
    zip.writeZip(zipPath);

    const result = await extract(zipPath, tempDir);
    
    expect(result.source).toBe('no-intro');
    expect(existsSync(join(tempDir, 'output', 'no-intro', 'game.dat'))).toBe(true);
  });

  it('throws error for unknown archive format', async () => {
    const { extract } = await import('../scripts/extract.js');
    const unknownPath = join(tempDir, 'test.unknown');
    writeFileSync(unknownPath, Buffer.from('unknown'));

    await expect(extract(unknownPath, tempDir)).rejects.toThrow('Unknown archive format');
  });

  it('creates output directory if missing', async () => {
    const { extract } = await import('../scripts/extract.js');
    const zipPath = join(tempDir, 'test-no-intro.zip');
    
    const zip = new AdmZip();
    zip.addFile('game.dat', Buffer.from('<?xml version="1.0"?><data></data>'));
    zip.writeZip(zipPath);

    const noOutputDir = join(tempDir, 'no-output');
    await extract(zipPath, noOutputDir);

    expect(existsSync(join(noOutputDir, 'output'))).toBe(true);
  });
});
