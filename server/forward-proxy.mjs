#!/usr/bin/env node
// Standalone HTTP forward proxy for harustream.
//
// Vercel's datacenter IPs are rejected by some provider CDNs (e.g. the Aliyun
// OSS host behind themoviebox.org, or the modpro.blog stream hubs, return 403
// for cloud IPs). Rather than proxying individual media URLs, this server
// exposes a plain HTTP forward proxy that the app's *whole* server-side
// egress (provider module fetches AND the media proxy) can route through:
//
//   Run:   PROXY_USERNAME=u PROXY_PASSWORD=p PORT=8787 node server/forward-proxy.mjs
//   Use:   set HTTP_PROXY/HTTPS_PROXY on the app host to
//          http://u:p@host:8787  (the app turns that into a ProxyAgent/axios proxy)
//
// No external deps and no build step: only node:http / node:https / node:net.
// Supports CONNECT (HTTPS tunneling) and absolute-form HTTP requests, which
// together cover every request the app's runtime makes.
//
// Env:
//   PORT            listen port (default 8787)
//   PROXY_USERNAME  optional Basic auth username
//   PROXY_PASSWORD  optional Basic auth password
//   LOG_LEVEL       set to "silent" to disable request logging

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const PORT = Number(process.env.PORT ?? 8787);
const USERNAME = process.env.PROXY_USERNAME ?? '';
const PASSWORD = process.env.PROXY_PASSWORD ?? '';
const QUIET = (process.env.LOG_LEVEL ?? '').trim() === 'silent';

const expectedAuth =
  USERNAME || PASSWORD ? `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}` : '';

function authorized(req) {
  if (!expectedAuth) return true;
  return (req.headers['proxy-authorization'] ?? '') === expectedAuth;
}

function rejectUnauthorized(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Proxy-Authenticate': 'Basic realm="harustream-proxy"',
  });
  res.end(message);
  return;
}

function log(line) {
  if (QUIET) return;
  // biome-ignore lint/suspicious/noConsole: standalone process boot/request log; no log framework is loaded yet.
  console.log(`[proxy] ${JSON.stringify({ ts: new Date().toISOString(), ...line })}`);
}

// CONNECT host:port  — the browser/undici tunnels TLS through this. After a
// 200 the raw TCP socket is spliced in both directions, so HTTPS is forwarded
// byte-for-byte with no decryption. The response head is written directly to
// the socket (not through the ServerResponse) so no HTTP framing interferes
// with the raw splice.
//
// Node's http.Server surfaces CONNECT via the server-level 'connect' event,
// not the request handler — the handler never sees it.
function handleConnect(req, client, head) {
  const [host, port] = (req.url ?? '').split(':');
  if (!host || !Number(port)) {
    client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    client.destroy();
    return;
  }

  const upstream = net.connect(Number(port), host, () => {
    log({ method: 'CONNECT', host, port, status: 200 });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Any bytes that arrived with the CONNECT head (early TLS) belong to the
    // tunnel — splice them before the live pipes.
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  upstream.on('error', () => {
    if (!client.destroyed) client.destroy();
    log({ method: 'CONNECT', host, port, status: 502, error: 'connect failed' });
  });

  client.on('error', () => {
    upstream.destroy();
  });
}

// Absolute-form request (GET http://host/path ...) for plain HTTP targets.
// Rewrites the request to origin-form and forwards it as a normal HTTP call.
function handleAbsoluteRequest(req, res) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad proxy URL');
    return;
  }

  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  delete headers.connection;
  headers.host = target.host;

  const transport = target.protocol === 'https:' ? https : http;
  const outbound = transport.request(
    target,
    { method: req.method, headers, signal: AbortSignal.timeout(60_000) },
    (upstream) => {
      log({
        method: req.method,
        host: target.host,
        path: target.pathname,
        status: upstream.statusCode,
      });
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  outbound.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Upstream failed');
  });
  req.pipe(outbound);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';

  // Health check for uptime monitors / systemd — unauthenticated so monitors
  // without proxy creds can poll it.
  if (url === '/health' && (req.method ?? '').toUpperCase() === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'harustream-forward-proxy' }));
    return;
  }

  if (!authorized(req)) {
    rejectUnauthorized(res, 407, 'Proxy authentication required');
    return;
  }

  // Proxy requests arrive with an absolute URL; direct requests to the proxy
  // itself (like /health) use origin-form and are not proxied.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    handleAbsoluteRequest(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// CONNECT (HTTPS tunneling) is emitted as a server-level event, not a request.
server.on('connect', (req, client, head) => {
  if (!authorized(req)) {
    client.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="harustream-proxy"\r\n' +
        'Content-Length: 0\r\nConnection: close\r\n\r\n',
    );
    client.end();
    return;
  }
  handleConnect(req, client, head);
});

server.listen(PORT, () => {
  log({ event: 'listening', port: PORT, auth: expectedAuth ? 'required' : 'disabled' });
});
