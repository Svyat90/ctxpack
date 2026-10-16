import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 5 * 1024 * 1024;

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Запит завеликий'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Некоректний JSON'));
      }
    });
    req.on('error', reject);
  });
}

const sameToken = (given, token) =>
  typeof given === 'string' && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

// Listens on 127.0.0.1 only. Every /api call needs the one-time token from the start URL.
export function startServer({ root, port = 0, open = true, outDir }) {
  const api = createApi(root, { outDir });
  const token = crypto.randomBytes(16).toString('hex');
  const routes = {
    'GET /api/tree': () => api.tree(),
    'GET /api/changed': () => api.changed(),
    'POST /api/related': b => api.related(b),
    'POST /api/preview': b => api.preview(b),
    'POST /api/export': b => api.export(b),
    'POST /api/expand': b => api.expand(b.include),
    'PUT /api/config': b => api.saveRelated(b.related),
    'POST /api/presets': b => api.savePreset(b.name, b.preset ?? null),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const { port: actual } = server.address();
      // Blocks DNS-rebinding: only direct loopback hosts may talk to the server.
      if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url, `http://127.0.0.1:${actual}`);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(UI_DIR, file)));
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'Not found' });
      if (!sameToken(req.headers['x-ctxpack-token'], token)) return send(res, 401, { error: 'Невірний токен сесії. Відкрийте посилання з терміналу ще раз.' });
      const body = req.method === 'GET' ? {} : await readJson(req);
      send(res, 200, handler(body));
    } catch (err) {
      send(res, err.status || 400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      if (open) openBrowser(url);
      resolve({ server, url, token, api });
    });
  });
}
