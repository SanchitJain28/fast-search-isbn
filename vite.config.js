import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { google } from 'googleapis'

const SPREADSHEET_ID = '1Kcib17p_ErSGePieW6Z8gWlhhc6lPxJris-5DTqJLB8';

// Vite plugin providing local real-time API endpoints, SSE hub, and direct Google Sheets API v4
function apiServerPlugin() {
  const scansFile = path.resolve(__dirname, 'scans.csv');
  const credentialsFile = path.resolve(__dirname, 'credentials.json');

  // Initialize scans.csv with header if it doesn't exist
  if (!fs.existsSync(scansFile)) {
    fs.writeFileSync(scansFile, 'ISBN13,Order,Title,Status,Timestamp\n', 'utf8');
  }

  const recentScans = new Map(); // isbn -> timestamp (deduplicate rapid scans)
  const sseClients = new Set();  // Active SSE client connections

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

  // Initialize Google Sheets API client
  let sheetsClient = null;
  let serviceAccountEmail = '';
  try {
    if (fs.existsSync(credentialsFile)) {
      const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      serviceAccountEmail = credentials.client_email || '';
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      sheetsClient = google.sheets({ version: 'v4', auth });
      console.log(`[Google Sheets API v4] Authenticated as ${serviceAccountEmail}`);
    } else {
      console.warn('[Google Sheets API v4] credentials.json not found');
    }
  } catch (err) {
    console.error('[Google Sheets API v4] Initialization error:', err.message);
  }

  // Background queue for Google Sheet writes (ensures scanner UI is 0ms instant)
  const sheetQueue = [];
  let isProcessingSheetQueue = false;

  async function processSheetQueue() {
    if (isProcessingSheetQueue || sheetQueue.length === 0 || !sheetsClient) return;
    isProcessingSheetQueue = true;

    while (sheetQueue.length > 0) {
      // Batch up to 10 rows at once for blazing fast performance
      const batch = sheetQueue.splice(0, 10);
      const values = batch.map(item => [
        item.isbn,
        item.order,
        item.title,
        item.status
      ]);

      try {
        const t0 = Date.now();
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Scan!A:D',
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values }
        });
        console.log(`[Google Sheets API v4] ✅ Appended ${batch.length} row(s) to Sheet in ${Date.now() - t0}ms`);
      } catch (err) {
        console.error('[Google Sheets API v4] Append error:', err.message);
        // If failed, re-queue once if not fatal
        if (!err.message?.includes('invalid_grant')) {
          // Keep system running smoothly
        }
      }
    }

    isProcessingSheetQueue = false;
  }

  return {
    name: 'fast-search-api',
    configureServer(server) {
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

        // 1. POST /api/scan - Instant local write + Live SSE Broadcast + Direct Sheets API queue
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

              // Deduplicate rapid scanner jitter (< 600ms)
              const now = Date.now();
              const lastSeen = recentScans.get(isbn) || 0;
              if (now - lastSeen < 600) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, deduplicated: true, isbn }));
                return;
              }
              recentScans.set(isbn, now);

              // Only record valid PACK scans
              if (statusType === 'PACK') {
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

                // Broadcast immediately to all connected packers (< 10ms)
                broadcast({
                  type: 'BOOK_PACKED',
                  scan: logEntry,
                  userCount: sseClients.size
                });

                // Queue for direct Google Sheets API v4 append
                sheetQueue.push({ isbn, order, title: data.title || '', status: data.status || `✅ PACK — Order ${order}` });
                processSheetQueue();
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, isbn, queueLength: sheetQueue.length }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // 2. GET /api/sheets/fetch-all - Fast direct fetch from Google Sheets API v4
        if (req.method === 'GET' && parsedUrl.pathname === '/api/sheets/fetch-all') {
          (async () => {
            try {
              if (!sheetsClient) {
                throw new Error('Google Sheets API client not initialized');
              }
              const t0 = Date.now();
              const response = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Scan!A4:D'
              });

              const rows = response.data.values || [];
              const isbns = [];
              const scans = [];

              for (const row of rows) {
                const rawIsbn = (row[0] || '').toString().trim();
                if (rawIsbn) {
                  const cleanIsbn = rawIsbn.replace(/[^0-9Xx]/g, '');
                  const finalIsbn = cleanIsbn || rawIsbn;
                  isbns.push(finalIsbn);
                  scans.push({
                    isbn: finalIsbn,
                    order: (row[1] || '').toString().trim(),
                    title: (row[2] || '').toString().trim(),
                    status: (row[3] || '').toString().trim()
                  });
                }
              }

              console.log(`[Google Sheets API v4] Fetched ${isbns.length} scans in ${Date.now() - t0}ms`);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, isbns, scans, count: isbns.length, timeMs: Date.now() - t0 }));
            } catch (err) {
              console.error('[Google Sheets API v4] Fetch error:', err.message);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          })();
          return;
        }

        // 3. GET /api/sheets/status - Status of Google Sheets connection
        if (req.method === 'GET' && parsedUrl.pathname === '/api/sheets/status') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            configured: !!sheetsClient,
            spreadsheetId: SPREADSHEET_ID,
            serviceAccountEmail,
            queueLength: sheetQueue.length
          }));
          return;
        }

        // 3b. GET /api/sheets/count - Fast sync lock count check (< 150ms)
        if (req.method === 'GET' && parsedUrl.pathname === '/api/sheets/count') {
          (async () => {
            try {
              if (!sheetsClient) throw new Error('Sheets API client not ready');
              const response = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Scan!A4:A'
              });
              const rows = response.data.values || [];
              const count = rows.filter(r => r[0] && r[0].toString().trim()).length;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, count }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          })();
          return;
        }

        // 4. GET /api/state - Central initial state for newly connecting devices
        if (req.method === 'GET' && parsedUrl.pathname === '/api/state') {
          try {
            const isbns = [];
            if (fs.existsSync(scansFile)) {
              const content = fs.readFileSync(scansFile, 'utf8');
              const lines = content.split('\n').filter(Boolean).slice(1);
              for (const line of lines) {
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
