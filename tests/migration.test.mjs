import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PackingStore } from '../server/store.js';
const catalog = JSON.parse(fs.readFileSync(new URL('../public/master.json', import.meta.url), 'utf8'));
const grouped = new Map();
for (const row of catalog) { const list = grouped.get(row.ISBN13) || []; list.push(row); grouped.set(row.ISBN13, list); }
const copies = [...grouped.values()].find(rows => rows.length === 2 && rows[0].Order !== rows[1].Order);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-migrate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PACKING_DB: path.join(dir, 'packing.sqlite'), PACKING_MIGRATION_REPORT: path.join(dir, 'report.json') };
  const run = (...args) => execFileSync(process.execPath, ['scripts/migrate-scans.mjs', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, env, run };
}
test('migration dry run preserves source and apply preserves recorded orders', t => {
  const { dir, env, run } = setup(t);
  assert.ok(copies);
  const file = path.join(dir, 'history.csv');
  const csv = `ISBN13,Order,Title,Status,Time\n${copies[0].ISBN13},${copies[1].Order},Book,PACK,Old time\n${copies[0].ISBN13},${copies[0].Order},Book,PACK,Old time\n${copies[0].ISBN13},,Book,DUPLICATE,Old time\n`;
  fs.writeFileSync(file, csv);
  run(file); assert.equal(fs.existsSync(env.PACKING_DB), false);
  assert.equal(JSON.parse(fs.readFileSync(env.PACKING_MIGRATION_REPORT)).issues.length, 0);
  run(file, '--apply'); assert.equal(fs.readFileSync(file, 'utf8'), csv);
  const store = new PackingStore(env.PACKING_DB, catalog);
  assert.equal(store.ready, true); assert.equal(store.list().at(-1).order, copies[1].Order);
  assert.equal(store.scan({ id: 'migration-retry', isbn: copies[0].ISBN13 }).statusType, 'DUPLICATE');
  store.close();
  assert.throws(() => run(file, '--apply'), /Migration requires a new database/);
  const backup = path.join(dir, 'backup.sqlite');
  execFileSync(process.execPath, ['scripts/backup-db.mjs', backup], { env, stdio: 'pipe' });
  const restored = new PackingStore(backup, catalog); assert.equal(restored.stats().count, 4); restored.close();
});
test('blank historical results block import instead of guessing packed progress', t => {
  const { dir, env, run } = setup(t); const file = path.join(dir, 'blank.csv');
  fs.writeFileSync(file, `ISBN13,Order,Title,Status\n${copies[0].ISBN13},${copies[0].Order},Book,\n`);
  assert.throws(() => run(file, '--apply'), /History was not imported/);
  assert.equal(fs.existsSync(env.PACKING_DB), false);
  assert.match(JSON.parse(fs.readFileSync(env.PACKING_MIGRATION_REPORT)).issues[0].reason, /Blank/);
});

test('historical NOT FOUND rows are retained without consuming catalog copies', t => {
  const { dir, env, run } = setup(t); const file = path.join(dir, 'unknown.csv');
  fs.writeFileSync(file, `ISBN13,Order,Title,Status\nX001ZPMAV9,NOT FOUND,,❌ NOT FOUND — search by name\n${copies[0].ISBN13},NOT FOUND,,❌ NOT FOUND — search by name\n`);
  run(file, '--apply');
  const report = JSON.parse(fs.readFileSync(env.PACKING_MIGRATION_REPORT));
  assert.equal(report.issues.length, 0); assert.equal(report.warnings.length, 2);
  const store = new PackingStore(env.PACKING_DB, catalog);
  assert.equal(store.stats().count, 2); assert.match(store.list()[0].status, /❌ NOT FOUND —/);
  assert.equal(store.scan({id:'known-after-unknown', isbn:copies[0].ISBN13}).copyNum, 1); store.close();
});

test('cutover append preserves prior request IDs and only imports an unchanged history suffix', t => {
  const { dir, env, run } = setup(t); const file = path.join(dir, 'followup.csv');
  const first = `ISBN13,Order,Title,Status\n${copies[0].ISBN13},${copies[0].Order},Book,PACK\n`;
  fs.writeFileSync(file, first); run(file, '--apply');
  let store = new PackingStore(env.PACKING_DB, catalog); const id = store.list()[0].id; store.close();
  fs.writeFileSync(file, first + `${copies[0].ISBN13},${copies[1].Order},Book,PACK\n`);
  run(file, '--append', '--apply');
  store = new PackingStore(env.PACKING_DB, catalog); assert.equal(store.stats().count, 2); assert.equal(store.list().at(-1).id, id); store.close();
  fs.writeFileSync(file, first.replace(',PACK', ',NOT FOUND'));
  assert.throws(() => run(file, '--append', '--apply'), /Source history is shorter|History prefix differs/);
});
