import { PackingManager } from '../utils/sync.js';
import { createScanDemoManager } from './scanDemoManager.js';

// Runs the real production connection/retry client against an isolated transport.
// The transport never fetches a URL or writes to browser storage.
export function createConnectionDemo(onChange = () => {}) {
  const saved = new Map(), storage = new Map(), server = createScanDemoManager();
  server.scanLog = [];
  const state = { online: true, loseNextReply: false, events: [], attempts: [], saved, server };
  const log = message => { state.events.unshift(message); onChange(); };
  const response = data => ({ ok: true, status: 200, json: async () => data });
  class DemoEvents { constructor() { state.stream = this; } close() {} }
  const manager = new PackingManager({
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    EventSource: DemoEvents,
    fetch: async (url, options) => {
      if (!state.online) { log(`API unreachable: ${url}`); throw Error('Simulated network outage'); }
      if (url === '/api/health') return response({ ready: true, mirror: {}, userCount: 1 });
      if (url === '/api/state') return response({ ready: true, mirror: {}, userCount: 1, scans: [...saved.values()] });
      if (url.startsWith('/api/scan?id=')) return response({ scan: saved.get(decodeURIComponent(url.split('=')[1])) || null });
      if (url !== '/api/scan') throw Error('Unavailable in connection demo');
      const request = JSON.parse(options.body);
      state.attempts.push(request.id);
      log(`POST attempt ${state.attempts.length} · ID ${request.id}`);
      if (!saved.has(request.id)) {
        const entry = await server.markPacked(request.isbn);
        saved.set(request.id, { ...entry, id: request.id, station: request.station });
        log(`Server saved one row · ID ${request.id}`);
      } else log('Server returned the existing row. No duplicate created.');
      if (state.loseNextReply) { state.loseNextReply = false; log('Response deliberately dropped AFTER server saved the scan.'); throw Error('Lost reply'); }
      return response(saved.get(request.id));
    },
  });
  manager.updateHealth({ ready: true, mirror: {}, userCount: 1 });
  manager.subscribe(onChange);
  return { manager, state, log,
    async dropFeed() {
      log('Live-feed connection dropped. API remains reachable.');
      state.stream.onerror();
      await manager.health();
      log(`Actual client result: ${manager.connected ? 'CONNECTED — scanning available' : 'DISCONNECTED'}`);
    },
    async goOffline() { state.online = false; log('Full network outage enabled.'); await manager.health(); onChange(); },
    async restore() { state.online = true; log('Network restored.'); await manager.health(); onChange(); },
    loseReply() { state.loseNextReply = true; log('Next scan response will be dropped after it is saved.'); },
  };
}
