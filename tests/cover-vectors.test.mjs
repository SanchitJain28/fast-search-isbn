import assert from 'node:assert/strict';
import test from 'node:test';
import { coverEmbeddingText, createCoverEmbedder } from '../server/cover-match/embedding.js';
import { createQdrantCoverClient } from '../server/cover-match/qdrant.js';
import { coverVectorDecision } from '../server/cover-match/vector-decision.js';

const vector = Array(1536).fill(0.5);

test('Gemini receives one cover and its text together and must return a valid vector', async () => {
  let request;
  const client = { models: { async embedContent(input) {
    request = input;
    return { embeddings: [{ values: vector }] };
  } } };
  const embed = createCoverEmbedder({ client });
  const bytes = Buffer.from('test image');
  const image = { bytes, mimeType: 'image/jpeg' };
  const text = coverEmbeddingText({ title: 'മലയാളം' });
  assert.equal(text, 'Title: മലയാളം');
  assert.deepEqual(await embed({ ...image, text }), { vector, inputTokens: null });
  assert.equal(request.model, 'gemini-embedding-2');
  assert.equal(request.config.outputDimensionality, 1536);
  assert.deepEqual(request.contents, [{ parts: [
    { text },
    { inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } },
  ] }]);
  await embed(image);
  assert.equal(request.contents[0].parts.length, 1);
  client.models.embedContent = async () => ({ embeddings: [{ values: [1, 2] }] });
  await assert.rejects(embed(image), /1,536-number/);
});

test('Qdrant ranks distinct ISBNs and shared or close covers go to review', async () => {
  const calls = [];
  const coverUrl = 'https://m.media-amazon.com/images/I/example.jpg';
  const point = (po_isbn, score, shared_cover = false, cover_url) => ({ score, payload: { po_isbn, shared_cover, cover_url } });
  const responses = [
    new Response(null, { status: 404 }),
    Response.json({ status: 'ok', result: true }),
    Response.json({ status: 'ok', result: { status: 'completed' } }),
    Response.json({ status: 'ok', result: { points: [
      point('isbn-a', 0.7), point('isbn-b', 0.85, false, 'https://example.org/images/I/cover.jpg'), point('isbn-a', 0.9, true, coverUrl),
    ] } }),
  ];
  const qdrant = createQdrantCoverClient({ url: 'http://localhost:6335', fetcher: async (url, options) => {
    calls.push({ url, ...options });
    return responses.shift();
  } });
  await qdrant.ensureCollection('books');
  await qdrant.upsert('books', [{ id: 1, vector, payload: { po_isbn: 'isbn-a' } }]);
  const hits = await qdrant.search('books', vector);
  assert.deepEqual(JSON.parse(calls[1].body), { vectors: { size: 1536, distance: 'Cosine' } });
  assert.equal(calls[2].url.search, '?wait=true');
  assert.equal(JSON.parse(calls[3].body).limit, 10);
  assert(JSON.parse(calls[3].body).with_payload.includes('cover_url'));
  assert.deepEqual(hits, [
    { isbn: 'isbn-a', score: 0.9, sharedCover: true, coverUrl }, { isbn: 'isbn-b', score: 0.85, sharedCover: false },
  ]);
  const rules = { minimumScore: 0.8, minimumGap: 0.02 };
  assert.equal(coverVectorDecision(hits, rules), 'review');
  const unshared = [{ ...hits[0], sharedCover: false }, hits[1]];
  assert.equal(coverVectorDecision(unshared, rules), 'suggest');
  assert.equal(coverVectorDecision(unshared, { ...rules, minimumGap: 0.06 }), 'review');
  assert.equal(coverVectorDecision(unshared, { ...rules, minimumScore: 0.91 }), 'fallback');
  assert.equal(coverVectorDecision([], rules), 'fallback');
});
