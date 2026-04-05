import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

describe('validate script', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'validate-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('valid DAT passes', async () => {
    const { validate } = await import('../scripts/validate.js');
    const noIntroDir = join(tempDir, 'no-intro');
    mkdirSync(noIntroDir, { recursive: true });
    const validDat = join(noIntroDir, 'valid-no-intro.dat');
    writeFileSync(validDat, `<?xml version="1.0"?>
<datafile>
  <game name="game1"><description>Game 1</description><rom name="game.nes" size="40976"/></game>
</datafile>`);

    const result = await validate(tempDir);
    expect(result.valid).toBe(true);
  });

  it('malformed XML fails with error', async () => {
    const { validate } = await import('../scripts/validate.js');
    const noIntroDir = join(tempDir, 'no-intro');
    mkdirSync(noIntroDir, { recursive: true });
    const malformedDat = join(noIntroDir, 'malformed.dat');
    writeFileSync(malformedDat, `<?xml version="1.0"?>
<datafile><game><description>Broken</description></game><unclosed>`);

    const result = await validate(tempDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('XML'))).toBe(true);
  });

  it('non-.dat extension fails', async () => {
    const { validate } = await import('../scripts/validate.js');
    const noIntroDir = join(tempDir, 'no-intro');
    mkdirSync(noIntroDir, { recursive: true });
    const wrongExt = join(noIntroDir, 'wrong.txt');
    writeFileSync(wrongExt, 'not a dat');

    const result = await validate(tempDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('.dat'))).toBe(true);
  });

  it('file in root /output/ fails sort check', async () => {
    const { validate } = await import('../scripts/validate.js');
    const outputDir = join(tempDir, 'output');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'loose-file.dat'), '<?xml?><datafile></datafile>');

    const result = await validate(tempDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('root'))).toBe(true);
  });

  it('direct invocation via CLI works', (done) => {
    const cli = spawn('node', ['scripts/validate.js', '--input', join(tempDir, 'fixtures')], {
      cwd: join(tempDir, '..'),
      shell: true
    });
    
    cli.on('close', (code) => {
      expect(code).toBe(0);
      done();
    });
  });
});
