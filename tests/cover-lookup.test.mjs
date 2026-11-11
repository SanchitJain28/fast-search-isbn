import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoverConfirmation } from '../server/cover-match/confirmation.js';
import { createGeminiVisionProvider } from '../server/cover-match/vision.js';
import { MAX_IMAGE_BYTES } from '../server/cover-match/upload.js';
import { createProductionServer } from '../server/http.js';
import { parsePrintedIsbn } from '../server/isbn.js';
import { SheetMirror } from '../server/sheets.js';
import { PackingStore } from '../server/store.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
const extraction = (fields = {}) => ({ title_as_printed: '', author: '', native_title: '', romanized_title: '', english_title: '', isbn_text: '', ...fields });
const catalog = [
  { ISBN13: '9780804429573', Order: 'A', Title: 'The Inside Page Book', Author: 'A. Writer' },
  { ISBN13: '9780804429573', Order: 'B', Title: 'The Inside Page Book', Author: 'A. Writer' },
  { ISBN13: '9789359621845', Order: 'C', Title: 'VAIVAHIKAM (വൈവാഹികം)' },
  { ISBN13: '9788184469660', Order: 'C', Title: 'பாடுக பாட்டே' },
  { ISBN13: '9780700702008', Order: 'D', Title: 'Archaeology', Author: 'N. Author' },
  { ISBN13: '9780700702008', Order: 'D', Title: 'Archaeology', Author: 'N. Author' },
];
const knownEdition = '9780367411718';
const conflictingEdition = '9781542016568';
const editions = {
  mappings: [{ barcode: knownEdition, poIsbn: '9780700702008', order: 'D', quantity: 1 }],
  conflicts: [{ barcode: conflictingEdition, targets: [['9780804429573', 'A'], ['9789359621845', 'C']] }],
};

async function scanner(t, coverMatch, seed = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-lookup-'));
  for (const directory of ['public', 'dist', 'data']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'public/master.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<h1>Scanner</h1>');
  fs.writeFileSync(path.join(root, 'data/amazon-editions.json'), JSON.stringify(editions));
  const databasePath = path.join(root, 'data/packing.sqlite');
  const store = new PackingStore(databasePath, catalog, editions);
  store.initializeEmpty();
  seed(store);
  const count = store.stats().count;
  const catalogVersion = store.catalogHash;
  store.close();
  const salt = 'b'.repeat(32);
  const password = 'temporary-test-password';
  const passwordHash = `scrypt:${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
  const origin = 'https://scanner.example.test';
  const server = createProductionServer(root, { databasePath, username: 'scanner', passwordHash, publicOrigin: origin, coverMatch });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`scanner:${password}`).toString('base64')}`;
  const request = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { authorization, Origin: origin, ...options.headers } });
  return { base, request, count, catalogVersion, databasePath };
}

function form(bytes = png, type = 'image/png') {
  const body = new FormData();
  body.append('image', new Blob([bytes], { type }), 'capture');
  return body;
}

test('checks both ISBN checksums and preserves terminal X', () => {
  assert.equal(parsePrintedIsbn('ISBN‑10: 0–8044–2957–x'), '9780804429573');
  assert.equal(parsePrintedIsbn('ISBN-13: 978-0-7007-0200-8'), '9780700702008');
  assert.equal(parsePrintedIsbn('9780700702009'), '');
  assert.equal(parsePrintedIsbn('0-8044-2957-1'), '');
  assert.equal(parsePrintedIsbn('0-8044-2957-X or 9780700702008'), '');
  assert.equal(parsePrintedIsbn('the code is 9780700702008'), '');
});

test('Gemini adapter sends a single image and a strict schema, then rejects invalid output', async () => {
  let request;
  let text = JSON.stringify(extraction({ title_as_printed: '  The Inside Page Book  ' }));
  const client = { models: { async generateContent(input) { request = input; return { text }; } } };
  const provider = createGeminiVisionProvider({ client });
  const signal = new AbortController().signal;
  assert.equal((await provider.extract({ bytes: png, mimeType: 'image/png' }, { signal })).title_as_printed, 'The Inside Page Book');
  assert.equal(request.model, 'gemini-3.8-flash');
  assert.equal(request.config.abortSignal, signal);
  assert.equal(request.config.responseJsonSchema.additionalProperties, false);
  assert.deepEqual(request.config.responseJsonSchema.required, Object.keys(extraction()));
  assert.deepEqual(request.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: png.toString('base64') } });
  text = '{"title_as_printed":"Missing fields"}';
  await assert.rejects(provider.extract({ bytes: png, mimeType: 'image/png' }), { status: 502 });
  text = 'not JSON';
  await assert.rejects(provider.extract({ bytes: png, mimeType: 'image/png' }), { status: 502 });
});

