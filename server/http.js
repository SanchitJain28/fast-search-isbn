import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { attachPackingApi } from './api.js';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export function createProductionServer(root, options = {}) {
  const username = options.username ?? process.env.SCANNER_USERNAME;
  const passwordHash = options.passwordHash ?? process.env.SCANNER_PASSWORD_HASH;
  if (!username || !passwordHash) throw new Error('Set SCANNER_USERNAME and SCANNER_PASSWORD_HASH before starting the production server. See deploy/README.md.');
  const [algorithm, salt, expected] = passwordHash.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Invalid SCANNER_PASSWORD_HASH format');
  const staticRoot = path.resolve(root, 'dist');
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) throw new Error('Build the UI before starting: npm run build');
  let api;
  let acceptedHeaderHash;
  const rejectedAttempts = new Map();
  const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    const auth = String(req.headers.authorization || '');
    const headerHash = createHash('sha256').update(auth).digest();
    let authorized = acceptedHeaderHash && equal(headerHash, acceptedHeaderHash);
    if (!authorized && auth.startsWith('Basic ')) {
      const address = req.socket.remoteAddress;
      const attempts = rejectedAttempts.get(address);
      if (attempts && attempts.until > Date.now() && attempts.count >= 10) {
        res.writeHead(429, { 'Retry-After': '60' }); return res.end('Too many login attempts. Try again in one minute.');
      }
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      if (auth.length < 2048 && separator >= 0 && user === username && equal(scryptSync(password, salt, 32), Buffer.from(expected, 'hex'))) {
        acceptedHeaderHash = headerHash; authorized = true;
      } else {
        if (rejectedAttempts.size > 1000) rejectedAttempts.clear();
        rejectedAttempts.set(address, { count: attempts?.until > Date.now() ? attempts.count + 1 : 1, until: attempts?.until > Date.now() ? attempts.until : Date.now() + 60000 });
      }
    }
    if (!authorized) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Book packing", charset="UTF-8"' }); return res.end('Sign in to access book packing.'); }
    void api(req, res, () => {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { res.writeHead(400); return res.end('Invalid path'); }
      if (pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.') || part === '..')) { res.writeHead(404); return res.end(); }
      let filename = path.resolve(staticRoot, `.${pathname}`);
      if (filename !== staticRoot && !filename.startsWith(`${staticRoot}${path.sep}`)) { res.writeHead(404); return res.end(); }
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        if (path.extname(pathname)) { res.writeHead(404); return res.end(); }
        filename = path.join(staticRoot, 'index.html');
      }
      res.setHeader('Content-Type', mimeTypes[path.extname(filename)] || 'application/octet-stream');
      res.setHeader('Content-Length', fs.statSync(filename).size);
      if (filename.startsWith(path.join(staticRoot, 'assets') + path.sep)) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      if (req.method === 'HEAD') return res.end();
      pipeline(fs.createReadStream(filename), res, () => {});
    }).catch(error => {
      console.error('Request failed:', error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    });
  });
  attachPackingApi({ httpServer: server, middlewares: { use: middleware => { api = middleware; } } }, root, { ...options, authenticatedCoverRoutes: true });
  return server;
}
