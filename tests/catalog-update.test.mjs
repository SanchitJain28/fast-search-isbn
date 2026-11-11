import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackingStore } from '../server/store.js';
import { updateCatalog } from '../scripts/update-catalog.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-catalog-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = [{ ISBN13: '9781234567890', Order: '317', Title: 'First book', copies: 1 }];
  const next = [{ ...previous[0], copies: 2 }, { ...previous[0], Order: 'ZB345', copies: 2 }];
  const databasePath = path.join(root, 'packing.sqlite'), catalogPath = path.join(root, 'master.json'), candidatePath = path.join(root, 'new.json');
  fs.writeFileSync(catalogPath, JSON.stringify(previous)); fs.writeFileSync(candidatePath, JSON.stringify(next));
  const store = new PackingStore(databasePath, previous); store.initializeEmpty();
  store.scan({ id: 'existing-scan-one', isbn: previous[0].ISBN13, station: 'Station-fixed' });
  store.setMeta('stationDisplayNames', JSON.stringify({ 'Station-fixed': 'Basement floor' }));
  store.setMeta('mirrorTarget', JSON.stringify(['workbook', 'Scan']));
  const scans = store.list(); store.close();
  return { root, previous, next, scans, databasePath, catalogPath, candidatePath };
}

test('append-only catalog deployment preserves all history and enables the new order', t => {
  const f = fixture(t); const dry = updateCatalog(f);
  assert.equal(dry.addedCopies, 1); assert.equal(dry.applied, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.catalogPath)), f.previous);
  const report = updateCatalog({ ...f, apply: true }); assert.equal(report.allocationsPreserved, 1);
  const store = new PackingStore(f.databasePath, f.next);
  assert.equal(store.ready, true); assert.deepEqual(store.list(), f.scans);
  assert.equal(store.getMeta('stationDisplayNames'), JSON.stringify({ 'Station-fixed': 'Basement floor' }));
  assert.equal(store.getMeta('mirrorTarget'), JSON.stringify(['workbook', 'Scan']));
  assert.equal(store.stats().pending, 1);
  assert.equal(store.scan({ id: 'new-order-scan-two', isbn: f.previous[0].ISBN13 }).order, 'ZB345'); store.close();
});

test('catalog update refuses reordered or removed copies and mismatched database catalogs', t => {
  const f = fixture(t);
  fs.writeFileSync(f.candidatePath, JSON.stringify([...f.next].reverse()));
  assert.throws(() => updateCatalog({ ...f, apply: true }), /moved or changed/);
  fs.writeFileSync(f.candidatePath, '[]');
  assert.throws(() => updateCatalog({ ...f, apply: true }), /retain every/);
  fs.writeFileSync(f.candidatePath, JSON.stringify(f.next));
  const store = new PackingStore(f.databasePath, f.previous); store.setMeta('catalog', 'wrong-catalog'); store.close();
  assert.throws(() => updateCatalog({ ...f, apply: true }), /does not match/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.catalogPath)), f.previous);
});

test('catalog update refuses a conflicting recorded allocation', t => {
  const f = fixture(t); const store = new PackingStore(f.databasePath, f.previous);
  store.db.prepare("UPDATE scans SET order_name='wrong-box'").run(); store.close();
  assert.throws(() => updateCatalog({ ...f, apply: true }), /allocation conflicts/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.catalogPath)), f.previous);
});

test('catalog reconciliation CLI also runs through a symlinked release path', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'public'));
  fs.writeFileSync(path.join(f.root, 'public/master.json'), JSON.stringify(f.previous));
  const script = path.join(f.root, 'update-catalog.mjs');
  fs.symlinkSync(fileURLToPath(new URL('../scripts/update-catalog.mjs', import.meta.url)), script);
  const result = spawnSync(process.execPath, [script, '--root', f.root, '--database', f.databasePath, '--candidate', f.candidatePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).addedCopies, 1);
  assert.equal(JSON.parse(result.stdout).applied, false);
});
