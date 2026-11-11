#!/usr/bin/env python3
"""Prepare cover records and optional camera-like test images for vector search."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
from runpy import run_path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]
metadata = run_path(str(ROOT / "scripts/consolidate-amazon-metadata.py"))
isbn13 = metadata["isbn13"]
author_fields = metadata["author_fields"]
title_key = metadata["title_key"]
records = metadata["records"]
IMAGE_HOST = "m.media-amazon.com"
MAX_BYTES = 5 * 1024 * 1024
# Verified against the actual Amazon image during the starter run.
PLACEHOLDER_ASSETS = {"11vdokru0FL", "61RgJAN2yeL"}


def packing_isbn(value):
    # Match normalizeIsbn in server/store.js so the saved key can find the live copy.
    return re.sub(r"[\s-]", "", str(value or "").strip().removeprefix("'")).upper()


def allowed_url(url):
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        return parts.scheme == "https" and parts.netloc.lower() == IMAGE_HOST and parts.path.startswith("/images/")
    except ValueError:
        return False


def input_info(path):
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path.resolve()), "sha256": digest.hexdigest()}


def read_catalog(rows):
    books = {}
    orders = Counter()
    for row in rows:
        key = packing_isbn(row.get("ISBN13"))
        code = isbn13(key)
        if not code:
            continue
        orders[key, str(row.get("Order") or "").strip()] += 1
        book = books.setdefault(code, {"keys": set(), "titles": {}, "authors": {}})
        book["keys"].add(key)
        title = str(row.get("Title") or "").strip()
        if normalized := title_key(title):
            book["titles"].setdefault(normalized, title)
        author, normalized = author_fields(row.get("Author"))
        if normalized:
            book["authors"].setdefault(normalized, author)
    return books, orders


def read_mappings(edition_list, books, orders):
    conflicts = {row["barcode"] for row in edition_list["conflicts"]}
    mappings = {}
    for row in edition_list["mappings"]:
        barcode, key, order, quantity = (row[field] for field in ("barcode", "poIsbn", "order", "quantity"))
        if (barcode in mappings or barcode in conflicts or isbn13(barcode) != barcode
                or type(quantity) is not int or not 0 < quantity <= orders[key, order]):
            raise ValueError(f"Invalid approved edition mapping for {barcode} / {key} / {order}")
        if barcode not in books:
            mappings[barcode] = key
        else:
            # The live store also treats an Amazon ISBN now present in the Master as a conflict.
            conflicts.add(barcode)
    return mappings, conflicts


def prepare_catalog(master, edition_list, scrape, review_covers=False):
    books, orders = read_catalog(master)
    mappings, conflicts = read_mappings(edition_list, books, orders)
    candidates = defaultdict(dict)
    scrape_authors = defaultdict(dict)
    review = {}
    outside = {}
    stats = Counter()
    trusted_cover_isbns = set()

    for line, row in records(scrape):
        stats["scrape_rows"] += 1
        if row is None:
            stats["invalid_scrape_rows"] += 1
            continue
        searched = isbn13(packing_isbn(row.get("searched_isbn")))
        found = isbn13(packing_isbn(row.get("found_isbn")))
        url = row.get("cover_url")
        if row.get("found") is not True or not url:
            continue
        book = books.get(searched)
        if not book:
            continue
        exact = found == searched and row.get("isbn_matched") is True
        approved = found and found != searched and mappings.get(found) in book["keys"]
        if review_covers and (exact or approved):
            trusted_cover_isbns.add(searched)
            continue
        source = {"scrape_line": line, "searched_isbn": searched, "found_isbn": found, "cover_url": url}
        reason = None
        if not allowed_url(url):
            reason = "unapproved_image_url"
        elif urlsplit(url).path.rsplit("/", 1)[-1].split(".")[0] in PLACEHOLDER_ASSETS:
            reason = "generic_cover"
        elif not review_covers and not exact and not approved:
            reason = "edition_conflict" if found in conflicts else "unconfirmed_edition"
            if found and found not in books and found not in mappings and found not in conflicts:
                outside.setdefault(found, source)
        elif not review_covers and (len(book["keys"]) != 1 or len(book["titles"]) != 1):
            reason = "unclear_master_book"
        if reason:
            review.setdefault((searched, found, str(url), reason), {
                **source, "reason": reason, "master_keys": sorted(book["keys"]),
                **({"master_titles": sorted(book["titles"].values())} if reason == "unclear_master_book" else {}),
            })
            continue

        if review_covers:
            if found != searched:
                listing_title = row.get("title")
                candidates[searched].setdefault((found, url), {
                    **source, "match": "review_different_isbn" if found else "review_no_valid_isbn",
                    "listing_title": listing_title.strip() if isinstance(listing_title, str) else "",
                })
            continue
        author, normalized = author_fields(row.get("author"))
        if normalized:
            scrape_authors[searched, found].setdefault(normalized, author)
        candidates[searched].setdefault((found, url), {
            **source, "match": "exact" if exact else "approved_replacement",
        })

    link_isbns = defaultdict(set)
    result = []
    preferred = "review_different_isbn" if review_covers else "exact"
    for searched, links in sorted(candidates.items()):
        if searched in trusted_cover_isbns:
            continue
        book = books[searched]
        covers = sorted(links.values(), key=lambda cover: (cover["match"] != preferred, cover["scrape_line"]))
        for cover in covers:
            names = {} if review_covers else book["authors"] | scrape_authors[searched, cover["found_isbn"]]
            if len(names) == 1:
                cover["author"] = next(iter(names.values()))
            elif names:
                stats["covers_with_author_conflict"] += 1
            link_isbns[cover["cover_url"]].add(searched)
        result.append({
            "po_isbn": searched if searched in book["keys"] else min(book["keys"]),
            "isbn13": searched,
            "title": next(iter(book["titles"].values()), searched),
            "covers": covers,
        })
        suffix = "_candidates" if review_covers else "_isbn_candidates"
        stats[covers[0]["match"] + suffix] += 1
    for book in result:
        for cover in book["covers"]:
            cover["shared_cover_url"] = len(link_isbns[cover["cover_url"]]) > 1

    stats.update(row["reason"] for row in review.values())
    stats["master_rows"] = len(master)
    stats["master_valid_isbns"] = len(books)
    stats["isbn_candidates"] = len(result)
    stats["shared_cover_urls"] = sum(len(isbns) > 1 for isbns in link_isbns.values())
    outside_covers = [cover for cover in outside.values() if cover["cover_url"] not in link_isbns]
    stats["outside_master_candidates"] = len(outside_covers)
    return result, list(review.values()), outside_covers, stats


class ImageRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_url(newurl):
            raise ValueError("unapproved_image_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_cover(url):
    if not allowed_url(url):
        raise ValueError("unapproved_image_url")
    for attempt in range(3):
        try:
            with build_opener(ImageRedirects()).open(url, timeout=8) as response:
                content = response.read(MAX_BYTES + 1)
                if len(content) > MAX_BYTES:
                    raise ValueError("image_too_large")
                return content
        except HTTPError as error:
            code = error.code
            error.close()
            if code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                raise ValueError(f"download_http_{code}") from error
        except (URLError, OSError) as error:
            if attempt == 2:
                raise ValueError("download_failed") from error
        sleep(2 ** attempt)


def normalize_cover(content, allow_static_gif=False):
    from PIL import Image, ImageOps

    try:
        with Image.open(BytesIO(content)) as source:
            supported = source.format in {"JPEG", "PNG", "WEBP"} or (
                allow_static_gif and source.format == "GIF" and source.n_frames == 1
            )
            if not supported or source.width * source.height > 20_000_000:
                raise ValueError("unsupported_image")
            image = ImageOps.exif_transpose(source).convert("RGB")
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError("broken_image") from error
    if min(image.size) < 64:
        raise ValueError("image_too_small")
    if max(high - low for low, high in image.getextrema()) < 12:
        raise ValueError("generic_cover")
    image.thumbnail((768, 768))
    encoded = BytesIO()
    image.save(encoded, "JPEG", quality=90)
    return encoded.getvalue()


def write_atomic(path, content):
    with NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        staged = Path(temp.name)
        try:
            temp.write(content)
            temp.close()
            staged.replace(path)
        finally:
            staged.unlink(missing_ok=True)


def check_book(book, output):
    failures = []
    for cover in book["covers"]:
        try:
            content = normalize_cover(download_cover(cover["cover_url"]))
        except ValueError as error:
            failures.append({**cover, "po_isbn": book["po_isbn"], "reason": str(error)})
            continue
        digest = sha256(content).hexdigest()
        path = f"images/{digest}.jpg"
        write_atomic(output / path, content)
        return {
            **cover, "po_isbn": book["po_isbn"], "title": book["title"],
            "image_sha256": digest, "image_path": path,
            **({"amazon_isbn": cover["found_isbn"]} if cover["match"] == "approved_replacement" else {}),
        }, failures
    return None, failures


def starter_books(books, limit):
    cases = json.loads((ROOT / "tests/fixtures/cover-match-cases.json").read_text())["cases"]
    fixture_ids = {code for case in cases for code in case.get("expectedTopThree", [])}
    fixture_ids.update(item["isbn"] for case in cases for item in case.get("ambiguousIdentities", []))
    chosen = [book for book in books if book["isbn13"] in fixture_ids][:limit]
    chosen_ids = {book["isbn13"] for book in chosen}
    shared_links = defaultdict(list)
    for book in books:
        first_cover = book["covers"][0]
        if first_cover["shared_cover_url"]:
            shared_links[first_cover["cover_url"]].append(book)
    for matches in shared_links.values():
        if (1 < len(matches) <= limit - len(chosen)
                and len({title_key(book["title"]) for book in matches}) == 1
                and not any(book["isbn13"] in chosen_ids for book in matches)):
            chosen.extend(matches)
            chosen_ids.update(book["isbn13"] for book in matches)
            break
    groups = defaultdict(list)
    for book in books:
        if book["isbn13"] not in chosen_ids:
            scripts = tuple(sorted({
                (ord(c) - 0x900) // 0x80 for c in book["title"] if 0x900 <= ord(c) <= 0xD7F
            }))
            groups[book["covers"][0]["match"], scripts].append(book)
    for group in groups.values():
        group.sort(key=lambda book: sha256(book["isbn13"].encode()).digest())
    for index in range(limit):
        for group in groups.values():
            if len(chosen) == limit:
                return chosen
            if index < len(group):
                chosen.append(group[index])
    return chosen


def make_queries(covers, output):
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    by_image = defaultdict(list)
    for cover in covers:
        by_image[cover["image_sha256"]].append(cover)
    for digest, matches in sorted(by_image.items()):
        expected = sorted(cover["po_isbn"] for cover in matches if cover["po_isbn"])
        if expected and any(not cover["po_isbn"] for cover in matches):
            continue  # This image cannot be a reliable outside-catalog test.
        with Image.open(output / matches[0]["image_path"]) as image:
            width, height = image.size
            queries = {
                "tilted": ImageOps.crop(image, (width // 20, height // 20)).rotate(9, expand=True, fillcolor="#ece6df"),
                "dim_blur": ImageEnhance.Brightness(image).enhance(0.65).filter(ImageFilter.GaussianBlur(1.3)),
            }
        for variation, query in queries.items():
            path = f"queries/{digest}-{variation}.jpg"
            encoded = BytesIO()
            query.save(encoded, "JPEG", quality=86)
            write_atomic(output / path, encoded.getvalue())
            yield {
                "image_path": path, "source_image_sha256": digest, "variation": variation,
                "expected_po_isbns": expected, "origin": "modified_amazon_cover",
                "split": "holdout" if int(digest[:2], 16) % 4 == 0 else "tuning",
            }


def write_jsonl(path, rows):
    write_atomic(path, "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode())


def check_sample(output, candidates, outside, limit, review):
    for name in ("images", "queries"):
        (output / name).mkdir()
    starter = starter_books(candidates, limit)
    outside.sort(key=lambda cover: sha256(cover["found_isbn"].encode()).digest())
    negatives = [{"po_isbn": None, "title": None, "covers": [{**cover, "match": "outside_master"}]}
                 for cover in outside[:min(8, limit)]]
    covers = []
    checked_negatives = []
    stats = Counter()
    with ThreadPoolExecutor(max_workers=6) as pool:
        for cover, failures in pool.map(lambda book: check_book(book, output), [*starter, *negatives]):
            review.extend(failures)
            stats.update(row["reason"] for row in failures)
            if cover:
                (covers if cover["po_isbn"] else checked_negatives).append(cover)
    duplicates = Counter(cover["image_sha256"] for cover in covers)
    for cover in covers:
        cover["shared_cover"] = cover["shared_cover_url"] or duplicates[cover["image_sha256"]] > 1
    queries = list(make_queries([*covers, *checked_negatives], output))
    write_jsonl(output / "covers.jsonl", covers)
    write_jsonl(output / "queries.jsonl", queries)
    stats.update({
        "sample_po_isbns": len(starter),
        "sample_usable_covers": len(covers),
        "sample_usable_outside_covers": len(checked_negatives),
        "sample_queries": len(queries),
        "sample_shared_covers": sum(cover["shared_cover"] for cover in covers),
    })
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scrape", type=Path, required=True)
    parser.add_argument("--master", type=Path, default=ROOT / "public/master.json")
    parser.add_argument("--editions", type=Path, default=ROOT / "data/amazon-editions.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/cover-search/phase-1")
    parser.add_argument("--sample-size", type=int, default=0, help="Number of PO ISBNs to check over HTTPS")
    parser.add_argument("--review-covers", action="store_true", help="Prepare unverified covers for a separate index")
    args = parser.parse_args()
    if args.sample_size < 0:
        parser.error("--sample-size must be zero or greater")
    if args.review_covers and args.sample_size:
        parser.error("Use --sample-size 0 for the unverified cover list.")
    output = args.output.resolve()
    if output.exists():
        parser.error("Choose a new --output directory to keep completed runs separate.")
    if args.sample_size:
        try:
            import PIL
        except ImportError:
            parser.error("Image checks require Pillow. Install it or use --sample-size 0 for the ISBN join only.")

    def read_json(path):
        return json.loads(path.read_text(encoding="utf-8"))

    inputs = {name: input_info(getattr(args, name)) for name in ("master", "editions", "scrape")}
    candidates, review, outside, stats = prepare_catalog(read_json(args.master), read_json(args.editions), args.scrape, args.review_covers)
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as temp:
        staging = Path(temp) / "prepared"
        staging.mkdir()
        write_jsonl(staging / "candidates.jsonl", candidates)
        if args.sample_size:
            stats.update(check_sample(staging, candidates, outside, args.sample_size, review))
        write_jsonl(staging / "review.jsonl", review)
        report = {"inputs": inputs, "stats": dict(sorted(stats.items()))}
        write_atomic(staging / "summary.json", (json.dumps(report, indent=2) + "\n").encode())
        staging.rename(output)
    print(json.dumps(report["stats"], indent=2))
    if args.sample_size and not stats["sample_usable_covers"]:
        parser.exit(1, "No PO covers could be checked. See review.jsonl for the failures.\n")


if __name__ == "__main__":
    main()
