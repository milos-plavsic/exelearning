/**
 * gzip compression for Elysia's mapResponse hook (src/index.ts).
 *
 * Handles two shapes a route handler can return:
 *  - A plain value (object/string) Elysia would otherwise auto-serialize to
 *    JSON/text (compressResponseValue).
 *  - An explicit Response — used throughout src/routes/pages.ts to set a
 *    custom Content-Type on rendered HTML (compressResponse). Only bodies
 *    whose Content-Type is in COMPRESSIBLE_TYPES are read and recompressed;
 *    binary downloads (ZIP/EPUB/octet-stream exports) and anything already
 *    Content-Encoding'd are left untouched so they're never buffered.
 */
import * as zlib from 'zlib';

const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE_TYPES = [
    'application/json',
    'text/html',
    'text/plain',
    'text/css',
    'text/xml',
    'application/xml',
    'application/javascript',
    'image/svg+xml',
];

const encoder = new TextEncoder();

/** Accept-Encoding is a comma-separated list of tokens, each optionally with a ";q=" weight. */
export function acceptsGzip(acceptEncodingHeader: string | null): boolean {
    if (!acceptEncodingHeader) return false;
    return acceptEncodingHeader.split(',').some(token => {
        const [name, ...params] = token.trim().split(';');
        if (name !== 'gzip' && name !== '*') return false;
        const q = params.find(p => p.trim().startsWith('q='));
        return q === undefined || Number.parseFloat(q.split('=')[1]) > 0;
    });
}

export function isCompressibleContentType(contentType: string | null): boolean {
    if (!contentType) return false;
    const type = contentType.split(';')[0].trim().toLowerCase();
    return COMPRESSIBLE_TYPES.includes(type);
}

/** Elysia's `set.headers` is a plain object handlers write to as either 'Content-Type' or 'content-type'. */
export function getHeaderCaseInsensitive(headers: Record<string, unknown> | undefined, name: string): string | null {
    if (!headers) return null;
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
            const value = headers[key];
            return typeof value === 'string' ? value : null;
        }
    }
    return null;
}

export type SerializedResponseValue = {
    bytes: Uint8Array;
    contentType: string;
};

/**
 * Mirrors Elysia's own default serialization for values it turns into a
 * Response. Returns undefined for raw bytes (Buffer/Uint8Array) — those are
 * handled directly in compressResponseValue instead, since JSON.stringify-ing
 * a Buffer would corrupt it (route handlers like the CodeMagic/exemindmap
 * editor handlers in src/index.ts return one directly, with their own
 * Content-Type set via set.headers).
 */
export function serializeResponseValue(responseValue: unknown): SerializedResponseValue | undefined {
    if (responseValue === undefined || responseValue instanceof Uint8Array) return undefined;
    const isJson = typeof responseValue === 'object' && responseValue !== null;
    const text = isJson ? JSON.stringify(responseValue) : String(responseValue);
    return {
        bytes: encoder.encode(text),
        contentType: isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    };
}

/**
 * Builds a gzip-compressed Response for a plain (non-Response) route return
 * value, or returns undefined when compression shouldn't apply. `setHeaders`
 * is Elysia's `set.headers` — the only place a Content-Type is available
 * when responseValue is raw bytes rather than a JSON-serializable value.
 */
export function compressResponseValue(
    responseValue: unknown,
    acceptEncodingHeader: string | null,
    setHeaders?: Record<string, unknown>,
): Response | undefined {
    if (responseValue instanceof Response) return undefined;
    if (!acceptsGzip(acceptEncodingHeader)) return undefined;

    if (responseValue instanceof Uint8Array) {
        const contentType = getHeaderCaseInsensitive(setHeaders, 'content-type');
        if (!isCompressibleContentType(contentType)) return undefined;
        if (responseValue.length < MIN_COMPRESS_BYTES) return undefined;

        return new Response(zlib.gzipSync(responseValue), {
            headers: { 'Content-Type': contentType as string, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' },
        });
    }

    const serialized = serializeResponseValue(responseValue);
    if (!serialized || serialized.bytes.length < MIN_COMPRESS_BYTES) return undefined;

    return new Response(zlib.gzipSync(serialized.bytes), {
        headers: {
            'Content-Type': serialized.contentType,
            'Content-Encoding': 'gzip',
            'Vary': 'Accept-Encoding',
        },
    });
}

/**
 * Re-wraps an explicit Response with a gzip-compressed body, preserving its
 * status and headers, or returns undefined when compression shouldn't apply
 * (already encoded, non-compressible content-type, or the client doesn't
 * accept gzip) — checked before the body is read, so redirects/binary/
 * streamed responses are left completely untouched.
 *
 * Once the body IS read to measure it, this never returns undefined anymore
 * — a Response's body stream can only be consumed once, so falling back to
 * "let the caller use the original response" at that point would silently
 * send an empty body. Below the size threshold, it returns an equivalent
 * uncompressed Response reconstructed from the bytes already read instead.
 */
export async function compressResponse(
    response: Response,
    acceptEncodingHeader: string | null,
): Promise<Response | undefined> {
    if (response.headers.get('content-encoding')) return undefined;
    if (!isCompressibleContentType(response.headers.get('content-type'))) return undefined;
    if (!acceptsGzip(acceptEncodingHeader)) return undefined;

    // Fast path: skip without touching the body when its declared length
    // already rules out compression being worth it.
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > 0 && declaredLength < MIN_COMPRESS_BYTES) return undefined;

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length < MIN_COMPRESS_BYTES) {
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-encoding', 'gzip');
    headers.set('vary', 'Accept-Encoding');

    return new Response(zlib.gzipSync(body), { status: response.status, statusText: response.statusText, headers });
}