test('authenticated read-only lookups handle exact ISBN, title, aliases, and duplicates', async t => {
  let extracted = extraction({ isbn_text: '0-8044-2957-X' });
  const api = await scanner(t, { enabled: true, visionProvider: { async extract(image) { assert.deepEqual(image.bytes, png); return extracted; } } },
    store => store.scan({ id: 'already-first-copy', isbn: '9780804429573' }));
  const { base, request } = api;
  const image = async () => {
    const response = await request('/api/cover-match', { method: 'POST', body: form() });
    assert.equal(response.status, 200);
    return response.json();
  };
  const typed = async query => {
    const response = await request('/api/cover-match/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await fetch(`${base}/api/cover-match`, { method: 'POST', body: form() })).status, 401);
  assert.equal((await request('/api/cover-match', { method: 'POST', body: form(), headers: { Origin: 'https://attacker.test' } })).status, 403);

  const exact = await image();
  assert.equal(exact.searchMethod, 'photo_text');
  assert.equal(exact.catalogVersion, api.catalogVersion);
  assert.equal(exact.printedIsbn, '9780804429573');
  assert.equal(exact.candidates[0].matchType, 'exact_isbn');
  assert.deepEqual(exact.autoPack, { isbn: '9780804429573', order: 'B' });
  assert.equal(exact.autoConfirm, false);
  extracted = extraction({ isbn_text: '9780804429573', author: 'Different Author' });
  assert((await image()).reviewReasons.includes('author_difference'));
  const typedExact = await typed('9780804429573');
  assert.equal(typedExact.searchMethod, 'typed');
  assert.equal(typedExact.candidates[0].order, 'B');
  assert.equal(typedExact.autoPack, null);
  extracted = extraction({ title_as_printed: 'The Inside Page Book' });
  assert.deepEqual((await image()).autoPack, { isbn: '9780804429573', order: 'B' });

  extracted = extraction({ native_title: 'പാടുക പാട്ടേ', title_as_printed: 'பாடுக பாட்டே', isbn_text: '9780700702009' });
  const title = await image();
  assert.equal(title.candidates[0].isbn, '9788184469660');
  assert.equal(title.candidates[0].matchType, 'title');
  assert.equal((await typed('വൈവാഹികം')).candidates[0].isbn, '9789359621845');
  extracted = extraction({ isbn_text: conflictingEdition, title_as_printed: 'The Inside Page Book' });
  const conflict = await image();
  assert.equal(conflict.status, 'REVIEW');
  assert.deepEqual(conflict.reviewReasons, ['edition_conflict']);
  assert.equal(conflict.autoPack, null);

  extracted = extraction({ isbn_text: knownEdition });
  const mapped = await image();
  assert.equal(mapped.candidates[0].matchType, 'edition_mapping');
  assert.equal(mapped.candidates[0].remaining, 1);
  assert.equal(mapped.autoPack, null);
  const barcode = await request('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'test-known-edition-scan', isbn: knownEdition }) });
  assert.equal((await barcode.json()).statusType, 'PACK');
  extracted = extraction({ isbn_text: knownEdition, title_as_printed: 'The Inside Page Book' });
  const duplicate = await image();
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.deepEqual(duplicate.candidates, []);
  assert.equal((await typed('9780700702008')).candidates[0].remaining, 1);
  const finishExact = await request('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'test-finish-exact-isbn', isbn: '9780804429573' }) });
  assert.equal((await finishExact.json()).order, 'B');
  extracted = extraction({ isbn_text: '9780804429573', title_as_printed: 'വൈവാഹികം' });
  assert.equal((await image()).status, 'DUPLICATE');
  extracted = extraction();
  assert.equal((await image()).status, 'NO_MATCH');
  assert.equal((await (await request('/api/state')).json()).count, api.count + 2);
});

test('rejects bad uploads and releases capacity after Gemini timeout', async t => {
  let calls = 0;
  const entered = Promise.withResolvers();
  const provider = { async extract(_image, { signal }) {
    calls++;
    if (calls <= 2) {
      if (calls === 2) entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    throw new Error('private upstream diagnostic');
  } };
  const { request, count } = await scanner(t, { enabled: true, visionProvider: provider, timeoutMs: 500 });
  const post = body => request('/api/cover-match', { method: 'POST', body });
  assert.equal((await post('not a form')).status, 415);
  assert.equal((await post(form(Buffer.from('not an image')))).status, 415);
  const two = form(); two.append('image', new Blob([png], { type: 'image/png' }), 'duplicate');
  assert.equal((await post(two)).status, 400);
  assert.equal((await post(form(Buffer.alloc(MAX_IMAGE_BYTES + 1)))).status, 413);
  assert.equal(calls, 0);
  const first = post(form()), second = post(form());
  await entered.promise;
  assert.equal((await post(form())).status, 429);
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [504, 504]);
  const failed = await post(form());
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private upstream diagnostic/);
  assert.equal((await (await request('/api/state')).json()).count, count);
});

const postJson = (request, route, data) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const coverRequest = (lookup, id, candidate = lookup.candidates[0]) => ({
  id, station: 'Station-Cover', catalogVersion: lookup.catalogVersion,
  isbn: candidate.isbn, order: candidate.order, confirmationToken: candidate.confirmationToken,
});

test('a strong cover result confirms one copy at a time and never replaces a packed match with a weaker book', async t => {
  const isbn = '9780804429573';
  const coverUrl = 'https://m.media-amazon.com/images/I/example.jpg';
  const { request } = await scanner(t, {
    enabled: true, vectorEnabled: true, autoPackMode: 'all',
    vectorSearch: async image => {
      assert.deepEqual(image.bytes, png);
      return {
        hits: [{ isbn, score: 0.94, coverUrl }, { isbn: '9789359621845', score: 0.8 }],
        reviewHits: [
          { isbn: '9789359621845', score: 0.99, amazonIsbn: knownEdition, coverUrl, listingTitle: 'Amazon listing' },
          { isbn: '9788184469660', score: 0.98, amazonIsbn: knownEdition, coverUrl, listingTitle: 'Amazon listing' },
        ],
      };
    },
    visionProvider: { async extract() { assert.fail('A strong cover match should skip text extraction'); } },
  });
  const lookup = async () => (await request('/api/cover-match', { method: 'POST', body: form() })).json();
  const confirm = data => postJson(request, '/api/mark-packed', data);
  const [first, second] = await Promise.all([lookup(), lookup()]);
  assert.equal(first.status, 'MATCH');
  assert.equal(first.searchMethod, 'cover_vector');
  assert.equal(first.autoConfirm, false);
  assert.equal(first.autoPack, null);
  assert.deepEqual(first.candidates.map(candidate => [candidate.isbn, candidate.order]), [[isbn, 'A']]);
  assert.equal(first.candidates[0].coverUrl, coverUrl);
  const [suggested, otherSuggestion] = first.reviewSuggestions;
  assert.equal(suggested.isbn, '9789359621845');
  assert.equal(suggested.amazonIsbn, knownEdition);
  assert.equal(suggested.order, 'C');
  assert.equal(suggested.matchType, 'cover_suggestion');
  assert(suggested.confirmationToken);
  assert.notEqual(otherSuggestion.isbn, suggested.isbn);
  assert.equal((await (await request('/api/state')).json()).count, 0);

  const one = coverRequest(first, 'vector-station-one'), two = coverRequest(second, 'vector-station-two');
  const responses = await Promise.all([confirm(one), confirm(two)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const [packed, stale] = await Promise.all([responses.find(r => r.ok).json(), responses.find(r => !r.ok).json()]);
  assert.equal(packed.order, 'A');
  assert.equal(packed.printedIsbn, undefined);
  assert.equal(stale.code, 'STALE_CANDIDATE');
  assert.equal(stale.lookup.candidates[0].matchType, 'cover_vector');
  assert.equal(stale.lookup.candidates[0].order, 'B');
  assert.deepEqual(await (await confirm(packed.id === one.id ? one : two)).json(), packed);
  const next = await lookup();
  assert.equal(next.candidates[0].order, 'B');
  assert.equal((await confirm(coverRequest(next, 'vector-next-copy'))).status, 200);
  const duplicate = await lookup();
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(duplicate.matchedIsbn, isbn);
  assert.equal(duplicate.matchedTitle, 'The Inside Page Book');
  assert.deepEqual(duplicate.candidates, []);
  assert.equal((await (await request('/api/state')).json()).count, 2);
  const manualRequest = coverRequest(first, 'manual-cover-review', suggested);
  assert.equal((await confirm({ ...manualRequest, isbn: otherSuggestion.isbn })).status, 409);
  const manual = await (await confirm(manualRequest)).json();
  assert.equal(manual.isbn, suggested.isbn);
  assert.equal(manual.order, 'C');
  assert.equal(manual.statusType, 'PACK');
  assert.equal(manual.scannedIsbn, undefined);
  assert.deepEqual(await (await confirm(manualRequest)).json(), manual);
  const reviewAfter = (await lookup()).reviewSuggestions;
  assert.equal(reviewAfter[0].alreadyPacked, true);
  assert.equal(reviewAfter[0].confirmationToken, undefined);
  assert(reviewAfter[1].confirmationToken);
  assert.equal((await (await request('/api/state')).json()).count, 3);
});

test('the pilot scopes vector lookup to one station and its title comparison cannot pack a copy', async t => {
  const isbn = '9780804429573';
  let vectorCalls = 0, visionCalls = 0;
  const { request } = await scanner(t, {
    enabled: true, vectorEnabled: true, vectorPilotStation: 'Station-pilot', autoPackMode: 'all',
    vectorSearch: async () => { vectorCalls++; return [{ isbn, score: 0.95 }]; },
    visionProvider: { async extract() { visionCalls++; return extraction({ isbn_text: isbn }); } },
  });
  const photo = params => request(`/api/cover-match?${params}`, { method: 'POST', body: form() });
  const health = await (await request('/api/health')).json();
  assert.deepEqual(health.coverVector, { enabled: true, pilotStation: 'Station-pilot' });
  const pilot = await (await photo('station=Station-pilot&mode=vector')).json();
  assert.equal(pilot.searchMethod, 'cover_vector');
  assert.equal(pilot.pilotComparisonAvailable, true);
  assert.deepEqual(pilot.vectorTopIsbns, [isbn]);
  assert.equal(pilot.autoConfirm, false);
  const baseline = await (await photo('station=Station-pilot&mode=title')).json();
  assert.equal(baseline.searchMethod, 'photo_text');
  assert.deepEqual(baseline.candidates, ['A', 'B'].map(order => ({ isbn, title: 'The Inside Page Book', order })));
  assert.equal(baseline.autoPack, undefined);
  assert.equal(baseline.autoConfirm, undefined);
  assert.equal((await photo('station=Station-other&mode=vector')).status, 403);
  const other = await (await photo('station=Station-other&mode=ocr')).json();
  assert.equal(other.searchMethod, 'photo_text');
  assert.equal(other.fallbackReason, undefined);
  assert.equal(other.candidates[0].matchType, 'exact_isbn');
  assert.equal(other.pilotComparisonAvailable, undefined);
  const legacy = await (await photo('')).json();
  assert.equal(legacy.candidates[0].matchType, 'exact_isbn');
  assert.equal((await photo('station=Station-other&mode=title')).status, 403);
  assert.equal(vectorCalls, 1);
  assert.equal(visionCalls, 3);
  assert.equal((await (await request('/api/state')).json()).count, 0);
});

test('a replacement cover requires a recognized ISBN and confirmation respects the mapped quota', async t => {
  const isbn = '9780700702008';
  let vectorCalls = 0, printed = '';
  const { request } = await scanner(t, {
    enabled: true, vectorEnabled: true, autoPackMode: 'all',
    vectorSearch: async () => { vectorCalls++; return [{ isbn, amazonIsbn: knownEdition, score: 0.95 }]; },
    visionProvider: { async extract() { return extraction({ title_as_printed: 'Archaeology', isbn_text: printed }); } },
  });
  const photo = async (route = '/api/cover-match') => (await request(route, { method: 'POST', body: form() })).json();
  const cover = await photo();
  assert.equal(cover.status, 'REVIEW');
  assert.deepEqual(cover.reviewReasons, ['verify_cover_edition']);
  assert.equal(cover.candidates[0].order, 'D');
  assert.equal(cover.candidates[0].amazonIsbn, knownEdition);
  assert.equal(cover.candidates[0].confirmationToken, undefined);
  assert.equal(cover.printedIsbn, undefined);
  assert.equal((await photo('/api/cover-match?mode=isbn')).status, 'NO_MATCH');
  printed = knownEdition;
  const verified = await photo('/api/cover-match?mode=isbn');
  assert.equal(verified.searchMethod, 'isbn_page');
  assert.equal(vectorCalls, 1);
  assert.equal(verified.printedIsbn, knownEdition);
  assert.equal(verified.autoConfirm, false);
  const packed = await (await postJson(request, '/api/mark-packed', coverRequest(verified, 'vector-edition-confirmed'))).json();
  assert.equal(packed.printedIsbn, knownEdition);
  assert.equal(packed.order, 'D');
  assert.equal((await photo('/api/cover-match?mode=isbn')).status, 'DUPLICATE');
  const after = await photo();
  assert.equal(after.candidates[0].alreadyPacked, true);
  assert.equal(after.candidates[0].confirmationToken, undefined);
  const exact = await (await postJson(request, '/api/cover-match/search', { query: isbn })).json();
  assert.equal(exact.candidates[0].remaining, 1);
});

test('close and shared cover choices keep a packed identity at the top for review', async t => {
  const isbn = '9780804429573';
  let shared = true;
  const { request } = await scanner(t, {
    enabled: true, vectorEnabled: true,
    vectorSearch: async () => [
      { isbn, score: 0.95, sharedCover: shared, imageHash: 'same-cover' },
      { isbn: '9789359621845', score: shared ? 0.8 : 0.94, imageHash: 'same-cover' },
    ],
  }, store => {
    store.scan({ id: 'shared-cover-first', isbn });
    store.scan({ id: 'shared-cover-second', isbn });
  });
  for (const reason of ['shared_cover', 'close_cover_matches']) {
    const review = await (await request('/api/cover-match', { method: 'POST', body: form() })).json();
    assert.equal(review.status, 'REVIEW');
    assert.deepEqual(review.reviewReasons, [reason]);
    assert.equal(review.candidates[0].isbn, isbn);
    assert.equal(review.candidates[0].alreadyPacked, true);
    assert.equal(review.candidates[0].confirmationToken, undefined);
    assert.equal(review.candidates[1].order, 'C');
    assert(review.candidates[1].confirmationToken);
    shared = false;
  }
});

test('vector outcomes never run OCR and an explicit title request can reuse the photo', async t => {
  let behavior = 'weak_cover';
  let visionCalls = 0, vectorCalls = 0, timedOut = false;
  let readTitleOnly = false;
  const isbn = '9780804429573';
  const coverUrl = 'https://m.media-amazon.com/images/I/example.jpg';
  const { request } = await scanner(t, {
    enabled: true, vectorEnabled: true, vectorTimeoutMs: 30, autoPackMode: 'all',
    async vectorSearch(_image, { signal }) {
      vectorCalls++;
      if (behavior === 'weak_cover') return [{ isbn, score: 0.4, coverUrl }, { isbn: '9789999999999', score: 0.3 }];
      if (behavior === 'empty_cover_results') return [];
      if (behavior === 'stale_cover_index') return [{ isbn: '9780804429573', amazonIsbn: knownEdition, score: 0.99 }];
      if (behavior === 'vector_unavailable') throw new Error('private diagnostic');
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        timedOut = true;
        reject(signal.reason);
      }, { once: true }));
    },
    visionProvider: { async extract() {
      visionCalls++;
      return readTitleOnly ? extraction({ title_as_printed: 'The Inside Page Book' }) : extraction({ isbn_text: isbn });
    } },
  });
  for (const reason of ['weak_cover', 'empty_cover_results', 'stale_cover_index', 'vector_unavailable', 'vector_timeout']) {
    behavior = reason;
    const response = await request('/api/cover-match?mode=vector', { method: 'POST', body: form() });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.searchMethod, 'cover_vector');
    assert.equal(result.vectorReason, reason);
    assert.equal(result.status, 'NO_MATCH');
    assert.deepEqual(result.candidates, []);
    if (reason === 'weak_cover') {
      assert.equal(result.vectorSuggestions.length, 1);
      assert.equal(result.vectorSuggestions[0].isbn, isbn);
      assert.equal(result.vectorSuggestions[0].order, 'A');
      assert(result.vectorSuggestions[0].confirmationToken);
    } else assert.equal(result.vectorSuggestions, undefined);
  }
  assert.equal(visionCalls, 0);
  assert.equal(vectorCalls, 5);
  assert(timedOut);
  behavior = 'weak_cover';
  const legacy = await (await request('/api/cover-match?mode=cover', { method: 'POST', body: form() })).json();
  assert.equal(legacy.vectorReason, 'weak_cover');
  assert.equal(visionCalls, 0);
  readTitleOnly = true;
  const title = () => request('/api/cover-match?mode=ocr&verify=isbn', { method: 'POST', body: form() });
  const review = await (await title()).json();
  assert.equal(review.status, 'REVIEW');
  assert.equal(review.searchMethod, 'photo_text');
  assert(review.reviewReasons.includes('verify_fallback_isbn'));
  assert(review.candidates.length > 0);
  assert(review.candidates.every(candidate => candidate.matchType === 'title' && !candidate.confirmationToken));
  assert.equal(review.vectorSuggestions, undefined);
  readTitleOnly = false;
  const exact = await (await title()).json();
  assert.equal(exact.candidates[0].matchType, 'exact_isbn');
  assert(exact.candidates[0].confirmationToken);
  assert.equal(exact.autoConfirm, false);
  assert.equal(visionCalls, 2);
  assert.equal(vectorCalls, 6);
});

test('vector lookup stops on browser cancellation and stays off when disabled', async t => {
  const entered = Promise.withResolvers(), canceled = Promise.withResolvers();
  const { request } = await scanner(t, { enabled: true, vectorEnabled: true,
    async vectorSearch(_image, { signal }) {
      entered.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        canceled.resolve();
        reject(signal.reason);
      }, { once: true }));
    },
    visionProvider: { async extract() { assert.fail('A canceled photo must not start text extraction'); } },
  });
  const controller = new AbortController();
  const pending = request('/api/cover-match', { method: 'POST', body: form(), signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await canceled.promise;
  const disabled = await scanner(t, { enabled: true, vectorEnabled: false,
    async vectorSearch() { assert.fail('Disabled vector lookup must not run'); },
    visionProvider: { async extract() { return extraction({ isbn_text: '9780804429573' }); } },
  });
  const legacy = await (await disabled.request('/api/cover-match', { method: 'POST', body: form() })).json();
  assert.equal(legacy.candidates[0].matchType, 'exact_isbn');
  assert.equal(legacy.searchMethod, 'photo_text');
});

