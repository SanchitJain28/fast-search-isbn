# Central VPS deployment

Production URL: https://scanner.200.234.32.63.nip.io

The hostname uses nip.io to resolve to the VPS without purchasing a domain. A trusted Let's Encrypt certificate is installed. DNS availability depends on nip.io; a domain owned by the business can replace it later.

## Layout

- App: `/opt/fast-search-isbn/current` (symlink to versioned release directory).
- Database: `/var/lib/fast-search-isbn/packing.sqlite`, owned by `bookscanner`.
- Runtime settings: `/etc/fast-search-isbn.env`, root and service account only. The app password is stored as a salted scrypt hash.
- Generated app login: `/root/bookscanner-login.json` on the VPS. A private copy is saved in the local project's ignored `data/deployment-login.json` for the owner. Do not commit or share this file beyond authorized packing staff.
- Google key, only if separately authorized: `/etc/fast-search-isbn-google.json`. Never put it in `dist/` or a public website directory.
- Service: `fast-search-isbn.service`, unprivileged process listening only on `127.0.0.1:3000`.
- HTTPS: existing OpenLiteSpeed, new isolated virtual host `bookscanner`. Existing site mappings are retained. Configuration backups are under `/root/bookscanner-litespeed-backups/`.
- Certificate: `/etc/letsencrypt/live/scanner.200.234.32.63.nip.io/`, renewed by existing `certbot-renew.timer`; a deploy hook gracefully reloads OpenLiteSpeed.
- Backups: `fast-search-isbn-backup.timer` every six hours, stored under `/var/lib/fast-search-isbn/backups/`. Each SQLite snapshot has a matching `.master.json` catalog copy. These on-server backups do not protect against loss of the whole VPS; copy dated backups off the VPS periodically.

All stations must open the production URL. Do not continue scanning into the old Sheet or run independent local packing servers for the same run.

## Operations

SSH from the owner's computer uses the dedicated key:

```sh
ssh -i ~/.ssh/id_ed25519_bookscanner_200_234_32_63 root@200.234.32.63
```

```sh
systemctl status fast-search-isbn
journalctl -u fast-search-isbn -n 50 --no-pager
systemctl restart fast-search-isbn
systemctl start fast-search-isbn-backup
systemctl list-timers fast-search-isbn-backup.timer
```

To update, upload a new versioned release without copying `.env`, credentials or local databases. Install its production dependencies (`npm ci --omit=dev`), preserve the deployed catalog, change the `current` symlink and restart the service. Roll back by restoring the previous release symlink and restarting; the database remains outside releases. Do not change catalog order or content during an active run without reconciling allocations.

The shared app login is separate from SSH root credentials. Workers sign into the HTTPS website; browsers normally retain Basic authentication for the browser session. Rotate its password by generating a new scrypt hash, updating `SCANNER_PASSWORD_HASH` in the protected environment file, and restarting the service. `scripts/hash-password.mjs` accepts a password on standard input and outputs only the hash; never put a password in shell command arguments.

Google reporting now writes fixed values to the **main Scan tab** in the existing packing workbook. The Scan-tab cutover preserves all 14,292 historical A–D records and maps app sequence 14293 to row 14299. Its hidden F–J columns contain request ID, sequence, station, exact result type and copy number. Progress formulas count that metadata. The old lookup formulas have been retired. `Scanner Log VPS` remains an archive.

The main Scan cutover used `/opt/fast-search-isbn/releases/20261017-main-scan`. SQLite metadata `mainScanLayout` holds the destination sheet ID, starting sequence/row and historical hash. `mirrorTarget` and `/etc/fast-search-isbn.env` both target `Scan`. Existing app scans were re-queued once for that destination, and imported historical records were retained in place. The previous release and environment are recorded under `/root/bookscanner-main-scan-switch/`. A cell values/formulas snapshot is saved in the owner's ignored local `data/main-scan-switch/` directory.

Do not run legacy Apps Script repair, manually insert/delete rows or physically sort the Scan tab. Use filter views. If an expected destination row contains an unknown entry, the worker reports an error and preserves it rather than overwriting it. If reporting is disabled or Google is unavailable, app scans remain saved and queued on the VPS.

## Cover vector index

The [Qdrant setup script](setup-cover-qdrant.sh) starts the pinned container on `127.0.0.1:6335` with a persistent Docker volume. The scanner uses the read-only key. The loader uses the write key. The protected Qdrant environment file is `/etc/fast-search-qdrant.env`.

To view the VPS dashboard from the owner's Mac, keep this SSH tunnel open and visit [Qdrant Dashboard](http://127.0.0.1:6336/dashboard/). Use the read-only key when the dashboard asks for one.

```sh
ssh -N -L 127.0.0.1:6336:127.0.0.1:6335 \
  -i ~/.ssh/id_ed25519_bookscanner_200_234_32_63 root@200.234.32.63
```

To copy the read-only key to the Mac clipboard, run this in another Terminal window.

