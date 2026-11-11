"""Check candidate covers for the backfill and return normalized JPEG bytes."""

from base64 import b64encode
from hashlib import sha256
import json
from pathlib import Path
from runpy import run_path
import sys

import PIL


preparation = run_path(str(Path(__file__).with_name("prepare-cover-search.py")))
download_cover = preparation["download_cover"]
normalize_cover = preparation["normalize_cover"]


def prepare(book):
    failures = []
    for cover in book["covers"]:
        try:
            review_cover = cover["match"] in {"review_different_isbn", "review_no_valid_isbn"}
            content = normalize_cover(download_cover(cover["cover_url"]), allow_static_gif=review_cover)
        except ValueError as error:
            failures.append({"cover_url": cover["cover_url"], "reason": str(error)})
            continue
        return {
            "cover": cover, "image_sha256": sha256(content).hexdigest(),
            "image": b64encode(content).decode("ascii"), "failures": failures,
        }
    return {"failures": failures}


if __name__ == "__main__":
    for line in sys.stdin:
        print(json.dumps(prepare(json.loads(line))), flush=True)
