/**
 * gzip compression helpers for Elysia's mapResponse hook (src/index.ts).
 *
 * Plain JSON/text values and raw bytes can be compressed directly. Response
 * objects are handled separately so their status and headers are preserved.
 * Values that Elysia normally treats as body types (Blob/BunFile, FormData,
 * URLSearchParams, ArrayBuffer, streams, and custom objects) are converted to
 * a Response before the fallback serializer in src/index.ts can turn them into
 * JSON accidentally.
 */
import * as zlib from 'zlib';
import { promisify } from 'util';

/**
 * Asynchronous gzip. Compression runs on libuv's threadpool instead of the
 * synchronous `zlib.gzipSync`, so it does not block the single JS thread while
 * every eligible response is compressed. Output bytes are identical to
 * `gzipSync` for the same input (same default compression level).
 */
const gzipAsync = promisify(zlib.gzip);

const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE_TYPES = ['application/json', 'application/javascript', 'application/xml', 'image/svg+xml'];

const encoder = new TextEncoder();

type HeaderCollection = Headers | Record<string, unknown>;

/**
 * True for async generators / async iterables, such as SSE handlers.
 */
export function isAsyncIterable(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
}

function parseQuality(params: string[]): number {
    const qualityParam = params.find(param => param.trim().toLowerCase().startsWith('q='));
    if (!qualityParam) return 1;

    const quality = Number(qualityParam.split('=', 2)[1]);
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) return 0;

    return quality;
}

/**
 * Checks whether gzip is acceptable according to the request's
 * Accept-Encoding header. An explicit gzip entry takes precedence over `*`.
 */
export function acceptsGzip(acceptEncodingHeader: string | null): boolean {
    if (!acceptEncodingHeader) return false;

    let wildcardQuality: number | undefined;

    for (const token of acceptEncodingHeader.split(',')) {
        const [rawName, ...params] = token.trim().split(';');
        const name = rawName.trim().toLowerCase();
        const quality = parseQuality(params);

        if (name === 'gzip') return quality > 0;
        if (name === '*' && wildcardQuality === undefined) wildcardQuality = quality;
    }

    return (wildcardQuality ?? 0) > 0;
}

export function isCompressibleContentType(contentType: string | null): boolean {
    if (!contentType) return false;

    const type = contentType.split(';')[0].trim().toLowerCase();
    if (type === 'text/event-stream') return false;

    return (
        type.startsWith('text/') || COMPRESSIBLE_TYPES.includes(type) || type.endsWith('+json') || type.endsWith('+xml')
    );
}

/**
 * Reads a header from either Elysia's plain header object or a Headers object.
 */
export function getHeaderCaseInsensitive(headers: HeaderCollection | undefined, name: string): string | null {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);

    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== lower) continue;

        const value = headers[key];
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        if (Array.isArray(value)) return value.join(', ');
        return null;
    }

    return null;
}

/**
 * Removes every casing variant of a header from an Elysia header collection.
 */
export function deleteHeaderCaseInsensitive(headers: HeaderCollection | undefined, name: string): void {
    if (!headers) return;
    if (headers instanceof Headers) {
        headers.delete(name);
        return;
    }

    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) delete headers[key];
    }
}

/**
 * Adds a Vary token without dropping existing cache dimensions.
 */
export function mergeVaryHeader(existing: string | null, token: string): string {
    if (!existing) return token;

    const values = existing
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

    if (values.some(value => value === '*')) return '*';
    if (!values.some(value => value.toLowerCase() === token.toLowerCase())) values.push(token);

    return values.join(', ');
}

export type SerializedResponseValue = {
    bytes: Uint8Array;
    contentType: string;
};