```sh
ssh -i ~/.ssh/id_ed25519_bookscanner_200_234_32_63 root@200.234.32.63 \
  'sed -n "s/^QDRANT__SERVICE__READ_ONLY_API_KEY=//p" /etc/fast-search-qdrant.env' | tr -d '\n' | pbcopy
```

The loader files are under `/opt/fast-search-qdrant`. Its progress database, reports, and downloaded snapshots are under `/var/lib/fast-search-qdrant`. The loader checks the live Master and edition list before starting, during the load, and before publishing a completion report. The current load uses `isbn_covers_84aeed43cc65e6bc` and reuses vectors from the first collection for unchanged cover records.

Check or stop the current load from the VPS.

```sh
systemctl status fast-search-cover-load
journalctl -u fast-search-cover-load -n 20 --no-pager -o cat
systemctl stop fast-search-cover-load
```

Resume the same collection with the same input files and loader state. Adjust the request rate or concurrency if needed.

```sh
systemd-run --unit=fast-search-cover-load --property=Type=exec \
  --property=KillMode=mixed --property=TimeoutStopSec=180 \
  --property=Nice=10 --property=CPUQuota=120% \
  /usr/bin/bash /opt/fast-search-qdrant/deploy/complete-cover-load.sh \
  isbn_covers_84aeed43cc65e6bc \
  --input /opt/fast-search-qdrant/data/cover-search/phase-4-resume/input \
  --reuse-input /opt/fast-search-qdrant/data/cover-search/phase-4-input \
  --rpm 1000 --concurrency 28
```

If the previous unit failed, run `systemctl reset-failed fast-search-cover-load` before starting it again.

If Gemini returns HTTP 402, check the project's Prepay balance before resuming. To copy only saved vectors from the previous collection, run `deploy/run-cover-loader.sh` with the same input and reuse paths plus `--reuse-only`. This mode makes zero Gemini requests. [Gemini Prepay billing](https://ai.google.dev/gemini-api/docs/billing#prepay)

The completion script verifies the searches, restores a snapshot to a separate collection, and saves the scanner settings with `COVER_VECTOR_SEARCH_ENABLED=false`. The scanner restart and station rollout are separate steps. Keep the snapshot and the matching loader report together. If the input catalog or edition list changes, prepare a new cover list and load it into a new collection.

### Production rollout

Release `20261110-cover-pack-actions` searches the verified collection `isbn_covers_84aeed43cc65e6bc` and the review collection `isbn_covers_cd01caf2d51532ec` with the read-only Qdrant key. Set the review collection through `COVER_VECTOR_REVIEW_COLLECTION`. Vector search is enabled for all stations with `COVER_VECTOR_SEARCH_ENABLED=true`, `COVER_VECTOR_MIN_SCORE=0.70`, and `COVER_MATCH_AUTO_PACK=off` (`COVER_VECTOR_PILOT_STATION` unset). To restrict vector search to a single station again, set `COVER_VECTOR_PILOT_STATION=Station-18dd0b` (or restore `/root/bookscanner-phase5/scanner.before-all-stations.env`) and restart `fast-search-isbn`.

