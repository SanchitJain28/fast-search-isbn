import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogTitleMatcher } from '../server/cover-match/matcher.js';
import { titleKeys } from '../server/cover-match/normalization.js';
import { openCoverMatcher } from '../server/cover-match/worker.js';

const book = (ISBN13, Title, Order = 'A', Author) => ({ ISBN13, Title, Order, Author });

test('normalizes Unicode and bridges mixed regional and Latin title forms', () => {
  assert.equal(titleKeys('  Latā   dīdī—२ ').unicode, 'latā dīdī २');
  assert.equal(titleKeys('പുസ്തകം').unicode, 'പുസ്തകം');
  assert.equal(titleKeys('பாடுக').unicode, 'பாடுக');
  assert.equal(titleKeys('१०५ নং').phonetic, '105 nam');
  assert.equal(titleKeys('Latā दिदी').phonetic, 'lata didi');
  assert.equal(titleKeys('Volume 11').phonetic, 'volume 11');

  const matcher = new CatalogTitleMatcher([book('1', 'श्री हरि कृष्ण'), book('2', 'വൈവാഹികം')]);
  const crossScript = matcher.match('Sri Hari Krishna').matches[0];
  assert.equal(crossScript.isbn, '1');
  assert.equal(crossScript.evidence.keyType, 'phonetic');
  assert(crossScript.score >= 89);
  assert.equal(matcher.match({ native_title: 'വൈവാഹികം', title_as_printed: 'different' }).matches[0].isbn, '2');
});

test('finds OCR spelling variants and keeps edition noise as lower-quality evidence', () => {
  const matcher = new CatalogTitleMatcher([book('1', 'Watercolors'), book('2', 'Advanced Geometry')]);
  assert.equal(matcher.match('Watercolros').matches[0].isbn, '1');
  const result = matcher.match('Geometry Advanced 3rd edition');
  assert.equal(result.matches[0].isbn, '2');
  assert.equal(result.matches[0].score, 100);
  assert(result.reviewReasons.includes('subset_title'));
  assert.deepEqual(matcher.match('   ').reviewReasons, ['no_match']);
});

test('retains distinct ISBNs and all copy positions, with optional author evidence', () => {
  const matcher = new CatalogTitleMatcher([
    book('1', 'Macbeth', 'A', 'William Shakespeare'),
    book('1', 'Macbeth', 'B', 'William Shakespeare'),
    book('2', 'Macbeth', 'A', 'W. J. Craig'),
    book('3', 'Macbeth', 'A'),
    book('4', 'Macbeth', 'C'),
    book('5', 'Macbeth Revision Cards', 'C', 'W. J. Craig'),
  ]);
  const result = matcher.match({ title_as_printed: 'Macbeth', author: 'W J Craig' });
  assert.equal(result.matches[0].isbn, '2');
  assert.equal(result.matches[0].authorAgreement, 'match');
  assert.equal(result.matches.find(match => match.isbn === '3').authorAgreement, 'unknown');
  assert.deepEqual(result.matches.find(match => match.isbn === '1').copies.map(copy => copy.rowIndex), [0, 1]);
  assert.deepEqual(result.matches.map(match => match.isbn), ['2', '1', '3', '4', '5']);
  assert(result.reviewReasons.includes('close_scores'));
  assert(matcher.match('Macbeth').reviewReasons.includes('multiple_catalog_orders'));
});

test('keeps all identities sharing an exact title even when the shortlist is capped', () => {
  const catalog = Array.from({ length: 900 }, (_, i) => book(`other-${i}`, `The Book Volume ${i}`));
  catalog.push(book('one', 'The Book'), book('two', 'The Book'));
  const result = new CatalogTitleMatcher(catalog).match('The Book');
  assert.deepEqual(result.matches.slice(0, 2).map(match => match.isbn), ['one', 'two']);
  assert(result.reviewReasons.includes('shortlist_truncated'));
});

test('flags competing volume numbers and translation-only evidence for review', () => {
  const matcher = new CatalogTitleMatcher([
    book('1', 'Fundamentals of Geometry Volume 1'),
    book('2', 'Fundamentals of Geometry Volume 11'),
  ]);
  const volumes = matcher.match('Fundamentals of Geometry Volume 11');
  assert.deepEqual(volumes.matches.map(match => match.isbn), ['2', '1']);
  assert(volumes.reviewReasons.includes('close_scores'));
  const translated = matcher.match({ english_title: 'Fundamentals of Geometry Volume 11' });
  assert(translated.reviewReasons.includes('translated_title'));
});

test('worker serves concurrent lookups and rejects a stale catalog version', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-matcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'master.json');
  fs.writeFileSync(catalogPath, JSON.stringify([book('1', 'Geometry'), book('2', 'പുസ്തകം')]));
  await assert.rejects(openCoverMatcher({ catalogPath, expectedCatalogVersion: 'old' }), /does not match/);
  const worker = await openCoverMatcher({ catalogPath });
  try {
    assert.match(worker.catalogVersion, /^[a-f0-9]{64}$/);
    const results = await Promise.all([worker.match('Geometry'), worker.match('പുസ്തകം')]);
    assert.deepEqual(results.map(result => result.matches[0].isbn), ['1', '2']);
    await assert.rejects(worker.match('Geometry', { minScore: -1 }), /between 0 and 100/);
  } finally {
    await worker.close();
  }
  await assert.rejects(worker.match('Geometry'), /closed/);
});
