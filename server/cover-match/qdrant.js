import { COVER_EMBEDDING_SIZE } from './embedding.js';

const vectorConfig = { size: COVER_EMBEDDING_SIZE, distance: 'Cosine' };

function coverImageUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.origin === 'https://m.media-amazon.com' && !url.username && !url.password && url.pathname.startsWith('/images/')) {
      return url.href;
    }
  } catch { /* Older or malformed cover records can still be searched. */ }
}

export function createQdrantCoverClient({ url, apiKey, fetcher = fetch }) {
  async function request(path, { method = 'GET', body, signal, allowMissing = false } = {}) {
    const response = await fetcher(new URL(path, url), {
      method,
      headers: { ...(apiKey ? { 'api-key': apiKey } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`Qdrant ${method} ${path} returned HTTP ${response.status}.`), { status: response.status });
    const data = await response.json();
    if (data.status !== 'ok') throw new Error(`Qdrant ${method} ${path} did not complete.`);
    return data.result;
  }

  const collectionPath = name => `/collections/${encodeURIComponent(name)}`;
  return {
    async ensureCollection(name) {
      const path = collectionPath(name);
      const current = await request(path, { allowMissing: true });
      if (current === null) {
        await request(path, { method: 'PUT', body: { vectors: vectorConfig } });
      } else {
        const vectors = current.config?.params?.vectors;
        if (vectors?.size !== vectorConfig.size || vectors?.distance !== vectorConfig.distance) {
          throw new Error(`Qdrant collection ${name} must use 1,536 dimensions and cosine distance.`);
        }
      }
    },
    async upsert(name, points, { signal } = {}) {
      const result = await request(`${collectionPath(name)}/points?wait=true`, { method: 'PUT', body: { points }, signal });
      if (result?.status !== 'completed') throw new Error('Qdrant did not finish saving the covers.');
    },
    async count(name) {
      const result = await request(`${collectionPath(name)}/points/count`, { method: 'POST', body: { exact: true } });
      if (!Number.isSafeInteger(result?.count)) throw new Error('Qdrant returned an invalid cover count.');
      return result.count;
    },
    async flagShared(name, points) {
      const result = await request(`${collectionPath(name)}/points/payload?wait=true`, {
        method: 'POST', body: { payload: { shared_cover: true }, points },
      });
      if (result?.status !== 'completed') throw new Error('Qdrant did not finish flagging shared covers.');
    },
    async search(name, vector, { signal } = {}) {
      const result = await request(`${collectionPath(name)}/points/query`, {
        method: 'POST',
        body: { query: vector, limit: 10, with_payload: ['po_isbn', 'amazon_isbn', 'shared_cover', 'image_sha256', 'cover_url', 'listing_title'] },
        signal,
      });
      if (!Array.isArray(result?.points)) throw new Error('Qdrant returned an invalid cover shortlist.');
      const hits = new Map();
      for (const { payload, score } of result.points) {
        if (typeof payload?.po_isbn !== 'string' || !Number.isFinite(score)
            || (payload.amazon_isbn != null && typeof payload.amazon_isbn !== 'string')) {
          throw new Error('Qdrant returned a cover without a valid ISBN or score.');
        }
        const previous = hits.get(payload.po_isbn);
        if (!previous || score > previous.score) {
          const coverUrl = coverImageUrl(payload.cover_url);
          hits.set(payload.po_isbn, {
            isbn: payload.po_isbn, score, sharedCover: payload.shared_cover === true,
            ...(coverUrl ? { coverUrl } : {}),
            ...(typeof payload.listing_title === 'string' ? { listingTitle: payload.listing_title } : {}),
            ...(payload.amazon_isbn != null ? { amazonIsbn: payload.amazon_isbn } : {}),
            ...(typeof payload.image_sha256 === 'string' ? { imageHash: payload.image_sha256 } : {}),
          });
        }
      }
      return [...hits.values()].sort((a, b) => b.score - a.score);
    },
  };
}
