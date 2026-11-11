import test from 'node:test';
import assert from 'node:assert/strict';
import { PackingStore } from '../server/store.js';
import { SheetMirror, mainScanValues } from '../server/sheets.js';
const catalog = [{ ISBN13: '9781234567890', Order: '317', Title: 'Original book' }, { ISBN13: '9781234567891', Order: '323', Title: 'Corrected book' }];
const scan = (store, id, isbn = catalog[0].ISBN13) => store.scan({ id, isbn, station: 'Station-fixed' });
const correction = (row, isbn, editId = 'edit-request-one') => ({ id: row.id, isbn, expectedRevision: row.revision, editId });
function store(t) { const instance = new PackingStore(':memory:', catalog); instance.initializeEmpty(); t.after(() => instance.close()); return instance; }

test('ISBN corrections update the same record, release the old copy, and keep identity and audit history', t => {
  const db = store(t); const original = scan(db, 'original-request');
  const edited = db.editScan(correction(original, catalog[1].ISBN13));
  assert.equal(edited.order, '323'); assert.equal(edited.title, 'Corrected book'); assert.equal(edited.statusType, 'PACK');
  for (const field of ['id', 'seq', 'station', 'timestamp', 'createdAt']) assert.equal(edited[field], original[field]);
  assert.equal(edited.revision, 1); assert.equal(db.stats().count, 1);
  assert.equal(scan(db, 'next-original-request').order, '317');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM scan_edits').get().count, 1);
  assert.deepEqual(db.editScan(correction(original, catalog[1].ISBN13)), edited);
  assert.throws(() => db.editScan(correction(original, catalog[0].ISBN13, 'stale-edit-request')), /changed at another station/);
});

test('corrections respect duplicate allocation, unknown ISBNs, invalid input and voided rows', t => {
  const db = store(t); const original = scan(db, 'original-request'); scan(db, 'other-request', catalog[1].ISBN13);
  const duplicate = db.editScan(correction(original, catalog[1].ISBN13));
  assert.equal(duplicate.statusType, 'DUPLICATE'); assert.equal(duplicate.order, '');
  assert.equal(scan(db, 'release-check-request').order, '317');
  const unknown = db.editScan(correction(duplicate, '9780000000000', 'unknown-edit-request'));
  assert.equal(unknown.statusType, 'NOT_FOUND');
  assert.throws(() => db.editScan(correction(unknown, 'not-an-isbn', 'invalid-edit-request')), /numeric book barcode/);
  assert.deepEqual(db.list().find(row => row.id === unknown.id), unknown);
  db.voidScan({ id: unknown.id });
  assert.throws(() => db.editScan(correction(unknown, catalog[0].ISBN13, 'void-edit-request')), /Voided/);
});

test('historical main Scan rows cannot be queued for an unmapped overwrite', t => {
  const db = store(t); const original = scan(db, 'historical-request'); db.acknowledge([original]);
  db.setMeta('mainScanLayout', JSON.stringify({ startSeq: 2 }));
  assert.throws(() => db.editScan(correction(original, catalog[1].ISBN13)), /historical rows/);
  assert.equal(db.stats().pending, 0); assert.deepEqual(db.list()[0], original);
});

test('a correction during a Sheets write stays queued and updates the same Sheet row on retry', async t => {
  const db = store(t); const original = scan(db, 'original-request');
  db.setMeta('mirrorTarget', JSON.stringify(['test', 'Scan']));
  db.setMeta('mainScanLayout', JSON.stringify({ spreadsheetId: 'test', tab: 'Scan', sheetId: 42, startSeq: 1, startRow: 20 }));
  const cells = new Map(); const writes = []; let duringWrite = true;
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 42, title: 'Scan', gridProperties: { rowCount: 100, columnCount: 10 } } }] } }),
    values: {
      get: async () => ({ data: { values: [cells.get(20) || []] } }),
      batchUpdate: async ({ requestBody }) => {
        writes.push(requestBody); cells.set(20, requestBody.data[0].values[0]);
        if (duringWrite) { duringWrite = false; db.editScan(correction(original, catalog[1].ISBN13)); }
      }
    }
  } };
  const mirror = new SheetMirror(db, { client, spreadsheetId: 'test', tab: 'Scan', enabled: true });
  await mirror.flush(); assert.equal(db.stats().pending, 1);
  await mirror.flush(); assert.equal(db.stats().pending, 0);
  assert.equal(writes.length, 2); assert.equal(writes[0].data[0].range, "'Scan'!A20:J20");
  assert.equal(writes[1].data[0].range, "'Scan'!A20:J20");
  assert.deepEqual(cells.get(20), mainScanValues(db.list()[0]));
  assert.equal(cells.get(20)[0], catalog[1].ISBN13); assert.equal(cells.get(20)[1], '323'); assert.equal(cells.get(20)[7], 'Station-fixed');
});

test('correction API validates origin, persists the change and rejects stale concurrent edits', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { createServer } = await import('vite'); const { packingApiPlugin } = await import('../server/api.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-edit-api-'));
  fs.mkdirSync(path.join(root, 'public')); fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  const databasePath = path.join(root, 'data/packing.sqlite'); const setup = new PackingStore(databasePath, catalog); setup.initializeEmpty(); setup.close();
  const server = await createServer({ configFile: false, root, plugins: [packingApiPlugin(root, { databasePath })], server: { port: 0, host: '127.0.0.1' } });
  await server.listen(); t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const send = (route, body, origin = base) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const row = await (await send('/api/scan', { id: 'original-row-request', isbn: catalog[0].ISBN13, station: 'Station-fixed' })).json();
  assert.equal((await send('/api/scan/edit', correction(row, catalog[1].ISBN13), 'https://untrusted.example')).status, 403);
  const result = await send('/api/scan/edit', correction(row, catalog[1].ISBN13)); assert.equal(result.status, 200);
  assert.equal((await result.json()).order, '323');
  assert.equal((await send('/api/scan/edit', correction(row, catalog[0].ISBN13, 'other-edit-request'))).status, 409);
  const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.scans.length, 1); assert.equal(state.scans[0].isbn, catalog[1].ISBN13);
});
