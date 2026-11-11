import { token_set_ratio, token_sort_ratio } from 'fuzzball';
import { authorKeys, checkAuthor, titleKeys } from './normalization.js';
import { fuzzOptions, TitleIndex } from './title-index.js';

const forms = ['title_as_printed', 'native_title', 'romanized_title', 'english_title'];
const DEFAULT_MIN_SCORE = 75;
const DEFAULT_GAP = 8;

function compareEvidence(a, b) {
  return b.score - a.score || Number(b.exact) - Number(a.exact) || Number(a.subsetOnly) - Number(b.subsetOnly)
    || b.tokenSortScore - a.tokenSortScore || forms.indexOf(a.queryForm) - forms.indexOf(b.queryForm)
    || Number(b.keyType === 'unicode') - Number(a.keyType === 'unicode');
}

function compareMatches(a, b) {
  const rank = match => match.score + (match.evidence.exact ? 3 : 0) + (match.authorAgreement === 'match' ? 2 : 0);
  return rank(b) - rank(a) || compareEvidence(a.evidence, b.evidence) || a.rowIndex - b.rowIndex;
}

function queryKeys(input) {
  const query = typeof input === 'string' ? { title_as_printed: input } : input ?? {};
  const keys = { unicode: new Map(), phonetic: new Map() };
  for (const form of forms) {
    if (typeof query[form] !== 'string') continue;
    const normalized = titleKeys(query[form].slice(0, 300));
    for (const [type, key] of Object.entries(normalized)) {
      if (key && !keys[type].has(key)) keys[type].set(key, form);
    }
  }
  return { keys, author: authorKeys(typeof query.author === 'string' ? query.author.slice(0, 300) : '') };
}

function scoreTitle(query, tokens, entry, minScore, queryForm, keyType) {
  const exact = query === entry.key;
  const score = exact ? 100 : token_set_ratio(query, entry.key, fuzzOptions);
  if (!score || score < minScore) return null;
  const shorter = tokens.length < entry.tokens.length ? tokens : entry.tokens;
  const longer = shorter === tokens ? entry.tokens : tokens;
  return {
    score, exact, queryForm, keyType,
    subsetOnly: shorter.length < longer.length && shorter.every(token => longer.includes(token)),
    tokenSortScore: exact ? 100 : token_sort_ratio(query, entry.key, fuzzOptions),
  };
}

export class CatalogTitleMatcher {
  constructor(catalog) {
    this.indexes = { unicode: new TitleIndex(false), phonetic: new TitleIndex(true) };
    this.copiesByIsbn = new Map();
    catalog.forEach((record, rowIndex) => {
      const isbn = String(record.ISBN13 ?? '').trim();
      const order = String(record.Order ?? '').trim();
      if (!isbn || !order) return;
      const title = String(record.Title ?? '').trim();
      const author = String(record.Author ?? '').trim();
      const row = { isbn, order, rowIndex, title, ...(author ? { author } : {}) };
      let copies = this.copiesByIsbn.get(isbn);
      if (!copies) this.copiesByIsbn.set(isbn, copies = []);
      copies.push(row);
      for (const [type, key] of Object.entries(titleKeys(title))) this.indexes[type].add(key, row);
    });
  }

  match(input, { minScore = DEFAULT_MIN_SCORE, gap = DEFAULT_GAP, exhaustive = false } = {}) {
    if (![minScore, gap].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
      throw new RangeError('Matcher thresholds must be between 0 and 100');
    }
    const { keys, author } = queryKeys(input);
    const byIsbn = new Map();
    let truncated = false;
    let scoredKeys = 0;
    for (const [type, queries] of Object.entries(keys)) {
      const index = this.indexes[type];
      for (const [query, form] of queries) {
        const tokens = [...new Set(query.split(' '))];
        const selection = exhaustive ? { ids: index.entries.keys(), truncated: false } : index.shortlist(query, tokens);
        truncated ||= selection.truncated;
        for (const id of selection.ids) {
          const entry = index.entries[id];
          const evidence = scoreTitle(query, tokens, entry, minScore, form, type);
          scoredKeys++;
          if (!evidence) continue;
          for (const row of entry.rows) {
            const previous = byIsbn.get(row.isbn);
            if (previous && compareEvidence(previous.evidence, evidence) < 0) continue;
            const next = { ...row, score: evidence.score, evidence, authorAgreement: checkAuthor(author, row.author) };
            if (!previous || compareEvidence(next.evidence, previous.evidence) < 0 || compareMatches(next, previous) < 0) {
              byIsbn.set(row.isbn, next);
            }
          }
        }
      }
    }
    const matches = [...byIsbn.values()].sort(compareMatches)
      .map(match => ({ ...match, copies: this.copiesByIsbn.get(match.isbn) }));
    const [top, second] = matches;
    const reviewReasons = [];
    if (!top) reviewReasons.push('no_match');
    if (truncated) reviewReasons.push('shortlist_truncated');
    if (top?.evidence.subsetOnly) reviewReasons.push('subset_title');
    if (top?.evidence.queryForm === 'english_title') reviewReasons.push('translated_title');
    if (top?.authorAgreement === 'different') reviewReasons.push('author_difference');
    if (top?.copies.some(copy => copy.order !== top.copies[0].order)) reviewReasons.push('multiple_catalog_orders');
    if (second && (top.score === second.score || top.score - second.score < gap)) reviewReasons.push('close_scores');
    return { matches, reviewReasons, scoredKeys };
  }
}
