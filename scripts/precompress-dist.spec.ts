import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { isPrecompressible, gzipStatic, brotliStatic, zstdStatic, precompressDir } from './precompress-dist';

describe('isPrecompressible', () => {
    it('accepts compressible text-based extensions', () => {
        expect(isPrecompressible('app.bundle.js')).toBe(true);
        expect(isPrecompressible('main.css')).toBe(true);
        expect(isPrecompressible('bundle.json')).toBe(true);
        expect(isPrecompressible('index.html')).toBe(true);
        expect(isPrecompressible('icon.svg')).toBe(true);
    });

    it('rejects already-compressed extensions', () => {
        expect(isPrecompressible('lomloe-1.json.gz')).toBe(false);
        expect(isPrecompressible('bundle.json.br')).toBe(false);
        expect(isPrecompressible('bundle.json.zst')).toBe(false);
    });

    it('rejects binary/non-compressible extensions', () => {
        expect(isPrecompressible('logo.png')).toBe(false);
        expect(isPrecompressible('font.woff2')).toBe(false);
        expect(isPrecompressible('content-css.zip')).toBe(false);
    });
});

describe('gzipStatic / brotliStatic / zstdStatic', () => {
    const sample = Buffer.from('x'.repeat(5000), 'utf-8');

    it('gzipStatic round-trips and shrinks repetitive data', () => {
        const compressed = gzipStatic(sample);
        expect(compressed.length).toBeLessThan(sample.length);
        expect(zlib.gunzipSync(compressed)).toEqual(sample);
    });

    it('brotliStatic round-trips and shrinks repetitive data', () => {
        const compressed = brotliStatic(sample);
        expect(compressed.length).toBeLessThan(sample.length);
        expect(zlib.brotliDecompressSync(compressed)).toEqual(sample);
    });

    it('zstdStatic round-trips and shrinks repetitive data', () => {
        const compressed = zstdStatic(sample);
        expect(compressed.length).toBeLessThan(sample.length);
        expect(zlib.zstdDecompressSync(compressed)).toEqual(sample);
    });
});

describe('precompressDir', () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates .gz/.br/.zst siblings only for eligible, large-enough files', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompress-test-'));
        const bigJs = 'console.log("x");'.repeat(200); // > 1KB
        fs.writeFileSync(path.join(tmpDir, 'app.js'), bigJs);
        fs.writeFileSync(path.join(tmpDir, 'tiny.css'), 'a{}'); // < 1KB, skipped
        fs.writeFileSync(path.join(tmpDir, 'logo.png'), Buffer.alloc(5000)); // binary, skipped
        fs.mkdirSync(path.join(tmpDir, 'nested'));
        fs.writeFileSync(path.join(tmpDir, 'nested', 'data.json'), JSON.stringify({ a: bigJs }));

        const stats = precompressDir(tmpDir);

        expect(stats.count).toBe(2);
        expect(fs.existsSync(path.join(tmpDir, 'app.js.gz'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'app.js.br'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'app.js.zst'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'nested', 'data.json.gz'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'tiny.css.gz'))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, 'logo.png.gz'))).toBe(false);

        // Original files are untouched
        expect(fs.readFileSync(path.join(tmpDir, 'app.js'), 'utf-8')).toBe(bigJs);

        // Compressed siblings decompress back to the original bytes
        const gz = fs.readFileSync(path.join(tmpDir, 'app.js.gz'));
        expect(zlib.gunzipSync(gz).toString('utf-8')).toBe(bigJs);
    });

    it('does not re-compress already-compressed files', () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompress-test-'));
        fs.writeFileSync(path.join(tmpDir, 'dataset.json.gz'), Buffer.alloc(2000));

        const stats = precompressDir(tmpDir);

        expect(stats.count).toBe(0);
        expect(fs.existsSync(path.join(tmpDir, 'dataset.json.gz.gz'))).toBe(false);
    });
});