test('auto-pack modes permit only eligible camera results and keep review cases manual', async t => {
  for (const mode of ['isbn', 'all']) {
    await t.test(mode, async t => {
      let fields;
      const { request } = await scanner(t, { enabled: true, autoPackMode: mode, visionProvider: {
        async extract(_image, { onUsage }) { onUsage({ totalTokenCount: 300 }); return extraction(fields); },
      } }, store => store.scan({ id: 'seed-auto-pack', isbn: '9780804429573' }));
      const image = async input => {
        fields = input;
        const response = await request('/api/cover-match', { method: 'POST', body: form() });
        assert.equal(response.status, 200);
        return response.json();
      };
      const exact = await image({ isbn_text: '9780804429573' });
      assert.equal(exact.autoConfirm, true);
      assert.equal(exact.visionUsage.totalTokenCount, 300);
      assert.equal((await image({ isbn_text: '9780804429573', author: 'Wrong Author' })).autoConfirm, false);
      assert.equal((await image({ isbn_text: knownEdition })).autoConfirm, false);
      assert.equal((await image({ isbn_text: conflictingEdition })).autoConfirm, false);
      const title = await image({ title_as_printed: 'The Inside Page Book' });
      assert.equal(title.autoConfirm, mode === 'all');
      assert.equal((await image({ english_title: 'The Inside Page Book' })).autoConfirm, false);
      assert.equal((await image({ title_as_printed: 'The Inside Page' })).autoConfirm, false);
      const short = await image({ title_as_printed: 'Archaeology' });
      assert.equal(short.autoConfirm, false);
      assert(short.reviewReasons.includes('short_title'));
      const mismatch = await image({ title_as_printed: 'The Inside Page Book', isbn_text: '9780140328721' });
      assert.equal(mismatch.autoConfirm, false);
      assert(mismatch.reviewReasons.includes('unmatched_printed_isbn'));
      const typed = await (await postJson(request, '/api/cover-match/search', { query: '9780804429573' })).json();
      assert.equal(typed.autoPack, null);
      assert.equal((await (await request('/api/state')).json()).count, 1);
    });
  }
});

