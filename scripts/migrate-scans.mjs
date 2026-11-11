import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { PackingStore, normalizeIsbn } from '../server/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
if (fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const args = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/master.json'), 'utf8'));
const dbPath = process.env.PACKING_DB || path.join(root, 'data/packing.sqlite');
const apply = args.includes('--apply');
const append = args.includes('--append');
if (args.includes('--empty')) {
  if (!apply) throw new Error('For a genuinely new packing run use --empty --apply. Existing runs must import history.');
  const store = new PackingStore(dbPath, catalog); store.initializeEmpty(); store.close();
  console.log('New empty run initialized.');
} else {
  const input = args.find(arg => !arg.startsWith('--'));
  if (!input) throw new Error('Usage: npm run migrate -- history.csv [--apply]');
  const workbook = /\.csv$/i.test(input) ? XLSX.read(fs.readFileSync(input, 'utf8'), { type: 'string', raw: true }) : XLSX.readFile(input, { raw: true });
  const sheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'scan') || workbook.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  const headerIndex = grid.findIndex(row => /isbn/i.test(String(row[0])));
  if (headerIndex < 0) throw new Error('Missing ISBN header in first column');
  const header = grid[headerIndex].map(String);
  const statusCol = header.findIndex(v => /^status$/i.test(v.trim()));
  const orderCol = header.findIndex(v => /^order(?:\s*\(box\))?$/i.test(v.trim()));
  const timeCol = header.findIndex(v => /time/i.test(v));
  if (statusCol < 0 || orderCol < 0) throw new Error('Export must include ISBN, Order and Status columns');
  const sourceHash = createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  const scratch = new PackingStore(':memory:', catalog);
  scratch.initializeEmpty();
  const issues = [], warnings = [], records = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const row = grid[i]; const isbn = normalizeIsbn(row[0]) || String(row[0] || '').trim();
    if (!isbn) continue;
    const status = String(row[statusCol]).trim(); const order = String(row[orderCol]).trim();
    const fail = reason => issues.push({ row: i + 1, isbn, order, status, reason });
    const type = /NOT\s*FOUND/i.test(status) ? 'NOT_FOUND' : /DUPLICATE/i.test(status) ? 'DUPLICATE' : /\bPACK\b/i.test(status) ? 'PACK' : null;
    if (!type) { fail('Blank or unrecognized result; resolve against the physical packing record'); continue; }
    if (type !== 'NOT_FOUND' && !/^\d{4,32}X?$/.test(isbn)) { fail('Invalid ISBN on a non-NOT-FOUND result'); continue; }
    if (type === 'NOT_FOUND' && !/^\d{4,32}X?$/.test(isbn)) warnings.push({ row: i + 1, isbn, reason: 'Non-ISBN barcode preserved as historical NOT FOUND' });
    const copies = scratch.byIsbn.get(isbn) || [];
    const used = new Set(scratch.db.prepare('SELECT allocation FROM scans WHERE isbn=? AND allocation IS NOT NULL').all(isbn).map(r => r.allocation));
    const target = copies.find(c => c.order === order && !used.has(c.allocation));
    if (type === 'PACK' && !target) { fail('Recorded order has no unallocated catalog copy'); continue; }
    if (type === 'NOT_FOUND' && copies.length) warnings.push({ row: i + 1, isbn, reason: 'Historical NOT FOUND preserved; this ISBN now exists in the catalog' });
    if (type === 'DUPLICATE' && (!copies.length || used.size < copies.length)) { fail('Duplicate conflicts with catalog/history'); continue; }
    const entry = { id: `history-${sourceHash.slice(0, 16)}-${i}`, isbn, order: type === 'PACK' ? order : '', title: target?.title || copies[0]?.title || String(row[2] || ''),
      statusType: type, status, copyNum: used.size + (type === 'PACK' ? 1 : 0), totalCopies: copies.length,
      createdAt: timeCol >= 0 && row[timeCol] ? String(row[timeCol]) : 'Historical scan', station: 'Imported history' };
    scratch.insert(entry, type === 'PACK' ? target.allocation : null);
    records.push({ entry, allocation: type === 'PACK' ? target.allocation : null });
  }
  const report = process.env.PACKING_MIGRATION_REPORT || path.join(root, 'data/migration-report.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify({ source: path.resolve(input), sourceHash, valid: records.length, issues, warnings }, null, 2));
  console.log(`${records.length} valid historical attempts; ${issues.length} issues; ${warnings.length} historical warnings. Report: ${report}`);
  if (apply) {
    if (issues.length) throw new Error('History was not imported. Resolve report issues and re-run.');
    const store = new PackingStore(dbPath, catalog);
    let start = 0;
    if (append) {
      if (!store.ready) throw new Error('Append requires a reconciled database with the same catalog');
      const existing = store.list().reverse();
      if (existing.length > records.length) throw new Error('Source history is shorter than the existing database');
      const fields = ['isbn','order','title','statusType','status','copyNum','totalCopies','createdAt','station'];
      for (let i = 0; i < existing.length; i++) {
        if (existing[i].station !== 'Imported history' || fields.some(key => existing[i][key] !== records[i].entry[key])) throw new Error(`History prefix differs at attempt ${i + 1}; reconcile manually. Append never overwrites existing scans.`);
      }
      start = existing.length;
    } else if (store.stats().count || store.getMeta('ready')) throw new Error('Migration requires a new database. Stop server and preserve existing database before proceeding.');
    store.transaction(() => {
      for (const r of records.slice(start)) store.insert(r.entry, r.allocation);
      store.setMeta('catalog', store.catalogHash); store.setMeta('ready', 'yes'); store.setMeta('historySource', sourceHash);
    });
    store.close(); console.log(`${records.length - start} attempts imported. Start the server and verify order totals.`);
  }
  scratch.close();
}
