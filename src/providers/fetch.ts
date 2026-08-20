// Fetch helper for provider-owned resources (manifest.json, urls.json, the
// dist/ modules). Retries with exponential backoff, honors an abort signal,
// and caps each attempt with a timeout so a stalled upstream never pins a
// route handler.

import { proxyFetch } from '@/lib/net/proxy';
import { ProviderError } from './errors';
import { PROVIDER_MAX_ATTEMPTS } from './registry/config';

const BACKOFF_BASE_MS = 400;

export async function providerFetch(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const { headers, timeoutMs = 15_000, signal } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < PROVIDER_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await proxyFetch(url, {
        headers: { Accept: 'application/json,text/plain,*/*', ...headers },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new ProviderError(
          response.status,
          `Provider source request failed (${response.status})`,
          url,
          response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
        );
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || controller.signal.aborted) {
        // Caller aborted (deadline or client disconnect): the timeout path
        // reports a timeout, anything else re-raises the abort as-is.
        if (timedOut) {
          throw new ProviderError(504, `Provider source timed out: ${url}`, url, 'TIMEOUT');
        }
        throw error;
      }
      if (attempt < PROVIDER_MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

export async function providerFetchJson<T>(
  url: string,
  options: Parameters<typeof providerFetch>[1] = {},
): Promise<T> {
  const response = await providerFetch(url, options);
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
