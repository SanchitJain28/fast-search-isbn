import { z } from 'zod';
import { parsePrintedIsbn } from '../isbn.js';
import { createCoverConfirmation } from './confirmation.js';
import { createCoverEmbedder } from './embedding.js';
import { CoverLookupError } from './errors.js';
import { coverSuggestions, lookupCover, lookupCoverVectors, refreshCoverSelection } from './lookup.js';
import { createQdrantCoverClient } from './qdrant.js';
import { readCoverImage } from './upload.js';
import { createGeminiVisionProvider, validateExtraction } from './vision.js';
import { openCoverMatcher } from './worker.js';

const querySchema = z.strictObject({ query: z.string().trim().min(1).max(300) });
const confirmationSchema = z.strictObject({
  id: z.string().regex(/^[\w-]{8,100}$/), isbn: z.string().regex(/^\d{4,32}X?$/),
  order: z.string().trim().min(1).max(128), station: z.string().max(80).default(''),
  catalogVersion: z.string().regex(/^[a-f0-9]{64}$/),
  confirmationToken: z.string().max(2048).regex(/^[\w-]+\.[\w-]+$/),
});
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readJson(req, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new CoverLookupError(415, 'Send an application/json request.');
  }
  if (Number(req.headers['content-length']) > 4096) throw new CoverLookupError(413, 'Request is too large.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    length += chunk.length;
    if (length > 4096) throw new CoverLookupError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, length)); }
  catch { throw new CoverLookupError(400, 'Invalid JSON request.'); }
}

function settings() {
  const minScore = Number(process.env.COVER_MATCH_MIN_SCORE || 75);
  const gap = Number(process.env.COVER_MATCH_GAP_MIN || 8);
  const autoThreshold = Number(process.env.COVER_MATCH_AUTO_THRESHOLD || 90);
  if (![minScore, gap, autoThreshold].every(value => Number.isFinite(value) && value >= 0 && value <= 100) || autoThreshold < minScore) {
    throw new CoverLookupError(503, 'Cover match scoring settings are invalid.');
  }
  return { minScore, gap, autoThreshold };
}

function vectorRules() {
  const minimumScore = Number(process.env.COVER_VECTOR_MIN_SCORE || 0.623026);
  const minimumGap = Number(process.env.COVER_VECTOR_MIN_GAP || 0.02219);
  if (!Number.isFinite(minimumScore) || minimumScore < -1 || minimumScore > 1
      || !Number.isFinite(minimumGap) || minimumGap < 0 || minimumGap > 2) {
    throw new Error('Invalid cover vector scores.');
  }
  return { minimumScore, minimumGap };
}

