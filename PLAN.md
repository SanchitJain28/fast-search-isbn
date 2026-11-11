--- Don't edit this

### Search system

- /Users/sanchitjain/vscode_files/book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl
  Please refer to this file

- I want to implement a system where the user will capture image and it will return the correct result for the image
- I want to make embedding for each book file
- The structure for each book from amazon scraping is like this

{
"searched_isbn": "9789500714006",
"cover_url": "https://m.media-amazon.com/images/I/410tpUESQLL.jpg",
"asin": "9500714000",
"isbn_10": "9500714000",
"isbn_13": "9789500714006",
"language": "Spanish",
"pages": 280,
"item_weight": "249 g",
"dimensions": "19.3 x 12.7 x 1.52 cm",
"binding": "Paperback",
"found": true,
"in_stock": false,
"stock_status": "Out of Stock",
"title": "La Gerencia Efectiva: Tareas Economicas y Decisiones Arriesgadas",
"found_isbn": "9789500714006",
"price": "N/A",
"mrp": "N/A",
"delivery": "N/A",
"seller": "N/A",
"author": null,
"used_available": "No Used Options",
"reviews_count": "30",
"publisher": "N/A",
"publication_date": "N/A",
"isbn_matched": true,
"url": "https://www.amazon.in/Gerencia-Efectiva-Economicas-Decisiones-Arriesgadas/dp/9500714000/ref=sr_1_1?dib=eyJ2IjoiMSJ9.yHsTlK95rbyWlpG09oaF6w.ZuVp484sqfaPgopd63HVq8_pyNz4_PxtHMK-qkr5CXM&dib_tag=se&keywords=9789500714006&qid=1794199945&sr=8-1",
"scraped_at": "2026-11-09T04:52:28.692Z"
}

- I want to add image + title + author in the embedding for best search results , but i am confused whether what other should i add for best search results , i want your help in this

- We will be using this multimodal embedding modal : gemini-embedding-2 at 1536 dimensions vector
- We will be using quadrant vector database , we will be self hosting this database on the existing vps on which our current fast search isbn is deployed

-- Please make a plan here , a concise plan here , then we will make detailed plan , add any questions here , if you have here only

- Before this analyse this project specially the image search tab and the master PO file please

-- Some questions from me 
1. How will the embedding map it to a book ? like suppose we got 10 recommendation then how other information will be stored like to which box this book belong and other things ? 

## How scanning works

- We scan the book by isbn , now we get a message that "NOT FOUND" , means this isbn is not in the PO file / Master file , now we search through title , ex : "computer science book" now we get recommendations , on matching book then mark the matching book as packed

- Now instead of searching title , we search the image , and we get recommendations , then we mark it as packed

---

# Book cover search

Stage 1 is the barcode scan. Stage 2 is for books that did not match in Stage 1. In Stage 2, take a photo of the front cover and search by image first. Use title search as a backup.

## How a match leads to a box

Gemini turns each book cover, title, and author into a list of numbers called an embedding. Qdrant saves those numbers with the book's Master PO ISBN. We can also save the title, author, and cover link beside the numbers so we can show them on screen.

If Qdrant returns 10 results, each result gives the app a Master PO ISBN. Think of it as a lookup key. Qdrant finds the book, the Master PO lists its boxes, and SQLite tells us which copies are already packed. For example, if a book has one copy for Box A and one for Box B, and Box A's copy is packed, the app shows Box B. When you confirm, it checks again in case another station just packed that copy. If the result is an approved replacement edition, the app uses that edition's existing box and quantity rules.

## Current app and data

