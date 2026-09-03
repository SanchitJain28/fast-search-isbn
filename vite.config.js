import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Vite plugin providing local real-time API endpoints for scanning & sheets sync
function apiServerPlugin() {
  const scansFile = path.resolve(__dirname, 'scans.csv');

  // Initialize scans.csv with header if it doesn't exist
  if (!fs.existsSync(scansFile)) {
    fs.writeFileSync(scansFile, 'ISBN13,Order,Title,Status,Timestamp\n', 'utf8');
  }

  // FIFO Sync Queue to ensure Google Sheet receives scans one-by-one without write storms
  const queue = [];
  let isProcessing = false;

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
      server.middlewares.use((req, res, next) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

        // 1. POST /api/scan - Instant local write + Google Sheet queue
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
              const timestamp = data.timestamp || new Date().toLocaleTimeString();

              // 1. Instant local file append (0.1ms backup)
              const csvRow = `"${isbn}","${order}","${title}","${status}","${timestamp}"\n`;
              fs.appendFileSync(scansFile, csvRow, 'utf8');

              // 2. Queue for real-time Google Sheet update
              if (data.webhookUrl) {
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

        // 2. GET /api/check-remote-count - Node backend fetch (CORS/Redirect-free)
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

        // 3. GET /api/fetch-all-scans - Node backend full scans fetch (CORS/Redirect-free)
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

        // 4. GET /api/scans - Get all locally saved scans
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

        // 5. POST /api/clear-scans - Reset scans file
        if (req.method === 'POST' && parsedUrl.pathname === '/api/clear-scans') {
          fs.writeFileSync(scansFile, 'ISBN13,Order,Title,Status,Timestamp\n', 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
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
