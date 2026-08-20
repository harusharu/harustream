// Sandboxed execution of provider modules inside node:vm.
//
// Provider modules are self-contained CommonJS bundles (esbuild output) that
// wire up `exports.getPosts`/`getMeta`/… and then return — the async work
// happens when we invoke the exported function with the args the module
// expects (`{ link, type, filter, page, providerValue, signal }` plus a
// `providerContext` of shared dependencies).
//
// The vm context gets the standard ECMAScript built-ins plus a curated set of
// host globals the bundles are known to touch (fetch, URL, atob, Buffer,
// timers, console, providerGlobal for their URL-cache state). No `require`,
// `process`, or `global` is exposed, and a sync execution budget bounds the
// top-level code. The invoked function races an overall deadline; the
// deadline aborts the shared signal so in-flight axios/fetch calls stop too.

import vm from 'node:vm';
import { proxyFetch } from '@/lib/net/proxy';
import { ProviderError } from './errors';
import { MODULE_SYNC_TIMEOUT_MS, PROVIDER_TIMEOUT_MS } from './registry/config';

export type ModuleRunOptions = {
  /** Where the module code came from (used in stack traces). */
  filename?: string;
  /** Per-call deadline; aborts the module's signal when it expires. */
  timeoutMs?: number;
  /** Caller cancellation; also aborts the module's in-flight requests. */
  signal?: AbortSignal;
};

function buildContext(providerContext: Record<string, unknown>) {
  const moduleBox = { exports: {} };
  return {
    module: moduleBox,
    exports: moduleBox.exports,
    providerGlobal: {},
    providerContext,
    console,
    // Proxy-aware fetch: when HTTP_PROXY/HTTPS_PROXY is configured the module's
    // outbound requests egress from the forward proxy host (Vercel datacenter
    // IPs are 403'd by some provider CDNs).
    fetch: proxyFetch,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    Blob,
    FormData,
    Buffer,
    crypto,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
  };
}

// Evaluates a module's top-level code and returns its exports. Used for the
// catalog module, which exports plain data (`catalog`, `genres`) instead of
// functions.
export async function evaluateProviderModule(
  code: string,
  providerContext: Record<string, unknown>,
  filename = 'provider-module.js',
): Promise<Record<string, unknown>> {
  const context = buildContext(providerContext);
  const sandbox = vm.createContext(context);

  let script: vm.Script;
  try {
    script = new vm.Script(code, { filename });
  } catch (error) {
    throw new ProviderError(
      502,
      `Provider module failed to compile: ${(error as Error).message}`,
      filename,
      'INVALID_SHAPE',
    );
  }

  try {
    script.runInContext(sandbox, { timeout: MODULE_SYNC_TIMEOUT_MS });
  } catch (error) {
    const timedOut = error instanceof Error && /timed out/.test(error.message);
    throw new ProviderError(
      timedOut ? 504 : 502,
      timedOut
        ? `Provider module took too long to load (${filename})`
        : `Provider module failed to load (${filename})`,
      filename,
      timedOut ? 'TIMEOUT' : 'INVALID_SHAPE',
    );
  }
  return context.module.exports as Record<string, unknown>;
}

export async function runProviderModule<T>(
  code: string,
  exportName: string,
  args: Record<string, unknown>,
  options: ModuleRunOptions = {},
): Promise<T> {
  const { filename = 'provider-module.js', timeoutMs = PROVIDER_TIMEOUT_MS, signal } = options;
  const providerContext = args.providerContext as Record<string, unknown>;
  const exports = await evaluateProviderModule(code, providerContext, filename);

  const fn = exports[exportName];
  if (typeof fn !== 'function') {
    throw new ProviderError(
      502,
      `Provider module does not export ${exportName}`,
      filename,
      'INVALID_SHAPE',
    );
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;

  try {
    const call = Promise.resolve(
      fn({ ...args, signal: controller.signal, providerContext }),
    ) as Promise<T>;
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new ProviderError(
            504,
            `Provider call timed out after ${Math.round(timeoutMs / 1000)}s`,
            filename,
            'TIMEOUT',
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([call, deadline]);
  } catch (error) {
    if (timedOut) {
      throw new ProviderError(
        504,
        `Provider call timed out after ${Math.round(timeoutMs / 1000)}s`,
        filename,
        'TIMEOUT',
      );
    }
    if (signal?.aborted) {
      throw new ProviderError(408, 'Request aborted', filename, 'TIMEOUT');
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
