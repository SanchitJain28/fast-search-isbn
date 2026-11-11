import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { PackingStore } from '../server/store.js';
import { SheetMirror } from '../server/sheets.js';
import { packingApiPlugin } from '../server/api.js';

const catalog = [
  { ISBN13: '9781234567890', Order: '317', Title: 'Book one' },
  { ISBN13: '9781234567890', Order: '323', Title: 'Book one' },
  { ISBN13: '123456789X', Order: 'ZBR', Title: 'Book two' }
];
const request = (id, isbn = catalog[0].ISBN13) => ({ id: `request-${id}`, isbn, station: 'Test' });
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('transactions allocate copies once, record all outcomes and survive restart', t => {
  const file = path.join(temporary(t), 'packing.sqlite');
  let store = new PackingStore(file, catalog);
  assert.throws(() => store.scan(request('blocked')), /Import and reconcile/);
  store.initializeEmpty();
  assert.equal(store.scan(request('one')).order, '317');
  assert.equal(store.scan(request('one')).order, '317');
  assert.equal(store.scan(request('two')).order, '323');
  assert.equal(store.scan(request('three')).statusType, 'DUPLICATE');
  assert.equal(store.scan(request('unknown', '100000508621')).statusType, 'NOT_FOUND');
  assert.equal(store.scan(request('isbn10', '123456789x')).statusType, 'PACK');
  assert.throws(() => store.scan(request('one', '123456789X')), /different ISBN/);
  assert.equal(store.stats().count, 5);
  store.close(); store = new PackingStore(file, catalog);
  assert.equal(store.ready, true);
  assert.equal(store.scan(request('four')).statusType, 'DUPLICATE');
  assert.equal(store.pending().length, 6); store.close();
  const changed = new PackingStore(file, [...catalog].reverse());
  assert.equal(changed.ready, false); changed.close();
});

test('failed transaction rolls back and does not consume a copy', () => {
  const store = new PackingStore(':memory:', catalog); store.initializeEmpty();
  assert.throws(() => store.transaction(() => { store.setMeta('shouldRollback', 'yes'); throw Error('fail'); }));
  assert.equal(store.getMeta('shouldRollback'), undefined);
  assert.equal(store.scan(request('one')).copyNum, 1); store.close();
});

test('three simultaneous HTTP clients cannot overpack and retries return saved decisions', async t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'public')); fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  const setup = new PackingStore(path.join(root, 'data/packing.sqlite'), catalog); setup.initializeEmpty(); setup.close();
  const server = await createServer({ configFile: false, root, plugins: [packingApiPlugin(root, { databasePath: path.join(root, 'data/packing.sqlite') })], server: { port: 0, host: '127.0.0.1' } });
  t.after(() => server.close()); await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const send = async body => { const res = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return [res.status, await res.json()]; };
  const results = await Promise.all([send(request('A')), send(request('B')), send(request('C'))]);
  assert.deepEqual(results.map(r => r[0]), [200, 200, 200]);
  assert.equal(results.filter(r => r[1].statusType === 'PACK').length, 2);
  assert.equal(results.filter(r => r[1].statusType === 'DUPLICATE').length, 1);
  assert.deepEqual((await send(request('A')))[1], results[0][1]);
  const state = await (await fetch(`${base}/api/state`)).json(); assert.equal(state.count, 3);
  assert.equal((await fetch(`${base}/api/clear-scans`, { method: 'POST' })).status, 405);
  const invalid = await send(request('bad', '<script>')); assert.equal(invalid[0], 400);
});

