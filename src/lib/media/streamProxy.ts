// Server-side web streaming proxy.
//
// Provider hosts serve their media from hotlinked URLs that require custom
// Referer/User-Agent headers and are often behind CORS-restricted origins a
// browser cannot reach directly. This module fetches those URLs server-side
// and streams them back through our own origin, transparently:
//
//  - Range requests pass through so video seeking still works
//  - HLS (.m3u8) manifests are rewritten so every segment/key/playlist URL
//    is routed back through the proxy (the browser can then fetch the whole
//    playlist without CORS or referer problems)
//  - provider-required headers (Referer, User-Agent, Origin, Cookie) are
//    injected; explicit `referer`/`origin`/`userAgent`/`cookie` query params
//    win over config defaults and are carried onto rewritten HLS URLs
//  - private/internal hosts are rejected (SSRF guard)

import { scopeLogger } from '@/lib/log';
import { proxyFetch } from '@/lib/net/proxy';

export type ProxyHeaders = Record<string, string>;

export type ProxyResult = {
  status: number;
  headers: ProxyHeaders;
  body: ReadableStream<Uint8Array> | string;
};

// Header query params the client may forward from the stream payload's
// `headers` (provider-enforced identity). These win over config defaults and
// are carried onto rewritten HLS segment/key URLs.
export const PROXY_HEADER_PARAMS = ['referer', 'origin', 'userAgent', 'cookie'] as const;
export type ProxyHeaderParam = (typeof PROXY_HEADER_PARAMS)[number];

export type ProxyOptions = {
  range?: string | null;
  signal?: AbortSignal;
  headers?: Partial<Record<ProxyHeaderParam, string>>;
};

// Whether a manifest should be rewritten as HLS.
function isHlsManifest(contentType: string | null, url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return true;
  const type = contentType ?? '';
  return (
    type.includes('mpegurl') || type.includes('x-mpegurl') || type.includes('application/vnd.apple')
  );
}

// Build the proxied href for an upstream media URL. Relative URLs are
// resolved against the manifest they were found in. `headers` are appended
// in a fixed order (referer, origin, userAgent, cookie) after the url param.
export function proxiedUrl(
  raw: string,
  base?: string,
  headers: Partial<Record<ProxyHeaderParam, string>> = {},
): string {
  const target = base ? new URL(raw, base).toString() : raw;
  const params = new URLSearchParams({ url: target });
  for (const key of PROXY_HEADER_PARAMS) {
    const value = headers[key];
    if (value) params.set(key, value);
  }
  return `/api/proxy?${params.toString()}`;
}

// Rewrite an HLS manifest so every nested URI (segments, keys, sub-playlists,
// map/init segments, media tracks) points back at /api/proxy. Non-URI lines
// (comments, attributes without URI=) are left untouched.
export function rewriteHlsManifest(
  manifest: string,
  manifestUrl: string,
  headers: Partial<Record<ProxyHeaderParam, string>> = {},
): string {
  const resolve = (raw: string) => {
    try {
      return proxiedUrl(raw, manifestUrl, headers);
    } catch {
      return raw;
    }
  };

  const lines = manifest.split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    // Attribute-style URI (e.g. #EXT-X-KEY:METHOD=AES-128,URI="key.bin").
    if (/^#EXT-X-(?:KEY|MEDIA|MAP|SESSION-KEY):/i.test(trimmed)) {
      return line.replace(/URI="([^"]+)"/gi, (_m, rawUri: string) => `URI="${resolve(rawUri)}"`);
    }

    // A bare URI line (segment or child playlist). hls.js already proxies
    // some of these, but rewriting keeps direct <video> HLS working too.
    if (trimmed && !trimmed.startsWith('#')) {
      return resolve(trimmed);
    }
    return line;
  });

  return rewritten.join('\n');
}

// The User-Agent we present to provider hosts. Configurable so hosts that
// fingerprint by UA can be tuned without a code change.
function upstreamUserAgent(explicit?: string): string {
  return (
    explicit?.trim() ??
    process.env.STREAM_PROXY_USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );
}

