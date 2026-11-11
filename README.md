# FastSearch ISBN packing

One central computer hosts the catalog, SQLite database and app. Open that computer's LAN address on each of the 1–3 scanning computers. All stations, title search and review use the same server to allocate copies. SQLite transactions prevent two stations from taking the same copy.

Requires Node.js 22.13 or newer (Node 22.17 used for verification). The central computer must stay on; disable sleep during packing. This setup is intended for a trusted local network, not direct exposure to the public internet.

## Move an existing packing run

1. Pause direct scanning in Google Sheets. Download the latest workbook as XLSX, or export the **Scan** tab as CSV. Keep an untouched backup of that export and the current catalog. Use the latest history, not the older local `scans.csv` unless it is complete.
2. On the central computer run `npm install`, then `npm run update-master`. The catalog script chooses the most recently modified `master*.csv`; use `npm run update-master -- /absolute/path/catalog.csv` to choose explicitly. The catalog must use one row per ordered copy.
3. Run `npm run migrate -- /absolute/path/history.xlsx`. This is a dry run: it writes `data/migration-report.json` and does **not** import history or alter the source spreadsheet. It recognizes the Scan sheet's column-A ISBN header, recorded order and status. Blank results and conflicts are flagged; compare them with the physical packing record. Preserve original files and correct a working copy of the export, then rerun the report. The local `scans.csv` may be in reverse chronological order; export Google Sheets for the original scanning order.
4. Once there are no unresolved issues, stop the app server and run `npm run migrate -- /absolute/path/history.xlsx --apply`. This only accepts a new database and imports in one transaction. It preserves recorded packing assignments, rather than recomputing which order an already packed copy went to. It does not silently turn blank rows into packed books.
5. Run `npm run build`, then `npm run preview` for local-network use. Open `http://localhost:3000` on the central computer. Verify packed totals for every order against the previous system before resuming work. If you selected an explicit catalog in step 2, use `npx vite build` in this step to avoid automatic catalog selection.
6. On other computers on the same network open `http://CENTRAL-COMPUTER-LAN-IP:3000`. Allow port 3000 through the host firewall if needed. Configure each barcode scanner to send **Enter** after the barcode. Only one copy of the server should run for this packing operation.

For a genuinely new run with no existing packed books, `npm run migrate -- --empty --apply` initializes an empty database. Do not use that command to bypass historical migration on an existing run.

The app blocks scanning before migration, and also if the catalog changes after migration. Changing the catalog in an active run needs reconciliation; keep the existing database and do not initialize another empty run to bypass this check.

Export the Master CSV as UTF-8 to preserve regional titles and names. An optional `Author` column is carried through when populated. To generate a catalog for reconciliation, run `npm run update-master -- /absolute/path/catalog.csv --output /absolute/path/candidate.json`. This writes only the candidate file.

### Enrich a candidate Master from Amazon scrape results

The offline importer uses Python 3 and its standard library. It accepts the Amazon India line-delimited JSON files, backups, and legacy CSV exports. The SQLite archive retains each distinct source record in `observations`. Its indexed `books` view exposes the preferred exact-match metadata and author status by ISBN. Price and stock fields remain historical observations.

```sh
mkdir -p data/amazon-metadata
python3 scripts/consolidate-amazon-metadata.py build /absolute/path/to/amazon-india/isbns data/amazon-metadata/amazon-india.sqlite
npm run update-master -- /absolute/path/to/master.csv --output data/amazon-metadata/master-utf8.json
python3 scripts/consolidate-amazon-metadata.py enrich data/amazon-metadata/amazon-india.sqlite data/amazon-metadata/master-utf8.json data/amazon-metadata/master-with-authors.json
```

The join preserves existing authors and fills blanks from checksum-valid records where the searched and found ISBN agree. Conflicting author names and ambiguous titles sharing the same ISBN are held for review. Apply the resulting candidate through the catalog reconciliation process before deployment.

### Cover lookup API

Set `COVER_MATCH_ENABLED=true` in the server environment to enable cover matching and confirmation. Set `GEMINI_API_KEY` on the server for image extraction. The default provider and model are `gemini` and `gemini-3.8-flash`. The API uses the same reconciled `public/master.json` as barcode packing and rejects requests if the packing database is on a different catalog version. Development and preview allow cover lookup on localhost. The production server requires the existing scanner login and checks the request origin.

