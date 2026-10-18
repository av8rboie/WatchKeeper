// Simulates HA ingress for dev and end-to-end tests: mounts the app under an
// ingress-style path prefix, strips it before forwarding, and injects the
// X-Ingress-Path and X-Remote-User-* headers HA would add. Any user headers
// the client sent are dropped first, as HA does.
//
// The HA user comes from a `ha_user` cookie ("id|Display Name", URL-encoded)
// so tests can switch users; without it, the default user is used.

import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

export interface IngressProxyOptions {
  /** Backend to forward to, e.g. http://127.0.0.1:8099 */
  target: string;
  port: number;
  /** e.g. /api/hassio_ingress/Xyz123 */
  prefix: string;
  defaultUser: { id: string; name: string };
  /** Paths outside the prefix forwarded untouched. */
  passthrough?: (url: string) => string | null;
  /**
   * Dev only: non-API requests under the prefix go here with the full,
   * unstripped URL (Vite's dev base is the prefix).
   */
  webTarget?: string;
}

function userFrom(headers: IncomingHttpHeaders, fallback: { id: string; name: string }) {
  const m = /(?:^|;\s*)ha_user=([^;]+)/.exec(headers.cookie ?? '');
  if (!m) return fallback;
  const [id, name] = decodeURIComponent(m[1]!).split('|');
  return id ? { id, name: name ?? id } : fallback;
}

function rewriteHeaders(headers: IncomingHttpHeaders, opts: IngressProxyOptions, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || k.startsWith('x-remote-user') || k === 'x-ingress-path') continue;
    out[k] = v;
  }
  const user = userFrom(headers, opts.defaultUser);
  out['x-ingress-path'] = opts.prefix;
  out['x-remote-user-id'] = user.id;
  out['x-remote-user-name'] = user.name.toLowerCase().replace(/\s+/g, '_');
  out['x-remote-user-display-name'] = user.name;
  out.host = host;
  return out;
}

export function startIngressProxy(opts: IngressProxyOptions): Promise<Server> {
  const backend = new URL(opts.target);
  const web = opts.webTarget ? new URL(opts.webTarget) : null;
  const strip = (url: string) => (url.startsWith(opts.prefix) ? url.slice(opts.prefix.length) || '/' : null);
  /** Where a request goes and with which path. */
  const route = (url: string): { target: URL; path: string; ingress: boolean } | null => {
    const stripped = strip(url);
    if (stripped !== null && web && !stripped.startsWith('/api/')) return { target: web, path: url, ingress: false };
    if (stripped !== null) return { target: backend, path: stripped, ingress: true };
    const pass = opts.passthrough?.(url) ?? null;
    return pass === null ? null : { target: web ?? backend, path: pass, ingress: false };
  };

  const server = createServer((req, res) => {
    const r = route(req.url ?? '/');
    if (r === null) {
      res.statusCode = 404;
      res.end('Not under the ingress prefix');
      return;
    }
    const { target, path } = r;
    const headers = r.ingress ? rewriteHeaders(req.headers, opts, target.host) : { ...req.headers, host: target.host };
    const upstream = request({ hostname: target.hostname, port: target.port, path, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      res.statusCode = 502;
      res.end('Upstream unavailable');
    });
    req.pipe(upstream);
  });

  // WebSockets: replay the upgrade request with the rewritten path and headers, then pipe.
  server.on('upgrade', (req, socket, head) => {
    const r = route(req.url ?? '/');
    if (r === null) return socket.destroy();
    const { target, path } = r;
    const headers = r.ingress ? rewriteHeaders(req.headers, opts, target.host) : { ...req.headers, host: target.host };
    const up = connect(Number(target.port), target.hostname, () => {
      const lines = [`GET ${path} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const val of [v].flat()) lines.push(`${k}: ${val}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
  });

  return new Promise((resolve) => server.listen(opts.port, '127.0.0.1', () => resolve(server)));
}
