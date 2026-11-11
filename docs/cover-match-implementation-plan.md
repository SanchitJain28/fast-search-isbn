# Cover Match implementation plan

Add a **Cover Match** tab for books left over after barcode scanning. A worker shows the cover or inside ISBN page to the camera. The app identifies likely Master entries, shows the next eligible box, and records the result through the existing packing system. The first live release uses one-tap confirmation. Auto-pack follows a measured pilot.

Requirements come from the [cover-matching prompt](../not_found_cover_match_PROMPT.md). Each phase ends with an exit check that we can review before starting the next phase.

## Stack and dependencies

| Layer | Choice |
| --- | --- |
| Camera and UI | Existing React 19, Vite, and Material UI. Use browser `getUserMedia`, Canvas, and keyboard events for the capture button and optional USB pedal. |
| Vision | Gemini 3.8 Flash (`gemini-3.8-flash`) via the Node SDK `@google/genai`. Use the existing Gemini API key as a server environment variable. Keep the provider and model configurable. [Gemini model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| App API | Existing Node.js 22 HTTP middleware. Add `busboy` for bounded multipart uploads and `zod` for request and response validation. |
| Title matcher | JavaScript in a persistent `node:worker_threads` worker. Add `fuzzball` for token-set scoring and `@indic-transliteration/sanscript` for regional transliteration. [Fuzzball](https://github.com/nol13/fuzzball.js) · [Sanscript](https://github.com/indic-transliteration/sanscript.js) |
| Catalog and packing | Reuse `xlsx` for import, `node:sqlite` for allocation, and `googleapis` for the existing Sheets reporting queue. |
| Pilot options | OpenCV.js if the camera needs stronger blur detection, page-edge detection, or perspective correction. Python with RapidFuzz and PyICU is a later matcher comparison using the same test cases. |

SQLite stays authoritative for all stations. The `packStore` interface will expose packed state and confirmation through the existing allocator. The existing reporting flag selects SQLite only or SQLite with a Google Sheets mirror. Making Sheets authoritative would require a separate migration for both barcode and cover packing.

## Phase 1 — Repair the catalog and prepare test data

- Fix UTF-8 decoding in [the Master import](../scripts/update-master.mjs). The previous importer garbled Devanagari, Tamil, Malayalam, and Bengali characters. The corrected import restores 3,764 titles containing those scripts while preserving every ISBN and order at its original row position.
- Generate a candidate catalog separately. Validate it using [the existing reconciliation script](../scripts/update-catalog.mjs) and a test database. Preserve row positions, packing history, and the mapping to Google Sheets. Node and its matcher must use the same approved catalog version.
- Preserve a supplied `Author` column as optional catalog metadata. The 5 November CSV has no author column. The [offline Amazon importer](../scripts/consolidate-amazon-metadata.py) builds a SQLite metadata archive and enriches a candidate Master using exact ISBN matches. It leaves conflicting or ambiguous author data blank. Use author agreement as supporting evidence during matching.
- Start from the [catalog-backed test cases](../tests/fixtures/cover-match-cases.json). They cover noisy editions, regional titles, diacritics, shared titles, copy order, duplicates, missing text, and ISBN-10. Add real camera captures and more short-title and volume-number cases during the matcher and vision phases.

**Exit check:** The candidate catalog preserves all 165,306 ISBN/order positions from the current snapshot. Tests verify that regional characters survive import and existing allocations still point to the same copies. A labeled set is ready for matcher testing.

**Phase 1 complete.** Use `data/amazon-metadata/master-with-authors.json` as the Phase 2 benchmark catalog. It retains all 165,306 ISBN, order, and quantity values in row order and has authors for 87,202 rows (52.8%). Coverage details are in `data/amazon-metadata/coverage.json`. The labeled ISBNs and order assignments were checked against the candidate. Applying reconciliation in a disposable database preserved scan history, active allocations, and Sheets reporting metadata. The next scan went to the next box and the following scan returned **DUPLICATE**. All five import and reconciliation tests passed.

For deployment, reconcile and publish this candidate using the existing catalog update process. When building the UI from a reconciled enriched catalog, run `npx vite build` directly so the build uses the selected catalog artifact.

## Phase 2 — Build and benchmark the JavaScript matcher

- Build an index once per catalog version in a persistent Node worker. Keep catalog row positions and ISBN identities available after deduplicating normalized title keys for scoring. Rebuild on an approved catalog update and reject stale catalog versions at confirmation.
- Generate a Unicode key with NFKC normalization, case folding, punctuation handling, and preservation of Indic vowel signs and other combining marks. Generate a second key by transliterating regional text, folding Latin diacritics, and applying the agreed phonetic rules. Test mixed-script titles and cross-script examples such as `Sri Hari Krishna` and `श्री हरि कृष्ण`.
- Use exact normalized keys and token postings to retrieve candidates. Include a broader fallback for spelling differences and queries with weak token overlap. Run Fuzzball on the query forms and matching key types, keeping the best score per catalog identity and the evidence behind it. Preserve enough candidates to detect ambiguity before limiting the UI to three cards.
- Benchmark warm lookup p50 and p95 on the VPS using the corrected full Master. Compare the shortlist with a broader search on labeled cases and measure correct-book top-three recall, missed ambiguity, and barcode responsiveness under concurrent load.

**Exit check:** Matcher p95 is under one second on the VPS, the required title fixtures find the expected book, and labeled ambiguous cases stay eligible for review. Record the baseline. If JavaScript misses the target, tune the index first. Later, compare RapidFuzz and PyICU on the same catalog and extracted text before deciding whether to change implementations.

The matcher is available through `openCoverMatcher` in [the worker client](../server/cover-match/worker.js). Pass the packing store's catalog hash as `expectedCatalogVersion` when wiring the worker into the app. Opening the worker builds a fresh index for that version. A result returns ranked ISBN identities, copy positions, title and author evidence, and review reasons. Availability and authorization to pack are evaluated by the packing layer.

Run the full-catalog benchmark with `node scripts/benchmark-cover-matcher.mjs data/amazon-metadata/master-with-authors.json --exhaustive`. The local baseline on Node 22.17 was **12.69 ms p50 and 51.26 ms p95** over 200 warm lookups, with batches of five and concurrent simulated barcode transactions. The matcher found all five labeled titles in the top three. The indexed search retained all close competitors found by exhaustive search in this fixture set. Worker startup took 1.69 seconds, and the benchmark process RSS increased by about 604 MiB under load. The VPS benchmark is deferred.

## Phase 3 — Add Gemini extraction and read-only lookup

- Implement `visionProvider.extract(image)` using server-side `@google/genai` and a schema for `title_as_printed`, `author`, `native_title`, `romanized_title`, `english_title`, and `isbn_text`. Use empty strings for missing fields and validate the response. Send only the captured image to Gemini. Keep credentials and raw captures out of logs.
- Implement authenticated, same-origin `POST /api/cover-match` with a single bounded image upload, format checks, a deadline, and a concurrency limit. Return extracted fields, ranked candidates, the catalog version, and whether the server considers the result eligible for auto-pack. Add a read-only typed search using the same matcher.
- Validate the checksum of visibly printed ISBNs. Preserve terminal `X` for ISBN-10 and convert valid ISBN-10s to ISBN-13. Try the exact Master identity first, then an eligible known edition mapping. Reuse the working tree’s existing Amazon edition mappings and quotas. Route conflicting mappings to review. If an identified ISBN or mapping is exhausted, return **DUPLICATE** instead of assigning a similar title. Use title search when the ISBN yields no known identity.
- Measure Gemini extraction accuracy, latency, and cost using real regional covers, glossy jackets, and small-print ISBN pages. Save representative validated extraction results for repeatable matcher tests.

**Exit check:** A valid inside-page ISBN reaches the exact lookup path. A readable different-edition cover reaches the correct title shortlist. Invalid uploads, unavailable Gemini, unreadable images, and mapping conflicts have tested outcomes and consume no allocation.

**Local verification:** The image and typed routes are implemented behind `COVER_MATCH_ENABLED`. The authenticated HTTP tests use a mocked Gemini response and verify exact ISBN, title fallback, existing edition rules, upload rejection, provider failures, and unchanged packing state. The remaining live check is to configure `GEMINI_API_KEY` and run labeled cover and inside-page photos through Gemini to measure extraction accuracy, latency, and usage. See the [API setup](../README.md#cover-lookup-api).

## Phase 4 — Connect confirmation to the existing packing store

- Add authenticated `POST /api/mark-packed` with a request ID, station, catalog version, and selected candidate or equivalent server-verifiable reference. Keep any printed ISBN separate from the Master ISBN used to allocate the book. For a confirmed edition mapping, retain the existing box and quantity rules.
- Group matches by Master ISBN and show the remaining quantity for each order. For ordinary copies of one ISBN, surface the earliest available Master row as the next eligible box. When two orders remain for a title match, show both for context and require confirmation of the next eligible box. Choosing a different Master ISBN is a separate identification decision.
- Recheck the next copy and expected box inside the SQLite transaction. A stale candidate returns a conflict with refreshed choices. Retry the same request ID after a lost reply and recover through the existing scan lookup and live events. A confirmed cover pack creates one normal history entry, queued for the same Google Sheets report if enabled.
- Add tests for mixed barcode and cover scans, two stations racing for the same copy, retries after a lost response, a book with several orders, exhausted copies, an Amazon mapping conflict or quota, and a Sheets outage. Preserve compatibility with scan history, correction, and voiding.

**Exit check:** A book in orders A and B packs into A, then B, then returns **DUPLICATE**. Two stations cannot consume the same copy or silently switch a confirmed box. Retries return the original result and Sheets reporting uses the existing queue.

**Phase 4 verified locally.** Confirmable candidates carry a 15-minute signed selection bound to the next available catalog copy and box. SQLite rechecks both in the allocation transaction. Stale selections return refreshed choices for a separate confirmation. Saved request IDs remain recoverable after a restart or lost response. The confirmation tests exercised competing cover and barcode requests, duplicate handling, Amazon quotas, correction, voiding, and retry through a simulated Sheets outage. The camera tab can use `PackingManager.confirmCover(candidate, catalogVersion)` with the same pending-request storage and live events as barcode scans.

## Phase 5 — Build the camera tab and run a confirmation pilot

- Add a Cover Match tab and a way to open it from a **NOT FOUND** result. Provide camera selection, a capture guide, a manual button, and a configurable foot-pedal key. Keep keyboard focus where the worker left it and ignore the pedal shortcut while typing.
- Use a small Canvas preview to detect a book entering and settling for about 0.5 seconds. Upload one cropped still at a resolution that preserves small ISBN print. Keep one lookup or pack confirmation in flight and wait for the book to leave before rearming automatic capture. Offer a deliberate retake.
- Show two or three candidate cards with title, ISBN, next eligible box, and match score. Provide manual search for weak results. Show a large box instruction after the server confirms a pack.
- Pilot on one station with the KB-700 and production-style HTTPS. Check permission prompts, mobile layout, glare, focus, double triggers, and USB pedal use. Test camera angle and lighting first for glossy covers. Add OpenCV.js only if the pilot identifies a capture problem it can address.

**Exit check:** A worker can clear a test pile from capture through confirmed packing without leaving the tab. A stationary book triggers only once, and an unconfirmed pack can be recovered after a reload. The pilot runs with one-tap confirmation and records what would have auto-packed.

**Local pilot:** `npm run dev:cover` starts a disposable preview at `http://localhost:3105/?tab=cover` with Sheets sync off. Chrome displayed the connected USB camera, a camera capture reached the local API, and typed lookup followed by box confirmation succeeded in the browser. Calibration clears the previous lookup so it can rearm after a failed image request. Detector tests cover stability, removal, low contrast, and pedal focus behavior. Live Gemini extraction still requires the server key. See the [local camera instructions](../README.md#try-cover-match-on-a-connected-camera).

## Phase 6 — Validate and release auto-pack

- Review pilot outcomes by source, including exact ISBN, known edition, and title match. Record correct-box rate, operator corrections, missed ambiguity, capture-to-result latency, and Gemini usage. Enable verified exact Master ISBN auto-pack first after review. Keep known edition mappings under their existing constraints and validate them separately before enabling their auto-pack.
- For title auto-pack, start with `AUTO_THRESHOLD=90` and `GAP_MIN=8` and tune the candidate score floor on labeled results. Require one clearly identified Master ISBN and one remaining order across credible matches. Keep short or subset-only matches, translation-only evidence, known author contradictions, and unresolved ISBN or order ambiguity in review. Assess identity ambiguity before removing exhausted candidates so an exhausted strong match cannot make a weak match look safe.
- Gate cover matching and auto-pack with separate server flags. Document `GEMINI_API_KEY`, provider and model, the Master path, score settings, pedal configuration, and `SHEETS_SYNC_ENABLED`. Document how to rebuild after a catalog update, diagnose provider failures, and switch back to confirmation mode.

**Exit check:** The labeled and pilot cases approved for auto-pack show no observed wrong-box decisions. Known ambiguous cases remain in review. Operators can disable auto-pack while continuing confirmation-based cover matching.

`COVER_MATCH_AUTO_PACK` defaults to `off`. Set it to `isbn` after validating exact printed ISBNs, then to `all` after validating title matches separately. The local operator reported that live cover lookup is working. This confirms the camera-to-Gemini path, while a labeled batch is still needed to measure wrong-box decisions before enabling automatic confirmation. The first production release is planned in manual confirmation mode.

The VPS benchmark returned a 150 ms p95 across 200 concurrent indexed lookups. It found all five labeled titles in the top three and retained every close competitor found by exhaustive search on these fixtures. A local Gemini smoke test read the synthetic printed ISBN `9780700702008` and matched box `317`.

The release is live in manual confirmation mode with authenticated title, ISBN, and photo lookup. The production photo smoke test read the synthetic printed ISBN `9780700702008` and returned `DUPLICATE` over HTTPS. See the [production release notes](../deploy/README.md#cover-match-release--7-november-2026).