- Today, Gemini reads the ISBN, title, and author from the photo. The app checks the ISBN first. If it cannot find the book by ISBN, it searches by title. A person confirms the box before the app records it as packed. [Cover Match code](src/components/CoverMatch.jsx) · [Lookup code](server/cover-match/lookup.js) · [Deployment notes](deploy/README.md#cover-match-release--7-november-2026)
- The Master PO has 165,306 copy rows and 156,469 different valid ISBNs. Some ISBNs appear more than once because we ordered more than one copy. The local copy with added author names has an author on 87,202 rows. [Master PO](master-5th-nov.csv) · [Master with authors](data/amazon-metadata/master-with-authors.json)
- The Amazon file has 165,306 rows. The searched ISBNs match the Master PO, including repeated copies. See [Cover stats](#cover-stats) for the ISBN and cover breakdown. [Amazon file](../book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl)

## Plan

1. **Make one Qdrant record for each ISBN with a usable cover.**

- Please explain in simple langauge , i didn't understnad
  > If the same ISBN appears five times in the Master PO, make one Qdrant record for its cover and keep all five copy rows in the Master PO. Start with covers from the same ISBN or from an approved replacement edition. If a book has more than one approved cover, we can save them separately and group the results by Master PO ISBN. Download the cover, keep the title and any verified author, and flag generic covers or covers used by different ISBNs. Books without a usable cover can still be found by title.

2. **Start with cover, title, and author.** Send these together to `gemini-embedding-2` and ask for a list of 1,536 numbers. Save the ISBN and any useful display details next to that list. [Gemini embeddings documentation](https://ai.google.dev/gemini-api/docs/embeddings)

- I agree on Leave price, stock, delivery, reviews, page count, weight, and dimensions out of the embedding as these contribute nothing to the searching, but how can we test the extra fields.
  > Use the same books and test photos each time. First try the cover alone. Then try cover, title, and author. After that, add one extra detail at a time, such as a subtitle, series name, volume number, or edition printed on the cover. For example, use photos of Volume 1 and Volume 2 and count how often the right volume comes first. Keep an extra field only if it helps on real photos. Leave price, stock, delivery, reviews, page count, weight, and dimensions out.

3. **Search the front cover first.**

- Can you explain it in simple english , you are using very complex words
  > Crop the photo to the front cover. Use the same Gemini model to turn the photo into its own list of 1,536 numbers. Qdrant uses cosine similarity to compare the photo's numbers with the saved numbers and returns the closest matches. Start by sending the photo alone. Then test your idea of having Gemini read the title and author from the photo and sending those words together with the photo. Reading the words takes an extra API call, so compare speed as well as accuracy.
  >
  > Show up to three possible books. If the results are weak, use the current title search. If two editions look alike, let the person choose. The barcode scan stays in Stage 1, and Stage 2 can start as soon as we have a front cover photo.

4. **Run a small test before adding every book to Qdrant.**

- What pilot meant here , what the fuck is pilot ? What is labeled stationp hotos .
  > A pilot just means a small test. Start with saved covers and any physical books we have on hand. Compare the new image search with today's title search. Count how often the right book appears first or in the first three results, how often the app suggests the wrong box, and how many seconds it takes. Keep manual confirmation during the test. See [Testing without old photos](#testing-without-old-photos).

5. **Run Qdrant on the same VPS.**

- There is enough fee ram on this VPS , nearly 12 gb ram is free , so depoying it won't be a problem
  > Plan for the same VPS with about 12 GB of free RAM. Keep Qdrant private and save its data to disk. Check that barcode scans stay fast while we load the books. If loading stops, it should pick up where it left off. After the small test, turn the new search on with a server setting so we can switch back if needed. [Qdrant setup](https://qdrant.tech/documentation/installation/)

## Remarks

- Our first priority should be image seach , not isbn search because when the camera clicks the front / cover image of the photo , it only gets the title and other things such as author name , we did not click the back of the book where the isbn is written , the image search through vectors is our first prioirty because we did all the ordering from amazon itself , hence we have scraped all the images also from the images itself , hence image search would be ideal here.

- We are searching these books in the first place because when we were scanning the books the isbn was not matched, hence we searching with title , if it has correct isbns , it would have cleared in 1st stage , you can think of it stage 1 as books that cleared directly through isbn match , and stage 2 is were we try to clear by searching through title.

- Also explain how the image search will work
- I am thinking capture image -> make emedding of the captured chunk , this chunks will include image , title , authour -> run cosine simalrity -> get results

- If you have any question please ask here itself , question about our scanning process and other things.

- this question is still answered :

1. How will the embedding map it to a book ? like suppose we got 10 recommendation then how other information will be stored like to which box this book belong and other things ?

   > Qdrant stores the ISBN next to the embedding. For each of the 10 matches, the app uses that ISBN to find the box in the Master PO and checks SQLite for the next copy that still needs packing. See [How a match leads to a box](#how-a-match-leads-to-a-box).

## Questions for the detailed plan

- Do we already have photos with the correct ISBN written down, especially photos where the current search struggled?
  > - /Users/sanchitjain/vscode_files/book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl
  >   Please check this file , this file has all the rows mapped to master file , Please check
  >
  > Checked. The Amazon covers are the saved images we search against. We can start without old photos of failed scans.
- How many seconds should it take to get a result, and how much can we spend on Gemini for the test?

  > Can you give me the estimated pricing , how much will be spent to generated embeddings for all the book in /Users/sanchitjain/vscode_files/book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl

  > Use regular Gemini API requests. Measure the time per search and how many books we can load per minute. See [Time to make the saved embeddings](#time-to-make-the-saved-embeddings).

- For the covers where Amazon returned a different ISBN and there is no approved link, do we have another list showing which edition we actually ordered?
- Can you give me the stats on how many books cover mathced isbns and other stats

## Where to check the Amazon edition

The Amazon ordering workbook lists the PO ISBN and Amazon ISBN on several tabs. The app's approved edition list comes from this workbook and has 6,568 Amazon-to-PO links. I checked the workbook and its saved review file. I found no separate Amazon purchase history in the local files I checked. The workbook helps us find the listed edition. An Amazon order record would confirm what was bought. [Ordering workbook](<AMAZON ORDERING ZOOM.xlsx>) · [Approved list](data/amazon-editions.json) · [Workbook review file](data/amazon-editions/audit.json)

Of the 20,672 PO ISBNs with a cover link that still needs checking, the review file has the same PO and Amazon ISBN pair for **148**. For 93, the Amazon ISBN points to more than one PO or box. For 50, the Amazon ISBN also appears as its own ISBN in the Master PO. For 5, the PO ISBN and box on the workbook row do not match a row in the Master PO. Another 213 have a PO ISBN in the review file but no matching Amazon ISBN from the scrape.

## Cover stats

The November 7 Amazon file has **165,306 scrape rows**. Of those, **165,296** have a valid searched ISBN. Those valid rows include **8,827 repeat rows**, leaving **156,469 distinct valid ISBNs**. The other **10 rows** have invalid searched ISBNs. All 156,469 valid ISBNs appear in the Master snapshot used for the scrape.

Each row counts in the first column of counts. The distinct column counts each valid ISBN once, using the best cover it got.

| Cover link result | Scrape rows | Distinct valid PO ISBNs |
| --- | ---: | ---: |
| Cover link and the same ISBN | 105,264 | 100,505 |
| Cover link for an approved replacement edition | 5,056 | 5,018 |
| Cover link for a different ISBN with no approved link | 19,179 | 18,684 |
| Cover link but no valid Amazon ISBN | 2,178 | 1,988 |
| No cover link | 33,629 | 30,274 |
| **Total** | **165,306** | **156,469** |

- **131,677 rows (79.66%)** and **126,195 distinct ISBNs (80.65%)** have a cover link. Of the 33,629 rows with no cover, 522 had a listing and 33,107 had no listing.
- **110,320 rows (66.74%)** and **105,523 distinct ISBNs (67.44%)** have a link for the same ISBN or an approved replacement.
- The file contains **123,372 different cover URLs**. **1,703** are shared by more than one valid PO ISBN.
- These are scrape counts. After filtering the cover list, Phase 4 had **104,233 embedding candidates**. It saved **104,093** and skipped **140** because their images were unusable. [Phase 4 result](docs/cover-vector-search-plan.md#phase-4-deployment-and-timing)

### Additional covers for review

The separate Qdrant collection `isbn_covers_cd01caf2d51532ec` contains **20,466 embeddings** from **20,672 candidates**. It saved **18,537** covers with a different Amazon ISBN and **1,929** covers without a valid Amazon ISBN. The remaining **206** images were too small or generic.

Each record is linked to the searched PO ISBN and stores the returned Amazon ISBN when it is valid. The embedding uses the cover and the Amazon listing title when available. The title is kept in its original language and is never compared with the Master title to decide whether to include a cover. The live Vector search uses this collection alongside the verified cover collection. **More cover matches to review** offers **Check printed ISBN**, **Look up PO ISBN**, and **Mark as packed** for eligible copies. Packing requires confirmation of the selected PO ISBN and box. [Prepared input summary](data/cover-search/unverified-covers-v1/summary.json)

### ISBN matches in the Amazon scrape

An exact match means Amazon returned the same ISBN we searched for. These counts include searches with and without a cover link.

| Scrape result                                   | All rows, including repeats | Different valid Master PO ISBNs |
| ----------------------------------------------- | --------------------------: | ------------------------------: |
| **Exact ISBN match**                            |        **105,264 (63.68%)** |            **100,505 (64.23%)** |
| **No exact ISBN match**                         |         **60,042 (36.32%)** |             **55,964 (35.77%)** |
| └ Amazon returned a different valid ISBN        |                      24,235 |                          23,702 |
| └ Amazon found a listing but gave no valid ISBN |                       2,700 |                           2,459 |
| └ Amazon found no listing                       |                      33,107 |                          29,803 |
| **Total**                                       |                 **165,306** |                     **156,469** |

Amazon found a listing for **132,199 rows (79.97%)** and **126,666 distinct valid ISBNs (80.95%)**. For the distinct column, an ISBN counts as matched if any of its rows has an exact match. An approved replacement counts as a different ISBN in this table. [Amazon scrape](../book_listing_automator/output/amazon-isbn-enchanced/isbns/2026-11-07/final.jsonl)

## How the current photo search works

Yes, that is the current title search flow. The app also checks for an ISBN first and waits for you to confirm the box.

- Capture a photo in Cover Match.
- Gemini reads the title, author, and ISBN if they are visible.
- If Gemini finds an ISBN the app knows, use that ISBN or its approved Amazon edition link.
- Otherwise, compare the title with titles in the Master PO. Use the author to help sort close matches.
- Get the Master PO ISBN for each match. Check which copies still need packing and show the next box.
- You confirm the book and box. The app checks that the copy is still available and marks it as packed.

## How the new photo search will work

Before we use it, Gemini turns each usable Amazon cover, title, and verified author into a list of 1,536 numbers. Qdrant saves that list with the book's Master PO ISBN.

- After a barcode scan fails to find the book, capture a photo of the front cover.
- Gemini turns the photo into its own list of 1,536 numbers.
- Qdrant compares that list with the saved lists and returns the closest matches with their Master PO ISBNs.
- Use those ISBNs to find the books in the Master PO. Check which copies still need packing and show the next box for each suggested book.
- If the cover matches are weak, try the current title search.
- You confirm the book and box. The app checks that the copy is still available and marks it as packed.

## Details for implementation

### Time to make the saved embeddings

Use regular Gemini `embedContent` requests, one request per usable cover. **105,523** is the starting count of ISBNs with an exact or approved replacement cover link. The final number of requests depends on how many images pass the checks.

| Books successfully embedded per minute | Time for 105,523 books |
| -------------------------------------: | ---------------------: |
|                                    100 |    17 hours 35 minutes |
|                                    300 |     5 hours 52 minutes |
|                                    600 |     2 hours 56 minutes |

These are estimates based on a steady speed. Time to download and check the covers or load Qdrant can add to the total. Google's limits apply to the project and can include requests per minute, input tokens per minute, and daily limits. Check the project's active limits in AI Studio. [Google API limits](https://ai.google.dev/gemini-api/docs/rate-limits?authuser=2)

Run **500–1,000 covers** first. Measure the time from download through saving to Qdrant and use that result to estimate the full run. Send a few requests at the same time, increase slowly, and slow down if Google limits the rate. Save progress for each ISBN so a stopped run can resume. Retry temporary failures and keep a list of broken or missing covers for review. If we sustain 300 books per minute end to end, the full load would take about **six hours**.

### What goes into each embedding

For the saved books, one chunk means **one cover and the text for that same book**. Send the image and text together in one request to `gemini-embedding-2`. Ask for one embedding with **1,536 numbers**. [Gemini embedding inputs](https://ai.google.dev/gemini-api/docs/embeddings?authuser=117)

| Field                                                      | What to send or save                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Front cover                                                | Send the actual JPEG or PNG image to Gemini. Save the source link beside the embedding for display and checking.                                 |
| Title                                                      | Send the title from the Master PO in its original script.                                                                                        |
| Author                                                     | Send the author if it is verified for the book. Leave the author line out if the name is missing or uncertain.                                   |
| Subtitle, series, volume, edition                          | Try one at a time if similar books are hard to tell apart. Use details we can verify on the cover. Keep a field only if it improves the results. |
| Master PO ISBN and approved Amazon ISBN                    | Save these beside the embedding in Qdrant. The app uses them to look up the book and apply the approved edition rules.                           |
| Box, quantity, and packed status                           | Keep using the Master PO and SQLite. Read the current box and packing status when showing a result.                                              |
| Price, stock, delivery, reviews, pages, weight, dimensions | Leave these out of the embedding.                                                                                                                |

For the sample book in this file, send its front cover and the title `La Gerencia Efectiva: Tareas Economicas y Decisiones Arriesgadas`. The author is blank in the sample, so leave out the author line unless we have a verified name. Save `9789500714006` beside the result as its PO ISBN.

For a live search, send the cropped camera photo to the same model first. Compare cover-only saved embeddings with saved cover + title + author embeddings using the same photos. If photo-only search struggles, test asking Gemini to read the title and author from the camera photo and sending those words with the photo. That adds another Gemini call, so check the time as well as the results.

### Which covers need checking

- A **broken image** is a link that fails to download or returns a file we cannot open as an image.
- A **generic cover** is a placeholder, such as a blank book picture or an image that says “No image available.” It does not help tell two books apart. A simple cover with the real title can still be useful.
- An **unconfirmed edition** is a cover linked to a different ISBN that we cannot tie to the PO book with the approved list. Keep it for review. If two ISBNs share the same real cover, show the choice for manual review when the image alone cannot tell them apart.

### Testing without old photos

1. **Start with the Amazon images.** Save a small set of covers in Qdrant. Test with copies that we crop, tilt, darken, or blur. Add similar books and a few covers outside the PO. This checks that the search works and gives us an early comparison of the embedding options.
2. **Use any physical books on hand.** Take front-cover photos with the packing camera and check the ISBN from the book or Master PO separately. These books can include ones that scan correctly. Use different books for the final check than the ones we used to tune the search.
3. **Collect real failures during normal work.** When a barcode scan fails, try Cover Match at one station and note the correct PO ISBN and box once confirmed. Keep manual confirmation. Use these results to compare image search with today's title search before turning it on for everyone.
