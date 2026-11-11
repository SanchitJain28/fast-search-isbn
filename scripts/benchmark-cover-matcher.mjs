import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openCoverMatcher } from '../server/cover-match/worker.js';
import { PackingStore } from '../server/store.js';

const { positionals: [catalogPath], values } = parseArgs({
  allowPositionals: true,
  options: { exhaustive: { type: 'boolean' }, rounds: { type: 'string', default: '20' } },
});
const rounds = Number(values.rounds);
if (!catalogPath || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('Usage: node scripts/benchmark-cover-matcher.mjs CATALOG.json [--rounds N] [--exhaustive]');
}

function timings(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = fraction => Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 100) / 100;
  return sorted.length ? { p50: at(0.5), p95: at(0.95), max: at(1) } : null;
}

function checkCase(fixture, result) {
  const topThree = result.matches.slice(0, 3).map(match => match.isbn);
  for (const isbn of fixture.expectedTopThree ?? []) assert(topThree.includes(isbn), `${fixture.id}: missing ${isbn} in top three`);
  for (const { isbn, order } of fixture.ambiguousIdentities ?? []) {
    const match = result.matches.find(candidate => candidate.isbn === isbn);
    assert(match?.copies.some(copy => copy.order === order), `${fixture.id}: missing competing ${isbn} in order ${order}`);
  }
  if (fixture.expectedDecision === 'REVIEW') assert(result.reviewReasons.length, `${fixture.id}: review required`);
  if (fixture.expectedDecision === 'NO_MATCH') assert.equal(result.matches.length, 0, fixture.id);
}

const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/cover-match-cases.json', import.meta.url), 'utf8'));
const cases = fixtures.cases.filter(fixture => fixture.query !== undefined);
const pressureCases = [
  ...cases,
  { query: { title_as_printed: 'Geometry and Trigonometry, Volume 11', romanized_title: 'Geometry and Trigonometry', english_title: 'The Elements of Geometry' } },
  { query: { title_as_printed: 'Karm evam Karmphal Mimansa', native_title: 'कर्म एवं कर्मफल मीमांसा', english_title: 'The Philosophy of Action and Its Results' } },
  { query: 'The' },
];
const half = Math.ceil(pressureCases.length / 2);
const batches = [pressureCases.slice(0, half), pressureCases.slice(half)];
const rssBefore = process.memoryUsage.rss();
const start = performance.now();
const matcher = await openCoverMatcher({ catalogPath });
const startupMs = Math.round(performance.now() - start);
const store = new PackingStore(':memory:', [{ ISBN13: '9780367411718', Order: '317', Title: 'Benchmark copy' }]);
let interval;
try {
  store.initializeEmpty();
  const indexed = new Map();
  for (const fixture of cases) {
    const result = await matcher.match(fixture.query);
    checkCase(fixture, result);
    indexed.set(fixture.id, result);
  }

  const lookup = [], scan = [], delay = [];
  let tick = performance.now();
  interval = setInterval(() => {
    const now = performance.now();
    delay.push(Math.max(0, now - tick - 5));
    tick = now;
    const record = store.scan({ id: `benchmark-${scan.length}`, isbn: '9780367411718' });
    assert.equal(record.statusType, scan.length === 0 ? 'PACK' : 'DUPLICATE');
    scan.push(performance.now() - now);
  }, 5);
  for (let round = 0; round < rounds; round++) {
    for (const batch of batches) {
      const time = performance.now();
      await Promise.all(batch.map(async fixture => {
        await matcher.match(fixture.query);
        lookup.push(performance.now() - time);
      }));
    }
  }
  clearInterval(interval);

  const output = {
    catalogVersion: matcher.catalogVersion, startupMs,
    rssDeltaMiB: Math.round((process.memoryUsage.rss() - rssBefore) / 1024 ** 2),
    caseCount: cases.length, labeledTitleRecall: `${cases.filter(fixture => fixture.expectedTopThree).length}/${cases.filter(fixture => fixture.expectedTopThree).length}`,
    indexedLookupCount: lookup.length, concurrentLookupMs: timings(lookup),
    concurrentBarcodeTransactions: scan.length, barcodeTransactionMs: timings(scan), mainThreadTimerDelayMs: timings(delay),
  };
  assert(output.concurrentLookupMs.p95 < 1000, 'Indexed p95 exceeded one second');
  if (values.exhaustive) {
    const comparisons = [];
    for (const fixture of cases) {
      const began = performance.now();
      const full = await matcher.match(fixture.query, { exhaustive: true });
      checkCase(fixture, full);
      const short = indexed.get(fixture.id);
      const shortIds = new Set(short.matches.map(match => match.isbn));
      const topScore = full.matches[0]?.score;
      const missingClose = full.matches.filter(match => topScore - match.score < 8 && !shortIds.has(match.isbn)).length;
      if (missingClose) assert(short.reviewReasons.length, `${fixture.id}: a close full-search competitor was omitted without a review reason`);
      comparisons.push({ case: fixture.id, fullMs: Math.round(performance.now() - began), missingClose });
    }
    output.exhaustiveComparison = comparisons;
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  clearInterval(interval);
  store.close();
  await matcher.close();
}
