import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import { google } from 'googleapis';

// Fixed row addresses make retries safe even if Google saved a request but its response was lost.
export class SheetMirror {
  constructor(store, { client, spreadsheetId, tab = 'Scanner Log', enabled = false, batchSize = 100 } = {}) {
    this.store = store; this.client = client; this.spreadsheetId = spreadsheetId; this.tab = tab;
    this.batchSize = Math.max(1, Math.min(1000, Number(batchSize) || 100));
    this.enabled = enabled; this.running = false; this.lastError = ''; this.lastSuccess = null;
    this.nextAttempt = 0; this.failures = 0;
  }
  status() { return { enabled: this.enabled, configured: !!this.client && !!this.spreadsheetId, tab: this.tab,
    pending: this.store.stats().pending, lastError: this.lastError, lastSuccess: this.lastSuccess }; }
  async flush() {
    if (!this.enabled || !this.client || !this.spreadsheetId || this.running || Date.now() < this.nextAttempt) return;
    this.running = true;
    try {
      const identity = JSON.stringify([this.spreadsheetId, this.tab]);
      if (this.store.getMeta('mirrorTarget') && this.store.getMeta('mirrorTarget') !== identity) throw new Error('Mirror destination changed; restore original settings before syncing');
      const mainScanLayout = JSON.parse(this.store.getMeta('mainScanLayout') || 'null');
      if (mainScanLayout) {
        await this.flushMainScan(mainScanLayout);
      } else {
      if (!this.store.getMeta('mirrorTarget')) {
        const doc = await this.client.spreadsheets.get({ spreadsheetId: this.spreadsheetId }, { timeout: 15000 });
        const pending = JSON.parse(this.store.getMeta('mirrorCreating') || 'null');
        if (pending && pending.identity !== identity) throw new Error('Finish creating the original mirror destination before changing settings');
        const existing = doc.data.sheets.find(s => s.properties.title === this.tab);
        if (existing && (!pending || existing.properties.sheetId !== pending.sheetId)) throw new Error(`Use a new destination tab name; ${this.tab} already exists`);
        const sheetId = pending?.sheetId ?? randomInt(1, 1000000000);
        this.store.setMeta('mirrorCreating', JSON.stringify({ identity, sheetId }));
        if (!existing) await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: this.tab, sheetId } } }] } }, { timeout: 15000 });
        this.store.setMeta('mirrorTarget', identity);
      }
      const rows = this.store.pending(this.batchSize);
      const quotedTab = `'${this.tab.replace(/'/g, "''")}'`;
      const data = [{ range: `${quotedTab}!A1:I1`, values: [['ISBN13', 'Order', 'Title', 'Status', 'Time', 'Station', 'Request ID', 'Result', 'Copy']] },
        ...rows.map(r => ({ range: `${quotedTab}!A${r.seq + 1}:I${r.seq + 1}`, values: [[r.isbn, r.order, r.title, r.status, r.createdAt, r.station, r.id, r.statusType, r.copyNum]] }))];
      if (rows.length) {
        // Grow the dedicated tab before writing beyond its default row capacity.
        const doc = await this.client.spreadsheets.get({ spreadsheetId: this.spreadsheetId }, { timeout: 15000 });
        const sheet = doc.data.sheets.find(s => s.properties.title === this.tab)?.properties;
        if (!sheet) throw new Error('Mirror tab was removed');
        const required = rows[rows.length - 1].seq + 1;
        if (sheet.gridProperties.rowCount < required) await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId,
          requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: sheet.sheetId, gridProperties: { rowCount: required + 1000 } }, fields: 'gridProperties.rowCount' } }] } }, { timeout: 15000 });
        await this.client.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { valueInputOption: 'RAW', data } }, { timeout: 15000 });
        this.store.acknowledge(rows);
      }
      }
      this.lastError = ''; this.failures = 0; this.nextAttempt = 0; this.lastSuccess = new Date().toISOString();
    } catch (error) {
      this.lastError = error.message; this.failures++;
      this.nextAttempt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(this.failures, 6));
    } finally { this.running = false; }
  }
  async flushMainScan(layout) {
    if (layout.spreadsheetId !== this.spreadsheetId || layout.tab !== this.tab ||
        ![layout.sheetId, layout.startSeq, layout.startRow].every(Number.isSafeInteger) || layout.startSeq < 1 || layout.startRow < 4) {
      throw new Error('Main Scan mapping does not match the configured destination');
    }
    const rows = this.store.pending(this.batchSize);
    if (!rows.length) return;
    if (rows.some(row => row.seq < layout.startSeq)) throw new Error('Historical Scan rows require reconciliation; automatic overwrite refused');
    const doc = await this.client.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' }, { timeout: 15000 });
    const sheet = doc.data.sheets.find(s => s.properties.sheetId === layout.sheetId && s.properties.title === this.tab)?.properties;
    if (!sheet || sheet.gridProperties.columnCount < 10) throw new Error('Main Scan destination or tracking columns were changed');
    const targetRow = scan => layout.startRow + scan.seq - layout.startSeq;
    const first = targetRow(rows[0]), last = targetRow(rows.at(-1));
    if (sheet.gridProperties.rowCount < last) {
      await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: sheet.sheetId, gridProperties: { rowCount: last + 1000 } }, fields: 'gridProperties.rowCount' } }] } }, { timeout: 15000 });
    }
    const quoted = `'${this.tab.replace(/'/g, "''")}'`;
    const response = await this.client.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId,
      range: `${quoted}!A${first}:J${last}`, valueRenderOption: 'UNFORMATTED_VALUE' }, { timeout: 15000 });
    const existing = response.data.values || [];
    const data = rows.map(scan => {
      const row = targetRow(scan), cells = existing[row - first] || [];
      const sameRequest = String(cells[5] || '') === scan.id && Number(cells[6]) === scan.seq;
      if (!sameRequest && cells.some(value => String(value ?? '').trim() !== '')) {
        throw new Error(`Scan row ${row} contains another entry. Reporting paused to preserve it; review the sheet before retrying.`);
      }
      return { range: `${quoted}!A${row}:J${row}`, values: [mainScanValues(scan)] };
    });
    await this.client.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data } }, { timeout: 15000 });
    this.store.acknowledge(rows);
  }
}

export function mainScanValues(scan) {
  const order = scan.statusType === 'PACK' ? scan.order : scan.statusType === 'NOT_FOUND' ? 'NOT FOUND' : '—';
  return [scan.isbn, order, scan.title, scan.status, scan.createdAt, scan.id, scan.seq, scan.station, scan.statusType, scan.copyNum];
}
export function createMirror(store, root, env = process.env) {
  let client, configurationError;
  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS || `${root}/credentials.json`;
  if (env.SHEETS_SYNC_ENABLED === 'true' && fs.existsSync(credentialsPath)) {
    try {
      const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(fs.readFileSync(credentialsPath, 'utf8')), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      client = google.sheets({ version: 'v4', auth });
    } catch { configurationError = 'Google credentials could not be read. Fix the server credentials and restart; scanning remains available.'; }
  }
  const mirror = new SheetMirror(store, { client, spreadsheetId: env.SHEETS_SPREADSHEET_ID,
    tab: env.SHEETS_SCANNER_TAB || 'Scanner Log', enabled: env.SHEETS_SYNC_ENABLED === 'true', batchSize: env.SHEETS_BATCH_SIZE });
  if (configurationError) mirror.lastError = configurationError;
  return mirror;
}
