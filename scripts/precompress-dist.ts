#!/usr/bin/env bun
/**
 * Pre-compresses eligible static assets into .gz siblings, for servers that
 * support gzip_static (see Dockerfile.static's nginx config). The original
 * uncompressed file is kept untouched — this only adds a sibling file, so
 * non-Docker consumers of dist/static (release ZIP, Electron packaging) are
 * unaffected.
 *
 * Runs once at build time rather than negotiated on the fly per-request, so
 * every request gets the compressed bytes with zero runtime CPU cost.
 *
 * Usage: bun scripts/precompress-dist.ts <dir>
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.html', '.svg', '.xml', '.txt']);

/** Skip files too small for an extra copy to be worth it. */
const MIN_SIZE_BYTES = 1024;

export function isPrecompressible(fileName: string): boolean {
    // Already compressed (e.g. the lomloe/digcompedu .json.gz datasets) — skip.
    if (fileName.endsWith('.gz') || fileName.endsWith('.br') || fileName.endsWith('.zst')) {
        return false;
    }
    return COMPRESSIBLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export function gzipStatic(data: Buffer): Buffer {
    return zlib.gzipSync(data, { level: zlib.constants.Z_BEST_COMPRESSION });
}

export type PrecompressStats = {
    count: number;
    origTotal: number;
    gzTotal: number;
};

function walkDir(dir: string, onFile: (absPath: string) => void): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkDir(abs, onFile);
        } else {
            onFile(abs);
        }
    }
}

export function precompressDir(targetDir: string): PrecompressStats {
    const stats: PrecompressStats = { count: 0, origTotal: 0, gzTotal: 0 };

    walkDir(targetDir, (absPath) => {
        const fileName = path.basename(absPath);
        if (!isPrecompressible(fileName)) return;
        const data = fs.readFileSync(absPath);
        if (data.length < MIN_SIZE_BYTES) return;

        const gz = gzipStatic(data);
        fs.writeFileSync(absPath + '.gz', gz);

        stats.count += 1;
        stats.origTotal += data.length;
        stats.gzTotal += gz.length;
    });

    return stats;
}

function main() {
    const targetDir = process.argv[2];
    if (!targetDir || !fs.existsSync(targetDir)) {
        console.error('Usage: bun scripts/precompress-dist.ts <dir>');
        process.exit(1);
    }

    const stats = precompressDir(targetDir);
    const pct = stats.origTotal > 0 ? Math.round((1 - stats.gzTotal / stats.origTotal) * 100) : 0;

    console.log(`Pre-compressed ${stats.count} file(s) in ${targetDir} with gzip:`);
    console.log(`  original: ${(stats.origTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  gzip:     ${(stats.gzTotal / 1024 / 1024).toFixed(2)} MB (-${pct}%)`);
}

if (import.meta.main) {
    main();
}
