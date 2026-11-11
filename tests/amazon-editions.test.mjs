import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { packingApiPlugin } from '../server/api.js';
import { mainScanValues } from '../server/sheets.js';
import { PackingStore } from '../server/store.js';

const amazon = '9780124105119';
const isbn10 = '0124105114';
const po = '9789351072324';
const conflict = '9780007491063';
const book = order => ({ ISBN13: po, Order: order, Title: 'PO book' });
const catalog = [book('317'), book('ZB346'), book('ZB346'), { ISBN13: conflict, Order: '322', Title: 'Another book' }];
const editions = {
  mappings: [{ barcode: amazon, poIsbn: po, order: 'ZB346', quantity: 1 }],
  conflicts: [{ barcode: conflict, targets: [[conflict, '322'], [po, 'ZB346']] }]
};
const request = (id, isbn = amazon) => ({ id: `request-${id}`, isbn, station: `Station-${id}` });

test('Amazon and PO scans share allocations, respect box and quantity, and recover safely', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-editions-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'data/amazon-editions.json'), JSON.stringify(editions));
  const databasePath = path.join(root, 'data/packing.sqlite');
  const store = new PackingStore(databasePath, catalog);
  store.initializeEmpty();
  store.close();

  const server = await createServer({ configFile: false, root, plugins: [packingApiPlugin(root, { databasePath })], server: { port: 0, host: '127.0.0.1' } });
  t.after(() => server.close());
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const post = async (route, data) => {
    const response = await fetch(`${base}/api/scan${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const requests = [request('amazon'), request('isbn10', isbn10), request('exact', po)];
  const [first, second, exact] = await Promise.all(requests.map(data => post('', data)));
  const pack = [first, second].find(entry => entry.statusType === 'PACK');
  const duplicate = [first, second].find(entry => entry.statusType === 'DUPLICATE');
  assert.equal(exact.order, '317');
  assert.equal(pack.order, 'ZB346');
  assert.equal(pack.isbn, po);
  assert.equal(pack.scannedIsbn, requests.find(data => data.id === pack.id).isbn);
  assert.match(duplicate.status, /All 1 Amazon copies recorded/);
  assert.deepEqual(mainScanValues(pack).slice(0, 3), [po, 'ZB346', 'PO book']);
  assert.match(mainScanValues(pack)[3], /Amazon ISBN .+ → PO ISBN/);
  assert.deepEqual(await post('', requests.find(data => data.id === pack.id)), pack);
  assert.equal((await post('', request('conflict', conflict))).statusType, 'REVIEW');

  const corrected = await post('/edit', { id: pack.id, isbn: po, expectedRevision: 0, editId: 'edit-request-1' });
  assert.equal(corrected.statusType, 'PACK');
  assert.equal(corrected.scannedIsbn, undefined);
  assert.deepEqual(await post('', requests.find(data => data.id === pack.id)), corrected);

  const replacement = await post('', request('remaining'));
  assert.equal(replacement.order, 'ZB346');
  await post('/void', { id: replacement.id });
  assert.equal((await post('', request('repacked'))).order, 'ZB346');
  assert.equal((await post('', request('full', po))).statusType, 'DUPLICATE');
});

test('an exact PO added later blocks an ambiguous Amazon barcode', t => {
  const store = new PackingStore(':memory:', [...catalog, { ISBN13: amazon, Order: '323', Title: 'New exact copy' }], editions);
  t.after(() => store.close());
  store.initializeEmpty();
  assert.equal(store.scan(request('review')).statusType, 'REVIEW');
  assert.equal(store.scan(request('po', po)).order, '317');
});