test('voiding a scan releases the catalog copy, updates status and marks pending sync', async t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'public')); fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  const setup = new PackingStore(path.join(root, 'data/packing.sqlite'), catalog); setup.initializeEmpty(); setup.close();
  const server = await createServer({ configFile: false, root, plugins: [packingApiPlugin(root, { databasePath: path.join(root, 'data/packing.sqlite') })], server: { port: 0, host: '127.0.0.1' } });
  t.after(() => server.close()); await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  const packRes = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('pack1')) });
  const packData = await packRes.json();
  assert.equal(packData.statusType, 'PACK');
  assert.equal(packData.order, '317');

  const packRes2 = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('pack2')) });
  const packData2 = await packRes2.json();
  assert.equal(packData2.statusType, 'PACK');
  assert.equal(packData2.order, '323');

  const packRes3 = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('pack3')) });
  const packData3 = await packRes3.json();
  assert.equal(packData3.statusType, 'DUPLICATE');

  const voidRes = await fetch(`${base}/api/scan/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: packData.id, station: 'Admin' }) });
  const voidData = await voidRes.json();
  assert.equal(voidRes.status, 200);
  assert.equal(voidData.statusType, 'VOID');
  assert.match(voidData.status, /REMOVED/);

  const repackedRes = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('repack')) });
  const repackedData = await repackedRes.json();
  assert.equal(repackedData.statusType, 'PACK');
  assert.equal(repackedData.order, '317');
});

function fakeGoogle({ failWrite = false, failCreate = false } = {}) {
  const sheets = [], writes = []; let writingFails = failWrite, creationFails = failCreate;
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets } }),
    batchUpdate: async ({ requestBody }) => { for (const r of requestBody.requests) {
      if (r.addSheet) { sheets.push({ properties: { ...r.addSheet.properties, gridProperties: { rowCount: 1000 } } }); if (creationFails) { creationFails = false; throw Error('Response lost during creation'); } }
      else if (r.updateSheetProperties) Object.assign(sheets[0].properties.gridProperties, r.updateSheetProperties.properties.gridProperties);
    } },
    values: { batchUpdate: async ({ requestBody }) => { writes.push(requestBody); if (writingFails) { writingFails = false; throw Error('Response lost after write'); } } }
  } };
  return { client, writes, sheets };
}

test('Google outage preserves queue and retry uses same rows after restart', async () => {
  const store = new PackingStore(':memory:', catalog); store.initializeEmpty(); store.scan(request('one'));
  const google = fakeGoogle({ failWrite: true });
  let mirror = new SheetMirror(store, { client: google.client, spreadsheetId: 'test', enabled: true });
  await mirror.flush(); assert.equal(store.stats().pending, 1); assert.match(mirror.status().lastError, /Response lost/);
  store.scan(request('two')); // Scanning continues while Google is unavailable.
  mirror = new SheetMirror(store, { client: google.client, spreadsheetId: 'test', enabled: true });
  await mirror.flush(); assert.equal(store.stats().pending, 0);
  assert.equal(google.writes[0].valueInputOption, 'RAW');
  assert.deepEqual(google.writes[0].data[1], google.writes[1].data[1]);
  assert.equal(google.writes[1].data[2].range, "'Scanner Log'!A3:I3"); store.close();
});

test('ambiguous tab creation recovers; unrelated existing sheet is never overwritten', async () => {
  const store = new PackingStore(':memory:', catalog); store.initializeEmpty(); store.scan(request('one'));
  const google = fakeGoogle({ failCreate: true });
  let mirror = new SheetMirror(store, { client: google.client, spreadsheetId: 'test', enabled: true });
  await mirror.flush(); assert.equal(store.stats().pending, 1);
  mirror = new SheetMirror(store, { client: google.client, spreadsheetId: 'test', enabled: true });
  await mirror.flush(); assert.equal(store.stats().pending, 0); assert.equal(google.sheets.length, 1); store.close();
  const other = new PackingStore(':memory:', catalog); other.initializeEmpty(); other.scan(request('one'));
  const refusal = new SheetMirror(other, { client: google.client, spreadsheetId: 'test', enabled: true });
  await refusal.flush(); assert.match(refusal.lastError, /already exists/); assert.equal(other.stats().pending, 1); other.close();
});
