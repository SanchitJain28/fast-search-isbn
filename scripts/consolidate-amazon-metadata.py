#!/usr/bin/env python3
"""Archive Amazon scrape results and enrich a candidate Master by exact ISBN."""

import argparse
from collections import Counter
from contextlib import closing
import csv
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
from tempfile import NamedTemporaryFile
import unicodedata


def isbn13(value):
    code = re.sub(r"[\s-]", "", str(value or "")).upper()
    if re.fullmatch(r"[0-9]{9}[0-9X]", code):
        digits = [10 if digit == "X" else int(digit) for digit in code]
        if sum(digit * weight for digit, weight in zip(digits, range(10, 0, -1))) % 11:
            return None
        prefix = "978" + code[:9]
        check = -sum(int(digit) * (1 if i % 2 == 0 else 3) for i, digit in enumerate(prefix)) % 10
        return prefix + str(check)
    if re.fullmatch(r"97[89][0-9]{10}", code):
        if sum(int(digit) * (1 if i % 2 == 0 else 3) for i, digit in enumerate(code)) % 10 == 0:
            return code
    return None


def author_fields(value):
    if not isinstance(value, str):
        return None, None
    value = " ".join("".join(c for c in value if unicodedata.category(c) != "Cf").split())
    folded = unicodedata.normalize("NFKC", value).casefold()
    key = "".join(c for c in folded if unicodedata.category(c)[0] in "LMN")
    if re.match(r"^n\s*/\s*a(?:\s|$)", folded) or key in {"", "na", "none", "null", "unknown", "error", "notavailable", "notfound", "authorunknown"}:
        return None, None
    return value, key


def records(file):
    with file.open(encoding="utf-8-sig", newline="") as source:
        if file.suffix == ".csv":
            reader = csv.DictReader(source)
            if not reader.fieldnames or "searched_isbn" not in reader.fieldnames:
                raise ValueError(f"Unexpected CSV header in {file}")
            for row in reader:
                yield reader.line_num, row if None not in row else None
            return
        for line_number, line in enumerate(source, 1):
            if line.strip():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    row = None
                yield line_number, row if isinstance(row, dict) else None


def build(source, output):
    files = sorted(f for f in source.rglob("*") if f.is_file() and f.suffix in {".json", ".csv", ".bak"})
    if not files:
        raise ValueError(f"No scrape files in {source}")
    if output.is_relative_to(source):
        raise ValueError("Choose an output outside the scrape source directory")
    with NamedTemporaryFile(dir=output.parent, prefix=output.name + ".", delete=False) as tmp:
        staging = Path(tmp.name)
    try:
        with closing(sqlite3.connect(staging)) as db:
            db.executescript("""
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                CREATE TABLE sources (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, rows INTEGER, malformed INTEGER);
                CREATE TABLE malformed_rows (source_id INTEGER, line INTEGER);
                CREATE TABLE observations (
                    id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
                    searched_isbn TEXT, found_isbn TEXT, exact_match INTEGER NOT NULL,
                    author TEXT, author_key TEXT, captured_at TEXT NOT NULL,
                    source_id INTEGER NOT NULL, source_line INTEGER NOT NULL, payload TEXT NOT NULL
                );
            """)
            for file in files:
                relative = file.relative_to(source)
                source_id = db.execute("INSERT INTO sources(path) VALUES (?)", (relative.as_posix(),)).lastrowid
                count = malformed = 0
                for line, row in records(file):
                    count += 1
                    if row is None:
                        malformed += 1
                        db.execute("INSERT INTO malformed_rows VALUES (?, ?)", (source_id, line))
                        continue
                    searched, found = isbn13(row.get("searched_isbn")), isbn13(row.get("found_isbn"))
                    exact = bool(searched and searched == found and str(row.get("isbn_matched")).lower() == "true" and row.get("found") is not False)
                    author, key = author_fields(row.get("author")) if exact else (None, None)
                    payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                    captured = str(row.get("scraped_at") or relative.parts[0])
                    db.execute("""INSERT INTO observations(digest,searched_isbn,found_isbn,exact_match,author,author_key,captured_at,source_id,source_line,payload)
                        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING""",
                        (sha256(payload.encode()).digest(), searched, found, exact, author, key, captured, source_id, line, payload))
                db.execute("UPDATE sources SET rows=?, malformed=? WHERE id=?", (count, malformed, source_id))
            db.executescript("""
                CREATE INDEX observations_searched ON observations(searched_isbn);
                CREATE INDEX observations_found ON observations(found_isbn);
                CREATE TABLE editions (isbn TEXT PRIMARY KEY, observation_id INTEGER NOT NULL, author_status TEXT NOT NULL) WITHOUT ROWID;
                INSERT INTO editions
                WITH variants AS (
                    SELECT found_isbn, count(DISTINCT author_key) AS authors
                    FROM observations WHERE exact_match=1 GROUP BY found_isbn
                ), ranked AS (
                    SELECT id, found_isbn, row_number() OVER (
                        PARTITION BY found_isbn ORDER BY author IS NOT NULL DESC, captured_at DESC, id DESC
                    ) AS rank
                    FROM observations WHERE exact_match=1
                )
                SELECT found_isbn, id, CASE authors WHEN 0 THEN 'missing' WHEN 1 THEN 'available' ELSE 'conflict' END
                FROM ranked JOIN variants USING (found_isbn) WHERE rank=1;
                CREATE VIEW books AS
                SELECT e.isbn, CASE WHEN e.author_status='available' THEN o.author END AS author,
                    e.author_status, json_extract(o.payload,'$.title') AS title,
                    json_extract(o.payload,'$.publisher') AS publisher,
                    json_extract(o.payload,'$.publication_date') AS publication_date,
                    json_extract(o.payload,'$.url') AS url, o.captured_at, s.path AS source_file, o.source_line
                FROM editions e JOIN observations o ON o.id=e.observation_id JOIN sources s ON s.id=o.source_id;
            """)
            summary = dict(zip(("files", "input_rows", "malformed_rows", "distinct_observations"), db.execute("""
                SELECT count(*), sum(rows), sum(malformed), (SELECT count(*) FROM observations) FROM sources
            """).fetchone()))
            summary["duplicate_rows"] = summary["input_rows"] - summary["malformed_rows"] - summary["distinct_observations"]
            summary["exact_isbns_by_author_status"] = dict(db.execute("SELECT author_status, count(*) FROM editions GROUP BY author_status"))
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite integrity check failed")
        staging.replace(output)
        return summary
    finally:
        staging.unlink(missing_ok=True)


