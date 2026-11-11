import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isbn10To13 } from './isbn.js';

export const normalizeIsbn = value => String(value ?? '').trim().replace(/^'/, '').replace(/[\s-]/g, '').toUpperCase();

function bookBarcode(isbn) {
  return /^\d{9}[\dX]$/.test(isbn) ? isbn10To13(isbn) : isbn;
}

export class PackingStore {
  constructor(filename, catalog, amazonEditions) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, isbn TEXT NOT NULL,
        order_name TEXT NOT NULL, title TEXT NOT NULL, status_type TEXT NOT NULL,
        status TEXT NOT NULL, copy_num INTEGER NOT NULL, total_copies INTEGER NOT NULL,
        allocation TEXT UNIQUE, created_at TEXT NOT NULL, station TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS scans_isbn ON scans(isbn);
      CREATE INDEX IF NOT EXISTS scans_pending ON scans(synced, seq);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(scans)').all().map(column => column.name));
    if (!columns.has('revision')) this.db.exec('ALTER TABLE scans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('scanned_isbn')) this.db.exec('ALTER TABLE scans ADD COLUMN scanned_isbn TEXT');
    if (!columns.has('request_isbn')) this.db.exec('ALTER TABLE scans ADD COLUMN request_isbn TEXT');
    if (!columns.has('printed_isbn')) this.db.exec('ALTER TABLE scans ADD COLUMN printed_isbn TEXT');
    if (!columns.has('cover_request_hash')) this.db.exec('ALTER TABLE scans ADD COLUMN cover_request_hash TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scans_cover_request ON scans(cover_request_hash) WHERE cover_request_hash IS NOT NULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS scan_edits (
      edit_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      previous_json TEXT NOT NULL, updated_json TEXT NOT NULL, edited_at TEXT NOT NULL)`);
    this.catalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    this.byIsbn = new Map();
    catalog.forEach((r, index) => {
      const isbn = normalizeIsbn(r.ISBN13);
      if (!isbn) return;
      const copies = this.byIsbn.get(isbn) || [];
      const author = String(r.Author ?? '').trim();
      copies.push({ order: String(r.Order).trim(), title: String(r.Title || ''), allocation: String(index), ...(author ? { author } : {}) });
      this.byIsbn.set(isbn, copies);
    });
    this.amazonByBarcode = new Map();
    this.amazonConflicts = new Map();
    if (amazonEditions) {
      for (const { barcode, targets } of amazonEditions.conflicts) this.amazonConflicts.set(barcode, targets);
      for (const { barcode, poIsbn, order, quantity } of amazonEditions.mappings) {
        const copies = (this.byIsbn.get(poIsbn) || []).filter(copy => copy.order === order);
        if (!/^97[89]\d{10}$/.test(barcode) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > copies.length ||
            this.amazonByBarcode.has(barcode) || this.amazonConflicts.has(barcode)) {
          throw new Error(`Invalid Amazon mapping for ${barcode} / ${poIsbn} / ${order}`);
        }
        this.amazonByBarcode.set(barcode, { poIsbn, order, quantity, copies });
      }
      // An append to the PO catalog can make a previously unique barcode ambiguous.
      for (const [isbn, copies] of this.byIsbn) {
        const barcode = bookBarcode(isbn);
        const mapping = this.amazonByBarcode.get(barcode);
        if (!mapping) continue;
        const targets = new Set(copies.map(copy => copy.order));
        this.amazonConflicts.set(barcode, [[mapping.poIsbn, mapping.order], ...[...targets].map(order => [isbn, order])]);
        this.amazonByBarcode.delete(barcode);
      }
    }
  }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value)); }
  get ready() { return this.getMeta('catalog') === this.catalogHash && this.getMeta('ready') === 'yes'; }
  initializeEmpty() {
    if (this.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n) throw new Error('Database already contains history');
    this.setMeta('catalog', this.catalogHash); this.setMeta('ready', 'yes');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  serialize(r) {
    return { seq: r.seq, id: r.id, isbn: r.isbn, order: r.order_name, title: r.title,
      ...(r.scanned_isbn ? { scannedIsbn: r.scanned_isbn } : {}),
      ...(r.cover_request_hash ? { source: 'cover' } : {}),
      ...(r.printed_isbn ? { printedIsbn: r.printed_isbn } : {}),
      statusType: r.status_type, status: r.status, copyNum: r.copy_num, totalCopies: r.total_copies,
      revision: r.revision, createdAt: r.created_at, timestamp: r.created_at, station: r.station };
  }
  insert(entry, allocation = null) {
    this.db.prepare(`INSERT INTO scans (id,isbn,order_name,title,status_type,status,copy_num,total_copies,allocation,created_at,station,scanned_isbn,request_isbn,printed_isbn,cover_request_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(entry.id, entry.isbn, entry.order, entry.title, entry.statusType,
      entry.status, entry.copyNum, entry.totalCopies, allocation, entry.createdAt, entry.station, entry.scannedIsbn || null,
      entry.scannedIsbn || entry.isbn, entry.printedIsbn || null, entry.coverRequestHash || null);
    return this.serialize(this.db.prepare('SELECT * FROM scans WHERE id=?').get(entry.id));
  }
  getPackedState(isbn, { mapping, barcode, excludeId = '' } = {}) {
    const copies = mapping?.copies || this.byIsbn.get(isbn) || [];
    const allocated = this.db.prepare('SELECT allocation, scanned_isbn FROM scans WHERE isbn=? AND id<>? AND allocation IS NOT NULL').all(isbn, excludeId);
    const used = new Set(allocated.map(row => row.allocation));
    const available = copies.filter(copy => !used.has(copy.allocation));
    const quotaUsed = mapping ? allocated.filter(row => row.scanned_isbn && bookBarcode(row.scanned_isbn) === barcode).length : 0;
    const quotaRemaining = mapping ? Math.max(0, mapping.quantity - quotaUsed) : null;
    return {
      copies, packed: copies.length - available.length,
      available: quotaRemaining === null ? available : available.slice(0, quotaRemaining),
      quotaReached: quotaRemaining === 0,
    };
  }
  decide(scannedIsbn, excludeId = '') {
    const barcode = bookBarcode(scannedIsbn);
    const conflict = this.amazonConflicts.get(barcode);
    if (conflict) {
      const targets = conflict.map(([isbn, order]) => `${order} / ${isbn}`).join(', ');
      return { isbn: scannedIsbn, order: '', title: '', statusType: 'REVIEW',
        status: `REVIEW — Set aside. Confirm the PO and box: ${targets}`, copyNum: 0, totalCopies: 0 };
    }
    const mapping = this.amazonByBarcode.get(barcode);
    return this.decideMaster(mapping?.poIsbn || scannedIsbn, { mapping, barcode, scannedIsbn, excludeId });
  }
  decideMaster(isbn, { mapping, barcode, scannedIsbn, excludeId } = {}) {
    const { copies, packed, available: [next], quotaReached } = this.getPackedState(isbn, { mapping, barcode, excludeId });
    const statusType = !copies.length ? 'NOT_FOUND' : next ? 'PACK' : 'DUPLICATE';
    const copyNum = packed + (next ? 1 : 0);
    const order = next?.order || '';
    const note = mapping ? ` · Amazon ISBN ${scannedIsbn} → PO ISBN ${isbn}` : '';
    const status = next ? `PACK — Order ${order}${copies.length > 1 ? ` (copy ${copyNum} of ${copies.length})` : ''}`
      : quotaReached ? `DUPLICATE — All ${mapping.quantity} Amazon copies recorded for Order ${mapping.order}. Set aside.`
      : copies.length ? `DUPLICATE — ${copies.length}/${copies.length} already packed${mapping ? ` for Order ${mapping.order}` : ''}. Set aside.`
      : 'NOT FOUND — search by title';
    return { isbn, scannedIsbn: mapping ? scannedIsbn : null, order, title: next?.title || copies[0]?.title || '',
      statusType, status: status + note, copyNum, totalCopies: copies.length, allocation: next?.allocation };
  }
  scan({ id, isbn: raw, station = '' }) {
    const isbn = normalizeIsbn(raw);
    if (!/^\d{4,32}X?$/.test(isbn)) throw Object.assign(new Error('Scan a numeric book barcode (4–32 digits, optionally ending in X)'), { status: 400 });
    if (typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id)) throw Object.assign(new Error('Invalid request ID'), { status: 400 });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id);
      if (existing) {
        if (existing.cover_request_hash) throw Object.assign(new Error('Request ID belongs to a cover confirmation'), { status: 409 });
        if ((existing.request_isbn || existing.isbn) !== isbn) throw Object.assign(new Error('Request ID belongs to a different ISBN'), { status: 409 });
        return this.serialize(existing);
      }
      if (!this.ready) throw Object.assign(new Error('Import and reconcile existing scans before starting. See README.md.'), { status: 409 });
      const decision = this.decide(isbn);
      return this.insert({ ...decision, id, createdAt: new Date().toISOString(), station: String(station).slice(0, 80) }, decision.allocation);
    });
  }
  confirmCover(request, verifySelection) {
    const { id, isbn, order, catalogVersion, confirmationToken, station } = request;
    const coverRequestHash = createHash('sha256').update(JSON.stringify([isbn, order, catalogVersion, confirmationToken])).digest('hex');
    const conflict = (code, message, selection) => Object.assign(new Error(message), { status: 409, code, selection });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id);
      if (existing) {
        if (existing.cover_request_hash !== coverRequestHash) throw conflict('REQUEST_ID_CONFLICT', 'Request ID belongs to another scan or selection.');
        return { scan: this.serialize(existing), created: false };
      }
      if (!this.ready || catalogVersion !== this.catalogHash) throw conflict('CATALOG_CHANGED', 'The packing catalog changed. Look up this book again.');
      if (this.db.prepare('SELECT 1 FROM scans WHERE cover_request_hash=?').get(coverRequestHash)) {
        throw conflict('SELECTION_USED', 'This selection was already confirmed. Refresh the lookup.');
      }
      const selection = verifySelection(request);
      const decision = selection.barcode ? this.decide(selection.barcode) : this.decideMaster(isbn);
      if (decision.statusType !== 'PACK' || decision.isbn !== isbn || decision.order !== order || decision.allocation !== selection.allocation) {
        throw conflict('STALE_CANDIDATE', 'The next available copy changed. Review the refreshed result.', selection);
      }
      const scan = this.insert({ ...decision, id, station, createdAt: new Date().toISOString(),
        coverRequestHash, printedIsbn: selection.printedIsbn }, decision.allocation);
      return { scan, created: true };
    });
  }
  editScan({ id, isbn: raw, expectedRevision, editId }) {
    const isbn = normalizeIsbn(raw);
    const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
    if (!/^\d{4,32}X?$/.test(isbn)) fail('Enter a numeric book barcode (4–32 digits, optionally ending in X)');
    if (typeof id !== 'string' || !id || typeof editId !== 'string' || !/^[\w-]{8,100}$/.test(editId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Invalid correction request');
    const signature = createHash('sha256').update(JSON.stringify([id, isbn, expectedRevision])).digest('hex');
    return this.transaction(() => {
      const replay = this.db.prepare('SELECT * FROM scan_edits WHERE edit_id=?').get(editId);
      if (replay) {
        if (replay.request_hash !== signature) fail('Correction request ID belongs to a different change', 409);
        return this.serialize(this.db.prepare('SELECT * FROM scans WHERE id=?').get(id));
      }
      const existing = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id);
      if (!existing) fail('Scan not found', 404);
      if (!this.ready) fail('Reconcile the catalog before editing scans', 409);
      if (existing.status_type === 'VOID') fail('Voided scans cannot be edited', 409);
      const layout = JSON.parse(this.getMeta('mainScanLayout') || 'null');
      if (layout && existing.seq < layout.startSeq) fail('Imported historical rows cannot be edited here; their Sheet mapping requires reconciliation', 409);
      if (existing.revision !== expectedRevision) fail('This row changed at another station. Refresh it before editing again.', 409);
      const before = this.serialize(existing);
      if ((existing.scanned_isbn || existing.isbn) !== isbn) {
        const next = this.decide(isbn, id);
        this.db.prepare(`UPDATE scans SET isbn=?, scanned_isbn=?, request_isbn=COALESCE(request_isbn,isbn),
          order_name=?, title=?, status_type=?, status=?, copy_num=?, total_copies=?, allocation=?, synced=0, revision=revision+1 WHERE id=?`)
          .run(next.isbn, next.scannedIsbn || null, next.order, next.title, next.statusType, next.status,
            next.copyNum, next.totalCopies, next.allocation || null, id);
      }
      const updated = this.serialize(this.db.prepare('SELECT * FROM scans WHERE id=?').get(id));
      this.db.prepare('INSERT INTO scan_edits VALUES (?,?,?,?,?,?)').run(editId, id, signature, JSON.stringify(before), JSON.stringify(updated), new Date().toISOString());
      return updated;
    });
  }
  voidScan({ id, station = '' }) {
    if (typeof id !== 'string' || !id) throw Object.assign(new Error('Invalid scan ID'), { status: 400 });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id);
      if (!existing) throw Object.assign(new Error('Scan not found'), { status: 404 });
      if (existing.status_type === 'VOID') throw Object.assign(new Error('Scan is already voided'), { status: 400 });
      const note = existing.scanned_isbn ? ` · Amazon ISBN ${existing.scanned_isbn} → PO ISBN ${existing.isbn}` : '';
      const voidStatus = `⛔ REMOVED${existing.order_name ? ` (was Order ${existing.order_name})` : ''}${note}`;
      this.db.prepare('UPDATE scans SET status_type=?, status=?, allocation=NULL, synced=0, revision=revision+1 WHERE id=?')
        .run('VOID', voidStatus, id);
      return this.serialize(this.db.prepare('SELECT * FROM scans WHERE id=?').get(id));
    });
  }
  findScan(id) { const row = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id); return row ? this.serialize(row) : null; }
  list() { return this.db.prepare('SELECT * FROM scans ORDER BY seq DESC').all().map(r => this.serialize(r)); }
  pending(limit = 100) { return this.db.prepare('SELECT * FROM scans WHERE synced=0 ORDER BY seq LIMIT ?').all(limit).map(r => this.serialize(r)); }
  acknowledge(rows) {
    this.transaction(() => { for (const row of rows) {
      if (typeof row === 'number') this.db.prepare('UPDATE scans SET synced=1 WHERE seq=?').run(row);
      else this.db.prepare('UPDATE scans SET synced=1 WHERE seq=? AND revision=?').run(row.seq, row.revision);
    } });
  }
  stats() { return { ready: this.ready, count: this.db.prepare('SELECT COUNT(*) AS n FROM scans').get().n,
    pending: this.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE synced=0').get().n }; }
  close() { this.db.close(); }
}
