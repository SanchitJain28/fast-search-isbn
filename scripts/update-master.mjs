import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "node:util";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const { positionals: [input], values: { output } } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" } },
});
let csvPath = input ? path.resolve(input) : null;

if (!csvPath) {
  const masterCsvFiles = fs
    .readdirSync(rootDir)
    .filter((f) => /^master.*\.csv$/i.test(f))
    .map((f) => path.resolve(rootDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const fallbackList = [
    path.resolve(rootDir, "master-17th-oct.csv"),
    path.resolve(rootDir, "master_latest.csv"),
    path.resolve(rootDir, "master-updated.csv"),
    path.resolve(rootDir, "master.csv"),
  ];

  for (const candidate of [...masterCsvFiles, ...fallbackList]) {
    if (fs.existsSync(candidate)) {
      csvPath = candidate;
      break;
    }
  }
}

const outJsonPath = output === undefined ? path.resolve(rootDir, "public", "master.json") : path.resolve(output);
const rootJsonPath = path.resolve(rootDir, "master.json");

if (!csvPath) {
  console.error("❌ No master CSV file found.");
  process.exit(1);
}

console.log(`📖 Reading master dataset from: ${csvPath}...`);
const workbook = path.extname(csvPath).toLowerCase() === ".csv"
  ? XLSX.read(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(csvPath)), { type: "string", raw: true })
  : XLSX.readFile(csvPath, { raw: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rawRows = XLSX.utils.sheet_to_json(sheet);

console.log(
  `🔍 Calculating copy counts and sequence keys for ${rawRows.length} rows...`,
);

// First pass: count copies per cleaned ISBN
const isbnCounts = new Map();
for (let i = 0; i < rawRows.length; i++) {
  const isbnRaw = String(rawRows[i].ISBN13 || "").trim();
  const isbn = isbnRaw.replace(/[^0-9Xx]/g, "");
  if (isbn) {
    isbnCounts.set(isbn, (isbnCounts.get(isbn) || 0) + 1);
  }
}

// Second pass: build cleaned records with accurate key, seqkey, and copies
const isbnSeqMap = new Map();
const cleaned = [];

for (let i = 0; i < rawRows.length; i++) {
  const r = rawRows[i];
  const order = String(r.Order || "").trim();
  const isbnRaw = String(r.ISBN13 || "").trim();
  const isbn = isbnRaw.replace(/[^0-9Xx]/g, "");
  const title = String(r.Title || "").trim();
  const author = String(r.Author ?? "").trim();
  const qty = parseInt(r.Qty, 10) || 1;

  let key = r.key ? String(r.key).trim() : isbn || isbnRaw;
  let copies = r.copies ? parseInt(r.copies, 10) : 1;
  let seqkey = r.seqkey ? String(r.seqkey).trim() : `${key}|1`;

  if (isbn) {
    copies = r.copies ? parseInt(r.copies, 10) : isbnCounts.get(isbn) || 1;
    const seq = (isbnSeqMap.get(isbn) || 0) + 1;
    isbnSeqMap.set(isbn, seq);
    seqkey = r.seqkey ? String(r.seqkey).trim() : `${isbn}|${seq}`;
    key = r.key ? String(r.key).trim() : isbn;
  }

  if (isbn || title) {
    cleaned.push({
      Order: order,
      ISBN13: isbn || isbnRaw,
      Title: title,
      ...(author ? { Author: author } : {}),
      Qty: qty,
      key: key,
      seqkey: seqkey,
      copies: copies,
    });
  }
}

const jsonContent = JSON.stringify(cleaned);
fs.writeFileSync(outJsonPath, jsonContent, "utf8");
if (output === undefined) {
  try {
    fs.writeFileSync(rootJsonPath, jsonContent, "utf8");
  } catch (e) {}
}

const stats = fs.statSync(outJsonPath);
console.log(
  `✅ Successfully converted ${cleaned.length} records to ${outJsonPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
);
