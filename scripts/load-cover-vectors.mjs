import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COVER_EMBEDDING_MODEL, coverEmbeddingText, createCoverEmbedder, isCoverEmbedding } from '../server/cover-match/embedding.js';
import { createQdrantCoverClient } from '../server/cover-match/qdrant.js';
import { parsePrintedIsbn } from '../server/isbn.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputVersion = 'cover-title-author-jpeg768-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const lines = buffer => buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const now = () => performance.now();
const collectionName = (manifestHash, inputs, revision) => `isbn_covers_${digest(JSON.stringify([
  manifestHash, inputs.master.sha256, inputs.editions.sha256, COVER_EMBEDDING_MODEL, inputVersion, revision,
])).slice(0, 16)}`;

async function openImageWorker(python) {
  const child = spawn(python, [path.join(root, 'scripts/cover-image-worker.py')], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  await once(child, 'spawn');
  child.stdin.on('error', () => {});
  const input = createInterface({ input: child.stdout });
  const responses = input[Symbol.asyncIterator]();
  return {
    async prepare(book) {
      await new Promise((resolve, reject) => child.stdin.write(`${JSON.stringify(book)}\n`, error => error ? reject(error) : resolve()));
      const response = await responses.next();
      if (response.done) throw new Error('The cover image checker stopped.');
      return JSON.parse(response.value);
    },
    close() { input.close(); child.stdin.end(); },
  };
}

function openProgress(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS vectors (hash TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS books (
      collection TEXT NOT NULL, id INTEGER NOT NULL, status TEXT NOT NULL,
      hash TEXT, payload TEXT, failures TEXT NOT NULL, PRIMARY KEY (collection, id)
    );
  `);
  const get = db.prepare('SELECT status, hash, payload, failures FROM books WHERE collection=? AND id=?');
  const counts = db.prepare('SELECT status, count(*) AS count FROM books WHERE collection=? GROUP BY status');
  const save = db.prepare(`
    INSERT INTO books(collection,id,status,hash,payload,failures) VALUES (?,?,?,?,?,?)
    ON CONFLICT(collection,id) DO UPDATE SET status=excluded.status,hash=excluded.hash,
      payload=excluded.payload,failures=excluded.failures
  `);
  const getVector = db.prepare('SELECT data FROM vectors WHERE hash=?');
  const saveVector = db.prepare('INSERT OR IGNORE INTO vectors VALUES (?,?)');
  return {
    get: (collection, id) => get.get(collection, id),
    counts: collection => Object.fromEntries(counts.all(collection).map(row => [row.status, row.count])),
    save(collection, id, { status, hash = null, payload = null, failures = [] }) {
      save.run(collection, id, status, hash, payload && JSON.stringify(payload), JSON.stringify(failures));
    },
    markSaved: (collection, id) => db.prepare("UPDATE books SET status='saved' WHERE collection=? AND id=?").run(collection, id),
    markPending: collection => db.prepare("UPDATE books SET status='pending' WHERE collection=? AND status='saved'").run(collection),
    getVector(hash) {
      const blob = getVector.get(hash)?.data;
      if (!blob) return null;
      const vector = Array.from(new Float32Array(Uint8Array.from(blob).buffer));
      if (!isCoverEmbedding(vector)) throw new Error('Invalid vector in loader progress.');
      return vector;
    },
    saveVector: (hash, vector) => saveVector.run(hash, Buffer.from(Float32Array.from(vector).buffer)),
    sharedIds(collection) {
      return db.prepare(`
        WITH covers AS (
          SELECT id, json_extract(payload, '$.image_sha256') AS image_hash
          FROM books WHERE collection=? AND status='saved'
        )
        SELECT id FROM covers WHERE image_hash IN (SELECT image_hash FROM covers GROUP BY image_hash HAVING count(*) > 1)
      `).all(collection).map(row => row.id);
    },
    close: () => db.close(),
  };
}

function pacedEmbed(embed, rpm, timings) {
  let next = 0, pausedUntil = 0, rate = rpm;
  return async (image, text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      while (Math.max(next, pausedUntil) > now()) await sleep(Math.ceil(Math.max(next, pausedUntil) - now()));
      next = now() + 60000 / rate;
      const started = now();
      const deadline = AbortSignal.timeout(25000);
      timings.geminiRequests++;
      try {
        return (await embed({ bytes: image, mimeType: 'image/jpeg', text }, { signal: deadline })).vector;
      } catch (error) {
        const status = Number(error.status);
        if (status === 429 && now() >= pausedUntil) {
          rate = Math.max(Math.min(rpm, 60), Math.floor(rate * 0.75));
          pausedUntil = now() + 30000 * (attempt + 1);
          console.log(JSON.stringify({ event: 'cover-load-throttled', rpm: rate, pauseSeconds: 30 * (attempt + 1) }));
        }
        if (attempt === 3 || (![429, 500, 502, 503, 504].includes(status) && !deadline.aborted && error.name !== 'TypeError')) {
          throw new Error(status ? `Gemini returned HTTP ${status}. Resume with the same inputs after checking the limit or key.` : 'Gemini cover request failed. Resume with the same inputs to retry.');
        }
        timings.geminiRetries++;
        await sleep(1000 * 2 ** attempt);
      } finally {
        timings.geminiMs += now() - started;
      }
    }
  };
}

async function writePoint(qdrant, collection, point) {
  for (let attempt = 0; ; attempt++) {
    try {
      await qdrant.upsert(collection, [point], { signal: AbortSignal.timeout(20000) });
      return;
    } catch (error) {
      const transient = ['TimeoutError', 'TypeError'].includes(error.name) || [429, 500, 502, 503, 504].includes(error.status);
      if (!transient || attempt === 3) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function isTemporaryDownload(failure) {
  return ['download_failed', 'download_http_408', 'download_http_429', 'download_http_500',
    'download_http_502', 'download_http_503', 'download_http_504'].includes(failure.reason);
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, 'reuse-input': { type: 'string' }, 'reuse-only': { type: 'boolean' },
    'retry-skipped': { type: 'boolean' },
    master: { type: 'string' }, editions: { type: 'string' },
    state: { type: 'string' }, seed: { type: 'string' }, limit: { type: 'string' },
    concurrency: { type: 'string', default: '10' }, rpm: { type: 'string', default: '180' },
    revision: { type: 'string', default: 'first' }, python: { type: 'string', default: 'python3' },
  } });
  if (!values.input || !values.master || !values.editions || !values.state) {
    throw new Error('Pass --input, --master, --editions and --state.');
  }
  if (values['reuse-only'] && !values['reuse-input']) throw new Error('Reuse-only requires the earlier cover list.');
  if (values['reuse-only'] && values['retry-skipped']) throw new Error('Retrying skipped covers requires image downloads.');
  const limit = values.limit ? Number(values.limit) : Infinity;
  const rpm = Number(values.rpm), concurrency = Number(values.concurrency);
  if ((limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) || !Number.isSafeInteger(rpm) || rpm < 1
      || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Use positive whole numbers for limit and rpm, and concurrency from 1 through 32.');
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const qdrantKey = process.env.QDRANT__SERVICE__API_KEY?.trim() || process.env.QDRANT_API_KEY?.trim();
  const url = new URL(process.env.QDRANT_URL || 'http://127.0.0.1:6335');
  if ((!apiKey && !values['reuse-only']) || !qdrantKey || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('The loader needs Gemini and Qdrant write keys and a loopback Qdrant address.');
  }
  const [manifest, rawSummary] = await Promise.all([
    readFile(path.join(values.input, 'candidates.jsonl')), readFile(path.join(values.input, 'summary.json')),
  ]);
  const { inputs, stats } = JSON.parse(rawSummary);
  async function verifyInputs() {
    for (const name of ['master', 'editions']) {
      if (digest(await readFile(values[name])) !== inputs[name].sha256) {
        throw new Error(`The ${name} differs from the cover list. Prepare a new input before continuing.`);
      }
    }
  }
  await verifyInputs();
  const manifestHash = digest(manifest);
  const collection = collectionName(manifestHash, inputs, values.revision);
  const books = lines(manifest);
  const ids = new Set();
  for (const book of books) {
    if (parsePrintedIsbn(book.po_isbn) !== book.isbn13 || !book.isbn13 || ids.has(book.isbn13)
        || !book.title || !book.covers?.length) throw new Error('Invalid book in the cover list.');
    ids.add(book.isbn13);
  }
  if (!books.length || books.length !== stats.isbn_candidates) throw new Error('The cover list count does not match its summary.');
  const seed = new Set(values.seed ? lines(await readFile(values.seed)).map(row => row.po_isbn) : []);
  const ordered = seed.size ? [...books.filter(row => seed.has(row.po_isbn)), ...books.filter(row => !seed.has(row.po_isbn))] : books;
  let oldCollection;
  const oldBooks = new Map();
  if (values['reuse-input']) {
    const oldManifest = await readFile(path.join(values['reuse-input'], 'candidates.jsonl'));
    const oldSummary = JSON.parse(await readFile(path.join(values['reuse-input'], 'summary.json'), 'utf8'));
    oldCollection = collectionName(digest(oldManifest), oldSummary.inputs, values.revision);
    if (oldCollection === collection) throw new Error('Reuse requires a different, earlier cover list.');
    for (const book of lines(oldManifest)) oldBooks.set(book.isbn13, digest(JSON.stringify(book)));
  }
  await mkdir(values.state, { recursive: true, mode: 0o700 });
  const qdrant = createQdrantCoverClient({ url, apiKey: qdrantKey });
  const progress = openProgress(path.join(values.state, 'progress.sqlite'));
  const timings = { prepared: 0, imageMs: 0, geminiRequests: 0, geminiRetries: 0, geminiMs: 0,
    reusedRecords: 0, reusedVectors: 0, written: 0, qdrantMs: 0 };
  const embed = values['reuse-only'] ? null : pacedEmbed(createCoverEmbedder({ apiKey }), rpm, timings);
  let stop = false, fatal, next = 0, finished = 0;
  process.once('SIGTERM', () => { stop = true; });
  process.once('SIGINT', () => { stop = true; });
  const started = now();
  try {
    const requested = ordered.slice(0, limit);
    const selected = values['reuse-only'] ? requested.filter(book => {
      if (oldBooks.get(book.isbn13) !== digest(JSON.stringify(book))) return false;
      const old = progress.get(oldCollection, Number(book.isbn13));
      return ['saved', 'skipped', 'pending'].includes(old?.status);
    }) : requested;
    if (!selected.length) throw new Error('No matching saved covers were found to load.');
    await qdrant.ensureCollection(collection);
    const existing = await qdrant.count(collection);
    const prior = progress.counts(collection);
    if (existing > (prior.saved || 0) + (prior.pending || 0)) throw new Error('Qdrant has more points than this loader journal.');
    if (existing < (prior.saved || 0)) progress.markPending(collection);
    console.log(JSON.stringify({ event: 'cover-load-start', collection, selected: selected.length, total: books.length, rpm, concurrency, existing }));

    async function load(book, worker) {
      const id = Number(book.isbn13);
      let previous = progress.get(collection, id);
      if (previous?.status === 'saved' || (previous?.status === 'skipped' && !values['retry-skipped'])) return;
      if (!previous && oldBooks.get(book.isbn13) === digest(JSON.stringify(book))) {
        const old = progress.get(oldCollection, id);
        if (old?.status === 'skipped') {
          progress.save(collection, id, { status: 'skipped', failures: JSON.parse(old.failures) });
          return;
        }
        if (old?.status === 'saved' || old?.status === 'pending') {
          previous = { ...old, status: 'pending' };
          progress.save(collection, id, { status: 'pending', hash: old.hash,
            payload: JSON.parse(old.payload), failures: JSON.parse(old.failures) });
          timings.reusedRecords++;
        }
      }
      let payload, hash, vector;
      if (previous?.status === 'pending') {
        payload = JSON.parse(previous.payload);
        hash = previous.hash;
        vector = progress.getVector(hash);
        if (!vector) throw new Error('A pending Qdrant write is missing its saved embedding.');
        timings.reusedVectors++;
      } else {
        if (!embed) throw new Error('Reuse-only found a book without a saved embedding.');
        const begin = now();
        const prepared = await worker.prepare(book);
        timings.prepared++;
        timings.imageMs += now() - begin;
        if (!prepared.cover) {
          progress.save(collection, id, {
            status: prepared.failures.some(isTemporaryDownload) ? 'retry' : 'skipped', failures: prepared.failures,
          });
          return;
        }
        const { cover, image_sha256, failures } = prepared;
        const reviewCover = ['review_different_isbn', 'review_no_valid_isbn'].includes(cover.match);
        const text = reviewCover
          ? cover.listing_title && coverEmbeddingText({ title: cover.listing_title })
          : coverEmbeddingText({ title: book.title, author: cover.author });
        hash = digest(JSON.stringify([COVER_EMBEDDING_MODEL, inputVersion, image_sha256, text]));
        vector = progress.getVector(hash);
        if (vector) timings.reusedVectors++;
        else {
          vector = await embed(Buffer.from(prepared.image, 'base64'), text);
          progress.saveVector(hash, vector);
        }
        payload = {
          po_isbn: book.po_isbn, amazon_isbn: reviewCover || cover.match === 'approved_replacement' ? cover.found_isbn : null,
          title: book.title, author: cover.author ?? null, cover_url: cover.cover_url, image_sha256,
          shared_cover: cover.shared_cover_url === true, input_version: inputVersion,
          ...(reviewCover ? { cover_match: cover.match, listing_title: cover.listing_title || null } : {}),
        };
        progress.save(collection, id, { status: 'pending', hash, payload, failures });
      }
      const begin = now();
      await writePoint(qdrant, collection, { id, vector, payload });
      progress.markSaved(collection, id);
      timings.written++;
      timings.qdrantMs += now() - begin;
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      let worker;
      try {
        if (!values['reuse-only']) worker = await openImageWorker(values.python);
        while (!stop && !fatal && next < selected.length) {
          await load(selected[next++], worker);
          finished++;
          if (finished % 100 === 0) console.log(JSON.stringify({ event: 'cover-load-progress', finished, selected: selected.length,
            counts: progress.counts(collection), elapsedSeconds: Math.round((now() - started) / 1000) }));
          if (finished % 2000 === 0) await verifyInputs();
        }
      } catch (error) { fatal ??= error; }
      finally { worker?.close(); }
    }));

    if (fatal) console.error(`Cover loader paused: ${fatal.message}`);
    const shared = progress.sharedIds(collection);
    for (let start = 0; start < shared.length; start += 500) {
      await qdrant.flagShared(collection, shared.slice(start, start + 500));
    }
    const counts = progress.counts(collection);
    const qdrantCount = await qdrant.count(collection);
    await verifyInputs();
    const elapsedSeconds = (now() - started) / 1000;
    const report = {
      collection, inputVersion, inputs, manifestHash, total: books.length, selected: selected.length, finished, counts, qdrantCount,
      duplicateImageRecords: shared.length, elapsedSeconds, booksSavedPerMinute: timings.written * 60 / elapsedSeconds, timings,
      complete: !stop && !fatal && selected.length === books.length && finished === selected.length
        && (counts.saved || 0) + (counts.skipped || 0) === books.length && qdrantCount === (counts.saved || 0),
    };
    const file = path.join(values.state, `${collection}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    console.log(JSON.stringify({ event: 'cover-load-end', ...report }));
    if (fatal) throw fatal;
    if (qdrantCount !== (counts.saved || 0)) throw new Error('Qdrant and the loader journal disagree. Resume to finish pending writes.');
    if (stop || counts.retry) process.exitCode = 2;
  } finally {
    progress.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
