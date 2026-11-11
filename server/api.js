import fs from 'node:fs';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { PackingStore } from './store.js';
import { createMirror } from './sheets.js';
import { createCoverRoutes } from './cover-match/routes.js';

export function attachPackingApi(server, root, options = {}) {
    const databasePath = options.databasePath || process.env.PACKING_DB || path.join(root, 'data/packing.sqlite');
    const editionFile = path.join(path.dirname(databasePath), 'amazon-editions.json');
    const editions = fs.existsSync(editionFile) ? JSON.parse(fs.readFileSync(editionFile, 'utf8')) : undefined;
    const catalogPath = path.join(root, 'public/master.json');
    const store = new PackingStore(databasePath, JSON.parse(fs.readFileSync(catalogPath, 'utf8')), editions);
    const mirror = createMirror(store, root);
    const clients = new Set();
    const stationNames = () => JSON.parse(store.getMeta('stationDisplayNames') || '{}');
    const broadcast = data => { for (const client of clients) client.write(`data: ${JSON.stringify(data)}\n\n`); };
    const onPacked = entry => {
      console.info(JSON.stringify({ event: 'scan-confirmed', id: entry.id, seq: entry.seq }));
      broadcast({ type: 'BOOK_PACKED', scan: entry });
    };
    const cover = createCoverRoutes({
      ...options.coverMatch, store, catalogPath, publicOrigin: options.publicOrigin || process.env.PUBLIC_ORIGIN,
      allowRemote: options.authenticatedCoverRoutes === true, onPacked,
    });
    const health = () => ({ ...store.stats(), userCount: clients.size, mirror: mirror.status(), coverMatchEnabled: cover.enabled, coverVector: cover.vector,
      amazonEditions: { mappings: store.amazonByBarcode.size, conflicts: store.amazonConflicts.size } });
    const interval = setInterval(() => { void mirror.flush(); broadcast({ type: 'HEALTH', ...health() }); }, 5000);
    const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20000);
    interval.unref(); heartbeat.unref();
    server.httpServer?.once('close', () => { clearInterval(interval); clearInterval(heartbeat); cover.close(); for (const client of clients) client.end(); });
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return next();
      const json = (status, data) => {
        const body = Buffer.from(JSON.stringify(data));
        const send = (bytes, encoding) => {
          if (res.destroyed) return;
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding',
            'Content-Length': bytes.length, ...(encoding ? { 'Content-Encoding': encoding } : {}) });
          res.end(bytes);
        };
        // Compress history off the event loop; scans must not wait on large transfers.
        if (body.length > 1024 && /\bgzip\b(?!\s*;\s*q=0(?:\D|$))/.test(req.headers['accept-encoding'] || '')) {
          gzip(body, (error, compressed) => send(error ? body : compressed, error ? undefined : 'gzip'));
        } else send(body);
      };
      if (url.pathname === '/api/cover-match' || url.pathname === '/api/cover-match/search' || url.pathname === '/api/mark-packed') {
        return cover.handle(req, res, url, json);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders(); clients.add(res); broadcast({ type: 'USER_COUNT', count: clients.size });
        req.once('close', () => { clients.delete(res); broadcast({ type: 'USER_COUNT', count: clients.size }); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { scans: store.list(), editableFromSeq: JSON.parse(store.getMeta('mainScanLayout') || 'null')?.startSeq || 1, stationNames: stationNames(), ...health() });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, health());
      if (req.method === 'GET' && url.pathname === '/api/scan') {
        const id = url.searchParams.get('id');
        if (!id || !/^[\w-]{8,100}$/.test(id)) return json(400, { error: 'Invalid request ID' });
        return json(200, { scan: store.findScan(id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/station-name') {
        const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
        const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        if (req.headers.origin && !String(req.headers.origin).split(',').every(origin => allowedOrigins.includes(origin.trim()))) return json(403, { error: 'Use the scanner server address' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: 'JSON required' });
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Request too large' }); }
          const { station, name } = JSON.parse(body);
          if (typeof station !== 'string' || !station.trim() || station.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(station) || typeof name !== 'string' || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return json(400, { error: 'Use a display name of up to 80 characters.' });
          const names = stationNames();
          if (name.trim()) names[station] = name.trim(); else delete names[station];
          // Presentation metadata only: never rewrite scan records or queue Sheets writes.
          store.setMeta('stationDisplayNames', JSON.stringify(names));
          broadcast({ type: 'STATION_NAMES', stationNames: names });
          return json(200, { stationNames: names });
        } catch (error) { return json(error instanceof SyntaxError ? 400 : 500, { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        // Reject cross-site submissions; scanner clients use the same host as the API.
        const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
        const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        const requestOrigins = String(req.headers.origin || '').split(',').map(value => value.trim());
        if (req.headers.origin && !requestOrigins.every(origin => allowedOrigins.includes(origin))) {
          console.warn('Rejected scanner origin', { origin: req.headers.origin, configuredOrigin: publicOrigin });
          return json(403, { error: 'Use the scanner server address' });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: 'JSON required' });
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Request too large' }); }
          const entry = store.scan(JSON.parse(body));
          onPacked(entry);
          return json(200, entry);
        } catch (error) { return json(error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/scan/edit') {
        const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
        const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        const requestOrigins = String(req.headers.origin || '').split(',').map(value => value.trim());
        if (req.headers.origin && !requestOrigins.every(origin => allowedOrigins.includes(origin))) {
          console.warn('Rejected scanner origin', { origin: req.headers.origin, configuredOrigin: publicOrigin });
          return json(403, { error: 'Use the scanner server address' });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: 'JSON required' });
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Request too large' }); }
          const entry = store.editScan(JSON.parse(body));
          broadcast({ type: 'BOOK_EDITED', scan: entry });
          return json(200, entry);
        } catch (error) { return json(error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/scan/void') {
        const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
        const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
        const requestOrigins = String(req.headers.origin || '').split(',').map(value => value.trim());
        if (req.headers.origin && !requestOrigins.every(origin => allowedOrigins.includes(origin))) {
          console.warn('Rejected scanner origin', { origin: req.headers.origin, configuredOrigin: publicOrigin });
          return json(403, { error: 'Use the scanner server address' });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: 'JSON required' });
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Request too large' }); }
          const entry = store.voidScan(JSON.parse(body));
          broadcast({ type: 'BOOK_VOIDED', scan: entry });
          return json(200, entry);
        } catch (error) { return json(error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.message }); }
      }
      return json(405, { error: 'This operation is unavailable. History is managed on the server; see README.md.' });
    });
}

export function packingApiPlugin(root, options = {}) {
  const attach = server => attachPackingApi(server, root, options);
  return { name: 'packing-api', configureServer: attach, configurePreviewServer: attach };
}