test('cover confirmation guards the selected copy, survives a lost reply, and shares barcode state', async t => {
  const { request, base } = await scanner(t, { enabled: true });
  const isbn = '9780804429573';
  const lookup = async () => (await postJson(request, '/api/cover-match/search', { query: isbn })).json();
  const first = await lookup(), second = await lookup();
  assert.deepEqual(first.candidates.map(candidate => [candidate.order, Boolean(candidate.confirmationToken)]), [['A', true], ['B', false]]);
  const confirm = data => postJson(request, '/api/mark-packed', data);
  const one = coverRequest(first, 'station-one-cover'), two = coverRequest(second, 'station-two-cover');
  assert.equal((await fetch(`${base}/api/mark-packed`, { method: 'POST' })).status, 401);
  assert.equal((await confirm({ ...one, order: 'B' })).status, 409);
  assert.equal((await confirm({ ...one, catalogVersion: '0'.repeat(64) })).status, 409);
  const responses = await Promise.all([confirm(one), confirm(two)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const [packed, stale] = await Promise.all([responses.find(r => r.ok).json(), responses.find(r => !r.ok).json()]);
  assert.equal(packed.order, 'A');
  assert.equal(packed.source, 'cover');
  assert.equal(stale.code, 'STALE_CANDIDATE');
  assert.equal(stale.lookup.candidates[0].order, 'B');
  assert.equal(stale.lookup.autoPack, null);
  const savedRequest = packed.id === one.id ? one : two;
  assert.deepEqual(await (await confirm(savedRequest)).json(), packed);
  assert.deepEqual((await (await request(`/api/scan?id=${packed.id}`)).json()).scan, packed);
  assert.equal((await confirm({ ...savedRequest, id: 'reuse-cover-selection' })).status, 409);

  const refreshed = await confirm(coverRequest(stale.lookup, 'new-confirmation-after-refresh'));
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).order, 'B');
  assert.equal((await lookup()).status, 'DUPLICATE');
  const state = await (await request('/api/state')).json();
  assert.equal(state.count, 2);
  assert.equal(state.pending, 2);
});

