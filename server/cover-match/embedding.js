import { GoogleGenAI } from '@google/genai';

export const COVER_EMBEDDING_MODEL = 'gemini-embedding-2';
export const COVER_EMBEDDING_SIZE = 1536;

export function isCoverEmbedding(vector) {
  return Array.isArray(vector) && vector.length === COVER_EMBEDDING_SIZE
    && vector.every(Number.isFinite) && vector.some(value => value !== 0);
}

export function coverEmbeddingText({ title, author }) {
  return [`Title: ${title}`, ...(author ? [`Author: ${author}`] : [])].join('\n');
}

export function createCoverEmbedder({ apiKey, client = new GoogleGenAI({ apiKey, vertexai: false }) }) {
  return async function embed({ bytes, mimeType, text }, { signal } = {}) {
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') throw new Error('Embedding expects a JPEG or PNG cover.');
    const parts = [
      ...(text ? [{ text }] : []),
      { inlineData: { mimeType, data: bytes.toString('base64') } },
    ];
    const response = await client.models.embedContent({
      model: COVER_EMBEDDING_MODEL,
      contents: [{ parts }],
      config: {
        outputDimensionality: COVER_EMBEDDING_SIZE,
        abortSignal: signal,
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });
    const embedding = response.embeddings?.[0];
    if (response.embeddings?.length !== 1 || !isCoverEmbedding(embedding?.values)) {
      throw new Error('Gemini did not return one valid 1,536-number cover embedding.');
    }
    return { vector: embedding.values, inputTokens: embedding.statistics?.tokenCount ?? response.usageMetadata?.promptTokenCount ?? null };
  };
}
