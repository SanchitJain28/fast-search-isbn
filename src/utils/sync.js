import * as XLSX from 'xlsx';

export class PackingManager {
  constructor() {
    this.packedCounts = new Map();
    this.scanLog = [];
    this.lastLocalScanTime = 0;
    this.connectedUsers = 1;
    this.listeners = new Set();
    this.eventSource = null;
    this.load();
    this.initRealtimeSync();
  }

  load() {
    try {
      const savedLogs = localStorage.getItem('fast_search_scans');
      if (savedLogs) {
        this.scanLog = JSON.parse(savedLogs);
        this.rebuildPackedCounts();
      }
    } catch (e) {
      console.warn('Failed to load packing storage:', e);
    }
  }

  rebuildPackedCounts() {
    this.packedCounts.clear();
    for (const scan of this.scanLog) {
      if (scan.statusType === 'PACK') {
        const cur = this.packedCounts.get(scan.isbn) || 0;
        this.packedCounts.set(scan.isbn, cur + 1);
      }
    }
  }

  save() {
    try {
      localStorage.setItem('fast_search_scans', JSON.stringify(this.scanLog));
    } catch (e) {
      console.warn('Failed to save packing storage:', e);
    }
  }

  // Subscribe to real-time events (incoming scans from other packers, user count changes)
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners(type, data) {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch (e) {
        console.error('Listener error:', e);
      }
    }
  }

  // Real-time EventSource (SSE) connection to local central pool
  initRealtimeSync() {
    if (typeof window === 'undefined') return;

    try {
      if (this.eventSource) {
        this.eventSource.close();
      }

      this.eventSource = new EventSource('/api/events');

      this.eventSource.onopen = () => {
        console.log('⚡ [Realtime Pool] Connected to Central Live Hub');
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'USER_COUNT') {
            this.connectedUsers = data.count || 1;
            this.notifyListeners('USER_COUNT', this.connectedUsers);
          } else if (data.type === 'BOOK_PACKED' && data.scan) {
            const incoming = data.scan;
            // Check if we already have this scan registered locally
            const exists = this.scanLog.some(s => s.id === incoming.id);
            if (!exists) {
              this.scanLog.unshift(incoming);
              if (incoming.statusType === 'PACK') {
                const cur = this.packedCounts.get(incoming.isbn) || 0;
                this.packedCounts.set(incoming.isbn, cur + 1);
              }
              this.lastLocalScanTime = Date.now();
              this.save();
              console.log(`📡 [Realtime Broadcast] Remote pack received: ${incoming.isbn} (${incoming.title})`);
              this.notifyListeners('BOOK_PACKED', incoming);
            }
          } else if (data.type === 'SCANS_CLEARED') {
            this.scanLog = [];
            this.packedCounts.clear();
            this.save();
            this.notifyListeners('SCANS_CLEARED');
          }
        } catch (e) {
          console.warn('Realtime message parse error:', e);
        }
      };

      this.eventSource.onerror = (err) => {
        // EventSource will automatically reconnect in background
      };
    } catch (e) {
      console.warn('Realtime connection error:', e);
    }
  }

  // Sync initial state from central server on page load
  async syncInitialStateFromServer(lookupCandidatesFn) {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.userCount === 'number') {
          this.connectedUsers = Math.max(1, data.userCount);
          this.notifyListeners('USER_COUNT', this.connectedUsers);
        }
        if (Array.isArray(data.isbns) && data.isbns.length > 0) {
          if (this.scanLog.length < data.isbns.length) {
            this.importScans(data.isbns, lookupCandidatesFn);
            console.log(`⚡ [Initial Sync] Synced ${data.isbns.length} master scans from central pool.`);
            return data.isbns.length;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to sync initial state from central server:', e);
    }
    return 0;
  }

  getPackedCount(isbn) {
    return this.packedCounts.get(String(isbn).trim()) || 0;
  }

  // Pack a single book
  markPacked(isbn, candidateRecords = [], skipWebhook = false) {
    const cleanIsbn = String(isbn || '').trim();
    if (!cleanIsbn) return { error: 'Empty ISBN' };

    const totalCopies = candidateRecords.length;
    const currentPacked = this.getPackedCount(cleanIsbn);

    let statusText = '';
    let statusType = 'PACK';
    let targetOrder = '';
    let targetTitle = '';

    if (totalCopies === 0) {
      statusType = 'NOT_FOUND';
      statusText = '❌ NOT FOUND — search by name';
    } else if (currentPacked >= totalCopies) {
      statusType = 'DUPLICATE';
      statusText = `⛔ DUPLICATE (${currentPacked}/${totalCopies} packed) — set aside`;
      targetOrder = candidateRecords[0]?.Order || '—';
      targetTitle = candidateRecords[0]?.Title || '';

      const dupLogEntry = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        isbn: cleanIsbn,
        order: targetOrder,
        title: targetTitle,
        status: statusText,
        statusType: 'DUPLICATE',
        copyNum: currentPacked,
        totalCopies: totalCopies,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };

      // When importing existing historical scans from Google Sheet, keep it in scanLog
      if (skipWebhook) {
        this.scanLog.unshift(dupLogEntry);
        this.save();
      }

      return dupLogEntry;
    } else {
      const targetItem = candidateRecords[currentPacked];
      const nextCopy = currentPacked + 1;
      targetOrder = targetItem.Order;
      targetTitle = targetItem.Title;
      statusType = 'PACK';

      if (totalCopies > 1) {
        statusText = `✅ PACK — Order ${targetOrder} (copy ${nextCopy} of ${totalCopies})`;
      } else {
        statusText = `✅ PACK — Order ${targetOrder}`;
      }

      this.packedCounts.set(cleanIsbn, currentPacked + 1);
    }

    const logEntry = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      isbn: cleanIsbn,
      order: targetOrder,
      title: targetTitle,
      status: statusText,
      statusType: statusType,
      copyNum: currentPacked + 1,
      totalCopies: totalCopies,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    this.scanLog.unshift(logEntry);
    this.lastLocalScanTime = Date.now();
    this.save();

    // Send to central server (only valid PACK scans)
    if (!skipWebhook && statusType === 'PACK') {
      this.sendToLocalApi(logEntry);
    }

    return logEntry;
  }

  // Bulk import existing scans
  importScans(isbnList = [], lookupCandidatesFn) {
    this.clearLogs(true);
    let importedCount = 0;

    for (let i = 0; i < isbnList.length; i++) {
      const raw = String(isbnList[i] || '').replace(/^'/, '').trim();
      if (!raw) continue;
      const candidates = lookupCandidatesFn ? lookupCandidatesFn(raw) : [];
      const res = this.markPacked(raw, candidates, true);
      if (res && res.statusType === 'PACK') {
        importedCount++;
      }
    }

    // Save to central server storage so all connected devices immediately get this master state
    try {
      fetch('/api/bulk-save-scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scans: this.scanLog })
      });
    } catch (e) {}

    return importedCount;
  }

  // Directly import an Excel workbook (.xlsx, .xls, .csv) with zero server latency
  async importExcelFile(file, lookupCandidatesFn) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });

          // Find 'Scan' sheet or fallback to the first sheet
          const sheetName =
            workbook.SheetNames.find((n) => n.toLowerCase().includes('scan')) ||
            workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

          const isbns = [];
          for (let i = 0; i < jsonRows.length; i++) {
            const row = jsonRows[i];
            if (row && row[0]) {
              const val = String(row[0]).replace(/^'/, '').trim();
              if (val && !val.toLowerCase().startsWith('isbn') && !val.toLowerCase().startsWith('order')) {
                isbns.push(val);
              }
            }
          }

          const count = this.importScans(isbns, lookupCandidatesFn);
          resolve({ count, sheetName, totalRows: isbns.length });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  }

  // Fetch all scans directly from Google Sheets API v4 in < 1 second!
  async fetchFromGoogleSheet(lookupCandidatesFn) {
    try {
      const res = await fetch('/api/sheets/fetch-all');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.isbns || !Array.isArray(data.isbns)) {
        throw new Error('Invalid response from Google Sheets API');
      }
      const count = this.importScans(data.isbns, lookupCandidatesFn);
      console.log(`⚡ [Google Sheets API v4] Successfully imported ${count} packed books (${data.isbns.length} total rows) in ${data.timeMs || 0}ms.`);
      return count;
    } catch (err) {
      console.error('Fetch from Google Sheets error:', err);
      throw err;
    }
  }

  // Real-time Local Node API endpoint (Saves in 0.1ms & Broadcasts in <5ms)
  async sendToLocalApi(logEntry) {
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: logEntry.id,
          isbn: logEntry.isbn,
          order: logEntry.order,
          title: logEntry.title,
          status: logEntry.status,
          statusType: logEntry.statusType,
          copyNum: logEntry.copyNum,
          totalCopies: logEntry.totalCopies,
          timestamp: logEntry.timestamp
        })
      });
      console.log('⚡ Scan saved to central storage & broadcasted:', logEntry.isbn);
    } catch (e) {
      console.warn('Local API error:', e);
    }
  }

  getProgress(orderTotals = {}) {
    const progress = {};
    for (const [ord, total] of Object.entries(orderTotals)) {
      progress[ord] = {
        order: ord,
        total: total,
        packed: 0,
        remaining: total,
        pct: 0
      };
    }

    let totalPacked = 0;
    let duplicates = 0;
    let notFound = 0;

    for (const scan of this.scanLog) {
      if (scan.statusType === 'PACK') {
        totalPacked++;
        const o = scan.order;
        if (progress[o]) {
          progress[o].packed++;
          progress[o].remaining = Math.max(0, progress[o].total - progress[o].packed);
          progress[o].pct = Math.round((progress[o].packed / progress[o].total) * 100);
        }
      } else if (scan.statusType === 'DUPLICATE') {
        duplicates++;
      } else if (scan.statusType === 'NOT_FOUND') {
        notFound++;
      }
    }

    return {
      orders: Object.values(progress),
      totalScanned: this.scanLog.length,
      totalPacked: totalPacked,
      duplicates: duplicates,
      notFound: notFound
    };
  }

  clearLogs(skipApi = false) {
    this.scanLog = [];
    this.packedCounts.clear();
    this.save();
    if (!skipApi) {
      try {
        fetch('/api/clear-scans', { method: 'POST' });
      } catch (e) {}
    }
  }

  exportExcel(orderTotals = {}) {
    const wb = XLSX.utils.book_new();

    // 1. Scan Log Sheet
    const scanData = this.scanLog.map(s => ({
      'ISBN13': s.isbn,
      'Order': s.order,
      'Title': s.title,
      'Status': s.status,
      'Time': s.timestamp
    }));
    const wsScans = XLSX.utils.json_to_sheet(scanData);
    XLSX.utils.book_append_sheet(wb, wsScans, 'Scan Log');

    // 2. Progress Summary Sheet
    const prog = this.getProgress(orderTotals);
    const summaryData = prog.orders.map(o => ({
      'Order (Box)': o.order,
      'Total Ordered': o.total,
      'Packed': o.packed,
      'Remaining': o.remaining,
      'Completion %': `${o.pct}%`
    }));
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Progress Dashboard');

    XLSX.writeFile(wb, `Packing_Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
}

export const packingManager = new PackingManager();
