import * as XLSX from 'xlsx';

// Google Apps Script Webhook receiver & fetch code template (Ultra-Fast 0.1s reader)
export const GOOGLE_APPS_SCRIPT_WEBHOOK_CODE = `
/**
 * FastSearch Webhook & Sync Engine (Ultra-Fast 0.15s)
 * Paste this in Extensions > Apps Script in your Google Sheet,
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 */

var SCAN_START = 4; // First scan row on Scan sheet

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s = ss.getSheetByName("Scan") || ss.getActiveSheet();

    // 1. If an ISBN is sent, write it safely to the next empty row
    if (p.isbn) {
      var isbn = ("" + p.isbn).trim();
      var targetRow = writeIsbnToNextRow_(s, isbn);
      return ContentService.createTextOutput(JSON.stringify({ status: "success", row: targetRow, isbn: isbn }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Fast reader: Reads filled rows and stops at empty tail (takes 0.15s!)
    var vals = s.getRange(SCAN_START, 1, 6000, 1).getValues();
    var isbns = [];
    var emptyStreak = 0;
    for (var i = 0; i < vals.length; i++) {
      var k = ("" + vals[i][0]).replace(/^'/, "").trim();
      if (k) {
        isbns.push(k);
        emptyStreak = 0;
      } else {
        emptyStreak++;
        if (emptyStreak >= 10) break; // Stop after 10 consecutive empty rows
      }
    }

    // Quick count check
    if (p.count) {
      return ContentService.createTextOutput(JSON.stringify({ count: isbns.length }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Full scans array
    return ContentService.createTextOutput(JSON.stringify({ isbns: isbns, count: isbns.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  return doGet(e);
}

// Thread-safe: Lock guarantees only 1 write happens at a time
function writeIsbnToNextRow_(s, isbn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var last = s.getLastRow();
    var targetRow = SCAN_START;
    if (last >= SCAN_START) {
      var vals = s.getRange(SCAN_START, 1, Math.min(6000, last - SCAN_START + 1), 1).getValues();
      var found = false;
      for (var i = 0; i < vals.length; i++) {
        if (("" + vals[i][0]).trim() === "") {
          targetRow = SCAN_START + i;
          found = true;
          break;
        }
      }
      if (!found) targetRow = SCAN_START + vals.length;
    }
    var cell = s.getRange(targetRow, 1);
    cell.setNumberFormat("@");
    cell.setValue(isbn);
    SpreadsheetApp.flush();
    return targetRow;
  } finally {
    lock.releaseLock();
  }
}
`.trim();

const DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzHr-yvrjSuszpQ_8DOR89_ImZNEJWwCLftd_hWNDc97nlHlTC2ckkh7By6oDgOk7dUcQ/exec';

export class PackingManager {
  constructor() {
    this.packedCounts = new Map();
    this.scanLog = [];
    this.webhookUrl = DEFAULT_WEBHOOK_URL;
    this.lastLocalScanTime = 0;
    this.load();
  }

  load() {
    try {
      const savedLogs = localStorage.getItem('fast_search_scans');
      const savedUrl = localStorage.getItem('fast_search_webhook_url');
      if (savedLogs) {
        this.scanLog = JSON.parse(savedLogs);
        this.rebuildPackedCounts();
      }
      if (savedUrl) {
        this.webhookUrl = savedUrl;
      } else {
        this.webhookUrl = DEFAULT_WEBHOOK_URL;
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
      if (this.webhookUrl) {
        localStorage.setItem('fast_search_webhook_url', this.webhookUrl);
      }
    } catch (e) {
      console.warn('Failed to save packing storage:', e);
    }
  }

  setWebhookUrl(url) {
    this.webhookUrl = (url || '').trim() || DEFAULT_WEBHOOK_URL;
    this.save();
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
      targetOrder = candidateRecords[0].Order;
      targetTitle = candidateRecords[0].Title;
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

    if (!skipWebhook) {
      this.sendToLocalApi(logEntry);
    }

    return logEntry;
  }

  // Bulk import existing scans
  importScans(isbnList = [], lookupCandidatesFn) {
    this.clearLogs();
    let importedCount = 0;

    for (let i = 0; i < isbnList.length; i++) {
      const raw = String(isbnList[i] || '').replace(/^'/, '').trim();
      if (!raw) continue;
      const candidates = lookupCandidatesFn ? lookupCandidatesFn(raw) : [];
      this.markPacked(raw, candidates, true);
      importedCount++;
    }

    return importedCount;
  }

  // Check if remote sheet has a different count via local Node API proxy
  async checkRemoteCount() {
    const url = this.webhookUrl || DEFAULT_WEBHOOK_URL;
    try {
      const res = await fetch(`/api/check-remote-count?url=${encodeURIComponent(url.trim())}`);
      const data = await res.json();
      if (typeof data.count === 'number') {
        return data.count;
      }
    } catch (e) {
      // Ignore background poll errors
    }
    return null;
  }

  // Fetch already scanned ISBNs from Google Sheet via local Node API proxy
  async fetchFromGoogleSheet(lookupCandidatesFn) {
    const url = this.webhookUrl || DEFAULT_WEBHOOK_URL;
    let data;
    try {
      const res = await fetch(`/api/fetch-all-scans?url=${encodeURIComponent(url.trim())}`);
      data = await res.json();
    } catch (netErr) {
      throw new Error(`Error connecting to Google Sheet proxy: ${netErr.message}`);
    }

    if (data && data.error) throw new Error(data.error);
    if (data && Array.isArray(data.isbns)) {
      return this.importScans(data.isbns, lookupCandidatesFn);
    }
    return 0;
  }

  // Real-time Local Node API endpoint
  async sendToLocalApi(logEntry) {
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isbn: logEntry.isbn,
          order: logEntry.order,
          title: logEntry.title,
          status: logEntry.status,
          timestamp: logEntry.timestamp,
          webhookUrl: this.webhookUrl || DEFAULT_WEBHOOK_URL
        })
      });
      console.log('⚡ Scan saved locally & queued for Google Sheet:', logEntry.isbn);
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

  clearLogs() {
    this.scanLog = [];
    this.packedCounts.clear();
    this.save();
    try {
      fetch('/api/clear-scans', { method: 'POST' });
    } catch (e) {}
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
