import test from 'node:test';
import assert from 'node:assert/strict';

test('saved pending scans recover through history, live events and automatic lookup using exact request IDs', async t => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const pending = { id: 'pending-recovery-123', isbn: '9781240126651', station: 'Station-test' };
  const saved = { ...pending, seq: 1, revision: 0, statusType: 'PACK', order: 'ZB344' };
  const make = fetch => {
    const storage = new Map([['fast_search_station', pending.station], ['fast_search_pending_request', JSON.stringify(pending)]]);
    return { storage, manager: new PackingManager({ fetch, EventSource: class {}, storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }) };
  };
  const json = data => ({ ok: true, status: 200, json: async () => data });

  // A reloaded browser must recognize a scan already in central history.
  const history = make(async url => {
    assert.equal(url, '/api/state');
    return json({ scans: [saved], ready: true, mirror: {}, userCount: 1 });
  });
  await history.manager.refresh();
  assert.equal(history.manager.pending, null);
  assert.equal(history.manager.lastConfirmed.order, 'ZB344');
  assert.equal(history.storage.has('fast_search_pending_request'), false);

  // A live confirmation wins even when the HTTP response never arrives.
  let posts = 0;
  const live = make(async () => { posts++; return new Promise(() => {}); });
  const waiting = live.manager.retryPending();
  live.manager.eventSource.onmessage({ data: JSON.stringify({ type: 'BOOK_PACKED', scan: { ...saved, id: 'someone-else-same-isbn' } }) });
  assert.equal(live.manager.pending.id, pending.id);
  live.manager.eventSource.onmessage({ data: JSON.stringify({ type: 'BOOK_PACKED', scan: saved }) });
  assert.equal((await waiting).id, pending.id);
  assert.equal(live.manager.busy, false);
  assert.equal(live.manager.pending, null);
  assert.equal(posts, 1);

  // After initial retries are exhausted, a healthy connection checks the exact
  // saved request automatically instead of leaving the packer stuck on Retry.
  let attempts = 0, lookups = 0;
  const auto = make(async (url, options) => {
    if (url === '/api/scan') { attempts++; assert.equal(JSON.parse(options.body).id, pending.id); throw Error('Reply lost'); }
    if (url.startsWith('/api/scan?id=')) { lookups++; assert.ok(url.endsWith(pending.id)); return json({ scan: saved }); }
    return json({ ready: true, mirror: {}, userCount: 1 });
  });
  await assert.rejects(auto.manager.retryPending(), /Result unconfirmed/);
  assert.equal(attempts, 3);
  assert.ok(auto.manager.pending);
  auto.manager.nextRecoveryAt = 0;
  await auto.manager.health();
  await auto.manager.recoverPending();
  assert.equal(lookups, 1);
  assert.equal(attempts, 3); // No fourth POST: the row was already saved.
  assert.equal(auto.manager.pending, null);
  assert.equal(auto.manager.lastConfirmed.id, pending.id);
  assert.equal(auto.manager.scanLog.length, 1);
});