- `POST /api/cover-match` accepts one multipart field named `image` with a JPEG, PNG, or WebP up to 5 MiB. The **Vector** tab sends `?mode=vector` with the station ID and only searches covers. The **Title** tab sends `?mode=ocr` for a front cover or `?mode=isbn` for the printed ISBN page. Each request runs one method. A weak vector result includes up to three cover suggestions.
- `POST /api/cover-match/search` accepts JSON such as `{"query":"വൈവാഹികം"}` and uses the same catalog and packing state. Typed lookup works without a Gemini key.
- Results can be `MATCH`, `REVIEW`, `DUPLICATE`, or `NO_MATCH`. `autoPack` records an eligible box for review. `autoConfirm` tells the camera tab whether the rollout setting allows it to submit that result for confirmation. Both lookup routes leave packing records unchanged.
- `POST /api/mark-packed` confirms an eligible candidate. Send `id`, `station`, `catalogVersion`, `isbn`, `order`, and the candidate's `confirmationToken`. The token identifies the exact available copy and is valid for 15 minutes. An unconfirmed token must be refreshed after a server restart. An accepted request ID and its original payload recover the saved scan even after the token expires or the server restarts.
- A `409 STALE_CANDIDATE` response includes a `lookup` with refreshed choices or `DUPLICATE` if the copies are exhausted. Have the operator confirm a refreshed choice with a new request ID. After a lost reply, retry the original ID and payload or use `GET /api/scan?id=...` to recover the saved result. The browser's `PackingManager.confirmCover` uses this recovery flow.

Confirmed covers use the standard scan history and Sheets queue. The history response includes `source: "cover"` and `printedIsbn` when a checksum-valid ISBN was extracted from an image. The Master ISBN remains the allocation and reporting ISBN. Known Amazon editions keep their mapped box and quantity limits.

Start with `COVER_MATCH_AUTO_PACK=off` for manual confirmation. After reviewing labeled pilot results, use `isbn` for eligible exact printed Master ISBNs. Use `all` only after validating eligible title matches as well. Known editions, ambiguous results, and typed search still require confirmation. To return to manual confirmation, set the value to `off` and restart the scanner. The camera tab records lookup duration, Gemini token counts when available, the proposed box, and the same-tab confirmation in `fast_search_cover_pilot` browser storage. Compare those entries with labeled books to measure missed ambiguity and correct-box rates.

For a local pilot, use a reconciled test database and start the server with the cover flag enabled. With a valid Gemini key, submit a real cover or inside-page photo using `curl -F 'image=@/absolute/path/cover.jpg' http://localhost:3000/api/cover-match` in Vite development. Use the existing login when testing the authenticated production HTTP server. See `.env.example` for the score floor, auto threshold, and minimum gap.

