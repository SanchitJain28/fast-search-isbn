import * as XLSX from 'xlsx';

function requestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export class PackingManager {
  constructor(options = {}) {
    this.storage = options.storage || globalThis.localStorage;
    this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
    this.EventSource = options.EventSource || globalThis.EventSource;
    this.autoRecovery = options.autoRecovery ?? (typeof window !== 'undefined');
    this.setTimeout = options.setTimeout || ((...args) => globalThis.setTimeout(...args));
    this.clearTimeout = options.clearTimeout || (timer => globalThis.clearTimeout(timer));
    this.now = options.now || Date.now;
    this.recoveryAttempts = 0;
    this.events = options.events || (typeof window !== 'undefined' ? window : null);
    this.onOnline = () => { void this.health(); this.scheduleRecovery(0, true); };
    this.events?.addEventListener('online', this.onOnline);
    this.scanLog = []; this.packedCounts = new Map(); this.listeners = new Set();
    this.stationNames = {};
    this.connectedUsers = 0; this.connected = false; this.ready = false; this.mirror = {};
    this.station = this.storage.getItem('fast_search_station') || `Station-${requestId().slice(-6)}`;
    this.storage.setItem('fast_search_station', this.station);
    try { this.pending = JSON.parse(this.storage.getItem('fast_search_pending_request') || 'null'); } catch { this.pending = null; }
    this.busy = false;
    this.initRealtimeSync();
    if (this.pending) this.scheduleRecovery(0);
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  notifyListeners(type, data) {
    for (const listener of this.listeners) {
      try { listener(type, data); } catch (error) { console.error('Scanner listener failed:', error); }
    }
  }
  recordContact() {
    this.lastServerContactAt = this.now(); this.healthFailures = 0; this.connected = true;
  }
  scheduleRecovery(delay = Math.min(15000, 2000 * 2 ** Math.min(this.recoveryAttempts, 3)), urgent = false) {
    if (!this.autoRecovery || !this.pending || this.disposed) return;
    if (this.recoveryTimer != null) {
      if (!urgent) return;
      this.clearTimeout(this.recoveryTimer);
    }
    this.recoveryTimer = this.setTimeout(() => {
      this.recoveryTimer = null;
      void this.recoverPending().catch(error => {
        this.recoveryError = error.message; this.notifyListeners('HEALTH');
      }).finally(() => {
        this.recoveryAttempts++;
        this.scheduleRecovery();
      });
    }, delay);
    this.recoveryTimer?.unref?.();
  }
  dispose() {
    this.disposed = true;
    if (this.recoveryTimer != null) this.clearTimeout(this.recoveryTimer);
    this.events?.removeEventListener('online', this.onOnline);
    this.eventSource?.close?.();
    this.pendingController?.abort();
  }
  rebuildPackedCounts() {
    this.packedCounts.clear();
    for (const scan of this.scanLog) if (scan.statusType === 'PACK') this.packedCounts.set(scan.isbn, (this.packedCounts.get(scan.isbn) || 0) + 1);
  }
  addScan(scan) {
    this.recordContact();
    this.confirmPending(scan);
    if (this.scanLog.some(s => s.id === scan.id)) return false;
    this.scanLog.push(scan); this.scanLog.sort((a, b) => b.seq - a.seq); this.rebuildPackedCounts(); return true;
  }
  updateScan(scan) {
    const idx = this.scanLog.findIndex(s => s.id === scan.id);
    if (idx !== -1) {
      if ((this.scanLog[idx].revision || 0) > (scan.revision || 0)) return;
      this.scanLog[idx] = scan;
    } else {
      this.scanLog.push(scan);
      this.scanLog.sort((a, b) => b.seq - a.seq);
    }
    this.rebuildPackedCounts();
    this.notifyListeners('STATE');
  }
  refresh() {
    // Focus, startup and SSE reconnect can arrive together. Share one download.
    if (!this.refreshPromise) this.refreshPromise = this.loadState().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async loadState() {
    const beforeIds = new Set(this.scanLog.map(scan => scan.id));
    const res = await this.fetch('/api/state', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('Cannot read central packing history');
    const state = await res.json();
    const combined = new Map(state.scans.map(scan => [scan.id, scan]));
    for (const scan of this.scanLog) {
      const remote = combined.get(scan.id);
      if (!beforeIds.has(scan.id) || (scan.revision || 0) > (remote?.revision || 0)) combined.set(scan.id, scan);
    }
    this.stationNames = state.stationNames || {};
    this.editableFromSeq = state.editableFromSeq || 1;
    this.scanLog = [...combined.values()].sort((a, b) => b.seq - a.seq);
    this.rebuildPackedCounts(); this.updateHealth(state);
    const confirmed = this.pending && this.scanLog.find(scan => scan.id === this.pending.id);
    if (confirmed) this.confirmPending(confirmed);
    this.notifyListeners('STATE'); return state;
  }
  updateHealth(state) {
    this.healthVersion = (this.healthVersion || 0) + 1;
    this.ready = state.ready; this.mirror = state.mirror; this.connectedUsers = state.userCount;
    this.coverMatchEnabled = state.coverMatchEnabled === true;
    this.coverVector = state.coverVector;
    this.recordContact();
    this.notifyListeners('HEALTH');
    if (this.pending && this.ready && !this.busy && this.now() >= (this.nextRecoveryAt || 0)) {
      if (this.autoRecovery) this.scheduleRecovery(0);
      else queueMicrotask(() => { void this.recoverPending().catch(() => {}); });
    }
  }
  confirmPending(scan) {
    if (!this.pending || scan.id !== this.pending.id) return false;
    this.pending = null;
    if (this.recoveryTimer != null) this.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null; this.recoveryAttempts = 0; this.recoveryError = '';
    this.storage.removeItem('fast_search_pending_request');
    this.lastConfirmed = scan;
    this.notifyListeners('SCAN_CONFIRMED', scan);
    return true;
  }
  recoverPending() {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (!this.pending || this.disposed) return Promise.resolve();
    const request = { ...this.pending };
    this.nextRecoveryAt = this.now() + 5000;
    this.recoveryPromise = (async () => {
      // Probe by ID even during an in-flight POST. This confirms a saved scan
      // promptly when both the POST reply and live-feed confirmation were lost.
      try {
        const res = await this.fetch(`/api/scan?id=${encodeURIComponent(request.id)}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw Error('Cannot check saved scan');
        const { scan } = await res.json();
        if (scan) {
          if (scan.id !== request.id) throw Error('Server returned a different scan request');
          this.addScan(scan); this.notifyListeners('STATE'); return scan;
        }
      } catch (error) {
        if (this.pendingPromise || this.busy || this.pending?.id !== request.id) throw error;
        // Re-sending the original ID is safe if the lookup route is unavailable.
      }
      return null;
    })().finally(() => { this.recoveryPromise = null; });
    // Track only the lookup above, so another background lookup can confirm a
    // retried POST whose response stalls. Never launch concurrent scan POSTs.
    return this.recoveryPromise.then(scan => {
      if (scan) return scan;
      if (this.pending?.id === request.id && !this.pendingPromise && !this.busy) return this.retryPending();
    });
  }

  health() {
    if (!this.healthPromise) this.healthPromise = this.checkHealth().finally(() => { this.healthPromise = null; });
    return this.healthPromise;
  }
  async checkHealth() {
    const version = this.healthVersion || 0;
    try {
      const res = await this.fetch('/api/health', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('Server unavailable');
      this.updateHealth(await res.json());
    } catch {
      // A delayed failed probe must not override a newer live heartbeat.
      if ((this.healthVersion || 0) === version) {
        this.healthFailures = (this.healthFailures || 0) + 1;
        const stale = this.lastServerContactAt == null || this.now() - this.lastServerContactAt > 15000;
        if (!this.autoRecovery || (stale && this.healthFailures >= 2)) this.connected = false;
        this.notifyListeners('HEALTH');
      }
    }
  }
  initRealtimeSync() {
    this.eventSource = new this.EventSource('/api/events');
    this.eventSource.onopen = () => { void this.health(); this.refresh().catch(() => this.health()); };
    // EventSource reconnects itself. Check the API before blocking the scanner.
    this.eventSource.onerror = () => { void this.health(); this.scheduleRecovery(); };
    this.eventSource.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === 'STATION_NAMES') { this.stationNames = data.stationNames; this.notifyListeners('HEALTH'); }
      if (data.type === 'USER_COUNT') { this.connectedUsers = data.count; this.notifyListeners('USER_COUNT', data.count); }
      if (data.type === 'HEALTH') {
        if (typeof data.ready === 'boolean') this.updateHealth(data); else void this.health();
      }
      if (data.type === 'BOOK_PACKED' && this.addScan(data.scan)) this.notifyListeners('BOOK_PACKED', data.scan);
      if (data.type === 'BOOK_EDITED' && data.scan) { this.updateScan(data.scan); this.notifyListeners('BOOK_EDITED', data.scan); }
      if (data.type === 'BOOK_VOIDED' && data.scan) { this.updateScan(data.scan); this.notifyListeners('BOOK_VOIDED', data.scan); }
    };
  }
  getStationLabel(station) { return this.stationNames?.[station] || station; }
  async updateStationName(name) {
    const res = await this.fetch('/api/station-name', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: this.station, name }), signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save station name');
    this.stationNames = data.stationNames;
    this.notifyListeners('HEALTH');
  }
  getPackedCount(isbn) { return this.packedCounts.get(String(isbn).trim()) || 0; }
  async editScan(scan, isbn) {
    if (this.pending || this.busy) throw new Error('Confirm the pending scan before editing a row.');
    const key = JSON.stringify([scan.id, String(isbn).trim(), scan.revision || 0]);
    // Retain the same edit ID after a timeout so a retry cannot apply the edit twice.
    if (this.editAttempt?.key !== key) this.editAttempt = { key, body: { id: scan.id, isbn, expectedRevision: scan.revision || 0, editId: requestId() } };
    this.busy = true; this.notifyListeners('HEALTH');
    try {
      const response = await this.fetch('/api/scan/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.editAttempt.body), signal: AbortSignal.timeout(8000) });
      const entry = await response.json();
      if (!response.ok) {
        if (response.status < 500) this.editAttempt = null;
        if (response.status === 409) await this.refresh();
        throw new Error(entry.error || 'Could not save correction');
      }
      this.updateScan(entry); this.editAttempt = null;
      return entry;
    } catch (error) {
      if (this.editAttempt) throw new Error('Correction unconfirmed. Retry saving this same value to confirm it.');
      throw error;
    } finally { this.busy = false; this.notifyListeners('HEALTH'); }
  }
  async voidScan(id) {
    const res = await this.fetch('/api/scan/void', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, station: this.station }),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server could not void scan');
    this.updateScan(data);
    return data;
  }
  markPacked(isbn) { return this.submitPack({ isbn }); }
  async confirmCover({ isbn, order, confirmationToken }, catalogVersion) {
    if (!confirmationToken) throw new Error('Look up an eligible copy before confirming the box.');
    return this.submitPack({ isbn, order, catalogVersion, confirmationToken });
  }
  async submitPack(selection) {
    if (this.busy && !this.pending) throw new Error('A scan is already being saved.');
    if (this.pending) throw new Error('Resolve the pending scan in the Scanning tab before scanning another book.');
    this.recoveryAttempts = 0; this.recoveryError = '';
    this.pending = { id: requestId(), ...selection, station: this.station };
    try { this.storage.setItem('fast_search_pending_request', JSON.stringify(this.pending)); }
    catch { this.pending = null; throw new Error('Browser storage unavailable. Enable it before scanning.'); }
    return this.retryPending();
  }
  retryPending() {
    if (this.pendingPromise) return this.pendingPromise;
    this.pendingPromise = this.savePending().finally(() => { this.pendingPromise = null; });
    return this.pendingPromise;
  }
  async savePending() {
    if (this.busy || !this.pending) throw new Error('A scan is already being saved.');
    this.busy = true; this.notifyListeners('HEALTH');
    const request = { ...this.pending };
    this.scheduleRecovery(2000);
    const controller = new AbortController();
    this.pendingController = controller;
    let unsubscribe;
    const confirmation = new Promise(resolve => {
      unsubscribe = this.subscribe((type, scan) => {
        if (type === 'SCAN_CONFIRMED' && scan.id === request.id) resolve(scan);
      });
    });
    try {
      const data = await Promise.race([this.sendPending(request, controller.signal), confirmation]);
      if (data.id !== request.id) throw Error('Server returned a different scan request');
      this.addScan(data);
      this.connected = true; this.notifyListeners('STATE'); return data;
    } catch (error) {
      if (this.pending?.id === request.id) {
        this.nextRecoveryAt = this.now() + 5000;
        throw new Error('Result unconfirmed. Recovery will retry automatically; keep this book aside.');
      }
      throw error;
    } finally { controller.abort(); this.pendingController = null; unsubscribe(); this.busy = false; this.notifyListeners('HEALTH'); this.scheduleRecovery(); }
  }
  async sendPending(request, signal) {
      const body = JSON.stringify(request);
      const route = request.confirmationToken ? '/api/mark-packed' : '/api/scan';
      let res, data;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) throw Error('Request already confirmed');
        const attemptController = new AbortController();
        const abort = () => attemptController.abort();
        const timeout = setTimeout(abort, 12000);
        signal.addEventListener('abort', abort, { once: true });
        try {
          res = await this.fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body, signal: attemptController.signal });
          if (res.status >= 500 || res.status === 429) throw new Error('Temporary server failure');
          data = await res.json();
          break;
        } catch (error) {
          if (attempt === 2 || signal.aborted) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        }
      }
      if (!res.ok) {
        // Only validation/setup errors prove this request was not accepted.
        if ([400, 409, 415].includes(res.status) && this.pending?.id === request.id) { this.pending = null; this.storage.removeItem('fast_search_pending_request'); }
        throw Object.assign(new Error(data.error || 'Server could not save scan'), { status: res.status, code: data.code, lookup: data.lookup });
      }
      return data;
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
