import test from 'node:test';
import assert from 'node:assert/strict';

test('unconfirmed scan survives reload and retries the same request ID', async t => {
  const storage = new Map();
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Lost response'); });
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.EventSource = class { close() {} };
  const { PackingManager } = await import('../src/utils/sync.js');
  const first = new PackingManager();
  await assert.rejects(first.markPacked('9781234567890'), /Result unconfirmed/);
  const original = JSON.parse(storage.get('fast_search_pending_request'));
  assert.equal(first.scanLog.length, 0);
  await assert.rejects(first.markPacked('9781234567890'), /Resolve the pending scan/);
  const reloaded = new PackingManager();
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ...sent, seq: 1, statusType: 'PACK', order: '317', title: 'A book', copyNum: 1, totalCopies: 1 }) };
  };
  const result = await reloaded.retryPending();
  assert.equal(sent.id, original.id); assert.equal(result.statusType, 'PACK');
  assert.equal(storage.has('fast_search_pending_request'), false);
  assert.equal(reloaded.getPackedCount('9781234567890'), 1);
  delete globalThis.localStorage; delete globalThis.EventSource;
});

test('editing a display name preserves station identity and pending scan requests', async t => {
  const storage = new Map([['fast_search_station', 'Station-fixed-id'], ['fast_search_pending_request', JSON.stringify({ id: 'pending-123', isbn: '9781234567890', station: 'Station-fixed-id' })]]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const manager = new PackingManager();
  const pendingBefore = storage.get('fast_search_pending_request');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/station-name');
    assert.deepEqual(JSON.parse(options.body), { station: 'Station-fixed-id', name: 'Basement floor' });
    return { ok: true, json: async () => ({ stationNames: { 'Station-fixed-id': 'Basement floor' } }) };
  });
  await manager.updateStationName('Basement floor');
  assert.equal(manager.station, 'Station-fixed-id');
  assert.equal(storage.get('fast_search_station'), 'Station-fixed-id');
  assert.equal(storage.get('fast_search_pending_request'), pendingBefore);
  assert.equal(manager.getStationLabel(manager.station), 'Basement floor');
  manager.eventSource.onmessage({ data: JSON.stringify({ type: 'STATION_NAMES', stationNames: { 'Station-other': 'Upper floor' } }) });
  assert.equal(manager.getStationLabel('Station-other'), 'Upper floor');
  assert.equal(manager.station, 'Station-fixed-id');
});

test('ISBN edit retries reuse the correction ID and stale refreshes do not revert newer revisions', async t => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const manager = new PackingManager();
  const original = { id: 'original-row', seq: 1, isbn: '9781234567890', revision: 0, statusType: 'PACK' };
  const updated = { ...original, isbn: '9781234567891', revision: 1 };
  manager.scanLog = [original];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw Error('Response lost');
    return { ok: true, json: async () => updated };
  });
  await assert.rejects(manager.editScan(original, updated.isbn), /Correction unconfirmed/);
  assert.deepEqual(await manager.editScan(original, updated.isbn), updated);
  assert.equal(requests[0].editId, requests[1].editId);
  let finish;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
  const refresh = manager.refresh();
  await new Promise(resolve => setImmediate(resolve));
  manager.updateScan({ ...updated, revision: 2 });
  finish({ scans: [original], ready: true, mirror: {}, userCount: 1 });
  await refresh;
  assert.equal(manager.scanLog[0].revision, 2);
  manager.updateScan(original);
  assert.equal(manager.scanLog[0].revision, 2);
});

test('live-feed reconnect does not block a reachable scanner and refreshes share one download', async t => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const manager = new PackingManager();
  manager.connected = true; manager.ready = true;
  let finish, stateRequests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === '/api/state') {
      stateRequests++;
      return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
    }
    return { ok: true, json: async () => ({ ready: true, mirror: {}, userCount: 2 }) };
  });
  manager.eventSource.onerror();
  await manager.health();
  assert.equal(manager.connected, true);
  const first = manager.refresh(), second = manager.refresh();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  finish({ scans: [], ready: true, mirror: {}, userCount: 2 });
  await first;
  assert.equal(stateRequests, 1);
  let fail;
  globalThis.fetch = () => new Promise((resolve, reject) => { fail = reject; });
  const staleProbe = manager.health();
  manager.eventSource.onmessage({ data: JSON.stringify({ type: 'HEALTH', ready: true, mirror: {}, userCount: 2 }) });
  fail(Error('Older connection failed'));
  await staleProbe;
  assert.equal(manager.connected, true);
  globalThis.fetch = async () => { throw Error('Offline'); };
  await manager.health();
  assert.equal(manager.connected, false);
});

test('transient scan failures automatically retry the identical saved request', async t => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const manager = new PackingManager();
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw Error('Response lost after save');
    if (bodies.length === 2) return { status: 503 };
    return { ok: true, status: 200, json: async () => ({ ...JSON.parse(options.body), seq: 1, statusType: 'PACK' }) };
  });
  const result = await manager.markPacked('9781234567890');
  assert.equal(result.statusType, 'PACK');
  assert.equal(new Set(bodies).size, 1);
  assert.equal(bodies.length, 3);
  assert.equal(manager.scanLog.length, 1);
  assert.equal(storage.has('fast_search_pending_request'), false);
});