Set `COVER_VECTOR_SEARCH_ENABLED=true`, `QDRANT_URL`, and `COVER_VECTOR_COLLECTION` to try front-cover similarity search. Point the collection setting at the saved **cover + title + verified author** collection. Keep any `QDRANT_API_KEY` on the server. Front-cover requests try Gemini Embedding 2 and Qdrant for up to five seconds, then use the existing photo lookup when the match is weak or the service is unavailable. The screen asks for manual confirmation. A suggested Amazon replacement must go through **ISBN page** or typed ISBN lookup before it can be packed. [Local vector preview](docs/cover-vector-search-plan.md#phase-3-result)

### Try Cover Match on a connected camera

Run `npm run dev:cover` and open `http://localhost:3105/?tab=cover` in Chrome. The command builds a loopback-only preview with a disposable packing database and Sheets sync off. It uses the enriched Master candidate when available and reads `GEMINI_API_KEY` from your environment or `.env.local`. Camera preview and typed confirmation also work when the key is absent. Stop the command to discard the pilot packing history.

Clear the capture area, select **Start camera**, and allow camera access in the browser. In the device menu, choose the document camera, which may appear as **USB Camera**. After the empty area calibrates, place one book or inside ISBN page in the guide and hold it steady. You can also use **Capture photo** or the pedal key (`F8` by default). Remove the book to rearm auto capture. If the desk or lighting changes, clear the guide and select **Calibrate empty area**.

Use **Confirm box** to save a selected copy. A stale choice brings up the new availability for another confirmation. The pilot keeps the last 100 successful image lookup outcomes in browser storage under `fast_search_cover_pilot`, including any suggested automatic box and a confirmation recorded in the same tab.

## Scanning

The Scanning tab shows a large PACK result and box, DUPLICATE, or NOT FOUND. Every attempt is saved before a result is confirmed, including exceptions. Wait for the result before putting the book in a box. The latest attempts appear across all connected stations; the full log and progress remain available in their tabs.

If a request times out, keep the book aside and select **Retry saved request**. The browser retains its request ID across reloads. Retrying confirms the original decision and cannot consume another copy. Do not clear browser storage or use another tab/station to rescan an unconfirmed book. A central-server or LAN outage pauses scanning; a Google outage does not.

Title search's Mark packed and keyboard Enter use this same allocation service. An order filter filters search results; packing always allocates the next available catalog copy, and the returned box is the one to use.

## Current Google Sheets reporting

The deployed VPS writes confirmed attempts to the existing **Scan** tab. Its historical A–D values were preserved; post-migration app results begin at row 14299. The prior **Scanner Log VPS** tab is an archive. Continue scanning in the website. The Sheet's Progress counters use the server's result metadata, so PACK, DUPLICATE and NOT FOUND counts agree with the app.

Columns F–J contain hidden request ID, server sequence, station, result and copy metadata. Those replace the retired lookup helpers. Do not run the legacy Apps Script repair routine, insert/delete rows, edit tracking columns or physically sort the Scan tab; use filter views for inspection. The reporter checks occupied destination rows and stops rather than overwriting another entry.

The existing-tab mapping is stored with the database. Do not change only `SHEETS_SCANNER_TAB` to point another database at an existing tab. For a new installation without existing history, the separate new-tab setup below still applies.

## New-installation Google Sheets reporting

For a new installation, reporting is disabled by default. The following creates a separate reporting tab; the current VPS uses the prepared main Scan destination described above:

1. Copy `.env.example` to `.env.local` and set `SHEETS_SYNC_ENABLED=true`, `SHEETS_SPREADSHEET_ID`, and a **new** `SHEETS_SCANNER_TAB` name.
2. Put the service account credentials in `credentials.json` on the server (or set `GOOGLE_APPLICATION_CREDENTIALS`) and share the spreadsheet with that service account as an editor. Credentials never go to browsers.
3. Restart the server. It creates the new reporting tab with fixed values; the old Scan and formula sheets remain untouched. Old formula dashboards will not automatically report app scans—use the app's Progress Dashboard or Excel export.

The durable queue is in SQLite and is sent in batches every five seconds, with exponential backoff after failures. Retried writes use fixed row addresses and RAW values, so lost API responses cannot create duplicate rows or evaluate titles as formulas. Imported history is included in the mirror. The tab belongs to this database: do not sort, delete, insert or manually edit its rows. Keep the same database and destination settings; the worker refuses an unrelated existing tab or a changed destination. Restoring an older database backup requires a new reporting destination to avoid stale rows in an existing mirror.

Header status and the storage/reporting modal show pending writes and errors. Sheet sync is reporting only; it never overwrites central history and never gates scanning.

## Backups and verification

Run `npm run backup` at least at the end of each packing day. Copy its generated SQLite file and the matching `public/master.json` to another disk/computer. The backup uses SQLite's consistent snapshot mechanism and can run while the server is up. Keep several dated backups. Excel export is useful for review but is not a complete database backup.

To restore: stop the server, preserve the current database and its `-wal` / `-shm` companions, restore a consistent backup as `data/packing.sqlite` with no stale companion files, restore the matching catalog, then start the server and verify order totals. Scans accepted since that backup need reconciliation. If reporting is enabled, preserve credentials/settings and follow the new-destination rule above.

- `npm test`: database persistence, idempotent retries, simultaneous HTTP clients, rollback and simulated Google failures.
- `npm run build`: regenerate catalog and compile UI.
- `npm run dev`: development server, same persistent database and API as `npm run preview`.

Hardware scanner behavior and live Google reporting should be checked with the actual stations during cutover. Tests use fake Sheets clients and isolated temporary databases; they do not write to Google or production packing history.

## VPS deployment

`npm start` runs the dedicated production HTTP server rather than Vite preview. It requires `SCANNER_USERNAME` and `SCANNER_PASSWORD_HASH`; HTTPS is supplied by the reverse proxy. For the deployed VPS layout, service names, backup schedule and login-file location, see [deploy/README.md](deploy/README.md).

Historical NOT FOUND attempts are retained as recorded, even when their barcodes are non-ISBN identifiers or the book was added to the catalog later. Those are reported as historical warnings and consume no packed copy. Blank statuses or conflicting PACK allocations still block migration.

### Material UI design

The UI follows `design/design.html` using Material UI, Emotion, and locally bundled Roboto fonts. A shared theme in `src/App.jsx` sets the dark palette; responsive layout rules live in `src/App.css`.

Install dependencies with `npm install`, then start the app with `npm run dev`.

Official references: [installation](https://mui.com/material-ui/getting-started/installation/), [theming](https://mui.com/material-ui/customization/theming/), and [MUI MCP](https://mui.com/material-ui/getting-started/mcp/).

The official documentation MCP is configured for VS Code in `.vscode/mcp.json`. Start `mui-mcp` from VS Code's MCP server list. This configuration does not register a server in Codex.

### Local scan demo

With `npm run dev`, open `http://localhost:3000/?demo=scanning` (or select **Try scan demo** on the Scanning page). Select Packed, Duplicate, or Not-found, then press Enter or Scan. Demo history lives only in memory, including Undo; it never writes to the server or Sheets. Exit the demo to return to normal scanning. The demo is available only on loopback hosts in development and is excluded from production builds.

### Station display names

Use the pencil next to Station to set a shared display name such as `Basement floor`. Names are stored separately as server metadata and update across connected stations. They appear in the app's scan history and live-feed toast. Station IDs, existing scan records, allocation behavior, Excel data and Google Sheets reporting are unchanged. Clearing the name shows the original station ID again.

The line below Sheet sync appears while reporting is enabled and there are pending writes; it disappears when the queue is empty. The localhost scan demo also includes a station editor, simulated pending-sync controls and a live-feed toast preview, all using in-memory sample data.

### Correct a scanned ISBN

Double-click an ISBN in the Scanning grid, enter the corrected barcode, then press Enter or Tab to save. Escape cancels. The server recalculates title, box, PACK/DUPLICATE/NOT FOUND status and copy allocation together. The old copy is released when needed. Other stations receive the corrected row through the live feed.

The correction keeps the scan ID, sequence, timestamp and station ID and queues an update to the same mapped Google Sheets row. Corrections have an audit history and revision checks to reject changes based on a stale row. A correction made during a Sheets write stays queued until its new revision is reported. If a save response is lost, retry saving the same value to confirm the original correction.

Only ISBN is directly editable; the other packing fields are derived from the catalog. Voided scans and imported historical rows before the main Scan mapping are read-only. The localhost demo supports ISBN editing entirely in memory, with no server or Sheets writes.

## Automatic recovery of unconfirmed scans

The browser retains the original scan request ID before sending it. A background timer retries recovery independently of the live event feed and health checks, including after a reload. It first asks the server for that exact request; if the request is not saved, it re-sends the original ID. A small lookup can confirm a saved scan even while the original POST reply is stalled. Retries back off to a maximum 15-second interval between recovery cycles. Validation failures still display an error; no packing result is guessed while disconnected.

A single failed health probe does not immediately disable a recently reachable scanner. Switching browser tabs checks health instead of downloading the entire history again. Live-feed reconnection still refreshes history. Keep the current book aside until its confirmed result appears; pending recovery remains automatic and does not authorize packing another copy.

Frontend-only fixes are installed by adding fingerprinted assets and atomically replacing `dist/index.html`. They do not need a scanner-service restart. Operators refresh the page once to load a new client, keeping the pending request in browser storage. Existing assets remain available for already-open tabs.
