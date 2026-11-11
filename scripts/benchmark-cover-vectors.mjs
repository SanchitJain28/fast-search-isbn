import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parsePrintedIsbn } from '../server/isbn.js';
import { normalizeIsbn, PackingStore } from '../server/store.js';
import {
  COVER_EMBEDDING_MODEL, COVER_EMBEDDING_SIZE, coverEmbeddingText, createCoverEmbedder, isCoverEmbedding,
} from '../server/cover-match/embedding.js';
import { lookupCover } from '../server/cover-match/lookup.js';
import { CatalogTitleMatcher } from '../server/cover-match/matcher.js';
import { createQdrantCoverClient } from '../server/cover-match/qdrant.js';
import { coverVectorDecision } from '../server/cover-match/vector-decision.js';
import { createGeminiVisionProvider, DEFAULT_VISION_MODEL } from '../server/cover-match/vision.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputVersion = 'phase2-v1';
const variants = ['cover_only', 'cover_with_text'];
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const readJsonl = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

async function mapLimited(items, concurrency, work) {
  const results = [];
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function cachedProvider(directory, name, execute, valid) {
  const stats = { requests: 0, cached: 0, inputTokens: 0, responsesWithTokenCount: 0 };
  const pending = new Map();
  async function load(key, image) {
    const file = path.join(directory, `${key}.json`);
    try {
      const saved = await readJson(file);
      if (!valid(saved) || !Number.isFinite(saved.ms)) throw new Error(`Invalid saved result for ${name}.`);
      stats.cached++;
      return saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const start = performance.now();
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      stats.requests++;
      try {
        response = await execute(image, { signal: AbortSignal.timeout(25000) });
        break;
      } catch (error) {
        if (attempt === 2 || ![429, 503].includes(Number(error.status))) throw error;
        await delay(1000 * 2 ** attempt + Math.random() * 500);
      }
    }
    const saved = { ...response, ms: Math.round(performance.now() - start) };
    if (Number.isFinite(saved.inputTokens)) {
      stats.inputTokens += saved.inputTokens;
      stats.responsesWithTokenCount++;
    }
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
    await rename(temp, file);
    return saved;
  }
  return {
    stats,
    get(image) {
      const key = sha(JSON.stringify([inputVersion, name, image.mimeType, sha(image.bytes), image.text ?? '']));
      const existing = pending.get(key);
      if (existing) return existing;
      const job = load(key, image).finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    },
  };
}

async function readJpeg(directory, relativePath) {
  const file = path.resolve(directory, relativePath);
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error('Image path is outside the prepared cover directory.');
  return { bytes: await readFile(file), mimeType: 'image/jpeg' };
}

function measure(rows, resultFor, rules) {
  const counts = {
    cases: rows.length, successful: 0, known: 0, outside: 0, top1: 0, top3: 0,
    wrongTop1: 0, correctSuggestions: 0, unsafeSuggestions: 0, outsideRejected: 0, reviews: 0, fallbacks: 0,
  };
  const times = [];
  for (const row of rows) {
    const result = resultFor(row);
    if (result.error) continue;
    counts.successful++;
    const { hits, ms } = result;
    const expected = row.expected_po_isbns;
    const action = rules ? coverVectorDecision(hits, rules) : result.action;
    const firstCorrect = expected.includes(hits[0]?.isbn);
    if (expected.length) {
      counts.known++;
      counts.top1 += Number(firstCorrect);
      counts.top3 += Number(hits.slice(0, 3).some(hit => expected.includes(hit.isbn)));
      counts.wrongTop1 += Number(Boolean(hits.length) && !firstCorrect);
    } else {
      counts.outside++;
      counts.outsideRejected += Number(action === 'fallback');
    }
    if (action === 'suggest') {
      if (firstCorrect && expected.length === 1) counts.correctSuggestions++;
      else counts.unsafeSuggestions++;
    }
    counts.reviews += Number(action === 'review');
    counts.fallbacks += Number(action === 'fallback');
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  const percentile = fraction => times.length ? times[Math.ceil(times.length * fraction) - 1] : null;
  return { ...counts, latencyMs: { p50: percentile(0.5), p95: percentile(0.95) } };
}

function tune(rows, variant) {
  const scores = new Set([-1]);
  const gaps = new Set([0]);
  const above = value => (Math.floor(value * 1e6) + 1) / 1e6;
  for (const row of rows) {
    const [first, second] = row[variant].hits;
    if (first) scores.add(above(first.score));
    if (second) gaps.add(above(first.score - second.score));
  }
  let best;
  for (const minimumScore of scores) {
    for (const minimumGap of gaps) {
      const rules = { minimumScore, minimumGap };
      const result = measure(rows, row => row[variant], rules);
      const safety = best ? compareSafety(result, best.result) : -1;
      const strongerRules = best && (minimumGap - best.rules.minimumGap || minimumScore - best.rules.minimumScore);
      if (safety < 0 || (safety === 0 && strongerRules > 0)) best = { rules, result };
    }
  }
  return best;
}

function compareSafety(a, b) {
  return a.unsafeSuggestions - b.unsafeSuggestions || b.correctSuggestions - a.correctSuggestions
    || b.outsideRejected - a.outsideRejected || a.fallbacks - b.fallbacks;
}

function summarize(rows) {
  const tuning = rows.filter(row => row.split === 'tuning');
  const holdout = rows.filter(row => row.split === 'holdout');
  const comparisons = Object.fromEntries(variants.map(variant => {
    const { rules, result } = tune(tuning, variant);
    return [variant, { rules, tuning: result, holdout: measure(holdout, row => row[variant], rules) }];
  }));
  function compareVariants(a, b, split) {
    const left = comparisons[a][split], right = comparisons[b][split];
    return left.unsafeSuggestions - right.unsafeSuggestions || right.top3 - left.top3
      || compareSafety(left, right) || right.top1 - left.top1;
  }
  const tuningWinner = [...variants].sort((a, b) => compareVariants(a, b, 'tuning'))[0];
  const tuningLeaders = variants.filter(variant => compareVariants(variant, tuningWinner, 'tuning') === 0);
  const selectedVariant = [...tuningLeaders].sort((a, b) => compareVariants(a, b, 'holdout'))[0];
  return {
    selectedVariant, tuningLeaders,
    comparisons: {
      title_lookup: { tuning: measure(tuning, row => row.title_lookup), holdout: measure(holdout, row => row.title_lookup) },
      ...comparisons,
    },
  };
}

async function checkedInput({ path: file, sha256 }) {
  const bytes = await readFile(file);
  if (sha(bytes) !== sha256) throw new Error('The Master or edition list changed since Phase 1. Rebuild the starter set first.');
  return JSON.parse(bytes);
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string', default: path.join(root, 'data/cover-search/phase-1') },
    output: { type: 'string', default: path.join(root, 'data/cover-search/phase-2') },
    'qdrant-url': { type: 'string', default: 'http://127.0.0.1:6335' },
    concurrency: { type: 'string', default: '4' },
  } });
  const url = new URL(values['qdrant-url']);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Use a local Qdrant address for the Phase 2 benchmark.');
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Use a concurrency of 1–8.');
  const envFile = path.join(root, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('Set GEMINI_API_KEY in the environment or .env.local.');
  const visionModel = process.env.COVER_VISION_MODEL || DEFAULT_VISION_MODEL;
  const titleOptions = {
    minScore: Number(process.env.COVER_MATCH_MIN_SCORE || 75),
    gap: Number(process.env.COVER_MATCH_GAP_MIN || 8),
  };
  const titleAutoThreshold = Number(process.env.COVER_MATCH_AUTO_THRESHOLD || 90);
  const input = path.resolve(values.input);
  const output = path.resolve(values.output);
  const cache = path.join(output, 'cache');
  const [covers, queries, summary] = await Promise.all([
    readJsonl(path.join(input, 'covers.jsonl')), readJsonl(path.join(input, 'queries.jsonl')), readJson(path.join(input, 'summary.json')),
  ]);
  const isbnSet = new Set(covers.map(cover => cover.po_isbn));
  const pointIds = covers.map(cover => Number(parsePrintedIsbn(cover.po_isbn)));
  if (!covers.length || isbnSet.size !== covers.length || pointIds.includes(0) || new Set(pointIds).size !== covers.length
      || !queries.some(row => row.split === 'holdout') || !queries.some(row => row.split === 'tuning')
      || queries.some(row => row.expected_po_isbns.some(isbn => !isbnSet.has(isbn)))) {
    throw new Error('Use a checked Phase 1 set with one cover per ISBN and labeled tuning and holdout images.');
  }
  const [master, editions] = await Promise.all([checkedInput(summary.inputs.master), checkedInput(summary.inputs.editions)]);
  const catalog = master.filter(book => isbnSet.has(normalizeIsbn(book.ISBN13)));
  if (new Set(catalog.map(book => normalizeIsbn(book.ISBN13))).size !== isbnSet.size) {
    throw new Error('A prepared ISBN is missing from the Master.');
  }
  const mappings = editions.mappings.filter(mapping => isbnSet.has(mapping.poIsbn));
  const conflicts = editions.conflicts.filter(conflict => conflict.targets.some(([isbn]) => isbnSet.has(isbn)));
  const qdrant = createQdrantCoverClient({ url, apiKey: process.env.QDRANT_API_KEY });
  const dataset = sha(JSON.stringify([inputVersion, COVER_EMBEDDING_MODEL, covers])).slice(0, 16);
  const collections = Object.fromEntries(variants.map(variant => [variant, `isbn_phase2_${dataset}_${variant}`]));
  await Promise.all(variants.map(variant => qdrant.ensureCollection(collections[variant])));
  await mkdir(cache, { recursive: true });
  const embeddings = cachedProvider(cache, COVER_EMBEDDING_MODEL, createCoverEmbedder({ apiKey }),
    result => isCoverEmbedding(result.vector));
  const vision = createGeminiVisionProvider({ apiKey, model: visionModel });
  const extraction = cachedProvider(cache, visionModel, async (image, { signal }) => {
    let inputTokens;
    const fields = await vision.extract(image, { signal, onUsage: usage => { inputTokens = usage.promptTokenCount; } });
    return { fields, inputTokens: inputTokens ?? null };
  }, result => typeof result.fields?.title_as_printed === 'string');

  console.log(`Indexing ${covers.length} checked covers in two local collections.`);
  const pairs = await mapLimited(covers, concurrency, async (cover) => {
    const image = await readJpeg(input, cover.image_path);
    if (sha(image.bytes) !== cover.image_sha256) throw new Error(`Prepared cover changed for ISBN ${cover.po_isbn}.`);
    const base = { id: Number(parsePrintedIsbn(cover.po_isbn)), payload: {
      po_isbn: cover.po_isbn, amazon_isbn: cover.amazon_isbn ?? null, title: cover.title, author: cover.author ?? null,
      cover_url: cover.cover_url, image_sha256: cover.image_sha256, shared_cover: cover.shared_cover, input_version: inputVersion,
    } };
    const imageOnly = await embeddings.get(image);
    const withText = await embeddings.get({ ...image, text: coverEmbeddingText(cover) });
    return [{ ...base, vector: imageOnly.vector }, { ...base, vector: withText.vector }];
  });
  await Promise.all(variants.map((variant, index) => qdrant.upsert(collections[variant], pairs.map(pair => pair[index]))));

  const store = new PackingStore(':memory:', catalog, { mappings, conflicts });
  const matcher = new CatalogTitleMatcher(catalog);
  let completed = 0;
  let results;
  try {
    console.log(`Comparing ${queries.length} queries with the existing title lookup.`);
    results = await mapLimited(queries, concurrency, async query => {
      const image = await readJpeg(input, query.image_path);
      const embedded = await embeddings.get(image);
      const ranked = await Promise.all(variants.map(async variant => {
        const start = performance.now();
        const hits = await qdrant.search(collections[variant], embedded.vector);
        return [variant, { hits, ms: embedded.ms + Math.round(performance.now() - start) }];
      }));
      let read;
      try { read = await extraction.get(image); }
      catch (error) {
        if (![502, 503, 504].includes(error.status) && error.name !== 'TimeoutError') throw error;
      }
      let title_lookup = { error: 'Photo text extraction did not complete.' };
      if (read) {
        const start = performance.now();
        const lookup = await lookupCover({
          store, input: read.fields, autoThreshold: titleAutoThreshold,
          matchTitles: async fields => matcher.match(fields, titleOptions),
        });
        const hits = [...new Map(lookup.candidates.map(({ isbn, score }) => [isbn, { isbn, score }])).values()];
        title_lookup = { hits, status: lookup.status, ms: read.ms + Math.round(performance.now() - start),
          action: lookup.status === 'MATCH' ? 'suggest' : lookup.status === 'REVIEW' ? 'review' : 'fallback' };
      }
      completed++;
      if (completed % 12 === 0 || completed === queries.length) console.log(`Compared ${completed}/${queries.length} test images.`);
      return { ...query, ...Object.fromEntries(ranked), title_lookup };
    });
  } finally {
    store.close();
  }
  const report = {
    dataset, coverCount: covers.length, queryCount: queries.length,
    embedding: { model: COVER_EMBEDDING_MODEL, size: COVER_EMBEDDING_SIZE, ...embeddings.stats },
    vision: { model: visionModel, titleOptions, titleAutoThreshold, ...extraction.stats }, collections,
    ...summarize(results), results,
  };
  const reportPath = path.join(output, 'report.json');
  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n');
  await rename(`${reportPath}.tmp`, reportPath);
  console.log(JSON.stringify({ selectedVariant: report.selectedVariant, comparisons: report.comparisons, reportPath }, null, 2));
}

main().catch(error => {
  const detail = error.status ? ` (HTTP ${error.status})` : '';
  // Provider errors can include request details. Print the status without the payload.
  console.error(error.name === 'ApiError' ? `Gemini request failed${detail}.` : error.message);
  process.exitCode = 1;
});
