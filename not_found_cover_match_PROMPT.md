# Build: AI Cover-Match "Not-Found" Clearing System (Delhi Book Market)

Build a web feature that clears the "not found" pile in our book-packing operation using an overhead document camera + vision AI, instead of a human reading Amazon Lens and retyping titles.

## 1. Business context (read first)

We pack incoming mixed books into customer orders. Each book's barcode (ISBN-13) is scanned and matched to a **Master** list that says which **order/box** it belongs to. Most books scan fine. This feature is ONLY for the **"not found" pile** — books whose scanned ISBN is not in the Master.

Breakdown of the not-found pile (from us):
- **80–85%**: the *same book* we ordered but a **different edition → different ISBN**. The printed ISBN is useless; they must be matched by **title + author**.
- **~10%**: no barcode on the back; ISBN is printed on an inside page.
- **~5%**: ISBN-10 printed (must convert to ISBN-13 before lookup).
- **~5%**: duplicates we set aside.

So the core of this system is **title + author matching against the Master**, with ISBN as a secondary path.

## 2. Goal / worker flow

1. Worker places a book under the overhead camera (front cover up). For the ~10% ISBN-inside cases, they instead show the page with the printed ISBN.
2. System **auto-captures** when a book is placed and the frame holds still (~0.5s). Also support a manual trigger (button / optional USB foot pedal).
3. Vision AI reads the image → title, author, and any visible ISBN.
4. System matches against the Master → best candidate(s) with their **order/box** and a confidence %.
5. If the match is **unambiguous and high-confidence → auto-pack**. Otherwise show the **top 2–3 candidates** for a **one-tap** confirm.
6. On confirm/auto-pack, mark the book **packed** against that order, using the same multi-order rules as our barcode scanner.

## 3. Hardware

THUSTAND KB-700 USB document camera (8MP, autofocus, built-in ring light), overhead arm pointing down at a fixed A4/A3 capture area. It appears as a normal USB webcam; capture via the browser (`getUserMedia`). Use the ring light; if glossy covers glare, the capture page should let the worker dim it or we angle it.

## 4. The Master data (we will provide the file)

A spreadsheet/export with these columns, ~165,000 rows and growing:
- `Order` — the box/order code (e.g. 317, ZB344, ZBPREP-3, ZBW-2, SEA-1, ZB346B). This is the answer we need to show.
- `ISBN13` — 13-digit ISBN (text).
- `Title` — book title. **May be English, romanized-with-diacritics (e.g. "Latā dīdī"), or native script (Devanagari, Tamil, Malayalam, Bengali). ~4,000 titles are in native script.**
- `Qty` — always 1 per row.
- There is **no reliable Author column** in the Master — many rows have no author. Do not depend on author being present in the Master; use it only when available.

### Multi-order semantics (critical — same as our barcode system)
The same ISBN/title can appear in **several orders** (we counted: ~10.6% of all copies share a title with a *different* order; books appear in up to **4** orders). Each occurrence is a separate physical copy that must go to a different box. Rule:
- The **Nth time** a given book is packed → it goes to the **Nth order** in Master row order (copy 1 → first order, copy 2 → second, …).
- Once all its copies across all orders are packed, any further scan is a **DUPLICATE** (set aside).
- Track packed state **per (ISBN, order)**.

## 5. Pipeline — implement these stages

### Stage A — Capture (frontend)
- Browser webcam page. Auto-capture on frame stability (motion settles), plus manual button + optional foot-pedal (USB foot pedals act as a keypress — bind a key).
- Do not move focus/cursor on capture (we had cursor-jump bugs before — avoid any focus stealing).
- Send the captured frame to the backend.

### Stage B — Vision extraction (backend → vision model)
Send the image to a vision-capable model (Claude via the Anthropic API is fine; Gemini / GPT-4o vision also work). Ask it to return **strict JSON**:
```json
{
  "title_as_printed": "",
  "author": "",            // "" if none visible
  "native_title": "",      // if cover is non-Latin script, the title in that script; else ""
  "romanized_title": "",   // romanization of native_title; else ""
  "english_title": "",     // English translation if applicable; else ""
  "isbn_text": ""          // any ISBN digits visibly printed in the image (10 or 13 digit); else ""
}
```
This replaces Amazon Lens: the model reads English **and** regional covers (Tamil/Malayalam/Marathi/Bengali) and gives native + romanized + English forms. Keep the vision prompt strict ("return only JSON, no commentary").

### Stage C — ISBN path (try first when an ISBN is present)
- If `isbn_text` has an ISBN: strip non-digits.
- **If 10 digits → convert to ISBN-13** (algorithm below), then exact-lookup in Master. If found → strong match, go to Stage F with that candidate.
- If 13 digits → exact-lookup. If found → candidate.
- If not found by ISBN, fall through to title matching (this is the common 80–85% case).

**ISBN-10 → ISBN-13 conversion:** take the first 9 digits of the ISBN-10, prepend `978`, then compute the ISBN-13 check digit: sum = Σ(digit × (1,3,1,3,…)) over the first 12 digits; check = (10 − (sum mod 10)) mod 10; append.

### Stage D — Title + author matching (the core)
Build this once at startup over the Master, in memory.

