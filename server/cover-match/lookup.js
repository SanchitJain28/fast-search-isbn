import { parsePrintedIsbn } from '../isbn.js';
import { authorKeys, checkAuthor, unicodeKey } from './normalization.js';
import { coverVectorDecision } from './vector-decision.js';

function byOrder(isbn, copies, { score, matchType, evidence, author }) {
  const orders = new Map();
  for (const copy of copies) {
    const existing = orders.get(copy.order);
    if (existing) existing.remaining++;
    else orders.set(copy.order, {
      order: copy.order, isbn, title: copy.title, allocation: copy.allocation, score, matchType, remaining: 1,
      nextEligible: orders.size === 0, authorAgreement: checkAuthor(author, copy.author),
      ...(copy.author ? { author: copy.author } : {}), ...(evidence ? { evidence } : {}),
    });
  }
  return [...orders.values()];
}

function result(status, candidates = [], reviewReasons = [], autoPack = null, extra = {}) {
  return { status, candidates: candidates.slice(0, 10), candidateCount: candidates.length, reviewReasons, autoPack, ...extra };
}

function lookupIsbn(store, barcode, author) {
  const conflict = store.amazonConflicts.get(barcode);
  if (conflict) {
    const candidates = conflict.flatMap(([isbn, order]) => {
      const { available } = store.getPackedState(isbn);
      return byOrder(isbn, available.filter(copy => copy.order === order), { score: 100, matchType: 'edition_conflict', author })
        .map(candidate => ({ ...candidate, nextEligible: false }));
    });
    return result('REVIEW', candidates, ['edition_conflict'], null, { printedIsbn: barcode });
  }
  const mapping = store.amazonByBarcode.get(barcode);
  const isbn = mapping?.poIsbn || barcode;
  if (!store.byIsbn.has(isbn)) return null;
  const { available } = store.getPackedState(isbn, { mapping, barcode });
  if (!available.length) return result('DUPLICATE', [], [], null, { printedIsbn: barcode, matchedIsbn: isbn });
  const candidates = byOrder(isbn, available, { score: 100, matchType: mapping ? 'edition_mapping' : 'exact_isbn', author });
  const reasons = [];
  if (mapping) reasons.push('edition_mapping');
  if (candidates[0].authorAgreement === 'different') reasons.push('author_difference');
  const autoPack = reasons.length ? null : { isbn, order: candidates[0].order };
  return result(reasons.length ? 'REVIEW' : 'MATCH', candidates, reasons, autoPack, { printedIsbn: barcode, matchedIsbn: isbn });
}

export function refreshCoverSelection(store, selection) {
  if (selection.barcode) return lookupIsbn(store, selection.barcode, []) ?? result('NO_MATCH');
  const { available } = store.getPackedState(selection.isbn);
  const vector = ['cover_vector', 'cover_suggestion'].includes(selection.matchType);
  const method = vector ? { searchMethod: 'cover_vector' } : {};
  if (!available.length) return result('DUPLICATE', [], [], null, { matchedIsbn: selection.isbn, ...method });
  const candidates = byOrder(selection.isbn, available, { score: selection.score, matchType: vector ? selection.matchType : 'title', author: [] });
  return result('REVIEW', vector ? candidates.slice(0, 1) : candidates, ['confirmation_changed'], null, method);
}

export function coverSuggestions(store, hits, { review = false } = {}) {
  return hits.filter(hit => store.byIsbn.has(hit.isbn)).map(hit => {
    const { isbn, score, amazonIsbn, coverUrl, listingTitle, sharedCover } = hit;
    const suggestion = { isbn, title: store.byIsbn.get(isbn)[0].title, score, amazonIsbn, coverUrl, listingTitle, sharedCover };
    if (!review && amazonIsbn) return suggestion;
    const { available } = store.getPackedState(isbn);
    const next = byOrder(isbn, available, { score, matchType: 'cover_suggestion', author: [] })[0];
    return next ? { ...suggestion, ...next } : { ...suggestion, alreadyPacked: true };
  });
}

