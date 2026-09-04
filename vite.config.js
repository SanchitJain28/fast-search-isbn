import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Vite plugin providing local real-time API endpoints & SSE hub for multi-user collaboration
function apiServerPlugin() {
  const scansFile = path.resolve(__dirname, 'scans.csv');

  // Initialize scans.csv with header if it doesn't exist
  if (!fs.existsSync(scansFile)) {
    fs.writeFileSync(scansFile, 'ISBN13,Order,Title,Status,Timestamp\n', 'utf8');
  }

  // FIFO Sync Queue to ensure Google Sheet receives scans one-by-one without write storms
  const queue = [];
  let isProcessing = false;
  const recentScans = new Map(); // isbn -> timestamp (to prevent scanner jitter / double posts)

  // Active SSE client connections
  const sseClients = new Set();

  function broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }

  async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item.webhookUrl) continue;

      try {
        const fullUrl = `${item.webhookUrl}${item.webhookUrl.includes('?') ? '&' : '?'}isbn=${encodeURIComponent(item.isbn)}`;
        await fetch(fullUrl);
        console.log(`[Vite API] Synced to Google Sheet: ${item.isbn}`);
      } catch (err) {
        console.warn(`[Vite API] Google Sheet sync error for ${item.isbn}:`, err.message);
      }
      // Small 150ms buffer between calls so Google Sheet formulas calculate smoothly
      await new Promise((r) => setTimeout(r, 150));
    }

    isProcessing = false;
  }

  return {
    name: 'fast-search-api',
    configureServer(server) {
      // HTTP Middlewares
      server.middlewares.use((req, res, next) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

        // 0. GET /api/events - Real-Time Server-Sent Events (SSE) Hub
        if (req.method === 'GET' && parsedUrl.pathname === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no'
          });
          if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
          }

          sseClients.add(res);
          console.log(`[SSE Hub] Packer connected. Total active: ${sseClients.size}`);
          broadcast({ type: 'USER_COUNT', count: sseClients.size });

          req.on('close', () => {
            sseClients.delete(res);
            console.log(`[SSE Hub] Packer disconnected. Total active: ${sseClients.size}`);
            broadcast({ type: 'USER_COUNT', count: sseClients.size });
          });
          return;
        }

        // 1. POST /api/scan - Instant local write + Live WebSocket Broadcast + Google Sheet queue
        if (req.method === 'POST' && parsedUrl.pathname === '/api/scan') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const isbn = String(data.isbn || '').trim();
              const order = String(data.order || '').trim();
              const title = String(data.title || '').replace(/"/g, '""');
              const status = String(data.status || '').replace(/"/g, '""');
              const statusType = data.statusType || 'PACK';
              const timestamp = data.timestamp || new Date().toLocaleTimeString();

              // Deduplicate identical ISBN requests arriving within 600ms
              const now = Date.now();
              const lastSeen = recentScans.get(isbn) || 0;
              if (now - lastSeen < 600) {
                console.warn(`[Vite API] Deduplicated rapid scan for ISBN: ${isbn}`);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, deduplicated: true, isbn }));
                return;
              }
              recentScans.set(isbn, now);

              // 1. Instant local file append (0.1ms backup)
              const csvRow = `"${isbn}","${order}","${title}","${status}","${timestamp}"\n`;
              fs.appendFileSync(scansFile, csvRow, 'utf8');

              const logEntry = {
                id: data.id || `${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                isbn,
                order,
                title: data.title || '',
                status: data.status || '',
                statusType,
                copyNum: data.copyNum || 1,
                totalCopies: data.totalCopies || 1,
                timestamp
              };

              // 2. Broadcast immediately to all connected devices in < 10ms!
              broadcast({
                type: 'BOOK_PACKED',
                scan: logEntry,
                userCount: sseClients.size
              });

              // 3. Queue for real-time Google Sheet update (only for valid PACK scans)
              if (data.webhookUrl && statusType === 'PACK') {
                queue.push({ isbn, webhookUrl: data.webhookUrl });
                processQueue();
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, isbn, queueLength: queue.length }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // 2. GET /api/state - Central initial state for newly connecting devices
        if (req.method === 'GET' && parsedUrl.pathname === '/api/state') {
          try {
            const isbns = [];
            if (fs.existsSync(scansFile)) {
              const content = fs.readFileSync(scansFile, 'utf8');
              const lines = content.split('\n').filter(Boolean).slice(1);
              for (const line of lines) {
                // Extract first quoted value (ISBN)
                const match = line.match(/^"([^"]+)"/);
                if (match && match[1]) {
                  isbns.push(match[1]);
                }
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ isbns, count: isbns.length, userCount: sseClients.size }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // 3. GET /api/check-remote-count - Node backend fetch (CORS/Redirect-free)
        if (req.method === 'GET' && parsedUrl.pathname === '/api/check-remote-count') {
          const targetUrl = parsedUrl.searchParams.get('url');
          if (!targetUrl) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ count: null, error: 'No URL provided' }));
            return;
          }
          (async () => {
            try {
              const fullUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}count=1`;
              const response = await fetch(fullUrl, { redirect: 'follow' });
              const text = await response.text();
              try {
                const data = JSON.parse(text);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
              } catch (pe) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ count: null, raw: text.slice(0, 100) }));
              }
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ count: null, error: err.message }));
            }
          })();
          return;
        }

        // 4. GET /api/fetch-all-scans - Node backend full scans fetch (CORS/Redirect-free)
        if (req.method === 'GET' && parsedUrl.pathname === '/api/fetch-all-scans') {
          const targetUrl = parsedUrl.searchParams.get('url');
          if (!targetUrl) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ isbns: [], error: 'No URL provided' }));
            return;
          }
          (async () => {
            try {
              const response = await fetch(targetUrl, { redirect: 'follow' });
              const text = await response.text();
              try {
                const data = JSON.parse(text);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
              } catch (pe) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ isbns: [], error: 'Invalid JSON from Google Sheet' }));
              }
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ isbns: [], error: err.message }));
            }
          })();
          return;
        }

        // 5. GET /api/scans - Get all locally saved scans
        if (req.method === 'GET' && parsedUrl.pathname === '/api/scans') {
          try {
            if (fs.existsSync(scansFile)) {
              const content = fs.readFileSync(scansFile, 'utf8');
              res.setHeader('Content-Type', 'text/csv');
              res.end(content);
            } else {
              res.end('');
            }
          } catch (err) {
            res.statusCode = 500;
            res.end(err.message);
          }
          return;
        }

        // 6. POST /api/clear-scans - Reset scans file & Broadcast clear
        if (req.method === 'POST' && parsedUrl.pathname === '/api/clear-scans') {
          fs.writeFileSync(scansFile, 'ISBN13,Order,Title,Status,Timestamp\n', 'utf8');
          broadcast({ type: 'SCANS_CLEARED' });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // 7. POST /api/bulk-save-scans - Save master list of scans to central scans.csv
        if (req.method === 'POST' && parsedUrl.pathname === '/api/bulk-save-scans') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              if (Array.isArray(data.scans)) {
                let csvContent = 'ISBN13,Order,Title,Status,Timestamp\n';
                for (const s of data.scans) {
                  const isbn = String(s.isbn || '').trim();
                  const order = String(s.order || '').trim();
                  const title = String(s.title || '').replace(/"/g, '""');
                  const status = String(s.status || '').replace(/"/g, '""');
                  const timestamp = s.timestamp || '';
                  csvContent += `"${isbn}","${order}","${title}","${status}","${timestamp}"\n`;
                }
                fs.writeFileSync(scansFile, csvContent, 'utf8');
                console.log(`[Vite API] Master sync: Saved ${data.scans.length} scans to central storage.`);
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), apiServerPlugin()],
  server: {
    host: true,
    port: 3000,
    open: true
  }
})
