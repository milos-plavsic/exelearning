import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    acceptsGzip,
    isCompressibleContentType,
    getHeaderCaseInsensitive,
    deleteHeaderCaseInsensitive,
    mergeVaryHeader,
    serializeResponseValue,
    compressResponseValue,
    compressResponse,
    isAsyncIterable,
} from './response-compression.util';

function createCompressionApp() {
    return new Elysia()
        .mapResponse(async ({ request, responseValue, set }) => {
            if (isAsyncIterable(responseValue)) return undefined;

            const acceptEncoding = request.headers.get('accept-encoding');

            if (responseValue instanceof Response) {
                return (await compressResponse(responseValue, acceptEncoding)) ?? responseValue;
            }

            const compressed = compressResponseValue(responseValue, acceptEncoding, set.headers);
            if (compressed) return compressed;

            const status = set.status as number;
            if (responseValue instanceof Uint8Array) return new Response(responseValue, { status });
            if (responseValue === undefined) return new Response(null, { status });
            if (typeof responseValue === 'object' && responseValue !== null) {
                return Response.json(responseValue, { status });
            }
            return new Response(String(responseValue), {
                status,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
        })
        .use(
            cors({
                origin: true,
                credentials: true,
            }),
        );
}

describe('acceptsGzip', () => {
    it('returns false when the header is missing', () => {
        expect(acceptsGzip(null)).toBe(false);
    });

    it('returns true when gzip is listed', () => {
        expect(acceptsGzip('gzip, deflate, br')).toBe(true);
    });

    it('matches content codings case-insensitively', () => {
        expect(acceptsGzip('GZip')).toBe(true);
    });

    it('returns true for a wildcard when gzip is not listed explicitly', () => {
        expect(acceptsGzip('*')).toBe(true);
    });

    it('returns false when gzip is explicitly disabled with q=0', () => {
        expect(acceptsGzip('gzip;q=0, deflate')).toBe(false);
    });

    it('lets an explicit gzip q=0 override a wildcard', () => {
        expect(acceptsGzip('gzip;q=0, *;q=1')).toBe(false);
    });

    it('returns false for an invalid quality value', () => {
        expect(acceptsGzip('gzip;q=invalid')).toBe(false);
    });

    it('returns false when gzip is not listed', () => {
        expect(acceptsGzip('br, deflate')).toBe(false);
    });
});

describe('serializeResponseValue', () => {
    it('JSON-stringifies plain objects', () => {
        const result = serializeResponseValue({ a: 1 });
        expect(result?.contentType).toBe('application/json; charset=utf-8');
        expect(new TextDecoder().decode(result?.bytes)).toBe('{"a":1}');
    });

    it('stringifies primitives as plain text', () => {
        const result = serializeResponseValue('hello');
        expect(result?.contentType).toBe('text/plain; charset=utf-8');
        expect(new TextDecoder().decode(result?.bytes)).toBe('hello');
    });

    it('returns undefined for null and undefined response values', () => {
        expect(serializeResponseValue(null)).toBeUndefined();
        expect(serializeResponseValue(undefined)).toBeUndefined();
    });

    it('returns undefined for raw bytes and body-specific objects', () => {
        expect(serializeResponseValue(Buffer.from('<html>hi</html>'))).toBeUndefined();
        expect(serializeResponseValue(new Uint8Array([1, 2, 3]))).toBeUndefined();
        expect(serializeResponseValue(new Blob(['content']))).toBeUndefined();
        expect(serializeResponseValue(new Date())).toBeUndefined();
    });
});

describe('header helpers', () => {
    it('finds a header regardless of key casing', () => {
        expect(getHeaderCaseInsensitive({ 'Content-Type': 'text/html' }, 'content-type')).toBe('text/html');
        expect(getHeaderCaseInsensitive({ 'content-type': 'text/html' }, 'Content-Type')).toBe('text/html');
        expect(getHeaderCaseInsensitive(new Headers({ 'Content-Type': 'text/html' }), 'content-type')).toBe(
            'text/html',
        );
    });

    it('returns null when a header is missing', () => {
        expect(getHeaderCaseInsensitive({ 'X-Other': 'x' }, 'content-type')).toBeNull();
        expect(getHeaderCaseInsensitive(undefined, 'content-type')).toBeNull();
    });

    it('removes all casing variants of a header', () => {
        const headers: Record<string, unknown> = {
            'Content-Length': '100',
            'content-length': '200',
            'Content-Type': 'text/html',
        };

        deleteHeaderCaseInsensitive(headers, 'content-length');

        expect(getHeaderCaseInsensitive(headers, 'content-length')).toBeNull();
        expect(getHeaderCaseInsensitive(headers, 'content-type')).toBe('text/html');
    });

    it('merges Vary tokens without dropping existing dimensions', () => {
        expect(mergeVaryHeader('Origin', 'Accept-Encoding')).toBe('Origin, Accept-Encoding');
        expect(mergeVaryHeader('Origin, Accept-Encoding', 'accept-encoding')).toBe('Origin, Accept-Encoding');
        expect(mergeVaryHeader('*', 'Accept-Encoding')).toBe('*');
    });
});

describe('compressResponseValue', () => {
    const bigObject = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })) };

    it('compresses a large JSON-serializable value when the client accepts gzip', () => {
        const response = compressResponseValue(bigObject, 'gzip, deflate, br');
        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.get('Content-Encoding')).toBe('gzip');
        expect(response?.headers.get('Vary')).toBe('Accept-Encoding');
        expect(response?.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });

    it('produces a gzip body that decompresses back to the original JSON', async () => {
        const response = compressResponseValue(bigObject, 'gzip');
        const bytes = new Uint8Array(await response!.arrayBuffer());
        const decompressed = zlib.gunzipSync(bytes).toString('utf-8');
        expect(JSON.parse(decompressed)).toEqual(bigObject);
    });

    it('does not compress when the client has no gzip support', () => {
        expect(compressResponseValue(bigObject, 'br')).toBeUndefined();
        expect(compressResponseValue(bigObject, null)).toBeUndefined();
    });

    it('does not compress a value below the size threshold', () => {
        expect(compressResponseValue({ ok: true }, 'gzip')).toBeUndefined();
    });

    it('leaves an explicit Response to compressResponse', () => {
        const original = new Response('binary-ish content', { status: 206 });
        expect(compressResponseValue(original, 'gzip')).toBeUndefined();
    });

    it('preserves null as an empty response instead of serializing it as text', async () => {
        const response = compressResponseValue(null, null);
        expect(response).toBeInstanceOf(Response);
        expect(await response!.text()).toBe('');
    });

    it('preserves Blob/BunFile-style bodies instead of JSON-stringifying them', async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        const response = compressResponseValue(new Blob([bytes]), null, { 'Content-Type': 'application/zip' });

        expect(response?.headers.get('Content-Type')).toBe('application/zip');
        expect(response?.headers.get('Content-Length')).toBe(bytes.length.toString());
        expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
    });

    it('preserves ElysiaFile wrappers used by the static plugin', async () => {
        class ElysiaFile {
            public readonly value = new Blob(['static-content']);
            public readonly type = 'text/plain';
        }

        const response = compressResponseValue(new ElysiaFile(), null);

        expect(response?.headers.get('Content-Type')).toBe('text/plain');
        expect(await response!.text()).toBe('static-content');
    });

    it('keeps an explicit HTML content type for string responses', () => {
        const html = `<html><body>${'x'.repeat(2000)}</body></html>`;
        const response = compressResponseValue(html, 'gzip', { 'Content-Type': 'text/html; charset=utf-8' });

        expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(response?.headers.get('Content-Encoding')).toBe('gzip');
    });

    describe('raw bytes with Content-Type from set.headers', () => {
        const html = Buffer.from(`<html><body>${'x'.repeat(2000)}</body></html>`);

        it('compresses when Content-Type is compressible', () => {
            const response = compressResponseValue(html, 'gzip', { 'Content-Type': 'text/html; charset=utf-8' });
            expect(response).toBeInstanceOf(Response);
            expect(response?.headers.get('Content-Encoding')).toBe('gzip');
            expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        });

        it('produces a body that decompresses back to the exact original bytes', async () => {
            const response = compressResponseValue(html, 'gzip', { 'Content-Type': 'text/html' });
            const decompressed = zlib.gunzipSync(new Uint8Array(await response!.arrayBuffer()));
            expect(Buffer.compare(decompressed, html)).toBe(0);
        });

        it('removes a stale uncompressed Content-Length and declares the compressed length', async () => {
            const setHeaders: Record<string, unknown> = {
                'Content-Type': 'text/html',
                'Content-Length': html.length.toString(),
            };

            const response = compressResponseValue(html, 'gzip', setHeaders);
            const compressedLength = (await response!.arrayBuffer()).byteLength;

            expect(getHeaderCaseInsensitive(setHeaders, 'content-length')).toBeNull();
            expect(response?.headers.get('Content-Length')).toBe(compressedLength.toString());
        });

        it('combines Vary with existing cache dimensions', () => {
            const response = compressResponseValue(html, 'gzip', {
                'Content-Type': 'text/html',
                Vary: 'Origin',
            });

            expect(response?.headers.get('Vary')).toBe('Origin, Accept-Encoding');
        });

        it('preserves Vary: * from the CORS plugin', () => {
            const response = compressResponseValue(html, 'gzip', {
                'Content-Type': 'text/html',
                Vary: '*',
            });

            expect(response?.headers.get('Vary')).toBe('*');
        });

        it('does not compress without a compressible Content-Type', () => {
            expect(compressResponseValue(html, 'gzip', { 'Content-Type': 'application/octet-stream' })).toBeUndefined();
            expect(compressResponseValue(html, 'gzip', undefined)).toBeUndefined();
        });
    });
});

