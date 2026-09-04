import FlexSearch from "flexsearch";

export class BookSearchEngine {
  constructor() {
    this.records = [];
    this.isbnMap = new Map(); // ISBN -> Array of records
    this.orders = new Set();
    this.orderTotals = new Map(); // Order -> count
    this.index = null;
    this.isReady = false;
  }

  init(data) {
    console.time("SearchEngine.init");
    this.records = data.map((item, idx) => ({
      id: idx,
      ...item,
      Title: String(item.Title || "").trim(),
      ISBN13: String(item.ISBN13 || "").trim(),
      Order: String(item.Order || "").trim(),
    }));

    // Fast O(1) ISBN Map and Orders collection
    this.isbnMap.clear();
    this.orders.clear();
    this.orderTotals.clear();

    for (let i = 0; i < this.records.length; i++) {
      const item = this.records[i];
      const isbn = item.ISBN13;
      const order = item.Order;

      if (order) {
        this.orders.add(order);
        this.orderTotals.set(order, (this.orderTotals.get(order) || 0) + 1);
      }

      if (isbn) {
        if (!this.isbnMap.has(isbn)) {
          this.isbnMap.set(isbn, []);
        }
        this.isbnMap.get(isbn).push(item);
      }
    }

    // FlexSearch Document index
    this.index = new FlexSearch.Document({
      document: {
        id: "id",
        index: [
          {
            field: "Title",
            tokenize: "forward",
            resolution: 9,
            minlength: 1,
            optimize: true,
          },
          {
            field: "ISBN13",
            tokenize: "strict",
            resolution: 9,
          },
        ],
        store: [
          "id",
          "Order",
          "ISBN13",
          "Title",
          "Qty",
          "key",
          "seqkey",
          "copies",
        ],
      },
    });

    for (let i = 0; i < this.records.length; i++) {
      this.index.add(this.records[i]);
    }

    this.isReady = true;
    console.timeEnd("SearchEngine.init");
    return {
      totalRecords: this.records.length,
      orders: Array.from(this.orders).sort(),
      orderTotals: Object.fromEntries(this.orderTotals),
    };
  }

  search(query, options = {}) {
    if (!this.isReady || !query || !query.trim()) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }

    const startTime = performance.now();
    const rawQuery = String(query).trim();
    const cleanQuery = rawQuery.toLowerCase();
    const limit = options.limit || 60;
    const filterOrder = options.order || "ALL";

    // 1. Check direct exact ISBN lookup first (0.005ms)
    const cleanIsbn = rawQuery.replace(/[-\s]/g, "");
    if (/^\d{9,13}$/.test(cleanIsbn) && this.isbnMap.has(cleanIsbn)) {
      let matches = this.isbnMap.get(cleanIsbn);
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

    // 2. Multi-token FlexSearch
    const searchRes = this.index.search(cleanQuery, {
      limit: limit * 2,
      enrich: true,
    });

    const seenIds = new Set();
    const matchedDocs = [];

    // Combine results from Title and ISBN fields
    if (searchRes && searchRes.length > 0) {
      for (const fieldRes of searchRes) {
        for (const item of fieldRes.result) {
          const doc = item.doc;
          if (doc && !seenIds.has(doc.id)) {
            seenIds.add(doc.id);
            if (filterOrder === "ALL" || String(doc.Order) === filterOrder) {
              matchedDocs.push(doc);
            }
          }
        }
      }
    }

    // 3. Fallback: Sub-string scanning if flexsearch returned few/no results
    if (matchedDocs.length === 0 && cleanQuery.length >= 2) {
      const tokens = cleanQuery.split(/\s+/).filter(Boolean);
      for (let i = 0; i < this.records.length; i++) {
        const doc = this.records[i];
        if (filterOrder !== "ALL" && String(doc.Order) !== filterOrder)
          continue;

        const titleLower = String(doc.Title || "").toLowerCase();
        let allTokensMatch = true;
        for (let t = 0; t < tokens.length; t++) {
          if (!titleLower.includes(tokens[t])) {
            allTokensMatch = false;
            break;
          }
        }

        if (allTokensMatch) {
          matchedDocs.push(doc);
          if (matchedDocs.length >= limit) break;
        }
      }
    }

    // Rank results: exact start of title / exact phrase higher
    matchedDocs.sort((a, b) => {
      const aTitle = String(a.Title || "").toLowerCase();
      const bTitle = String(b.Title || "").toLowerCase();
      const aStarts = aTitle.startsWith(cleanQuery) ? -1 : 0;
      const bStarts = bTitle.startsWith(cleanQuery) ? -1 : 0;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return 0;
    });

    const finalResults = matchedDocs.slice(0, limit);
    const endTime = performance.now();
    const latencyMs = +(endTime - startTime).toFixed(3);

    return {
      results: finalResults,
      latencyMs: latencyMs,
      totalMatches: matchedDocs.length,
    };
  }

  // Get total copies ordered for a given ISBN
  getCopiesForIsbn(isbn) {
    const clean = String(isbn || "").trim();
    return this.isbnMap.get(clean) || [];
  }
}

export const searchEngine = new BookSearchEngine();
