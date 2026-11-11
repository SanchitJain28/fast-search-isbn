#!/usr/bin/env python3
"""Generate a reviewed Amazon barcode map and row audit (requires openpyxl)."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re

from openpyxl import load_workbook


# Worksheet layout: (order, header row, PO ISBN, Amazon ISBN, qty, match label).
# The combined ZB346 tab takes its order from column S on each row.
LAYOUTS = {
    "ZBBID-3_4NOV_ALL": ("ZBBID-3", 5, "B", "G", "J", "H"),
    "ZBIN-1_3NOV_ALL(-)DIRECTPUB": ("ZBIN-1", 3, "B", "D", "L", "G"),
    "ZBW2_2NOV_ALL_VIEWONLY": ("ZBW-2", 5, "B", "J", "L", "M"),
    "PREP3_2NOV_ALLAMZNAVL": ("ZBPREP-3", 1, "B", "C", "I", "O"),
    "ZB346+ZB346B_2NOV_UNDER3_POD_NO": ("@S", 5, "B", "I", "L", "J"),
    "SEA1_2NOV_ALLREMAINING": ("SEA-1", 1, "A", "F", "I", "G"),
    "ZBPREP4_2NOV_ALLREMAINING": ("ZBPREP-4", 4, "B", "G", "F", "R"),
    "ZBW_31OCT_ALLREMAINING_VIEWONLY": ("ZBW", 5, "B", "J", "M", "K"),
    "ZBBID2_31OCT_ALLREMAINING": ("ZBBID-2", 5, "B", "J", "M", "K"),
    "ZBBID1_27OCT_ALLTITLES": ("ZBBID-1", 4, "A", "H", "I", "J"),
    "ZB345_24_OCT_UNDER3&POD&NOPUB": ("ZB345", 5, "B", "I", "K", "R"),
    "ZB3441_23_OCT_UNDER3&POD": ("ZB344", 5, "B", "H", "V", "G"),
    "ZB3442_14TH_OCT_UNDER3&POD&NOPU": ("ZB344", 8, "B", "H", None, "K"),
    "ZB343_8TH_OCT_UNDER3&POD": ("ZB343", 5, "D", "K", None, "J"),
    "PREP_1_5TH_OCT_LESSTHEN3": ("ZBPREP-1", 6, "A", "I", None, "H"),
    "ZBR_ALOK_SHORT_10": ("ZBR", 1, "B", None, None, None),
    "ZBR_AMAZON_32_17THSEP": ("ZBR", 1, "B", None, None, None),
    "ZBR_AMAZON_205_16th_sep": ("ZBR", 1, "B", None, None, "L"),
    "317_AMAZON_12SEP_50BOOK": ("317", 1, "A", None, None, None),
    "327_AMAZON_120_12SEP": ("327", 6, "B", None, None, "D"),
    "323_Amazon_Buy_AFTER_KALPATARU_": ("323", 4, "B", None, None, None),
    "OX-2_Amazon_denied_29_FROM_VAJR": ("OX2", 1, "A", None, "D", None),
    "317_Amazon_Buy_List_254_AFTER_D": ("317", 1, "A", None, None, None),
    "327_Amazon_Reorder_45_ALOK_AND_": ("327", 6, "B", None, None, None),
    "AMAZON ORDER 267 FROM ORDER OX2": ("OX2", 1, "A", "E", None, "F"),
    "327_Amazon Buy List (585)": ("327", 6, "B", "H", None, "O"),
    "FOR AMAZON OX-2 ORDER 579": ("OX2", 1, "A", None, None, "E"),
    "Amazon Buy List(1 - 4) 327": ("327", 6, "B", None, None, None),
    "Amazon Batch 2 (5-9) 327": ("327", 6, "B", None, None, "J"),
    "AMAZON BATCH 3 - 88 FROM ORDER": ("327", 1, "A", None, None, None),
    "AMAZONBATCH4 - ORDER 327": ("327", 1, "A", None, None, "I"),
    "ZBW_31OCT_ALLREMAINING_BACKUP": ("ZBW", 5, "B", "J", "M", "K"),
    "ZBW2_2NOV_ALL_BACKUP": ("ZBW-2", 5, "B", "G", "J", "H"),
}
SKIPPED = {
    "ZB337_27OCT_6+AVAILABLE",
    "ZB337_6THOCT_3_4_5_PROFITABLE",
    "337_23rd_SEP_LESSTHEN3",
    "322_22nd_SEP_AFTERKALPATRUFINAL",
    "322_Amazon_Buy_46_From_UNSOURCE",
    "322_AMAZON_15THSEP",
    "ZBR_AMAZON_ORDER_BATCH_1",
}
YELLOW = {"FFFF00", "FFF2CC", "FFF9C4", "FFEB9C"}
ISBN_MISMATCH = re.compile(
    r"\b(?:isbn\s*[-–:]?\s*(?:not match\w*|mismatch)|"
    r"(?:different|diff)\s*(?:[-–]\s*)?(?:isbn|edition))\b", re.I
)


def text(value):
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value if value is not None else "").strip()


def normalize(value):
    return re.sub(r"[\s-]", "", text(value).lstrip("'").upper())


def isbn13(value):
    value = normalize(value)
    if re.fullmatch(r"\d{9}[\dX]", value):
        digits = [int(d) for d in value[:9]] + [10 if value[-1] == "X" else int(value[-1])]
        if sum((10-i)*d for i, d in enumerate(digits)) % 11:
            return None
        value = "978" + value[:9]
    elif not re.fullmatch(r"97[89]\d{10}", value):
        return None
    digit = str(-sum(int(d)*(1 if i % 2 == 0 else 3) for i, d in enumerate(value[:12])) % 10)
    return value[:12] + digit if len(value) == 12 or value[-1] == digit else None


def yellow(cell):
    fill = cell.fill
    return fill.patternType == "solid" and fill.fgColor.type == "rgb" and fill.fgColor.rgb[-6:] in YELLOW


def extract(workbook, catalog):
    order_copies = Counter((normalize(r["ISBN13"]), text(r["Order"])) for r in catalog)
    exact = defaultdict(set)
    for po, order in order_copies:
        code = isbn13(po)
        if code:
            exact[code].add((po, order))

    rows = []
    candidates = defaultdict(list)
    for sheet in workbook:
        name = sheet.title.strip()
        if name in SKIPPED:
            continue
        order_rule, header, po_col, amazon_col, qty_col, match_col = LAYOUTS[name]
        # Build row groups from populated cells, including explicitly styled blanks.
        grouped = defaultdict(dict)
        for cell in sheet._cells.values():
            if cell.row > header:
                grouped[cell.row][cell.column_letter] = cell
        for number, cells in sorted(grouped.items()):
            def value(col):
                return cells[col].value if col in cells else None

            po = normalize(value(po_col))
            if not re.fullmatch(r"\d{9,13}X?", po):
                continue
            label = text(value(match_col))
            marked = (
                bool(re.match(r"^(?:no\b|title(?: match)?$|title match \(other edition\))", label, re.I))
                or any(yellow(c) or ISBN_MISMATCH.search(text(c.value)) for c in cells.values())
            )
            order = text(value(order_rule[1:])) if order_rule.startswith("@") else order_rule
            raw_amazon = text(value(amazon_col))
            barcode = isbn13(raw_amazon)
            record = dict(sheet=sheet.title, row=number, order=order, poIsbn=po, amazonIsbn=raw_amazon, match=label)
            if not marked:
                if barcode and isbn13(po) and barcode != isbn13(po):
                    rows.append(dict(record, result="unmarked_different_isbn"))
                continue
            rows.append(record)
            if not raw_amazon or raw_amazon.upper() in {"N/A", "NA", "-"}:
                record["result"] = "missing_amazon_isbn"
            elif barcode is None:
                record["result"] = "invalid_amazon_isbn"
            elif barcode == isbn13(po) or normalize(raw_amazon) == po:
                record["result"] = "same_isbn"
            else:
                qty = text(value(qty_col)) if qty_col else "1"
                record.update(barcode=barcode, quantity=int(qty) if re.fullmatch(r"[1-9]\d*", qty) else None)
                candidates[barcode].append(record)

    mappings = []
    conflicts = []
    for barcode, records in sorted(candidates.items()):
        targets = {(r["poIsbn"], r["order"]) for r in records}
        if len(targets) > 1 or exact[barcode]:
            reason = "multiple_po_targets" if len(targets) > 1 else "exact_po_collision"
            conflicts.append({"barcode": barcode, "targets": [list(target) for target in sorted(targets | exact[barcode])]})
        else:
            po, order = next(iter(targets))
            available = order_copies[po, order]
            quantities = {r["quantity"] for r in records}
            if not available:
                reason = "po_order_missing"
            elif None in quantities or len(quantities) != 1 or next(iter(quantities)) > available:
                reason = "quantity_needs_review"
            else:
                reason = "mapped"
                mappings.append(dict(barcode=barcode, poIsbn=po, order=order, quantity=next(iter(quantities))))
        for record in records:
            record["result"] = reason
    return mappings, conflicts, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    workbook = load_workbook(args.workbook, data_only=True)
    names = {sheet.title.strip() for sheet in workbook}
    unknown = names - LAYOUTS.keys() - SKIPPED
    if unknown:
        parser.error(f"Review the layout of these worksheets before importing: {sorted(unknown)}")
    with args.catalog.open() as source:
        mappings, conflicts, rows = extract(workbook, json.load(source))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {
        "amazon-editions.json": dict(mappings=mappings, conflicts=conflicts),
        "audit.json": dict(workbook=args.workbook.name, skippedTabs=sorted(names & SKIPPED), rows=rows),
    }
    for name, contents in outputs.items():
        with (args.output_dir / name).open("w") as destination:
            json.dump(contents, destination, indent=2, ensure_ascii=False)
            destination.write("\n")
    print(f"{len(mappings)} mappings; {len(conflicts)} conflicting barcodes")
    print(dict(Counter(row["result"] for row in rows)))


if __name__ == "__main__":
    main()
