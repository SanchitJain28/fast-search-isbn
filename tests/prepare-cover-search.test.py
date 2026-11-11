"""Run with python3 tests/prepare-cover-search.test.py."""

from io import BytesIO
import json
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


SCRIPT = run_path(str(Path(__file__).resolve().parents[1] / "scripts/prepare-cover-search.py"))
PO = "9789500714006"
REPLACEMENT = "9780700702008"
UNAPPROVED = "9780367411718"
OTHER = "9788184469660"
BASE = "https://m.media-amazon.com/images/I/"


def listing(searched, found, cover, matched=False, author=None):
    return dict(searched_isbn=searched, found_isbn=found, found=True, isbn_matched=matched,
                cover_url=BASE + cover, author=author)


class CoverPreparationTest(unittest.TestCase):
    def test_static_gif_support_is_opt_in_and_keeps_minimum_size(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is required for image checks")
        normalize = SCRIPT["normalize_cover"]
        image = Image.new("RGB", (160, 320), "white")
        image.paste("black", (0, 0, 80, 320))
        content = BytesIO()
        image.save(content, "GIF")
        with self.assertRaisesRegex(ValueError, "unsupported_image"):
            normalize(content.getvalue())
        with Image.open(BytesIO(normalize(content.getvalue(), allow_static_gif=True))) as cover:
            self.assertEqual(cover.format, "JPEG")
        tiny = BytesIO()
        image.resize((60, 40)).save(tiny, "GIF")
        with self.assertRaisesRegex(ValueError, "image_too_small"):
            normalize(tiny.getvalue(), allow_static_gif=True)

    def test_unverified_cover_list_uses_isbn_evidence_and_accepts_other_titles(self):
        master = [
            {"ISBN13": PO, "Order": "A", "Title": "Título"},
            {"ISBN13": OTHER, "Order": "B", "Title": "தமிழ்"},
            {"ISBN13": REPLACEMENT, "Order": "C", "Title": "A verified book"},
        ]
        rows = [
            {**listing(PO, UNAPPROVED, "foreign-title.jpg"), "title": "Another language"},
            listing(OTHER, "missing", "unknown-isbn.jpg"),
            listing(REPLACEMENT, UNAPPROVED, "unverified.jpg"),
            listing(REPLACEMENT, REPLACEMENT, "verified.jpg", matched=True),
        ]
        with TemporaryDirectory() as directory:
            source = Path(directory) / "scrape.jsonl"
            source.write_text("".join(json.dumps(row) + "\n" for row in rows))
            candidates, _, _, stats = SCRIPT["prepare_catalog"](master, {"mappings": [], "conflicts": []}, source, review_covers=True)

        by_isbn = {book["po_isbn"]: book["covers"][0] for book in candidates}
        self.assertEqual(set(by_isbn), {PO, OTHER})
        self.assertEqual(by_isbn[PO]["listing_title"], "Another language")
        self.assertEqual(by_isbn[PO]["found_isbn"], UNAPPROVED)
        self.assertEqual(by_isbn[OTHER]["match"], "review_no_valid_isbn")
        self.assertIsNone(by_isbn[OTHER]["found_isbn"])
        self.assertEqual(stats["isbn_candidates"], 2)

    def test_catalog_join_keeps_packing_key_and_holds_unapproved_covers(self):
        master = [
            {"ISBN13": "'950-0714000", "Order": "A", "Title": "Título", "Author": "Ana"},
            {"ISBN13": "9500714000", "Order": "B", "Title": "Título", "Author": "Ana"},
            {"ISBN13": OTHER, "Order": "B", "Title": "முதல் தலைப்பு"},
            {"ISBN13": OTHER, "Order": "C", "Title": "இரண்டாம் தலைப்பு"},
        ]
        editions = {
            "mappings": [dict(barcode=REPLACEMENT, poIsbn="9500714000", order="A", quantity=1)],
            "conflicts": [],
        }
        rows = [
            listing(PO, REPLACEMENT, "replacement.jpg"),
            listing(PO, PO, "front.jpg", matched=True, author="Different Author"),
            listing(PO, "9500714000", "front.jpg", matched=True),
            listing(PO, UNAPPROVED, "unapproved.jpg"),
            listing(PO, PO, "11vdokru0FL._SL1500_.jpg", matched=True),
            listing(OTHER, OTHER, "conflicting-master.jpg", matched=True),
        ]
        with TemporaryDirectory() as directory:
            source = Path(directory) / "scrape.jsonl"
            source.write_text("".join(json.dumps(row) + "\n" for row in rows))
            candidates, review, outside, stats = SCRIPT["prepare_catalog"](master, editions, source)

        self.assertEqual(len(candidates), 1)
        book = candidates[0]
        self.assertEqual((book["po_isbn"], book["title"]), ("9500714000", "Título"))
        self.assertEqual([cover["match"] for cover in book["covers"]], ["exact", "approved_replacement"])
        self.assertNotIn("author", book["covers"][0])
        self.assertEqual(outside[0]["found_isbn"], UNAPPROVED)
        self.assertEqual({row["reason"] for row in review},
                         {"unconfirmed_edition", "generic_cover", "unclear_master_book"})
        self.assertEqual(stats["covers_with_author_conflict"], 1)

    def test_broken_exact_cover_can_fall_back_to_approved_edition(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is required for image checks")
        image = Image.new("RGB", (160, 320), "white")
        image.paste("black", (0, 0, 80, 320))
        encoded = BytesIO()
        image.save(encoded, "PNG")
        book = {
            "po_isbn": PO, "title": "Book",
            "covers": [
                {"cover_url": BASE + "broken.jpg", "match": "exact", "found_isbn": PO},
                {"cover_url": BASE + "replacement.jpg", "match": "approved_replacement", "found_isbn": REPLACEMENT},
            ],
        }

        def download(url):
            return b"not an image" if url.endswith("broken.jpg") else encoded.getvalue()

        check_book = SCRIPT["check_book"]
        with TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "images").mkdir()
            (output / "queries").mkdir()
            with patch.dict(check_book.__globals__, {"download_cover": download}):
                cover, failures = check_book(book, output)
            with Image.open(output / cover["image_path"]) as saved:
                self.assertEqual((saved.format, saved.size), ("JPEG", (160, 320)))
            shared = {**cover, "po_isbn": OTHER}
            queries = list(SCRIPT["make_queries"]([cover, shared], output))

        self.assertEqual(cover["amazon_isbn"], REPLACEMENT)
        self.assertEqual(failures[0]["reason"], "broken_image")
        self.assertEqual(len(queries), 2)
        self.assertTrue(all(row["expected_po_isbns"] == sorted([PO, OTHER]) for row in queries))
        self.assertEqual(len({row["split"] for row in queries}), 1)


if __name__ == "__main__":
    unittest.main()
