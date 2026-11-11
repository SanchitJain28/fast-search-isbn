# Book cover search implementation plan

## How it works

- Scan the barcode. If the app says **NOT FOUND**, open Cover Match.
- Take a photo of the front cover.
- Gemini turns the photo into a list of 1,536 numbers called an embedding.
- Qdrant compares it with the saved covers and returns the closest matches with their Master PO ISBNs.
- The app looks up the books and shows up to three choices with the next available box. Use title search when the cover results are weak.
- Confirm the book and box. The app checks the copy is still available and records it as packed.

## Starting point

Stage 1 is the barcode scan. Stage 2 is for books left over after that scan. Today, Cover Match asks Gemini to read the photo, checks a recognized ISBN, and searches by title when needed. The new front-cover flow searches by image first. The current photo lookup and typed search stay available. The Master PO lists the copies and boxes. SQLite tracks which copies are packed and saves each confirmation. Qdrant only helps identify the book. [Current flow and decisions](../PLAN.md) · [Current Cover Match release](../deploy/README.md#cover-match-release--7-november-2026)

| Data from the current files                                 |       Count |
| ----------------------------------------------------------- | ----------: |
| Master PO copy rows, including repeats                      |     165,306 |
| Different valid Master PO ISBNs                             |     156,469 |
| PO ISBNs with an exact ISBN and cover link                  |     100,505 |
| Additional PO ISBNs with an approved replacement cover link |       5,018 |
| **Starting set of cover links to check**                    | **105,523** |

The final number of embeddings may be lower after we check the images. Keep the remaining books available through the current title search. [Cover stats and ISBN counts](../PLAN.md#cover-stats)

## Phase 1 — Prepare the books, covers, and test images

### Match each cover to a book

1. Read the reconciled `public/master.json` used by the scanner, the approved Amazon edition list, and the Amazon scrape. Use the 7 November 2026 scrape listed in [PLAN.md](../PLAN.md). Record which Master, edition list, and scrape produced the cover list.
2. Validate and compare ISBNs using the existing ISBN helper. Convert valid ISBN-10 values to ISBN-13 for comparison. Keep the ISBN key used by the live Master for the packing lookup. Put unclear or conflicting mappings on a review list.
3. Prefer a usable cover from an exact ISBN match. If none is usable, take a cover from an approved replacement with the same PO ISBN in the live mapping. Keep both ISBNs for a replacement. A different Amazon ISBN without an approved link goes to review.
4. Start with **one cover per PO ISBN**. If one ISBN has five copies, keep all five rows in the Master PO and make one search record. Test extra approved covers for the same book later if the first cover often misses it.
5. Keep the Master title in its original script. Use a verified author from the Master or trusted metadata for that edition. Skip the author field when the sources disagree or the name is missing.

### Check the image files

The current scrape's 131,677 cover links all use `m.media-amazon.com`. Download from the known HTTPS image host. Set a download timeout and cap the file size. Check the host again after a redirect. Open the file as an image before accepting it. Keep its original shape when resizing. Save a hash of the image we send to Gemini so we can spot duplicates and tell when a cover changes.

| What we find                                                                                       | What to do                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Broken image**. The link fails or returns a file that cannot be opened as an image.              | Retry temporary errors. Record the reason if the cover still cannot be used.                                             |
| **Generic cover**. A placeholder such as a blank book icon or “No image available.”                | Skip the placeholder. A plain cover with the real title can still be useful.                                             |
| **Unconfirmed edition**. Amazon shows a different ISBN and the approved list has no matching link. | Put the ISBN pair on the review list.                                                                                    |
| **The same real cover is used for different ISBNs**.                                               | Keep the ISBNs separate. Flag the shared cover so the app can ask for review when the image cannot tell the books apart. |

Keep a cover list with the PO ISBN, Amazon ISBN when applicable, cover link, chosen title and author, image hash, and source. Keep a separate list of skipped or disputed covers. Report the counts of usable, broken, generic, shared, and unconfirmed covers.

### Start testing without old failed-scan photos

- Start with a small group of saved covers, including similar titles, different volumes, and books in different scripts. Make cropped, tilted, darkened, or blurred copies to use as test queries. Keep the original covers in Qdrant and use the changed copies as queries. These tests check the search code and give an early comparison.
- Add fresh photos of any physical books on hand, including books that scan correctly. Write down the correct PO ISBN by checking the actual book and Master. Include a few outside the PO and label them **no match**.
- Keep some books aside for the final check. Use different books from the ones used to pick settings. Collect real barcode failures during the one-station trial.

**Move on when** we have a checked starter cover list, a list of skipped covers, and test images with known answers. Old failed-scan photos are optional.

### Phase 1 result

Phase 1 is complete for the starter set. The ISBN join produced **104,209 candidates** after holding unclear Master records and known placeholder covers for review. We checked 48 PO books and kept **47 usable covers**. The starter set has **108 test images**, including 26 held back for the final check, 16 outside-PO queries, and two queries for a real cover shared by two ISBNs. These are modified Amazon images. Fresh packing-camera photos will test real search accuracy.

Use the outputs in [`data/cover-search/phase-1`](../data/cover-search/phase-1/).

| File               | What to use it for                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `candidates.jsonl` | The full list from the ISBN join. Its cover links still need image checks before the full load.                   |
| `covers.jsonl`     | The checked starter covers and image paths to use in Phase 2.                                                     |
| `queries.jsonl`    | Test image paths, expected PO ISBNs, and tuning or holdout groups. An empty ISBN list means no match is expected. |
| `review.jsonl`     | Covers and ISBN pairs that need review, with a reason for each.                                                   |
| `summary.json`     | Counts, source file paths, and hashes of the three inputs.                                                        |

To repeat the starter run, use Python 3.11 or newer with Pillow installed. Run the [preparation script](../scripts/prepare-cover-search.py) with a fresh output directory.

```sh
python3 scripts/prepare-cover-search.py \
  --scrape /Users/sanchitjain/vscode_files/book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl \
  --sample-size 48 \
  --output data/cover-search/phase-1-rerun
```

Leave out `--sample-size` to run just the ISBN join without image downloads.

## Phase 2 — Build and measure image search locally

### Define exactly what Gemini gets

Use `gemini-embedding-2` with an output size of **1,536**. One chunk is the front-cover image and the short text for the same book. Send them as parts of **one** regular `embedContent` request so Gemini returns one list of numbers. Send the JPEG or PNG image itself. Keep the title and author in a short text block. [Gemini embedding inputs](https://ai.google.dev/gemini-api/docs/embeddings?authuser=117)

Example of the text part when both fields are known

```text
Title: The Example Book
Author: Example Author
```

| Information                                                                                | Where it goes                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Front-cover image, Master title, verified author                                           | Send together to Gemini. Omit the author line if the name is uncertain.                                              |
| Subtitle, series, volume, or edition                                                       | Test one field at a time if needed. Use details verified on the cover. Keep a field only if it improves the results. |
| Master PO ISBN, approved Amazon ISBN, cover link, title, author, image hash, input version | Save beside the embedding in Qdrant. The app uses these fields to look up and explain the match.                     |
| Box, order quantity, and packed status                                                     | Read from the Master PO and SQLite when the app shows a result.                                                      |
| Price, stock, delivery, seller, reviews, page count, weight, dimensions                    | Leave out of the search inputs.                                                                                      |

For a live query, start with the cropped front-cover photo alone. Use the same model and 1,536-number output size. If similar books still cause trouble, test having Gemini read the title and author and send those words with the photo. Measure the extra time from that call.

### Save and query the records

- Create a local Qdrant collection for 1,536-number vectors using **cosine similarity**. This gives a score for how close the photo is to a saved cover. Use one stable record ID per PO ISBN for the first version so retrying a write updates the same record. Check that Gemini returned exactly 1,536 finite numbers before saving or querying.
- Keep the experimental collections separate for cover-only and cover plus text. Use a version for the model and image/text preparation so a change can be tested before replacing the current collection.
- Start by asking Qdrant for the top **10** matches. Group results by Master PO ISBN if more than one cover is saved for a book later. The app will show up to three choices. Save the score and rank in test results. Use the score to rank covers and use the test results to decide how to handle close matches. [Qdrant collections](https://qdrant.tech/documentation/manage-data/collections/)

### Compare the options

Run the same test photos against today's photo-to-title lookup, the cover-only collection, and the cover plus title and author collection. Give each version the same catalog and include similar books among the choices. Record whether the correct ISBN was first, was in the first three, or was missed. For books outside the PO, record whether the app correctly declined to suggest a match. Record wrong edition suggestions, fallback use, and seconds from photo to result.

Use the test to pick a minimum similarity score and how far the first result should be ahead of the second. A close pair, a shared cover, or text that disagrees should go to review. Try the chosen settings on the photos set aside earlier. Keep results from edited Amazon images separate from real camera results.

**Move on when** a local photo query returns the right ISBNs, both embedding setups have been compared, and there are clear rules for showing a match, asking for review, or falling back to title search. If only edited Amazon images are available, use them to continue development and check accuracy on real photos in Phase 5.

### Run the local benchmark

Use the [benchmark script](../scripts/benchmark-cover-vectors.mjs) from the project folder. It uses the Gemini key already set in the environment or `.env.local` and the current Cover Match vision model for the title baseline. Start the local Qdrant container once.

```sh
docker run -d --name isbn-cover-phase2-qdrant \
  -p 127.0.0.1:6335:6333 \
  -v isbn-cover-phase2-qdrant:/qdrant/storage \
  qdrant/qdrant:v1.17.0
node scripts/benchmark-cover-vectors.mjs
```

If the container already exists and is stopped, run `docker start isbn-cover-phase2-qdrant`. The benchmark reads the checked Phase 1 files by default and writes a [report](../data/cover-search/phase-2/report.json) with the result for each test image. It uses a disposable, empty packing database for the title lookup and the same 47 PO ISBNs for all three methods. A rerun can reuse successful Gemini calls saved in the local Phase 2 cache.

### Phase 2 result

The local benchmark ran all **108** test images through both Qdrant collections and today's title lookup. It used 82 images to set the rules and 26 held-out images to compare the results. Of the held-out images, 20 had a known book and six were outside the PO.

| Method                                  | Right book first | Right book in first three | Outside-PO images sent to fallback or no match | Median search time |
| --------------------------------------- | ---------------: | ------------------------: | ---------------------------------------------: | -----------------: |
| Current photo-to-title lookup           |            18/20 |                     20/20 |                                            6/6 |             4.81 s |
| Saved cover only                        |            20/20 |                     20/20 |                                            4/6 |             0.95 s |
| Saved cover, title, and verified author |            20/20 |                     20/20 |                                            6/6 |             0.95 s |

Both vector setups tied on the tuning images. Cover-only sent the other two outside-PO holdout images to manual review. Cover plus text sent all six to fallback, so use **cover plus title and verified author** for the saved books in Phase 3. Keep the query as the photo alone.

Start local integration with the measured cosine score floor of `0.623026` and a gap of `0.02219` between the top two results. Below the score floor, use the existing photo or title lookup. At or below the gap, or when the first result shares its cover with another ISBN, ask for review. These settings came from a small set of modified Amazon images. Recheck them with fresh packing-camera photos before wider use.

The times include Gemini and the lookup on the local test setup. They exclude camera capture and browser upload.

## Phase 3 — Connect image search to the existing Cover Match screen

### Route the photo and display the result

1. Use the existing **Cover Match** button from the scanner's **NOT FOUND** result. Reuse the current camera and photo upload. Keep the existing title and ISBN options.
2. Add a server setting for image search, off by default. On a front-cover lookup with the setting enabled, call Gemini Embedding 2 and Qdrant first. Give this part a short time limit so the old lookup still has time to run within the existing 20-second request deadline. Stop outstanding work if the browser cancels the request.
3. Send weak or empty results and service failures to the current photo lookup, which can read an ISBN or search by title. If Gemini is unavailable or time runs out, keep typed title and ISBN search available. Use the current lookup directly when an operator chooses to read an ISBN page.
4. Check returned ISBNs against the current Master and edition list. Rank the books before checking which copies are available. If the strongest match is fully packed, show it as already packed. Keep close matches in review rather than changing the order based on which boxes have copies left.
5. Show up to three choices with title, PO ISBN, and next available box where the app can safely find one. Label a result found by cover search and show when it needs review.

Start in the existing [Cover Match screen](../src/components/CoverMatch.jsx) and [lookup route](../server/cover-match/routes.js). Keep the current upload and confirmation APIs. Send camera photos to Gemini from the server and keep raw photos out of logs. Record the search method, elapsed time, result type, and fallback reason so we can check the trial.

### Keep the current packing rules

- Search only reads the packing state. The current confirmation step saves the pack. Use the existing signed confirmation token and recheck the catalog, exact copy, and box in the SQLite transaction.
- For an approved replacement found by cover, show the possible match and ask the worker to verify the replacement ISBN through the existing ISBN lookup before packing it. The confirmed ISBN must use the current mapping's box and quantity limit. Store a printed ISBN only when it was actually read from the book.
- If another station packs the copy first, show the refreshed choice and ask for a new confirmation. If the response is lost after saving, retry the same request ID and return the original result. Keep manual confirmation on for the new photo search.
- Use the same packing history and Sheets reporting flow. Try the changes first in the local Cover Match preview with its disposable database. [Existing Cover Match API and preview](../README.md#cover-lookup-api)

### Tests before deployment

| Case                                                           | Expected result                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Clear match with copies in two boxes                           | Show the next box from the current Master order. After confirming that copy, the next lookup shows the next box. |
| Approved Amazon edition                                        | Ask for ISBN verification, then keep the mapped box and quantity limit.                                          |
| Shared cover or two similar editions                           | Show a review choice. Packing requires confirmation of the book and box.                                         |
| Best match already packed                                      | Show it as already packed. Let the worker retry or open title search if they believe it is a different book.     |
| Missing cover, out-of-PO book, or weak scores                  | Try the old lookup and show no match if it also finds nothing.                                                   |
| Qdrant or embedding call fails or times out                    | Fall back to the current photo lookup when time allows. Keep typed search available.                             |
| Two stations pick the same copy, or confirmation reply is lost | One confirmation can claim the copy. A retry returns the saved result or refreshes a stale choice.               |
| Search is disabled                                             | The current photo, typed search, and barcode flows still work.                                                   |

**Move on when** these cases pass locally and each successful confirmation saves one packing record.

### Phase 3 result

Front-cover search is wired into Cover Match behind `COVER_VECTOR_SEARCH_ENABLED`. Choose **Front cover** to search by image or **ISBN page** to look up a printed ISBN. Image search and its photo fallback use manual confirmation. Replacement candidates show the mapped box and ask for the printed ISBN before confirmation.

With the Phase 2 Qdrant container running, start the disposable preview from the project folder.

```sh
COVER_VECTOR_SEARCH_ENABLED=true \
QDRANT_URL=http://127.0.0.1:6335 \
COVER_VECTOR_COLLECTION="$(node -p "require('./data/cover-search/phase-2/report.json').collections.cover_with_text")" \
npm run dev:cover
```

Open `http://localhost:3105/?tab=cover`. The preview uses a disposable packing database and the local approved Amazon edition list. The local API check used the live Gemini API and the 47-cover Qdrant collection. It found ISBN `9780757926068`, confirmed one copy for box `ZB344`, and returned the same saved result on retry. It also returned an Amazon replacement as a review choice that needed ISBN verification. All 69 app tests passed, including weak results, Qdrant failure and timeout, shared covers, and two stations confirming the same copy.

## Phase 4 — Load the checked covers on the VPS

### Set up Qdrant and run a timed sample

- Run Qdrant on the existing VPS with persistent disk storage and a private address reachable only by the server. Keep the Gemini and Qdrant keys on the server. Give the app read access and the loader write access. Keep Qdrant outside the public scanner site. [Qdrant self-hosting security](https://qdrant.tech/documentation/tutorials-operations/secure-qdrant/)
- Check the VPS memory, disk, and normal barcode scan time before loading. For 105,523 records, the 1,536 numbers alone take about **618 MiB** as 32-bit values. Allow additional space for the index, record details, images, and backups.
- Use regular Gemini API requests, one per usable cover. Start with **500–1,000** covers. Measure downloads, Gemini calls, Qdrant writes, retries, and the full time from cover link to saved record. Start with a few requests in parallel and increase gradually. Check the project's live request, input token, and daily limits in AI Studio. Leave room for the packing station's live requests. [Gemini API limits](https://ai.google.dev/gemini-api/docs/rate-limits?authuser=2)

|      Sustained speed | Approximate time for 105,523 books |
| -------------------: | ---------------------------------: |
| 100 books per minute |                       17 hr 35 min |
| 300 books per minute |                        5 hr 52 min |
| 600 books per minute |                        2 hr 56 min |

Use the measured **end-to-end** rate to estimate the full load. If a speed was measured for Gemini alone, allow time for downloads, Qdrant writes, and retries. Daily limits can spread the run over more than one day. These rates are examples and have not been measured on the project.

### Save progress and verify the load

1. Keep a progress list with the PO ISBN, a hash of what was sent to Gemini, status, retry count, and last error. Save a successful embedding locally until Qdrant confirms the write. Mark the record complete after that. If the write fails, retry the same record ID using the saved embedding.
2. Slow down on rate-limit errors and retry temporary download or service failures with a wait between attempts. Leave broken, generic, and disputed covers in the review list. Pause or slow the loader if barcode scans or live searches get slower.
3. Load into a versioned collection while the new production search is off. Check totals for checked, saved, skipped, and failed covers. Try sample queries, including a known replacement and a book outside the PO. Verify the collection uses the selected model settings and still links to the current Master.
4. Save a Qdrant snapshot and test restoring it separately. Keep the scanner's SQLite backup process in place. On future updates, make new embeddings only for covers or text that changed, or when the model or input format changes. Remove entries whose PO ISBN or approved edition link was removed. Test a replacement collection before pointing the scanner at it. [Qdrant snapshots](https://qdrant.tech/documentation/operations/snapshots/)

Keep the Qdrant address, collection name, and feature setting in the server's environment. Record which Master and approved edition list were used for the load. If the saved collection is out of date, use the existing lookup until the new collection is checked. Keep loader files and image caches separate from the scanner's live SQLite database. [Existing VPS layout](../deploy/README.md#layout)

**Move on when** the checked covers can be searched on the VPS, an interrupted load resumes without duplicate records, and barcode scans stay within their normal range.

### Phase 4 deployment and timing

The cover list was rebuilt against the live Master and approved edition file. It has **104,233 candidate ISBNs** before checking image files. Qdrant runs on the VPS at `127.0.0.1:6335`, with a persistent Docker volume and separate read and write keys. The loader uses its own SQLite progress file and the existing Gemini configuration. The scanner keeps using its current lookup during the load.

The sample resumed from **388 saved covers**. It finished with **998 usable covers out of 1,000** and two skips. The second pass saved 610 new covers in about 66 seconds, or **558 per minute**. The exact and approved replacement probes both returned the expected ISBN first. A separate restore returned all 998 points from the sample snapshot.

The outside-PO probe scored **0.6247** in the larger sample, above the **0.623026** cutoff from the 47-cover local test. The full index should be checked with more outside-PO photos before any station uses the image search. The loader stages the collection with image search off after verification.

We also compared Master titles, scraped Amazon titles, and both titles on the same 47 local covers. The titles differed on 32 covers. With each setup's rules chosen using the tuning images, all three ranked the right ISBN first on **20/20** known-book holdout images and sent **6/6** outside-PO images to fallback. The VPS load uses the Master title. Fresh station photos and the full index will give us a better test for similar editions. [Title comparison report](../data/cover-search/phase-4-results/title-comparison.json)

During the full load, the live Master added 105 copy rows. The loader stopped with **56,594 saved covers** in the first collection, `isbn_covers_6b50deff800f8a50`. The existing ISBNs, orders, titles, and authors stayed the same. Rebuilding the list against the updated Master produced the same 104,233 cover records.

The full VPS job is `fast-search-cover-load.service`. It resumed into `isbn_covers_84aeed43cc65e6bc` for the updated Master and reuses saved vectors for identical records. On a successful finish it checks the Master and edition file again, tests search with the read-only key, saves a snapshot and checks the restored count, then writes the disabled collection settings for the scanner.

The loader reused all **56,594** earlier embeddings and resumed with the new Gemini key after the old key ran out of prepaid credit. It finished with **104,093 saved**, **140 skipped** because the cover was unusable, and **0 pending**. The exact and replacement search checks returned the expected ISBNs. Restoring the snapshot recovered all **104,093** points. [Recovery report](../data/cover-search/phase-4-results/recovered-progress.json)

```sh
systemctl status fast-search-cover-load
journalctl -u fast-search-cover-load -n 15 --no-pager -o cat
```

The [VPS runbook](../deploy/README.md#cover-vector-index) has the loader and resume commands.

## Phase 5 — Try one station, then turn it on more widely

1. Enable image search for one packing station with the server setting. Keep all stations on the same packing server. The existing scanner login still controls access.
2. Use fresh photos of real barcode failures as they occur. Record the correct PO ISBN and box after checking the book and Master. For each case, compare the current title search and the new search on the same photo without creating two packing records.
3. Track whether the correct ISBN is first or in the first three, whether the next box is right, how often title search is needed, and how long a result takes. Keep a separate count of wrong suggestions, no-match cases, operator corrections, and wrong boxes actually confirmed. Review shared covers and similar editions by hand.
4. Expand to other stations after reviewing the results. If a wrong box is confirmed, repeated suggestions point to the wrong edition, or barcode scanning slows down, switch off image search and return to the current Cover Match lookup. Keep the Qdrant collection and test results for diagnosis.

**Roll out to more stations when** the new search finds the right book at least as often as title search on the same real test cases, staff are happy with the wait time, and the trial has no observed wrong-box confirmations. Keep manual confirmation during rollout.

### Production pilot and all-station rollout

- Vector search is now enabled across **all stations** (`COVER_VECTOR_PILOT_STATION` removed after the pilot on **Station-18dd0b** / A1-154, first floor). Reload the scanner on any station and open **Cover Match → Vector** for front-cover similarity, or **Title** for OCR and typed title or ISBN lookup.
- The full index put the right ISBN first on all 20 prepared holdout photos for known books. A pilot score floor of **0.70** lets 19 of those 20 through and keeps all 16 prepared outside-PO photos below the cutoff. The score gap stays **0.02219**. The station trial still needs fresh camera photos.
- The selected tab runs one method. When similarity is below the cutoff, **Closest vector results** shows up to three suggestions with covers and scores. Choose **Search this photo by title** to open the Title tab and run OCR on the same photo. Title-only suggestions from this action require ISBN verification before packing.
- For each real trial case, write down the verified PO ISBN and box, both methods' suggestions and wait times, and what the operator did. Track wrong suggestions separately from wrong boxes actually confirmed. The browser keeps the latest 100 observations, including the top vector ISBNs, search outcome, and any confirmation. It keeps the vector photo in memory while the option to search it by title is available.
- To pause the pilot, set `COVER_VECTOR_SEARCH_ENABLED=false` and restart the scanner service. The [VPS runbook](../deploy/README.md#cover-vector-index) covers the production settings and rollback.
