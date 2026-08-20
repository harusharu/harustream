// Proxy-aware outbound HTTP for the server-side runtime.
//
// Vercel's datacenter IPs are rejected by some provider CDNs (403 for the hub
// pages the provider modules scrape and for the media CDNs the media proxy
// reads). The app can route ALL of its server-side egress through a single
// forward proxy running on a residential/non-blocked IP by setting the
// standard HTTP_PROXY/HTTPS_PROXY env vars — this module turns those into an
// undici ProxyAgent (for the provider sandbox and media proxy fetches) and an
// axios proxy config (for the provider modules' axios instance).
//
// When no proxy is configured everything passes through untouched, so local
// dev and proxies-less deployments behave exactly as before.

import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type ProxyCredentials = { username: string; password: string };

export type ProxyTarget = {
  url: string;
  credentials?: ProxyCredentials;
};

// NO_PROXY host suffixes bypass the proxy (loopback, provider hosts that are
// already reachable, etc.). Standard comma-separated list of domains, with
// optional leading dot and optional :port.
function noProxySet(): Set<string> {
  const raw = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').trim();
  if (!raw) return new Set();
  const hosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const host = entry.trim().toLowerCase().replace(/^\./, '');
    if (host) hosts.add(host);
  }
  return hosts;
}

function shouldBypass(target: URL): boolean {
  const bypass = noProxySet();
  if (bypass.size === 0) return false;
  const host = target.hostname.toLowerCase();
  if (bypass.has(host)) return true;
  return [...bypass].some((suffix) => host.endsWith(`.${suffix}`) || host === suffix);
}

// Reads HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (upper or lower case), matching
// curl's behavior. Returns null when unset or the target is on NO_PROXY.
export function resolveProxy(targetUrl?: string): ProxyTarget | null {
  const raw =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    '';
  const url = raw.trim();
  if (!url) return null;

  if (targetUrl) {
    try {
      if (shouldBypass(new URL(targetUrl))) return null;
    } catch {
      // Unparsable target URL — let the caller surface the real error.
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const target: ProxyTarget = { url: parsed.href.replace(/\/$/, '') };
  if (parsed.username || parsed.password) {
    target.credentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  return target;
}

// fetch() that routes through the configured forward proxy when present. The
// global fetch() is swapped for undici's so a per-request dispatcher (the
// ProxyAgent) can be attached; the response contract is identical. Accepts the
// same input forms as the standard fetch (URL, string, or Request).
export function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const target = resolveProxy(url);
  if (!target) return fetch(input, init);
  const agent = proxyAgentFor(target);
  if (!agent) return fetch(input, init);
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}

// Lazily build (and reuse) a ProxyAgent for a resolved proxy target.
let cachedAgent: ProxyAgent | null = null;
let cachedUrl = '';

function proxyAgentFor(target: ProxyTarget): ProxyAgent | null {
  if (cachedAgent && cachedUrl === target.url) return cachedAgent;
  cachedUrl = target.url;
  cachedAgent = new ProxyAgent({ uri: target.url, keepAliveTimeout: 30_000 });
  return cachedAgent;
}

// axios proxy config from the same env vars, for the provider modules' axios
// instance (they don't go through the ProxyAgent above).
export function axiosProxyConfig():
  | { protocol: string; host: string; port: number; auth?: ProxyCredentials }
  | undefined {
  const target = resolveProxy();
  if (!target) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return undefined;
  }
  const config: { protocol: string; host: string; port: number; auth?: ProxyCredentials } = {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
  };
  if (target.credentials) config.auth = target.credentials;
  return config;
}
