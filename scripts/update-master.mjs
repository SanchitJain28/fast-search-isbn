import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const csvPath = path.resolve(rootDir, 'master-updated.csv');
const outJsonPath = path.resolve(rootDir, 'public', 'master.json');

if (!fs.existsSync(csvPath)) {
  console.error(`❌ master-updated.csv not found at: ${csvPath}`);
  process.exit(1);
}

console.log(`📖 Reading ${csvPath}...`);
const workbook = XLSX.readFile(csvPath, { raw: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rawRows = XLSX.utils.sheet_to_json(sheet);

const cleaned = [];
for (let i = 0; i < rawRows.length; i++) {
  const r = rawRows[i];
  const order = String(r.Order || '').trim();
  const isbnRaw = String(r.ISBN13 || '').trim();
  const isbn = isbnRaw.replace(/[^0-9Xx]/g, '');
  const title = String(r.Title || '').trim();
  const qty = parseInt(r.Qty, 10) || 1;
  const key = String(r.key || isbn || isbnRaw).trim();
  const seqkey = String(r.seqkey || `${isbn || isbnRaw}|1`).trim();
  const copies = parseInt(r.copies, 10) || 1;

  if (isbn || title) {
    cleaned.push({
      Order: order,
      ISBN13: isbn || isbnRaw,
      Title: title,
      Qty: qty,
      key: key,
      seqkey: seqkey,
      copies: copies,
    });
  }
}

fs.writeFileSync(outJsonPath, JSON.stringify(cleaned), 'utf8');
const stats = fs.statSync(outJsonPath);
console.log(`✅ Converted ${cleaned.length} records to ${outJsonPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