**Normalization — produce, for every Master title AND every query form, two keys:**
1. **Unicode key** (keeps native script): NFKC normalize, lowercase, keep only Unicode letters/numbers (`category L*`/`N*`), collapse whitespace. (This lets a Devanagari cover match a Devanagari Master title directly.)
2. **Phonetic Latin key** (bridges scripts & spellings): romanize ANY script to Latin (use a transliterator such as `unidecode`), lowercase, strip non-`[a-z0-9 ]`, then collapse common romanization variants to one skeleton, then collapse repeated letters. Variant collapses we verified work:
   `aa→a, ee→i, ii→i, oo→u, uu→u, ou→u, au→u, w→v, sh→s, shh→s, ss→s, chh→c, ch→c, ck→k, kh→k, gh→g, th→t, dh→d, ph→f, bh→b, z→j, y→i`, then collapse any run of the same char to one.
   (This is what makes a typed "Sri Hari Krishna" match Devanagari "श्री हरि कृष्ण" — it went from 13% to ~89% in our tests; "Govinda"→"गोविन्द" 0%→92%.)

**Matching:** for each query form the vision model returned (`title_as_printed`, `native_title`, `romanized_title`, `english_title`), score it against the Master using a fuzzy ratio that is tolerant to extra/reordered words — **token-set ratio** (RapidFuzz `token_set_ratio` or equivalent). Match the Unicode key against Master Unicode keys, and the phonetic key against Master phonetic keys. **Take the best score across all forms and both keys.**
- Use **author** as a tiebreaker only: when two Master candidates score similarly and the cover author matches one, prefer it. Never require author (Master often lacks it).

**Performance:** 165k titles is large. Pre-normalize and index at load. Pure JS fuzzy over 165k per query is slow — either (a) use a prebuilt inverted index on tokens to shortlist, then score the shortlist, or (b) run the matcher as a small **Python microservice using RapidFuzz** (very fast at this size, ~100–200 ms/query in our tests) that Node calls. Either is fine; just keep each lookup well under ~1 second.

### Stage E — Packing-state disambiguation (handles no-author & duplicate-title books)
A title often matches several Master rows across different orders. Resolve using **what still needs packing**:
- Gather all Master candidates above a score floor.
- For each, compute **remaining = (copies ordered in that order) − (copies already packed in that order)**.
- Drop candidates with remaining = 0 (that order's copy is already packed).
- If exactly **one** order still needs the book → that's the answer (auto-eligible).
- If **two+** orders still need it → cannot auto-decide; show them as candidates.

### Stage F — Decision & write-back
**Auto-pack only when ALL of these hold** (otherwise show top 2–3 for one-tap confirm):
- top candidate score ≥ **AUTO_THRESHOLD** (default 90), and clearly ahead of the 2nd (gap ≥ **GAP_MIN**, default 8), and
- after Stage E, exactly **one** order still needs the book, and
- if the cover shows an author and the Master candidate has one, they don't contradict.
(Reason for the guardrail: ~10.6% of books share a title across orders, so title-only auto-pack would misroute ~1 in 10 — unacceptable for export cartons. ISBN-exact matches from Stage C can auto-pack more freely.)

On confirm/auto-pack: **mark packed** against the chosen (ISBN, order), applying the Nth-copy → Nth-order rule and DUPLICATE guard. Then clear the frame and go back to capture.

## 6. Tech stack & integration

- Backend: **Node.js** (our site is Node). Expose a REST endpoint, e.g. `POST /api/cover-match` (multipart image) → `{ candidates: [{ order, isbn, title, score, remaining }], autoPack: {order, isbn} | null, extracted: {...vision JSON...} }`.
- `POST /api/mark-packed` `{ isbn, order }` → applies the copy/duplicate rules and writes packed state.
- **We mark packed in two places**: the **Google Sheet via API** and our **own database**. Write to whichever we designate as source of truth (make it a config flag; implement a clean adapter interface `packStore` with `getPackedState(isbn)` and `markPacked(isbn, order)` so we can point it at the Sheet API, our DB, or both).
- Vision: pluggable `visionProvider` (default Anthropic Claude vision); API key from env.
- Frontend: a capture page (webcam + auto-capture + candidate cards with big tap targets + confirm button). Mobile-friendly (we may run the capture on a phone browser too).
- Config file: thresholds (`AUTO_THRESHOLD`, `GAP_MIN`, score floor), vision provider/key, packStore target, Master file path.

## 7. Deliverables

1. `matcher` module: Master loader + both normalization keys + phonetic collapse + token-set scoring + packing-state disambiguation. Unit-tested.
2. `vision` wrapper: image → strict JSON (with the prompt above).
3. `isbn` util: ISBN-10→13 conversion + exact lookup.
4. REST endpoints `/api/cover-match` and `/api/mark-packed`.
5. `packStore` adapter (Google Sheet API + our DB), behind a config flag.
6. Capture frontend (webcam, auto-capture on stability, foot-pedal key, candidate UI, confirm/auto-pack).
7. README: how to load the Master file, set env/keys, run, and the config knobs.

## 8. Test cases to include (we verified these)

- English different-edition: typed/vision title with noise + a bogus "3rd edition" suffix still matches the right Master row (token-set handles extra words).
- Multi-order: a book in orders A and B → 1st pack → A (copy 1 of 2), 2nd → B (copy 2 of 2), 3rd → DUPLICATE.
- Regional native-to-native: a Devanagari/Malayalam cover matches its native-script Master row at 90%+.
- Cross-script: Latin "Sri Hari Krishna" matches Devanagari "श्री हरि कृष्ण" (≈89% with phonetic key; ~13% without — must pass).
- Ambiguous: a title shared by two still-unpacked orders → NOT auto-packed; returns both candidates.
- ISBN-10 on an inside page → converts to ISBN-13 → exact match.

## 9. Notes / guardrails
- Never auto-pack on a title-only match that is ambiguous across orders — show candidates.
- Nothing is 100%; when the model can't read a cover or confidence is low, show "no confident match — pick manually" with a search box fallback (the phonetic normalizer should power that search box too, so typed regional queries work).
- Keep each lookup < ~1s; pre-index the Master at startup; reload the index when the Master file changes.