Reload the production scanner on any station. In **Cover Match**, choose **Vector** for cover similarity or **Title** for OCR and typed lookup. To reuse a Vector photo, click **Search this photo by title**. It opens the Title tab and submits only the OCR lookup. [Phase 5 plan](../docs/cover-vector-search-plan.md#phase-5--try-one-station-then-turn-it-on-more-widely)

To pause the pilot, set `COVER_VECTOR_SEARCH_ENABLED=false` in `/etc/fast-search-isbn.env` and restart `fast-search-isbn`. To roll back the labels release, point `current` to `20261110-cover-vector-pilot`, restore `/root/bookscanner-phase5/scanner.before-labels.env` to `/etc/fast-search-isbn.env`, then restart.

```sh
journalctl -u fast-search-isbn --since today --no-pager -o cat | rg '"event":"cover-lookup"'
```

## Amazon replacement editions

Generate the order-specific barcode map and worksheet audit with Python and `openpyxl`:

```sh
python3 scripts/import-amazon-editions.py 'AMAZON ORDERING ZOOM.xlsx' public/master.json data/amazon-editions
```

Review `audit.json` and install the generated `amazon-editions.json` beside the packing database, in `data/` locally or `/var/lib/fast-search-isbn/` on the VPS. Restart the packing server to load it. Keep this file with deployment backups. A replacement claims an available copy of the PO ISBN in the mapped order, up to its workbook quantity. Conflicting barcodes produce REVIEW without allocating a copy. The main Scan tab stores the PO ISBN in column A for progress reporting and shows the Amazon ISBN in the status.

## Cutover recovery

The initial migration snapshot contained 14,284 attempts: 11,696 PACK, 194 DUPLICATE and 2,394 NOT FOUND. Historical NOT FOUND warnings were preserved without allocating copies. After all stations stopped, eight extra PACK rows were appended safely. Final verified totals: **14,292 attempts, 11,704 PACK, 194 DUPLICATE, and 2,394 NOT FOUND**. All order totals and every reporting row matched; the Google queue was empty. Final verification record is in the local ignored `data/deployment-verification.json`.

For that narrow cutover case, `scripts/migrate-scans.mjs HISTORY.csv --append --apply` imports only an appended suffix. It verifies the entire existing prefix, preserves existing request IDs and sheet mirror row addresses, and refuses to run if any live app scans or changed history rows appear in the prefix. Stop the scanner service and take a backup before invoking it. This is not a general-purpose merge tool for two active packing systems.

`PUBLIC_ORIGIN` is set to the exact HTTPS URL. The API accepts repeated identical Origin headers produced by OpenLiteSpeed, and rejects requests containing any untrusted Origin.

## Master catalog update — 26 October 2026

Deployed `master-26th-oct.csv`: 149,381 copies, including 5,139 added copies for order ZB345. All 144,242 previous catalog positions were preserved. The append-only update validated the live allocations and changed only the catalog hash in database metadata; scan records and Sheets settings were retained.

For future additions, generate a candidate JSON separately and use `scripts/update-catalog.mjs --candidate NEW.json --database DB --root APP` for read-only validation. Stop the scanning service before adding `--apply`, publish the resulting `public/master.json` to `dist/master.json`, then restart. This helper refuses removed/reordered copies or conflicting allocations.

## Master catalog update — 31 October 2026

Deployed `master-31th-oct.csv`: 151,599 copies, adding ZBBID-1 (559), ZBBID-2 (135), and ZBW (1,524). All 149,381 prior catalog positions and titles were retained. Production reconciliation preserved 20,058 scan records and 15,815 active packing allocations. Server code and Sheets settings were unchanged.

## Master catalog update — 5 November 2026

Deployed `master-5th-nov.csv`: 165,306 copies, adding 13,707 copies across ZBW-2 (2,337), SEA-1 (508), ZBPREP-4 (440), ZBIN-1 (1,984), ZB346 (527), ZB346B (3,573), and ZBPREP-3 (4,338). All 151,599 prior catalog positions and titles were retained. Production reconciliation preserved 21,880 scan records and 16,960 active packing allocations. Server code and Sheets settings were unchanged.

## Connection recovery fix — 6 November 2026

Deployed frontend connection recovery and API response framing fixes. History refreshes now share one in-flight request and allow 60 seconds on slow links. EventSource reconnects trigger an API health check rather than immediately blocking the scanner; stale failed probes cannot override newer successful heartbeats. Health events carry status directly, avoiding an extra request every five seconds. Scan submissions retry transient failures up to three times using the identical persisted request ID, retaining the existing server idempotency and pending-request protection. Large API responses are gzip-compressed asynchronously with explicit Content-Length to avoid partial chunked history transfers through the proxy. Packing allocation logic, database schema, catalog, and Sheets destination are unchanged. All 31 regression tests and the production build passed.

## Saved scan confirmation recovery — 6 November 2026

A production packer showed ISBN 9781240126651 as unconfirmed even though request sequence 23617 was saved as PACK for ZB344 and synced to Sheets. The prior connection fix did not clear a persisted pending request from matching live-feed/history records and stopped automatic attempts after three failures.

The client now confirms pending requests by exact request ID from live events, history refresh, or the new authenticated read-only `GET /api/scan?id=...` endpoint. Healthy connection updates continue recovery after initial retries are exhausted. A matching live confirmation can complete an in-flight scan without waiting for its lost HTTP response. Recovered results restore the large box message; pending records are retained until confirmation. All 33 tests passed, including a real production HTTP-server/SQLite test that deliberately discards all three POST replies and recovers the original row without inserting duplicates. No catalog, Sheets configuration, or existing scan records were changed during deployment.

## Cover Match release — 7 November 2026

Production uses `/opt/fast-search-isbn/releases/20261107-cover-match` with manual confirmation. The reconciled catalog retains all 165,306 copy positions. Cutover preserved 24,274 scans, 18,459 allocations, and 6,568 edition mappings. Authenticated HTTPS title lookup passed, and Sheets reporting was enabled.

The pre-cutover database, matching catalog, and previous environment are in the root-protected directory `/opt/fast-search-isbn/cover-release.RCSrtN/cutover`. To roll back, pause the scanner, reconcile the prior catalog against the live database using a temporary copy of the currently active catalog, restore the previous environment, and point `current` to `20261107-amazon-editions` before restarting. Reconcile the catalog metadata against the current database to preserve scans made since cutover.

Photo lookup is enabled with `GEMINI_API_KEY` in `/etc/fast-search-isbn.env`. After restarting the service, an authenticated HTTPS photo lookup read the synthetic printed ISBN `9780700702008` and returned `DUPLICATE` for its existing packing state. The release uses `COVER_MATCH_AUTO_PACK=off` while operators validate proposed boxes against labeled books.