test('cover packs keep the printed ISBN and obey Amazon quota through Sheets retries and voids', async t => {
  let extracted = extraction({ isbn_text: knownEdition });
  const { request, databasePath } = await scanner(t, { enabled: true, visionProvider: { async extract() { return extracted; } } });
  const lookup = async () => (await request('/api/cover-match', { method: 'POST', body: form() })).json();
  const mapped = await lookup();
  const confirm = data => postJson(request, '/api/mark-packed', data);
  const data = coverRequest(mapped, 'cover-edition-pack');
  const pack = await (await confirm(data)).json();
  assert.equal(pack.isbn, '9780700702008');
  assert.equal(pack.printedIsbn, knownEdition);
  assert.equal(pack.scannedIsbn, knownEdition);
  assert.equal((await lookup()).status, 'DUPLICATE');

  extracted = extraction({ isbn_text: conflictingEdition });
  const conflict = await lookup();
  assert(conflict.candidates.length > 0);
  assert(conflict.candidates.every(candidate => !candidate.confirmationToken));
  extracted = extraction({ isbn_text: '9781878818980', native_title: 'വൈവാഹികം' });
  const title = await lookup();
  const titlePack = await (await confirm(coverRequest(title, 'cover-title-pack'))).json();
  assert.equal(titlePack.isbn, '9789359621845');
  assert.equal(titlePack.printedIsbn, '9781878818980');
  assert.equal(titlePack.scannedIsbn, undefined);

  const store = new PackingStore(databasePath, catalog, editions);
  t.after(() => store.close());
  const writes = [];
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'Scanner Log', gridProperties: { rowCount: 1000 } } }] } }),
    values: { batchUpdate: async ({ requestBody }) => { writes.push(requestBody); if (writes.length === 1) throw Error('Sheets unavailable'); } },
  } };
  store.setMeta('mirrorTarget', JSON.stringify(['fake-sheet', 'Scanner Log']));
  const mirror = new SheetMirror(store, { client, spreadsheetId: 'fake-sheet', enabled: true });
  await mirror.flush();
  assert.equal(store.stats().pending, 2);
  assert.match(mirror.lastError, /Sheets unavailable/);
  mirror.nextAttempt = 0;
  await mirror.flush();
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1].data[1].values[0][0], '9780700702008');
  assert.equal(store.stats().pending, 0);
  const edited = await (await postJson(request, '/api/scan/edit', {
    id: titlePack.id, isbn: '9788184469660', expectedRevision: 0, editId: 'cover-title-correction',
  })).json();
  assert.equal(edited.isbn, '9788184469660');
  assert.equal(edited.source, 'cover');
  assert.equal(edited.printedIsbn, '9781878818980');
  const voided = await (await postJson(request, '/api/scan/void', { id: pack.id })).json();
  assert.equal(voided.statusType, 'VOID');
  assert.equal(voided.printedIsbn, knownEdition);
  assert.equal((await confirm({ ...data, id: 'cannot-reuse-voided-token' })).status, 409);
  extracted = extraction({ isbn_text: knownEdition });
  const repack = await confirm(coverRequest(await lookup(), 'repack-with-fresh-choice'));
  assert.equal((await repack.json()).statusType, 'PACK');
});