export function createCoverRoutes({ store, catalogPath, publicOrigin, allowRemote = false,
  enabled = process.env.COVER_MATCH_ENABLED === 'true', autoPackMode = process.env.COVER_MATCH_AUTO_PACK,
  vectorEnabled = process.env.COVER_VECTOR_SEARCH_ENABLED === 'true',
  vectorPilotStation = process.env.COVER_VECTOR_PILOT_STATION?.trim(), vectorSearch, vectorTimeoutMs = 5000,
  visionProvider, timeoutMs = 20000, onPacked }) {
  const active = { image: 0, typed: 0, confirm: 0 };
  const limits = { image: 2, typed: 8, confirm: 8 };
  const confirmation = createCoverConfirmation();
  let matcherPromise;

  async function matchTitles(input, options, signal) {
    if (!['title_as_printed', 'native_title', 'romanized_title', 'english_title'].some(field => input[field])) {
      return { matches: [], reviewReasons: ['no_match'] };
    }
    if (!matcherPromise) {
      matcherPromise = openCoverMatcher({ catalogPath, expectedCatalogVersion: store.catalogHash }).catch(error => {
        matcherPromise = undefined;
        throw error;
      });
    }
    try {
      const matcher = await matcherPromise;
      signal.throwIfAborted();
      return await matcher.match(input, options);
    } catch {
      signal.throwIfAborted();
      throw new CoverLookupError(503, 'Title matching is temporarily unavailable.');
    }
  }

  function getVisionProvider() {
    if (visionProvider) return visionProvider;
    const provider = process.env.COVER_VISION_PROVIDER || 'gemini';
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (provider !== 'gemini' || !apiKey) throw new CoverLookupError(503, 'Cover vision is not configured. You can still search by title.');
    return visionProvider = createGeminiVisionProvider({ apiKey, model: process.env.COVER_VISION_MODEL || undefined });
  }

  function getVectorSearch() {
    if (vectorSearch) return vectorSearch;
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    const url = process.env.QDRANT_URL?.trim();
    const collection = process.env.COVER_VECTOR_COLLECTION?.trim();
    const reviewCollection = process.env.COVER_VECTOR_REVIEW_COLLECTION?.trim();
    if (!apiKey || !url || !collection) throw new Error('Cover vector search is not configured.');
    const embed = createCoverEmbedder({ apiKey });
    const qdrant = createQdrantCoverClient({ url, apiKey: process.env.QDRANT_API_KEY });
    return vectorSearch = async (image, { signal }) => {
      const { vector } = await embed(image, { signal });
      signal.throwIfAborted();
      const verified = qdrant.search(collection, vector, { signal });
      if (!reviewCollection || reviewCollection === collection) return { hits: await verified };
      const [primary, review] = await Promise.allSettled([
        verified, qdrant.search(reviewCollection, vector, { signal }),
      ]);
      if (primary.status === 'rejected' && review.status === 'rejected') throw primary.reason;
      return {
        hits: primary.status === 'fulfilled' ? primary.value : [],
        reviewHits: review.status === 'fulfilled' ? review.value : [],
        partialSearch: primary.status === 'rejected' || review.status === 'rejected',
      };
    };
  }

  async function tryVector(image, signal, timeLeftMs) {
    if (!['image/jpeg', 'image/png'].includes(image.mimeType)) return { fallbackReason: 'unsupported_cover_format' };
    const budget = Math.min(vectorTimeoutMs, Math.floor(timeLeftMs));
    if (budget < 1) return { fallbackReason: 'vector_timeout' };
    const deadline = AbortSignal.timeout(budget);
    const vectorSignal = AbortSignal.any([signal, deadline]);
    let search, rules;
    try {
      rules = vectorRules();
      search = await withAbort(getVectorSearch()(image, { signal: vectorSignal }), vectorSignal);
    } catch {
      signal.throwIfAborted();
      return { fallbackReason: deadline.aborted ? 'vector_timeout' : 'vector_unavailable' };
    }
    signal.throwIfAborted();
    if (!store.ready) throw new CoverLookupError(409, 'Reconcile the catalog before looking up packing availability.');
    const { hits, reviewHits = [], partialSearch } = Array.isArray(search) ? { hits: search } : search;
    const reviewSuggestions = coverSuggestions(store, reviewHits, { review: true });
    return { ...lookupCoverVectors(store, hits, rules), hits, reviewSuggestions, partialSearch };
  }

  async function lookup(req, mode, signal, params, trace) {
    active[mode]++;
    const photoMode = params.get('mode');
    const isbnPage = photoMode === 'isbn';
    const pilot = vectorEnabled && Boolean(vectorPilotStation) && params.get('station') === vectorPilotStation;
    const comparison = mode === 'image' && photoMode === 'title';
    const vectorAllowed = vectorEnabled && (!vectorPilotStation || pilot);
    const vectorAttempt = mode === 'image' && vectorAllowed && [null, 'cover', 'vector'].includes(photoMode);
    const verifyPhotoIsbn = mode === 'image' && photoMode === 'ocr' && params.get('verify') === 'isbn';
    const started = performance.now();
    let lookupStatus = 'ERROR';
    try {
      if (comparison && !pilot) throw new CoverLookupError(403, 'Photo comparison is only available at the pilot station.');
      if (mode === 'image' && photoMode === 'vector' && !vectorAllowed) {
        throw new CoverLookupError(403, 'Vector search is unavailable at this station.');
      }
      if (mode === 'confirm') {
        const request = confirmationSchema.safeParse(await readJson(req, signal));
        if (!request.success) throw new CoverLookupError(400, 'Send the request ID and the selected ISBN, box, catalog version, and confirmation token.');
        signal.throwIfAborted();
        const { scan, created } = store.confirmCover(request.data, confirmation.verify);
        if (created) onPacked(scan);
        return scan;
      }
      let extracted, visionUsage;
      if (mode === 'image') {
        const image = await readCoverImage(req, signal);
        signal.throwIfAborted();
        if (vectorAttempt) {
          trace.searchMethod = 'cover_vector';
          const vector = await tryVector(image, signal, timeoutMs - (performance.now() - started));
          const vectorTopIsbns = pilot ? vector.hits?.slice(0, 3).map(hit => hit.isbn) : undefined;
          const signSuggestions = candidates => candidates?.length
            ? confirmation.issue({ candidates }, store.catalogHash, null).candidates
            : undefined;
          const review = {
            reviewSuggestions: signSuggestions(vector.reviewSuggestions),
            partialSearch: vector.partialSearch || undefined,
          };
          if (vector.result) {
            lookupStatus = vector.result.status;
            return { ...confirmation.issue(vector.result, store.catalogHash, null), autoConfirm: false, ...review,
              ...(pilot ? { pilotComparisonAvailable: true, vectorTopIsbns } : {}) };
          }
          trace.vectorReason = vector.fallbackReason;
          lookupStatus = 'NO_MATCH';
          return { ...trace, status: lookupStatus, candidates: [], reviewReasons: [], vectorTopIsbns, ...review,
            catalogVersion: store.catalogHash, vectorSuggestions: signSuggestions(vector.vectorSuggestions) };
        }
        trace.searchMethod = isbnPage ? 'isbn_page' : 'photo_text';
        const provider = getVisionProvider();
        extracted = validateExtraction(await provider.extract(image, { signal, onUsage: usage => { visionUsage = usage; } }));
      }
      const { autoThreshold, ...options } = settings();
      const query = mode === 'typed' ? querySchema.safeParse(await readJson(req, signal)) : null;
      if (query && !query.success) throw new CoverLookupError(400, 'Enter a title or ISBN of up to 300 characters.');
      if (query) trace.searchMethod = 'typed';
      signal.throwIfAborted();
      if (!store.ready) throw new CoverLookupError(409, 'Reconcile the catalog before looking up packing availability.');
      const result = await lookupCover({
        store, input: extracted ?? { title_as_printed: query.data.query, isbn_text: query.data.query }, autoThreshold,
        matchTitles: async input => {
          if (mode === 'image' && isbnPage) return { matches: [], reviewReasons: ['isbn_not_recognized'] };
          const ranked = await matchTitles(input, options, signal);
          if (!store.ready) throw new CoverLookupError(409, 'Reconcile the catalog before looking up packing availability.');
          return ranked;
        },
      });
      const requiresIsbn = verifyPhotoIsbn && result.candidates.some(candidate => candidate.matchType === 'title');
      if (requiresIsbn) {
        result.status = 'REVIEW';
        result.autoPack = null;
        result.reviewReasons.push('verify_fallback_isbn');
        for (const candidate of result.candidates) {
          if (candidate.matchType === 'title') candidate.nextEligible = false;
        }
      }
      lookupStatus = result.status;
      if (comparison) {
        const { status, matchedIsbn, matchedTitle } = result;
        const candidates = result.candidates.slice(0, 3).map(({ isbn, title, order }) => ({ isbn, title, order }));
        return { status, matchedIsbn, matchedTitle, candidates, ...trace, lookupMs: Math.round(performance.now() - started) };
      }
      const printedIsbn = extracted ? parsePrintedIsbn(extracted.isbn_text) : null;
      const issued = { ...confirmation.issue(result, store.catalogHash, printedIsbn), ...trace };
      if (!extracted) return { ...issued, autoPack: null };
      if (isbnPage || verifyPhotoIsbn) return { ...issued, extracted, autoPack: null, autoConfirm: false, ...(visionUsage ? { visionUsage } : {}) };
      const candidate = issued.candidates[0];
      const autoConfirm = Boolean(issued.autoPack && candidate?.confirmationToken &&
        (autoPackMode === 'all' || (autoPackMode === 'isbn' && candidate.matchType === 'exact_isbn')));
      return { ...issued, extracted, autoConfirm, ...(visionUsage ? { visionUsage } : {}) };
    } finally {
      active[mode]--;
      if (vectorAttempt || (comparison && pilot)) console.info(JSON.stringify({
        event: 'cover-lookup', searchMethod: trace.searchMethod, vectorReason: trace.vectorReason,
        status: lookupStatus, lookupMs: Math.round(performance.now() - started),
        ...(pilot ? { station: vectorPilotStation, comparison } : {}),
      }));
    }
  }

  return {
    enabled,
    vector: { enabled: enabled && vectorEnabled, pilotStation: vectorPilotStation || null },
    async handle(req, res, url, json) {
      const mode = url.pathname === '/api/cover-match' ? 'image' : url.pathname === '/api/cover-match/search' ? 'typed'
        : url.pathname === '/api/mark-packed' ? 'confirm' : null;
      if (!mode) return false;
      if (!enabled) { json(404, { error: 'Cover matching is disabled.' }); return true; }
      if (req.method !== 'POST') { json(405, { error: 'Use POST for cover requests.' }); return true; }
      const origins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
      const trustedOrigin = !req.headers.origin || String(req.headers.origin).split(',').every(origin => origins.includes(origin.trim()));
      if (!trustedOrigin || (!allowRemote && !localAddresses.has(req.socket.remoteAddress))) {
        json(403, { error: 'Use the authenticated scanner address, or localhost for development.' });
        return true;
      }
      if (mode !== 'confirm' && !store.ready) { json(409, { error: 'Reconcile the catalog before looking up packing availability.' }); return true; }
      if (active[mode] >= limits[mode]) { json(429, { error: 'Cover lookup is busy. Try again shortly.' }); return true; }
      const disconnected = new AbortController();
      const onClose = () => disconnected.abort();
      res.once('close', onClose);
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([disconnected.signal, deadline]);
      const trace = {};
      try {
        json(200, await withAbort(lookup(req, mode, signal, url.searchParams, trace), signal));
      } catch (error) {
        if (disconnected.signal.aborted) return true;
        if (deadline.aborted) json(504, { error: 'Cover lookup timed out. Retry or search by title.', ...trace });
        else if (error.status === 409) {
          const refreshed = error.selection && refreshCoverSelection(store, error.selection);
          const lookup = refreshed && confirmation.issue({ ...refreshed, autoPack: null }, store.catalogHash, error.selection.printedIsbn);
          json(409, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(lookup ? { lookup } : {}), ...trace });
        } else if (error instanceof CoverLookupError) json(error.status, { error: error.message, ...trace });
        else json(502, { error: mode === 'confirm' ? 'Cover confirmation could not be completed. Retry the same request.' : 'Cover lookup failed. Retry or search by title.', ...trace });
      } finally {
        res.off('close', onClose);
        if (!req.complete && !req.destroyed) req.resume();
      }
      return true;
    },
    close() {
      void matcherPromise?.then(matcher => matcher.close()).catch(() => {});
    },
  };
}