export function lookupCoverVectors(store, hits, rules) {
  const [first] = hits;
  const decision = coverVectorDecision(hits, rules);
  const isCurrent = ({ isbn, amazonIsbn }) => store.byIsbn.has(isbn)
    && (amazonIsbn == null || store.amazonByBarcode.get(amazonIsbn)?.poIsbn === isbn);
  if (decision === 'fallback') {
    if (!first) return { fallbackReason: 'empty_cover_results' };
    const vectorSuggestions = coverSuggestions(store, hits.filter(isCurrent));
    return { fallbackReason: 'weak_cover', vectorSuggestions };
  }

  if (!isCurrent(first)) return { fallbackReason: 'stale_cover_index' };
  const reviewReasons = new Set();
  if (decision === 'review') reviewReasons.add(first.sharedCover ? 'shared_cover' : 'close_cover_matches');
  const searchMethod = 'cover_vector';
  const matches = decision === 'review' ? hits.filter(hit => isCurrent(hit) && hit.score >= rules.minimumScore
    && (first.score - hit.score <= rules.minimumGap || (first.imageHash && first.imageHash === hit.imageHash))) : [first];
  const candidates = matches.map(({ isbn, score, amazonIsbn, coverUrl }) => {
    const mapping = store.amazonByBarcode.get(amazonIsbn);
    const { copies, available } = store.getPackedState(isbn, { mapping, barcode: amazonIsbn });
    const next = byOrder(isbn, available, { score, matchType: searchMethod, author: [] })[0];
    const candidate = {
      ...(next ?? { isbn, score, matchType: searchMethod, title: copies[0].title, remaining: 0, alreadyPacked: true }),
      coverUrl,
    };
    if (!mapping) return candidate;
    reviewReasons.add('verify_cover_edition');
    return { ...candidate, amazonIsbn, nextEligible: false };
  });
  if (!reviewReasons.size && candidates[0].alreadyPacked) {
    return { result: result('DUPLICATE', [], [], null, { matchedIsbn: first.isbn, matchedTitle: candidates[0].title, searchMethod }) };
  }
  return { result: result(reviewReasons.size ? 'REVIEW' : 'MATCH', candidates, [...reviewReasons], null, { searchMethod }) };
}

export async function lookupCover({ store, matchTitles, input, autoThreshold = 90 }) {
  const author = authorKeys(input.author);
  const printedIsbn = parsePrintedIsbn(input.isbn_text);
  const known = printedIsbn && lookupIsbn(store, printedIsbn, author);
  if (known) return known;

  const { matches, reviewReasons } = await matchTitles(input);
  if (!matches.length) return result('NO_MATCH', [], reviewReasons);
  const candidates = matches.flatMap(match => byOrder(match.isbn, store.getPackedState(match.isbn).available, {
    score: match.score, matchType: 'title', evidence: match.evidence, author,
  }));
  if (!candidates.length) return result('NO_MATCH', [], ['no_available_title_copies']);
  const [top] = candidates;
  const reasons = new Set(reviewReasons.filter(reason => reason !== 'multiple_catalog_orders'));
  const titleWords = unicodeKey(top.title).split(' ');
  if (titleWords.length < 2 || titleWords.join('').length < 10) reasons.add('short_title');
  if (printedIsbn) reasons.add('unmatched_printed_isbn');
  if (matches[0].isbn !== top.isbn) reasons.add('top_title_exhausted');
  else if (unicodeKey(matches[0].title) !== unicodeKey(top.title)) reasons.add('catalog_title_difference');
  if (top.score < autoThreshold) reasons.add('low_title_score');
  if (top.authorAgreement === 'different') reasons.add('author_difference');
  if (new Set(candidates.map(candidate => candidate.order)).size > 1) reasons.add('multiple_remaining_orders');
  if (new Set(candidates.map(candidate => candidate.isbn)).size > 1) reasons.add('multiple_title_identities');
  const autoPack = reasons.size ? null : { isbn: top.isbn, order: top.order };
  return result(reasons.size ? 'REVIEW' : 'MATCH', candidates, [...reasons], autoPack);
}
