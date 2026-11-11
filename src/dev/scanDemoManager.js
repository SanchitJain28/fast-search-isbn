const books = [
  { isbn: '9789381416044', title: 'Sociology of changing agrarian society', order: 'ZB343' },
  { isbn: '9788186268803', title: 'University Libraries and Space in the Digital World', order: '317' },
  { isbn: '9788197170447', title: 'Navigating Conflict: Northeast India and Beyond', order: 'ZB343' },
];
export const DEMO_ISBNS = { pack: books[0].isbn, duplicate: books[1].isbn, notFound: '9780000000000' };

// This manager has no network, storage, or Sheets access. State lasts only for this demo.
export function createScanDemoManager() {
  let sequence = 0;
  const manager = {
    station: 'Demo station', stationNames: {}, mirror: { enabled: true, pending: 0 },
    getStationLabel(station) { return this.stationNames[station] || station; },
    async updateStationName(name) { this.stationNames = name.trim() ? { [this.station]: name.trim() } : {}; }, connected: true, ready: true, busy: false, pending: null, scanLog: [],
    async markPacked(isbn) {
      const book = books.find(item => item.isbn === isbn);
      const packed = this.scanLog.some(scan => scan.isbn === isbn && scan.statusType === 'PACK');
      const statusType = !book ? 'NOT_FOUND' : packed ? 'DUPLICATE' : 'PACK';
      const scan = { id: `demo-${++sequence}`, seq: sequence, revision: 0, isbn, title: book?.title || '', order: statusType === 'PACK' ? book.order : '', station: this.station, timestamp: new Date().toISOString(), statusType,
        status: statusType === 'PACK' ? `PACK — Order ${book.order}` : statusType === 'DUPLICATE' ? 'DUPLICATE — Already packed. Set aside.' : 'NOT FOUND — Search by title or set aside.' };
      this.scanLog = [scan, ...this.scanLog];
      return scan;
    },
    async editScan(scan, isbn) {
      const normalized = String(isbn).trim().replace(/[\s-]/g, '').toUpperCase();
      if (!/^\d{4,32}X?$/.test(normalized)) throw new Error('Enter a numeric book barcode');
      const existing = this.scanLog.find(row => row.id === scan.id);
      if (!existing || existing.statusType === 'VOID') throw new Error('This scan cannot be edited');
      const book = books.find(item => item.isbn === normalized);
      const used = this.scanLog.some(row => row.id !== scan.id && row.isbn === normalized && row.statusType === 'PACK');
      const statusType = !book ? 'NOT_FOUND' : used ? 'DUPLICATE' : 'PACK';
      const updated = { ...existing, revision: existing.revision + 1, isbn: normalized, title: book?.title || '', order: statusType === 'PACK' ? book.order : '', statusType,
        status: statusType === 'PACK' ? `PACK — Order ${book.order}` : statusType === 'DUPLICATE' ? 'DUPLICATE — Already packed. Set aside.' : 'NOT FOUND — search by title' };
      this.scanLog = this.scanLog.map(row => row.id === scan.id ? updated : row);
      return updated;
    },
    async voidScan(id) {
      this.scanLog = this.scanLog.map(scan => scan.id === id ? { ...scan, statusType: 'VOID', status: `REMOVED${scan.order ? ` (was Order ${scan.order})` : ''}` } : scan);
    },
  };
  // Seed representative history; the first book remains available for a successful demo scan.
  void manager.markPacked(books[1].isbn);
  void manager.markPacked(books[2].isbn);
  return manager;
}
