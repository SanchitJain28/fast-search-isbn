import { ratio } from 'fuzzball';

const MAX_POSTINGS = 6000;
const MAX_GRAM_POSTINGS = 1500;
const MAX_CANDIDATES = 800;

export const fuzzOptions = { full_process: false };

function grams(word) {
  const padded = `^${word}$`;
  return new Set(Array.from({ length: padded.length - 2 }, (_, i) => padded.slice(i, i + 3)));
}

export class TitleIndex {
  constructor(approximate) {
    this.keys = new Map();
    this.entries = [];
    this.postings = new Map();
    this.gramPostings = approximate ? new Map() : null;
  }

  add(key, row) {
    if (!key) return;
    const existing = this.keys.get(key);
    if (existing !== undefined) {
      this.entries[existing].rows.push(row);
      return;
    }
    const id = this.entries.length;
    this.keys.set(key, id);
    const tokens = [...new Set(key.split(' '))];
    this.entries.push({ key, rows: [row], tokens });
    for (const token of tokens) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = [];
        this.postings.set(token, posting);
        if (this.gramPostings && token.length >= 3) {
          for (const gram of grams(token)) {
            let words = this.gramPostings.get(gram);
            if (!words) this.gramPostings.set(gram, words = []);
            words.push(token);
          }
        }
      }
      posting.push(id);
    }
  }

  similarTokens(token) {
    const hits = new Map();
    for (const gram of grams(token)) {
      const words = this.gramPostings.get(gram);
      if (!words || words.length > MAX_GRAM_POSTINGS) continue;
      for (const word of words) hits.set(word, (hits.get(word) ?? 0) + 1);
    }
    return [...hits].sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([word]) => [word, ratio(token, word, fuzzOptions)])
      .filter(([, score]) => score >= 70)
      .sort((a, b) => b[1] - a[1]).slice(0, 4);
  }

  shortlist(key, tokens) {
    const exact = this.keys.get(key);
    const weights = new Map();
    let common;
    const add = (posting, similarity) => {
      const weight = similarity * Math.log(1 + this.entries.length / posting.length);
      for (const id of posting) weights.set(id, (weights.get(id) ?? 0) + weight);
    };
    for (const token of tokens) {
      const posting = this.postings.get(token);
      if (posting?.length <= MAX_POSTINGS) add(posting, 1);
      else if (posting && (!common || posting.length < common.length)) common = posting;
      if (!posting && this.gramPostings && token.length >= 3) {
        for (const [word, score] of this.similarTokens(token)) {
          const nearby = this.postings.get(word);
          if (nearby.length <= MAX_POSTINGS) add(nearby, score / 150);
        }
      }
    }
    if (exact !== undefined) weights.set(exact, Infinity);
    if (common && (weights.size === 0 || (weights.size === 1 && exact !== undefined))) {
      const ids = new Set(exact === undefined ? [] : [exact]);
      for (const id of common.slice(0, MAX_CANDIDATES - ids.size)) ids.add(id);
      return { ids, truncated: true };
    }
    if (weights.size <= MAX_CANDIDATES) return { ids: weights.keys(), truncated: false };
    const ids = [...weights].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES).map(([id]) => id);
    return { ids, truncated: true };
  }
}