def title_key(value):
    folded = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join("".join(c if unicodedata.category(c)[0] in "LMN" else " " for c in folded).split())


def enrich(database, master, output):
    if output == master or output == database:
        raise ValueError("Choose a separate output path for the enriched candidate")
    catalog = json.loads(master.read_text(encoding="utf-8"))
    keys = [isbn13(row["ISBN13"]) for row in catalog]
    counts = Counter(keys)
    titles_by_isbn = {}
    for row, key in zip(catalog, keys):
        if key and counts[key] > 1:
            titles_by_isbn.setdefault(key, set()).add(title_key(row.get("Title")))
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        books = {isbn: (author, title, status) for isbn, author, title, status in
                 db.execute("SELECT isbn, author, title, author_status FROM books") if isbn in counts}

    stats = Counter()
    enriched_keys = set()
    for row, key in zip(catalog, keys):
        author, title, status = books.get(key, (None, None, "no_exact_match"))
        if str(row.get("Author") or "").strip():
            stats["existing_author"] += 1
        elif not author:
            stats[status] += 1
        else:
            if len(titles_by_isbn.get(key, ())) > 1:
                catalog_title, amazon_title = title_key(row.get("Title")), title_key(title)
                agrees = catalog_title and amazon_title and (f" {catalog_title} " in f" {amazon_title} " or f" {amazon_title} " in f" {catalog_title} ")
                if not agrees:
                    stats["shared_isbn_title_disagreement"] += 1
                    continue
            row["Author"] = author
            enriched_keys.add(key)
            stats["author_added"] += 1
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, prefix=output.name + ".", delete=False) as tmp:
        staging = Path(tmp.name)
        try:
            json.dump(catalog, tmp, ensure_ascii=False, separators=(",", ":"))
            tmp.close()
            staging.replace(output)
        finally:
            staging.unlink(missing_ok=True)
    return {
        "master_rows": len(catalog), "master_distinct_isbns": len({str(row["ISBN13"]) for row in catalog}),
        "master_isbns_with_exact_match": len(books), "master_isbns_with_author_added": len(enriched_keys),
        "master_row_outcomes": dict(stats),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    archive = commands.add_parser("build")
    archive.add_argument("source", type=Path)
    archive.add_argument("database", type=Path)
    join = commands.add_parser("enrich")
    join.add_argument("database", type=Path)
    join.add_argument("master", type=Path)
    join.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        summary = build(args.source.resolve(), args.database.resolve())
    else:
        summary = enrich(args.database.resolve(), args.master.resolve(), args.output.resolve())
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
