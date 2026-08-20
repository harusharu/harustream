// The `providerContext` every provider module receives, mirroring the Vega
// Android app's contract: axios + cheerio for scraping, a browser-like
// `commonHeaders` set, a Crypto shim, `getBaseUrl` for resolving a channel's
// home URL from urls.json, and `openWebView` for CAPTCHA-gated sources.

import { randomBytes } from 'node:crypto';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { axiosProxyConfig } from '@/lib/net/proxy';
import { ProviderError } from './errors';
import { getProviders } from './registry/manifest';

// Browser-like headers the modules merge into their requests; some channel
// sites 403/429 without them.
export const commonHeaders: Record<string, string> = {
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Android WebView";v="120"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// expo-crypto-shaped shim backed by WebCrypto (Node 18+ global). Only a
// handful of modules touch Crypto; the surface mirrors what they use.
export const CryptoDigestAlgorithm = {
  Sha1: 'SHA-1',
  Sha256: 'SHA-256',
  Sha384: 'SHA-384',
  Sha512: 'SHA-512',
} as const;

export async function digestStringAsync(
  algorithm: (typeof CryptoDigestAlgorithm)[keyof typeof CryptoDigestAlgorithm],
  data: string,
): Promise<string> {
  const buffer = await crypto.subtle.digest(algorithm, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function getRandomBytesAsync(length: number): Promise<string> {
  return Promise.resolve(randomBytes(length).toString('base64'));
}

const Crypto = { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync };

// Resolves a channel's home URL from the live urls.json, matching the id or
// display name case-insensitively (modules pass either).
export async function getBaseUrl(idOrName: string): Promise<string> {
  const providers = await getProviders();
  const needle = idOrName.toLowerCase();
  const provider = providers.find(
    (p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle,
  );
  if (!provider) return '';
  return provider.url;
}

// Interactive CAPTCHA/Cloudflare challenges cannot be solved from a
// server-side sandbox. Fail loudly and specifically instead of pretending.
export async function openWebView(_url: string): Promise<never> {
  throw new ProviderError(
    501,
    'This source requires an interactive captcha and cannot be played from the web app.',
    undefined,
    'NO_SOURCE',
  );
}

export type ProviderContext = {
  axios: ReturnType<typeof axios.create>;
  cheerio: typeof cheerio;
  Crypto: typeof Crypto;
  commonHeaders: Record<string, string>;
  getBaseUrl: typeof getBaseUrl;
  openWebView: typeof openWebView;
};

export function createProviderContext(): ProviderContext {
  const proxy = axiosProxyConfig();
  return {
    // The modules pass their own `signal` in request config, so the instance
    // only needs a fallback timeout for requests that omit one. When a
    // forward proxy is configured (HTTP_PROXY/HTTPS_PROXY), the provider's
    // scrapes egress from that host instead of Vercel's datacenter IPs —
    // some provider CDNs 403 cloud IPs.
    axios: axios.create({
      timeout: 30_000,
      proxy: proxy ?? false,
    }),
    cheerio,
    Crypto,
    commonHeaders,
    getBaseUrl,
    openWebView,
  };
}