test('saved cover confirmation survives token expiry and a new server key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-saved-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'packing.sqlite');
  let now = 0;
  const confirmation = createCoverConfirmation({ now: () => now });
  const isbn = catalog[0].ISBN13;
  const store = new PackingStore(filename, catalog);
  store.initializeEmpty();
  const issue = () => confirmation.issue({ candidates: [{ isbn, order: 'A', allocation: '0', nextEligible: true, matchType: 'title', score: 100 }] }, store.catalogHash, null);
  const savedRequest = coverRequest(issue(), 'persisted-confirmation');
  const staleRequest = coverRequest(issue(), 'unsaved-expired-confirmation');
  const saved = store.confirmCover(savedRequest, confirmation.verify).scan;
  now = 16 * 60 * 1000;
  assert.throws(() => confirmation.verify(staleRequest), /stale/);
  store.close();
  const reopened = new PackingStore(filename, catalog);
  try {
    const freshKey = createCoverConfirmation();
    assert.deepEqual(reopened.confirmCover(savedRequest, freshKey.verify), { scan: saved, created: false });
    assert.throws(() => reopened.confirmCover(staleRequest, freshKey.verify), /no longer valid/);
    assert.equal(reopened.stats().count, 1);
  } finally { reopened.close(); }
});

test('browser recovery finds a saved cover pack after all confirmation replies are lost', async t => {
  const { request } = await scanner(t, { enabled: true });
  const query = '9780700702008';
  const lookup = await (await postJson(request, '/api/cover-match/search', { query })).json();
  const competingLookup = await (await postJson(request, '/api/cover-match/search', { query })).json();
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.EventSource = class {};
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { PackingManager } = await import('../src/utils/sync.js');
  const persisted = new Map();
  const options = { autoRecovery: false, EventSource: class {}, storage: {
    getItem: key => persisted.get(key) ?? null, setItem: (key, value) => persisted.set(key, value), removeItem: key => persisted.delete(key),
  } };
  const replies = [];
  const first = new PackingManager({ ...options, fetch: async (route, init) => {
    assert.equal(route, '/api/mark-packed');
    const response = await request(route, init);
    assert.equal(response.status, 200);
    replies.push(await response.json());
    throw new Error('Confirmation response lost');
  } });
  t.after(() => first.dispose());
  await assert.rejects(first.confirmCover(lookup.candidates[0], lookup.catalogVersion), /Result unconfirmed/);
  const pending = JSON.parse(persisted.get('fast_search_pending_request'));
  assert.equal(replies.length, 3);
  assert(replies.every(reply => reply.id === pending.id && reply.seq === replies[0].seq));
  first.dispose();
  const reloaded = new PackingManager({ ...options, fetch: request });
  t.after(() => reloaded.dispose());
  assert.deepEqual(await reloaded.recoverPending(), replies[0]);
  assert.equal(persisted.has('fast_search_pending_request'), false);

  const stale = new PackingManager({ ...options, fetch: request });
  t.after(() => stale.dispose());
  let refreshed;
  await assert.rejects(stale.confirmCover(competingLookup.candidates[0], competingLookup.catalogVersion), error => {
    assert.equal(error.code, 'STALE_CANDIDATE');
    assert.equal(error.lookup.candidates[0].order, 'D');
    refreshed = error.lookup;
    return true;
  });
  assert.equal(persisted.has('fast_search_pending_request'), false);
  // The next copy is in the same box, and a barcode station takes it before confirmation.
  const barcode = await (await postJson(request, '/api/scan', { id: 'same-box-barcode-copy', isbn: query })).json();
  assert.equal(barcode.order, 'D');
  await assert.rejects(stale.confirmCover(refreshed.candidates[0], refreshed.catalogVersion), error => {
    assert.equal(error.code, 'STALE_CANDIDATE');
    assert.equal(error.lookup.status, 'DUPLICATE');
    return true;
  });
  assert.equal(persisted.has('fast_search_pending_request'), false);
  assert.equal((await (await request('/api/state')).json()).count, 2);
});
