export class BookSearchEngine {
  constructor() {
    this.records = [];
    this.isbnMap = new Map(); // cleanIsbn -> Array of records
    this.isbnPrefixMap = new Map(); // isbnPrefix (>= 4 digits) -> Array of record IDs
    this.tokenMap = new Map(); // tokenPrefix (>= 2 chars) -> Array of record IDs
    this.orders = new Set();
    this.orderTotals = new Map(); // Order -> count
    this.isReady = false;
  }

  init(data) {
    console.time("SearchEngine.init");
    const total = data.length;
    this.records = new Array(total);
    this.isbnMap.clear();
    this.isbnPrefixMap.clear();
    this.tokenMap.clear();
    this.orders.clear();
    this.orderTotals.clear();

    for (let i = 0; i < total; i++) {
      const item = data[i];
      const title = String(item.Title || "").trim();
      const isbnRaw = String(item.ISBN13 || "").trim();
      const cleanIsbn = isbnRaw.replace(/[^0-9Xx]/g, "");
      const order = String(item.Order || "").trim();
      const lowerTitle = title.toLowerCase();

      const record = {
        id: i,
        Order: order,
        ISBN13: cleanIsbn || isbnRaw,
        Title: title,
        Qty: item.Qty != null ? item.Qty : 1,
        key: item.key || cleanIsbn || isbnRaw,
        seqkey: item.seqkey || `${cleanIsbn || isbnRaw}|1`,
        copies: item.copies != null ? item.copies : 1,
        lowerTitle: lowerTitle,
        lowerIsbn: (cleanIsbn || isbnRaw).toLowerCase(),
      };

      this.records[i] = record;

      // Track Orders
      if (order) {
        this.orders.add(order);
        this.orderTotals.set(order, (this.orderTotals.get(order) || 0) + 1);
      }

      // Track exact ISBN Map
      const finalIsbn = record.ISBN13;
      if (finalIsbn) {
        let arr = this.isbnMap.get(finalIsbn);
        if (!arr) {
          arr = [];
          this.isbnMap.set(finalIsbn, arr);
        }
        arr.push(record);

        // Index ISBN prefixes (from 4 digits up to length)
        for (let l = 4; l <= finalIsbn.length; l++) {
          const prefix = finalIsbn.substring(0, l);
          let pList = this.isbnPrefixMap.get(prefix);
          if (!pList) {
            pList = [];
            this.isbnPrefixMap.set(prefix, pList);
          }
          pList.push(i);
        }
      }

      // Index Title Tokens
      const words = lowerTitle.split(/[^a-z0-9]+/);
      const seenWords = new Set();

      for (let w = 0; w < words.length; w++) {
        const word = words[w];
        if (!word || word.length < 2 || seenWords.has(word)) continue;
        seenWords.add(word);

        // Index word prefixes from 2 up to 8 characters
        const maxPrefixLen = Math.min(word.length, 8);
        for (let l = 2; l <= maxPrefixLen; l++) {
          const prefix = word.substring(0, l);
          let tList = this.tokenMap.get(prefix);
          if (!tList) {
            tList = [];
            this.tokenMap.set(prefix, tList);
          }
          tList.push(i);
        }
      }
    }

    this.isReady = true;
    console.timeEnd("SearchEngine.init");

    return {
      totalRecords: this.records.length,
      orders: Array.from(this.orders).sort((a, b) => {
        const numA = Number(a);
        const numB = Number(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      }),
      orderTotals: Object.fromEntries(this.orderTotals),
    };
  }

  search(query, options = {}) {
    if (!this.isReady || !query) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }

    const startTime = performance.now();
    const rawQuery = String(query).trim();
    if (!rawQuery) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }

    const limit = options.limit || 60;
    const filterOrder = options.order || "ALL";

