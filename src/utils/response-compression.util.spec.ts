import * as zlib from 'zlib';
import {
    acceptsGzip,
    isCompressibleContentType,
    serializeResponseValue,
    compressResponseValue,
    compressResponse,
} from './response-compression.util';

describe('acceptsGzip', () => {
    it('returns false when the header is missing', () => {
        expect(acceptsGzip(null)).toBe(false);
    });

    it('returns true when gzip is listed', () => {
        expect(acceptsGzip('gzip, deflate, br')).toBe(true);
    });

    it('returns true for a wildcard', () => {
        expect(acceptsGzip('*')).toBe(true);
    });

    it('returns false when gzip is explicitly disabled with q=0', () => {
        expect(acceptsGzip('gzip;q=0, deflate')).toBe(false);
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

    it('returns undefined for an undefined response value', () => {
        expect(serializeResponseValue(undefined)).toBeUndefined();
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

    it('does not compress a value already below the size threshold', () => {
        expect(compressResponseValue({ ok: true }, 'gzip')).toBeUndefined();
    });

    it('leaves an explicit Response untouched — that path goes through compressResponse instead', () => {
        const original = new Response('binary-ish content', { status: 206 });
        expect(compressResponseValue(original, 'gzip')).toBeUndefined();
    });
});

describe('isCompressibleContentType', () => {
    it('accepts text-based types, ignoring the charset parameter', () => {
        expect(isCompressibleContentType('text/html; charset=utf-8')).toBe(true);
        expect(isCompressibleContentType('application/json')).toBe(true);
    });

    it('rejects binary/missing content types', () => {
        expect(isCompressibleContentType('application/zip')).toBe(false);
        expect(isCompressibleContentType('application/octet-stream')).toBe(false);
        expect(isCompressibleContentType(null)).toBe(false);
    });
});

describe('compressResponse', () => {
    const bigHtml = `<html><body>${'x'.repeat(2000)}</body></html>`;

    it('compresses a large HTML Response when the client accepts gzip', async () => {
        const original = new Response(bigHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Custom': 'kept' },
        });

        const compressed = await compressResponse(original, 'gzip, deflate, br');

        expect(compressed).toBeInstanceOf(Response);
        expect(compressed?.status).toBe(200);
        expect(compressed?.headers.get('Content-Encoding')).toBe('gzip');
        expect(compressed?.headers.get('Vary')).toBe('Accept-Encoding');
        expect(compressed?.headers.get('X-Custom')).toBe('kept');

        const decompressed = zlib.gunzipSync(new Uint8Array(await compressed!.arrayBuffer())).toString('utf-8');
        expect(decompressed).toBe(bigHtml);
    });

    it('does not compress when the client has no gzip support', async () => {
        const original = new Response(bigHtml, { headers: { 'Content-Type': 'text/html' } });
        expect(await compressResponse(original, 'br')).toBeUndefined();
    });

    it('does not touch a response that is already Content-Encoding-tagged', async () => {
        const original = new Response(bigHtml, {
            headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'br' },
        });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('does not touch binary downloads (ZIP/EPUB/octet-stream exports)', async () => {
        const original = new Response(new Uint8Array(2000), { headers: { 'Content-Type': 'application/zip' } });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('does not compress a redirect (no content-type at all)', async () => {
        const original = new Response(null, { status: 302, headers: { Location: '/workarea' } });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
    });

    it('skips via Content-Length without reading the body when already known to be too small', async () => {
        const original = new Response('tiny', {
            headers: { 'Content-Type': 'text/html', 'Content-Length': '4' },
        });
        expect(await compressResponse(original, 'gzip')).toBeUndefined();
        // Body must still be readable — compressResponse must not have consumed it.
        expect(await original.text()).toBe('tiny');
    });

    it('preserves body/status/headers for a compressible response that turns out too small (no Content-Length hint)', async () => {
        // Regression test: once the body is read to measure it, this must
        // NEVER return undefined — the stream is already consumed, so
        // falling back to "use the original response" would send an empty
        // body even though the original had real content and a 302 status.
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
