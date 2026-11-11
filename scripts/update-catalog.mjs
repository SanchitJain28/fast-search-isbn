import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIsbn } from '../server/store.js';

// Append an expanded catalog without changing any existing scan or allocation.
export function updateCatalog({ catalogPath, candidatePath, databasePath, apply = false }) {
  const oldText = fs.readFileSync(catalogPath, 'utf8');
  const previous = JSON.parse(oldText);
  const next = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length < previous.length) throw new Error('Updated catalog must retain every existing copy');
  const order = row => String(row.Order ?? '').trim();
  for (let i = 0; i < previous.length; i++) {
    if (normalizeIsbn(previous[i].ISBN13) !== normalizeIsbn(next[i].ISBN13) || order(previous[i]) !== order(next[i])) throw new Error(`Existing copy moved or changed at catalog row ${i + 1}`);
  }
  for (let i = 0; i < next.length; i++) {
    if (!normalizeIsbn(next[i].ISBN13) || !order(next[i])) throw new Error(`Missing ISBN or order at catalog row ${i + 1}`);
  }
  const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const oldHash = hash(previous), newHash = hash(next);
  const db = new DatabaseSync(databasePath, { readOnly: !apply });
  let replaced = false;
  const temporary = `${catalogPath}.next`;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const meta = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
    if (meta('ready') !== 'yes') throw new Error('Packing history is not initialized');
    if (meta('catalog') !== oldHash) throw new Error('Current catalog does not match the reconciled packing database');
    const active = db.prepare('SELECT seq,isbn,order_name,allocation,status_type FROM scans WHERE allocation IS NOT NULL').all();
    for (const scan of active) {
      const index = Number(scan.allocation);
      const row = previous[index];
      if (!Number.isSafeInteger(index) || index < 0 || !row || scan.status_type !== 'PACK' || normalizeIsbn(row.ISBN13) !== scan.isbn || order(row) !== scan.order_name) throw new Error(`Existing packing allocation conflicts at scan sequence ${scan.seq}`);
    }
    const report = { applied: apply, previousCopies: previous.length, updatedCopies: next.length, addedCopies: next.length - previous.length,
      scansPreserved: db.prepare('SELECT COUNT(*) AS count FROM scans').get().count, allocationsPreserved: active.length,
      oldHash, newHash, orderTotals: next.reduce((totals, row) => { const key = order(row); totals[key] = (totals[key] || 0) + 1; return totals; }, {}) };
    if (apply) {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: fs.statSync(catalogPath).mode & 0o777 });
      fs.renameSync(temporary, catalogPath); replaced = true;
      db.prepare('UPDATE meta SET value=? WHERE key=?').run(newHash, 'catalog');
    }
    db.exec('COMMIT');
    return report;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (replaced) fs.writeFileSync(catalogPath, oldText);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const value = option => { const index = args.indexOf(option); return index < 0 ? undefined : args[index + 1]; };
  const root = path.resolve(value('--root') || fileURLToPath(new URL('../', import.meta.url)));
  const candidatePath = value('--candidate');
  if (!candidatePath) throw new Error('Usage: node scripts/update-catalog.mjs --candidate NEW.json [--root APP] [--database DB] [--apply]');
  console.log(JSON.stringify(updateCatalog({ candidatePath: path.resolve(candidatePath), catalogPath: path.join(root, 'public/master.json'),
    databasePath: value('--database') || process.env.PACKING_DB || path.join(root, 'data/packing.sqlite'), apply: args.includes('--apply') }), null, 2));
}