function isPlainJsonValue(value: unknown): boolean {
    if (Array.isArray(value)) return true;
    if (typeof value !== 'object' || value === null) return false;

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Mirrors Elysia's default serialization for plain JSON values and primitives.
 * Body-specific and custom object types are handled separately.
 */
export function serializeResponseValue(responseValue: unknown): SerializedResponseValue | undefined {
    if (responseValue === undefined || responseValue === null || responseValue instanceof Uint8Array) return undefined;

    if (isPlainJsonValue(responseValue)) {
        return {
            bytes: encoder.encode(JSON.stringify(responseValue)),
            contentType: 'application/json; charset=utf-8',
        };
    }

    if (typeof responseValue === 'object') return undefined;

    return {
        bytes: encoder.encode(String(responseValue)),
        contentType: 'text/plain; charset=utf-8',
    };
}

function createPassThroughResponse(responseValue: unknown, setHeaders?: HeaderCollection): Response | undefined {
    if (responseValue === null) return new Response(null);

    const explicitContentType = getHeaderCaseInsensitive(setHeaders, 'content-type');

    if (responseValue instanceof Blob) {
        const headers = new Headers();
        const contentType = explicitContentType || responseValue.type;
        if (contentType) headers.set('content-type', contentType);
        headers.set('content-length', responseValue.size.toString());
        return new Response(responseValue, { headers });
    }

    if (typeof responseValue === 'object' && responseValue !== null) {
        const constructorName = responseValue.constructor?.name;
        const wrappedValue = (responseValue as { value?: unknown }).value;

        if (constructorName === 'ElysiaFile' && wrappedValue instanceof Blob) {
            const headers = new Headers();
            const contentType =
                explicitContentType ||
                (typeof (responseValue as { type?: unknown }).type === 'string'
                    ? ((responseValue as { type: string }).type as string)
                    : wrappedValue.type);
            if (contentType) headers.set('content-type', contentType);
            headers.set('content-length', wrappedValue.size.toString());
            return new Response(wrappedValue, { headers });
        }

        if (constructorName === 'Cookie' && wrappedValue !== undefined) {
            return new Response(String(wrappedValue));
        }
    }

    if (responseValue instanceof FormData || responseValue instanceof URLSearchParams) {
        return new Response(responseValue);
    }

    if (responseValue instanceof ArrayBuffer) return new Response(responseValue);

    if (ArrayBuffer.isView(responseValue) && !(responseValue instanceof Uint8Array)) {
        const bytes = new Uint8Array(responseValue.buffer, responseValue.byteOffset, responseValue.byteLength);
        return new Response(bytes);
    }

    if (responseValue instanceof ReadableStream) return new Response(responseValue);

    if (responseValue instanceof Error) {
        return Response.json({
            name: responseValue.name,
            message: responseValue.message,
            cause: responseValue.cause,
        });
    }

    if (
        typeof responseValue === 'object' &&
        responseValue !== null &&
        !(responseValue instanceof Uint8Array) &&
        !isPlainJsonValue(responseValue)
    ) {
        const toResponse = (responseValue as { toResponse?: () => unknown }).toResponse;
        if (typeof toResponse === 'function') {
            const result = toResponse.call(responseValue);
            if (result instanceof Response) return result;
        }

        return new Response(String(responseValue));
    }

    return undefined;
}

async function buildCompressedResponse(bytes: Uint8Array, contentType: string, vary: string): Promise<Response> {
    const compressed = await gzipAsync(bytes);

    return new Response(compressed, {
        headers: {
            'Content-Type': contentType,
            'Content-Encoding': 'gzip',
            'Content-Length': compressed.length.toString(),
            Vary: vary,
        },
    });
}

/**
 * Builds a gzip-compressed Response for a plain route return value. It also
 * preserves body-specific values that Elysia would otherwise serialize itself
 * before src/index.ts's explicit fallback runs.
 */
export async function compressResponseValue(
    responseValue: unknown,
    acceptEncodingHeader: string | null,
    setHeaders?: HeaderCollection,
): Promise<Response | undefined> {
    if (responseValue instanceof Response) return undefined;

    const passThroughResponse = createPassThroughResponse(responseValue, setHeaders);
    if (passThroughResponse) return passThroughResponse;

    if (responseValue instanceof Uint8Array) {
        const contentType = getHeaderCaseInsensitive(setHeaders, 'content-type');
        if (!isCompressibleContentType(contentType)) return undefined;
        if (getHeaderCaseInsensitive(setHeaders, 'content-encoding')) return undefined;
        if (!acceptsGzip(acceptEncodingHeader) || responseValue.length < MIN_COMPRESS_BYTES) return undefined;

        deleteHeaderCaseInsensitive(setHeaders, 'content-length');
        const vary = mergeVaryHeader(getHeaderCaseInsensitive(setHeaders, 'vary'), 'Accept-Encoding');
        return await buildCompressedResponse(responseValue, contentType as string, vary);
    }

    const serialized = serializeResponseValue(responseValue);
    if (!serialized) return undefined;

    const explicitContentType = getHeaderCaseInsensitive(setHeaders, 'content-type');
    const contentType = explicitContentType || serialized.contentType;
    const canCompress =
        acceptsGzip(acceptEncodingHeader) &&
        !getHeaderCaseInsensitive(setHeaders, 'content-encoding') &&
        isCompressibleContentType(contentType) &&
        serialized.bytes.length >= MIN_COMPRESS_BYTES;

    if (canCompress) {
        deleteHeaderCaseInsensitive(setHeaders, 'content-length');
        const vary = mergeVaryHeader(getHeaderCaseInsensitive(setHeaders, 'vary'), 'Accept-Encoding');
        return await buildCompressedResponse(serialized.bytes, contentType, vary);
    }

    if (explicitContentType) {
        return new Response(serialized.bytes, {
            headers: { 'Content-Type': explicitContentType },
        });
    }

    return undefined;
}

/**
 * Re-wraps an explicit Response with a gzip-compressed body while preserving
 * its status and headers. The application installs CORS globally with
 * `Vary: *`; when the Response itself has no Vary header, the compressed
 * Response keeps that value so Elysia does not replace it with the narrower
 * `Accept-Encoding` dimension.
 */
export async function compressResponse(
    response: Response,
    acceptEncodingHeader: string | null,
): Promise<Response | undefined> {
    if (response.headers.get('content-encoding')) return undefined;
    if (!isCompressibleContentType(response.headers.get('content-type'))) return undefined;
    if (!acceptsGzip(acceptEncodingHeader)) return undefined;

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

    const compressed = await gzipAsync(body);
    const headers = new Headers(response.headers);
    const existingVary = headers.get('vary');

    headers.delete('content-length');
    headers.set('content-encoding', 'gzip');
    headers.set('content-length', compressed.length.toString());
    headers.set('vary', existingVary ? mergeVaryHeader(existingVary, 'Accept-Encoding') : '*');

    return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
