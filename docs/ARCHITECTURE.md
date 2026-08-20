# Architecture

Harustream is a single Next.js (App Router) application. This document
describes how the code is organized so new contributors can find things fast.

```
src/
├── app/            # routes only — thin HTTP glue
│   └── api/        #   each handler parses the request, calls into media/ or
│                   #   providers/, and shapes the HTTP response
├── components/     # UI, grouped by feature (home, library, player, search, settings),
│                   # layout, motion, ui — no fetch or provider logic
├── providers/      # the plugin/fetch system (runtime for untrusted provider
│   │               # modules) — what providers exist, how they load & execute
│   ├── registry/   #   manifest.ts, config.ts, modules.ts — provider discovery
│   ├── sandbox.ts  #   isolated execution of provider code (node:vm)
│   ├── cache.ts    #   in-process TTL cache with single-flight loading
│   ├── fanout.ts   #   multi-provider search/feed with concurrency + deadline
│   ├── runtime.ts  #   single-provider operations (posts, meta, stream, …)
│   ├── context.ts  #   axios/cheerio context handed to provider modules
│   ├── fetch.ts    #   retrying fetch for provider-owned resources
│   └── errors.ts   #   ProviderError (status + code + upstream)
├── media/          # domain logic the API routes actually call — validates
│   │               # inputs and orchestrates providers/
│   ├── catalog.ts  #   categories, meta, featured feed
│   ├── search.ts   #   search (fan-out or single-provider)
│   ├── stream.ts   #   playable-source resolution
│   └── episodes.ts #   episode-list resolution
├── lib/            # generic app-wide plumbing, not domain logic
│   ├── api/        #   browser fetchers (client.ts), client errors, shared
│   │               #   response helpers (respond.ts), zod shapes (types.ts)
│   ├── hooks/      #   React hooks (useProviders, useSettings, …)
│   ├── media/      #   client-side helpers: images, playback, stream proxy
│   ├── state/      #   client state: reducer.ts, provider registry (providers.ts)
│   ├── log.ts      #   pino structured logging
│   └── utils.ts
├── instrumentation.ts  # server boot lifecycle hook
├── proxy.ts            # middleware: request-id stamping + request logging
```

## Forward proxy (`server/`)

`server/forward-proxy.mjs` is a standalone, zero-dependency HTTP forward proxy
(Node-only, no build step) meant to run on a VPS / home server with a
residential IP. Some provider CDNs return `403` for Vercel's datacenter IPs,
so the app can route **all** server-side outbound HTTP — provider module
scrapes and media-proxy upstream reads — through it via the standard
`HTTP_PROXY`/`HTTPS_PROXY` env vars.

- `src/lib/net/proxy.ts` turns those env vars into an undici `ProxyAgent` and
  an axios proxy config.
- Provider modules egress through the proxy via their axios instance
  (`src/providers/context.ts`) and the sandbox `fetch` (`src/providers/sandbox.ts`)
  and `providerFetch` (`src/providers/fetch.ts`).
- The media proxy's upstream fetch (`src/lib/media/streamProxy.ts`) uses the
  same `proxyFetch`, so HLS segments and MP4s are read from the proxy host too.

Run it with `pnpm start:proxy` (`PROXY_USERNAME`/`PROXY_PASSWORD`/`PORT` env),
then set `HTTP_PROXY`/`HTTPS_PROXY` on the app host.

## providers/ vs media/

The key split is between *how content is fetched* and *what the app does with
it*.

- **`src/providers/`** is the execution engine. It knows nothing about the app's
  HTTP contract: it loads a live provider manifest, fetches each provider's
  `dist/` module, executes that untrusted code in a `node:vm` sandbox, fans out
  across providers with bounded concurrency, and normalizes raw module output
  into plain data shapes (`Post`, `MetaInfo`, `Stream`, …). This is what used to
  live in `packages/provider-runtime`.

- **`src/media/`** is the domain layer the API routes actually call. Each module
  validates its inputs (throwing a 400 `ProviderError` for missing params) and
  delegates to `providers/`. Routes stay thin: they parse the request, call one
  `media/` function, log, and respond.

Rule of thumb: if it executes provider code or talks to the provider manifest,
it belongs in `src/providers/`. If it decides *what* to fetch for a route and
shapes it for the API contract, it belongs in `src/media/`. Generic plumbing
(no provider concept) belongs in `src/lib/`.