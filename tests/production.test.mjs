import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptSync } from 'node:crypto';
import { createProductionServer } from '../server/http.js';
import { PackingStore } from '../server/store.js';

test('production server protects UI, catalog and API and never serves project secrets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['public', 'dist']) fs.mkdirSync(path.join(root, directory));
  const catalog = [{ ISBN13: '9781234567890', Order: '317', Title: 'Test book' }];
  fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'dist/master.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<h1>Scanner</h1>');
  fs.writeFileSync(path.join(root, 'credentials.json'), 'private credentials');
  const databasePath = path.join(root, 'data/packing.sqlite');
  const store = new PackingStore(databasePath, catalog); store.initializeEmpty(); store.close();
  const salt = 'a'.repeat(32); const password = 'temporary-test-password';
  const passwordHash = `scrypt:${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
  assert.throws(() => createProductionServer(root, { username: '', passwordHash }), /Set SCANNER_USERNAME/);
  const server = createProductionServer(root, { databasePath, username: 'scanner', passwordHash, publicOrigin: 'https://scanner.example.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`scanner:${password}`).toString('base64')}`;
  for (const route of ['/', '/master.json', '/api/state']) assert.equal((await fetch(`${base}${route}`)).status, 401);
  assert.equal((await fetch(base, { headers: { authorization: `Basic ${Buffer.from('scanner:wrong').toString('base64')}` } })).status, 401);
  assert.match(await (await fetch(base, { headers: { authorization } })).text(), /Scanner/);
  for (const route of ['/credentials.json', '/data/packing.sqlite', '/.env.local', '/server/api.js']) assert.equal((await fetch(`${base}${route}`, { headers: { authorization } })).status, 404);
  const rejected = await fetch(`${base}/api/scan`, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json', Origin: 'https://scanner.example.test, https://scanner.example.test' }, body: JSON.stringify({ id: 'production-invalid', isbn: '!!!' }) });
  assert.equal(rejected.status, 400);
  const foreign = await fetch(`${base}/api/scan`, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json', Origin: 'https://scanner.example.test, https://untrusted.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const results = await Promise.all([1, 2, 3].map(async i => (await fetch(`${base}/api/scan`, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `production-${i}`, isbn: catalog[0].ISBN13 }) })).json()));
  assert.equal(results.filter(r => r.statusType === 'PACK').length, 1);
  assert.equal(results.filter(r => r.statusType === 'DUPLICATE').length, 2);
  const recovered = await (await fetch(`${base}/api/scan?id=${encodeURIComponent(results[0].id)}`, { headers: { authorization } })).json();
  assert.deepEqual(recovered.scan, results[0]);
  const missing = await (await fetch(`${base}/api/scan?id=unknown-request-123`, { headers: { authorization } })).json();
  assert.equal(missing.scan, null);
  assert.equal((await fetch(`${base}/api/scan?id=bad`, { headers: { authorization } })).status, 400);
  assert.equal((await fetch(`${base}/api/scan?id=${results[0].id}`)).status, 401);
  const history = await fetch(`${base}/api/state`, { headers: { authorization, 'Accept-Encoding': 'gzip' } });
  assert.equal(history.headers.get('content-encoding'), 'gzip');
  assert.ok(Number(history.headers.get('content-length')) < 1024);
  const state = await history.json();
  assert.equal(state.scans.length, 3);
  assert.equal(state.scans.filter(scan => scan.statusType === 'PACK').length, 1);

  // Exercise the screenshot failure against the real HTTP API and SQLite:
  // all POST replies are lost, but recovery must find the already-saved ID.
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const pending = { id: results[0].id, isbn: results[0].isbn, station: results[0].station };
  const storage = new Map([['fast_search_pending_request', JSON.stringify(pending)]]);
  let lostReplies = 0;
  const manager = new PackingManager({ EventSource: class {},
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (route, options = {}) => {
      const response = await fetch(`${base}${route}`, { ...options, headers: { ...options.headers, authorization } });
      if (options.method === 'POST') {
        assert.equal((await response.json()).id, pending.id);
        lostReplies++;
        throw Error('Deliberately discarded real server reply');
      }
      return response;
    },
  });
  await assert.rejects(manager.retryPending(), /Result unconfirmed/);
  assert.equal(lostReplies, 3);
  manager.nextRecoveryAt = 0;
  await manager.health();
  await manager.recoverPending();
  assert.equal(manager.pending, null);
  assert.equal(manager.lastConfirmed.id, pending.id);
  assert.equal(manager.lastConfirmed.seq, results[0].seq);
  assert.equal(storage.has('fast_search_pending_request'), false);
  const finalHealth = await (await fetch(`${base}/api/health`, { headers: { authorization } })).json();
  assert.equal(finalHealth.count, 3); // Recovery created no duplicate records.
});