    // 1. Direct exact ISBN lookup (0.002ms)
    const cleanDigits = rawQuery.replace(/[^0-9Xx]/g, "");
    if (cleanDigits.length >= 9 && this.isbnMap.has(cleanDigits)) {
      let matches = this.isbnMap.get(cleanDigits);
      if (filterOrder !== "ALL") {
        matches = matches.filter((r) => String(r.Order) === filterOrder);
      }
      const endTime = performance.now();
      return {
        results: matches.slice(0, limit),
        latencyMs: +(endTime - startTime).toFixed(3),
        totalMatches: matches.length,
      };
    }

    // 2. Partial ISBN search (e.g. user typed 4 to 8 digits of barcode)
    if (/^\d{4,8}$/.test(cleanDigits)) {
      const isbnMatches = this.isbnPrefixMap.get(cleanDigits);
      if (isbnMatches && isbnMatches.length > 0) {
        const matchedDocs = [];
        const seen = new Set();
        for (let i = 0; i < isbnMatches.length; i++) {
          const doc = this.records[isbnMatches[i]];
          if (!seen.has(doc.id)) {
            seen.add(doc.id);
            if (filterOrder === "ALL" || String(doc.Order) === filterOrder) {
              matchedDocs.push(doc);
              if (matchedDocs.length >= limit * 2) break;
            }
          }
        }
        if (matchedDocs.length > 0) {
          const endTime = performance.now();
          return {
            results: matchedDocs.slice(0, limit),
            latencyMs: +(endTime - startTime).toFixed(3),
            totalMatches: matchedDocs.length,
          };
        }
      }
    }

    // 3. Multi-token Title Search
    const cleanQuery = rawQuery.toLowerCase();
    const tokens = cleanQuery.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

    let candidateIds = null;

    if (tokens.length > 0) {
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        const searchPrefix = tok.substring(0, 8);
        const ids = this.tokenMap.get(searchPrefix);

        if (!ids || ids.length === 0) {
          candidateIds = [];
          break;
        }

        if (candidateIds === null) {
          candidateIds = [...ids];
        } else {
          // Intersect with candidate set
          const currentSet = new Set(ids);
          candidateIds = candidateIds.filter((id) => currentSet.has(id));
          if (candidateIds.length === 0) break;
        }
      }
    }

    const matchedDocs = [];
    const seenIds = new Set();

    if (candidateIds && candidateIds.length > 0) {
      for (let i = 0; i < candidateIds.length; i++) {
        const doc = this.records[candidateIds[i]];
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          if (filterOrder === "ALL" || String(doc.Order) === filterOrder) {
            matchedDocs.push(doc);
          }
        }
      }
    }

    // 4. Fallback: Fast linear substring scan if 0 matches
    if (matchedDocs.length === 0 && cleanQuery.length >= 2) {
      for (let i = 0; i < this.records.length; i++) {
        const doc = this.records[i];
        if (filterOrder !== "ALL" && String(doc.Order) !== filterOrder) continue;

        if (doc.lowerTitle.includes(cleanQuery) || doc.lowerIsbn.includes(cleanQuery)) {
          matchedDocs.push(doc);
          if (matchedDocs.length >= limit * 2) break;
        }
      }
    }

    // Rank results: exact phrase at start of title ranked highest
    matchedDocs.sort((a, b) => {
      const aStarts = a.lowerTitle.startsWith(cleanQuery) ? -1 : 0;
      const bStarts = b.lowerTitle.startsWith(cleanQuery) ? -1 : 0;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return 0;
    });

    const finalResults = matchedDocs.slice(0, limit);
    const endTime = performance.now();

    return {
      results: finalResults,
      latencyMs: +(endTime - startTime).toFixed(3),
      totalMatches: matchedDocs.length,
    };
  }

  // Get all copies ordered for a given ISBN
  getCopiesForIsbn(isbn) {
    const clean = String(isbn || "").trim().replace(/[^0-9Xx]/g, "");
    return this.isbnMap.get(clean) || this.isbnMap.get(String(isbn).trim()) || [];
  }
}

export const searchEngine = new BookSearchEngine();
