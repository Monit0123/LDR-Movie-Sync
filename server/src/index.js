import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRelay, Rooms, normaliseCode } from './relay.js';
import { resolveUrl } from './extract.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(here, '../../web');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const rooms = new Rooms();
const startedAt = Date.now();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ---------------------------------------------------------------
  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), ...rooms.stats() });
  }

  if (url.pathname === '/api/room') {
    const code = normaliseCode(url.searchParams.get('code'));
    const room = rooms.get(code);
    return json(res, 200, {
      code,
      exists: Boolean(room),
      peers: room ? room.peers.size : 0,
    });
  }

  if (url.pathname === '/api/extract') {
    const started = Date.now();
    try {
      const source = await resolveUrl(url.searchParams.get('url'));
      log(`extract ${source.kind} <- ${url.searchParams.get('url')} (${Date.now() - started}ms)`);
      return json(res, 200, { ok: true, source });
    } catch (err) {
      log(`extract failed: ${err.message}`);
      return json(res, err.status || 502, { ok: false, error: err.message });
    }
  }

  if (req.method === 'OPTIONS') {
    return json(res, 204, null, { 'access-control-allow-origin': '*' });
  }

  // ---- static web app ----------------------------------------------------
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(url.pathname, req, res);
  }

  return json(res, 405, { ok: false, error: 'method not allowed' });
});

async function serveStatic(pathname, req, res) {
  let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  const target = resolve(WEB_ROOT, normalize(relative));
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(pathname + '/', req, res);

    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    const immutable = /\/(app|player|sync)\.[a-z0-9]+\.js$/.test(target);
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      // The in-app browsers need to be embeddable, and the app is same-origin.
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(target).pipe(res);
  } catch {
    // SPA fallback
    if (!relative.includes('.')) {
      try {
        const html = await readFile(join(WEB_ROOT, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(html);
      } catch { /* fall through */ }
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

function json(res, status, body, extraHeaders = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

attachRelay(server, { rooms, log });

server.listen(PORT, HOST, () => {
  log(`LDR Sync server listening on http://${HOST}:${PORT}`);
  log(`serving web client from ${WEB_ROOT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