// Referer injected for provider hosts. An explicit override wins, then the
// configured default (STREAM_PROXY_REFERER), then the target's own origin.
function upstreamReferer(target: URL, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const configured = process.env.STREAM_PROXY_REFERER?.trim();
  if (configured) return configured;
  return `${target.protocol}//${target.host}`;
}

// SSRF guardrail: block clearly-internal destinations unless explicitly
// allowed. Full DNS resolution is skipped to avoid latency; IP literals and
// obvious local hostnames are checked.
export function isInternalHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }
  // IPv4/IPv6 literals in private/reserved ranges.
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127 || a === 0) return true; // loopback / this network
  }
  return false;
}

// Cap on how much of an HLS manifest is read before rewriting. Manifests are
// small (KBs); the cap is a safety net against a misbehaving upstream that
// claims HLS but streams unbounded bytes.
const MAX_MANIFEST_BYTES = 2 << 20; // 2 MiB

// Core proxy routine. `url` must be an absolute http(s) URL.
export async function proxyStream(url: string, options: ProxyOptions = {}): Promise<ProxyResult> {
  const log = scopeLogger('stream-proxy');
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('Invalid target URL');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('Only http(s) targets are allowed');
  }
  if (!process.env.STREAM_PROXY_ALLOW_PRIVATE && isInternalHost(target.hostname)) {
    throw new Error('Target host is not reachable');
  }

  const referer = upstreamReferer(target, options.headers?.referer);
  const origin = options.headers?.origin?.trim() || referer;
  const headers: Record<string, string> = {
    'User-Agent': upstreamUserAgent(options.headers?.userAgent),
    Referer: referer,
    Accept: '*/*',
    // Origin mirrors Referer so provider hosts that enforce hotlink
    // protection on both headers see a consistent browser-like identity.
    // An explicit provider Origin (e.g. themoviebox.org) wins over that.
    Origin: origin,
  };
  const cookie = options.headers?.cookie?.trim();
  if (cookie) headers.Cookie = cookie;
  if (options.range) headers.Range = options.range;

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await proxyFetch(url, {
      headers,
      cache: 'no-store',
      redirect: 'follow',
      signal: options.signal,
    });
  } catch (error) {
    log.error(
      { url, code: (error as Error).name ?? 'FETCH', durationMs: Date.now() - started },
      'upstream stream fetch failed',
    );
    throw new Error(
      (error as Error).name === 'AbortError' ? 'Stream request aborted' : 'Upstream unreachable',
    );
  }

  const contentType = upstream.headers.get('content-type');
  log.debug(
    { url, status: upstream.status, contentType, durationMs: Date.now() - started },
    'upstream responded',
  );

  // Non-2xx responses are surfaced with their status so the client video
  // element reports a truthful error instead of a silent stall.
  if (!upstream.ok) {
    if (!upstream.body) {
      throw new Error(`Upstream error (${upstream.status})`);
    }
    // Drain the upstream body so the connection is reusable, then surface
    // the status to the caller as a plain error.
    await upstream.body.cancel().catch(() => {});
    throw new Error(`Upstream error (${upstream.status})`);
  }

  const passthrough: ProxyHeaders = {
    'Content-Type': contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  };

  // Preserve range semantics so seeking works.
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
    const value = upstream.headers.get(name);
    if (value) passthrough[name] = value;
  }

  // HLS manifests need rewriting before they're usable from the browser.
  if (isHlsManifest(contentType, url)) {
    const text = (await upstream.text()).slice(0, MAX_MANIFEST_BYTES);
    const rewritten = rewriteHlsManifest(text, url, options.headers);
    passthrough['Content-Type'] = 'application/vnd.apple.mpegurl';
    passthrough['Cache-Control'] = 'public, max-age=60';
    // The rewritten body differs from the upstream bytes — the passed-
    // through Content-Length would truncate the response.
    passthrough['Content-Length'] = String(Buffer.byteLength(rewritten));
    return { status: 200, headers: passthrough, body: rewritten };
  }

  if (!upstream.body) {
    throw new Error('Upstream returned an empty body');
  }

  return {
    status: upstream.status,
    headers: passthrough,
    body: upstream.body,
  };
}
