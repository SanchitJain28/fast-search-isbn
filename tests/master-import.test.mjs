import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Master CSV preserves Unicode and optional authors in a separate candidate catalog', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'master.csv');
  const output = path.join(dir, 'candidate.json');
  const importer = fileURLToPath(new URL('../scripts/update-master.mjs', import.meta.url));
  fs.writeFileSync(input, [
    '\uFEFFOrder,ISBN13,Title,Qty,Author',
    '317,9781234567897,कर्म एवं कर्मफल,1,"  लेखक, सहलेखक  "',
    'ZB344,9781234567897,പുസ്തകം,1,',
    'ZB345,9789350000182,Latā dīdī,1,"   "',
  ].join('\n'));

  execFileSync(process.execPath, [importer, input, '--output', output]);
  const rows = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(rows.map(row => [row.Order, row.ISBN13, row.Title, row.Author, row.seqkey, row.copies]), [
    ['317', '9781234567897', 'कर्म एवं कर्मफल', 'लेखक, सहलेखक', '9781234567897|1', 2],
    ['ZB344', '9781234567897', 'പുസ്തകം', undefined, '9781234567897|2', 2],
    ['ZB345', '9789350000182', 'Latā dīdī', undefined, '9789350000182|1', 1],
  ]);
  assert.equal(Object.hasOwn(rows[1], 'Author'), false);
  assert.equal(Object.hasOwn(rows[2], 'Author'), false);
});