describe('isCompressibleContentType', () => {
    it('accepts text and structured JSON types', () => {
        expect(isCompressibleContentType('text/html; charset=utf-8')).toBe(true);
        expect(isCompressibleContentType('application/json')).toBe(true);
        expect(isCompressibleContentType('application/problem+json')).toBe(true);
    });

    it('rejects binary, streaming, and missing content types', () => {
        expect(isCompressibleContentType('application/zip')).toBe(false);
        expect(isCompressibleContentType('application/octet-stream')).toBe(false);
        expect(isCompressibleContentType('text/event-stream')).toBe(false);
        expect(isCompressibleContentType(null)).toBe(false);
    });
});

describe('compressResponse', () => {
    const bigHtml = `<html><body>${'x'.repeat(2000)}</body></html>`;

    it('compresses a large HTML Response and preserves its metadata', async () => {
        const original = new Response(bigHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Custom': 'kept' },
        });

        const compressed = await compressResponse(original, 'gzip, deflate, br');
        const compressedLength = (await compressed!.clone().arrayBuffer()).byteLength;

        expect(compressed).toBeInstanceOf(Response);
        expect(compressed?.status).toBe(200);
        expect(compressed?.headers.get('Content-Encoding')).toBe('gzip');
        expect(compressed?.headers.get('Content-Length')).toBe(compressedLength.toString());
        expect(compressed?.headers.get('Vary')).toBe('*');
        expect(compressed?.headers.get('X-Custom')).toBe('kept');

        const decompressed = zlib.gunzipSync(new Uint8Array(await compressed!.arrayBuffer())).toString('utf-8');
        expect(decompressed).toBe(bigHtml);
    });

    it('combines an existing Response Vary header with Accept-Encoding', async () => {
        const original = new Response(bigHtml, {
            headers: { 'Content-Type': 'text/html', Vary: 'Origin' },
        });

        const compressed = await compressResponse(original, 'gzip');

        expect(compressed?.headers.get('Vary')).toBe('Origin, Accept-Encoding');
    });

    it('does not compress when the client has no gzip support', async () => {
        const original = new Response(bigHtml, { headers: { 'Content-Type': 'text/html' } });
        expect(await compressResponse(original, 'br')).toBeUndefined();
    });

    it('does not touch a response that is already encoded', async () => {
        const original = new Response(bigHtml, {
            headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'br' },
        });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('does not touch binary downloads', async () => {
        const original = new Response(new Uint8Array(2000), { headers: { 'Content-Type': 'application/zip' } });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('does not compress a redirect without a content type', async () => {
        const original = new Response(null, { status: 302, headers: { Location: '/workarea' } });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('skips via Content-Length without consuming a known-small body', async () => {
        const original = new Response('tiny', {
            headers: { 'Content-Type': 'text/html', 'Content-Length': '4' },
        });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
        expect(await original.text()).toBe('tiny');
    });

    it('reconstructs a small body after reading it', async () => {
        const original = new Response('short html', {
            status: 302,
            headers: { 'Content-Type': 'text/html; charset=utf-8', Location: '/somewhere' },
        });

        const result = await compressResponse(original, 'gzip');

        expect(result).toBeInstanceOf(Response);
        expect(result?.status).toBe(302);
        expect(result?.headers.get('Location')).toBe('/somewhere');
        expect(result?.headers.get('Content-Encoding')).toBeNull();
        expect(await result!.text()).toBe('short html');
    });
});

describe('Elysia mapResponse integration', () => {
    let tmpDir: string | undefined;

    afterEach(() => {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
    });

    it('serves Bun.file bytes instead of serializing the BunFile object as JSON', async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'response-compression-'));
        const filePath = path.join(tmpDir, 'bundle.zip');
        const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
        fs.writeFileSync(filePath, zipBytes);

        const app = createCompressionApp().get('/bundle.zip', ({ set }) => {
            set.headers['Content-Type'] = 'application/zip';
            return Bun.file(filePath);
        });

        const response = await app.handle(new Request('http://localhost/bundle.zip'));

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toContain('application/zip');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(zipBytes);
    });

    it('keeps CORS Vary metadata on compressed explicit responses', async () => {
        const html = `<html><body>${'x'.repeat(2000)}</body></html>`;
        const app = createCompressionApp().get(
            '/page',
            () => new Response(html, { headers: { 'Content-Type': 'text/html' } }),
        );

        const response = await app.handle(
            new Request('http://localhost/page', {
                headers: {
                    Origin: 'https://example.com',
                    'Accept-Encoding': 'gzip',
                },
            }),
        );

        expect(response.headers.get('Content-Encoding')).toBe('gzip');
        expect(response.headers.get('Vary')).toBe('*');
    });

    it('does not expose the original Content-Length after compressing a Buffer route', async () => {
        const html = Buffer.from(`<html><body>${'x'.repeat(2000)}</body></html>`);
        const app = createCompressionApp().get('/buffer', ({ set }) => {
            set.headers['Content-Type'] = 'text/html';
            set.headers['Content-Length'] = html.length.toString();
            return html;
        });

        const response = await app.handle(
            new Request('http://localhost/buffer', {
                headers: { 'Accept-Encoding': 'gzip' },
            }),
        );
        const responseBytes = new Uint8Array(await response.arrayBuffer());

        expect(response.headers.get('Content-Encoding')).toBe('gzip');
        expect(response.headers.get('Content-Length')).toBe(responseBytes.length.toString());
        expect(zlib.gunzipSync(responseBytes)).toEqual(html);
    });
});
