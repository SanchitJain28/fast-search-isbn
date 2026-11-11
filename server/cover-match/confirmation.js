import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CoverLookupError } from './errors.js';

const SELECTION_TTL_MS = 15 * 60 * 1000;

export function createCoverConfirmation({ now = Date.now } = {}) {
  const key = randomBytes(32);
  const sign = payload => createHmac('sha256', key).update(payload).digest('base64url');

  return {
    issue(result, catalogVersion, printedIsbn) {
      return { ...result, catalogVersion, candidates: result.candidates.map(({ allocation, ...candidate }) => {
        if (!candidate.nextEligible) return candidate;
        const { isbn, order, score, matchType } = candidate;
        const barcode = matchType === 'exact_isbn' || matchType === 'edition_mapping' ? result.printedIsbn : null;
        const payload = Buffer.from(JSON.stringify({ isbn, order, allocation, catalogVersion, barcode, printedIsbn,
          score, ...(['cover_vector', 'cover_suggestion'].includes(matchType) ? { matchType } : {}),
          expires: now() + SELECTION_TTL_MS, nonce: randomUUID() })).toString('base64url');
        return { ...candidate, confirmationToken: `${payload}.${sign(payload)}` };
      }) };
    },
    verify({ confirmationToken, catalogVersion, isbn, order }) {
      const [payload, signature] = confirmationToken.split('.');
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new CoverLookupError(409, 'This selection is no longer valid. Look up the book again.');
      }
      const selection = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (selection.expires <= now() || selection.catalogVersion !== catalogVersion || selection.isbn !== isbn || selection.order !== order) {
        throw new CoverLookupError(409, 'This selection is stale or does not match the requested ISBN and box. Look up the book again.');
      }
      return selection;
    },
  };
}
