#!/usr/bin/python3

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Iterable, Optional


MAIN_HEADER = "DATUM TYP BESCHREIBUNG ZAHLUNGSEINGANG ZAHLUNGSAUSGANG SALDO"
FUND_HEADER = "DATUM ZAHLUNGSART GELDMARKTFONDS STÜCK KURS PRO STÜCK BETRAG"
KNOWN_TRANSACTION_TYPES = [
    "SEPA-Lastschrift",
    "Kartentransaktion",
    "Überweisung",
    "Empfehlung",
    "Zinsen",
    "Bonus",
    "Ertrag",
    "Handel",
    "Steuern",
]
EURO_RE = re.compile(r"-?\d{1,3}(?:\.\d{3})*,\d{2} €")
FUND_RE = re.compile(
    r"^(?P<date>\d{2} [A-Za-zÄÖÜäöüß]+\.? \d{4}) "
    r"(?P<payment_type>Kauf|Verkauf) "
    r"(?P<fund>.+?) "
    r"(?P<isin>[A-Z0-9]{12}) "
    r"(?P<units>\d{1,3}(?:\.\d{3})*,\d{2}) "
    r"(?P<price>-?\d{1,3}(?:\.\d{3})*,\d{2} €) "
    r"(?P<amount>-?\d{1,3}(?:\.\d{3})*,\d{2} €)$"
)
MONTHS = {
    "Jan": "01",
    "Jan.": "01",
    "Feb": "02",
    "Feb.": "02",
    "März": "03",
    "März.": "03",
    "Mrz": "03",
    "Mrz.": "03",
    "Apr": "04",
    "Apr.": "04",
    "Mai": "05",
    "Juni": "06",
    "Jun.": "06",
    "Juli": "07",
    "Jul.": "07",
    "Aug": "08",
    "Aug.": "08",
    "Sep.": "09",
    "Sept.": "09",
    "Okt.": "10",
    "Nov.": "11",
    "Dez.": "12",
}
SWIFT_EXTRACTION_SCRIPT = r"""
import Foundation
import PDFKit

struct Fragment: Codable {
  let page: Int
  let x: Double
  let y: Double
  let text: String
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
  fputs("Failed to open PDF.\n", stderr)
  exit(1)
}

var fragments: [Fragment] = []
for pageIndex in 0..<document.pageCount {
  guard let page = document.page(at: pageIndex) else { continue }
  guard let selection = page.selection(for: page.bounds(for: .mediaBox)) else { continue }
  for line in selection.selectionsByLine() {
    let text = (line.string ?? "")
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    let bounds = line.bounds(for: page)
    fragments.append(Fragment(page: pageIndex + 1, x: Double(bounds.origin.x), y: Double(bounds.origin.y), text: text))
  }
}

let encoder = JSONEncoder()
let data = try encoder.encode(fragments)
FileHandle.standardOutput.write(data)
"""


@dataclass(frozen=True)
class Fragment:
    page: int
    x: float
    y: float
    text: str


@dataclass
class TransactionRow:
    page: int
    date_original: str
    date: str
    type: str
    description: str
    amount_in: str
    amount_out: str
    signed_amount: str
    balance: str
    raw_row: str


@dataclass
class FundRow:
    page: int
    date_original: str
    date: str
    payment_type: str
    fund: str
    isin: str
    units: str
    price_per_unit: str
    amount: str
    raw_row: str


def normalize_fingerprint_part(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def canonical_row_fingerprint(parts: Iterable[object]) -> str:
    normalized = [normalize_fingerprint_part(part) for part in parts]
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def stable_row_id(prefix: str, fingerprint: str) -> str:
    digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    return f"{prefix}_{digest}"


def transaction_row_fingerprint(row: TransactionRow) -> str:
    return canonical_row_fingerprint(
        [
            "transactions",
            row.page,
            row.date,
            row.date_original,
            row.type,
            row.description,
            row.signed_amount,
            row.balance,
            row.raw_row,
        ]
    )


def fund_row_fingerprint(row: FundRow) -> str:
    return canonical_row_fingerprint(
        [
            "money_market_fund",
            row.page,
            row.date,
            row.date_original,
            row.payment_type,
            row.fund,
            row.isin,
            row.units,
            row.price_per_unit,
            row.amount,
            row.raw_row,
        ]
    )


def dedupe_transaction_rows(rows: list[TransactionRow]) -> tuple[list[TransactionRow], int]:
    deduped: list[TransactionRow] = []
    seen: set[str] = set()
    dropped = 0
    for row in rows:
        fingerprint = transaction_row_fingerprint(row)
        if fingerprint in seen:
            dropped += 1
            continue
        seen.add(fingerprint)
        deduped.append(row)
    return deduped, dropped


def dedupe_fund_rows(rows: list[FundRow]) -> tuple[list[FundRow], int]:
    deduped: list[FundRow] = []
    seen: set[str] = set()
    dropped = 0
    for row in rows:
        fingerprint = fund_row_fingerprint(row)
        if fingerprint in seen:
            dropped += 1
            continue
        seen.add(fingerprint)
        deduped.append(row)
    return deduped, dropped


def transaction_row_id(row: TransactionRow) -> str:
    return stable_row_id("tx", transaction_row_fingerprint(row))


def fund_row_id(row: FundRow) -> str:
    return stable_row_id("fund", fund_row_fingerprint(row))


def compute_statement_fingerprint(transaction_rows: list[TransactionRow], fund_rows: list[FundRow]) -> str:
    row_ids = sorted(
        [transaction_row_id(row) for row in transaction_rows]
        + [fund_row_id(row) for row in fund_rows]
    )
    payload = "\n".join(row_ids)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_parse_metadata(
    path: Path,
    transaction_rows: list[TransactionRow],
    fund_rows: list[FundRow],
    transaction_duplicates_dropped: int,
    fund_duplicates_dropped: int,
) -> None:
    payload = {
        "transaction_row_count": len(transaction_rows),
        "fund_row_count": len(fund_rows),
        "duplicates_dropped": transaction_duplicates_dropped + fund_duplicates_dropped,
        "transaction_duplicates_dropped": transaction_duplicates_dropped,
        "fund_duplicates_dropped": fund_duplicates_dropped,
        "statement_fingerprint": compute_statement_fingerprint(transaction_rows, fund_rows),
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=True)
        handle.write("\n")


def english_output_name(value: str) -> str:
    translated = value
    translated = re.sub(r"(?i)kontoauszug", "statement", translated)
    translated = re.sub(r"(?i)geldmarktfonds", "money_market_fund", translated)
    return translated


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a Trade Republic PDF statement into CSV files."
    )
    parser.add_argument("pdf", help="Path to the PDF statement.")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for the generated CSV files. Defaults to the PDF folder.",
    )
    parser.add_argument(
        "--prefix",
        default=None,
        help="Prefix for output filenames. Defaults to the PDF filename without .pdf.",
    )
    return parser.parse_args()


def ensure_environment() -> None:
    if sys.platform != "darwin":
        raise SystemExit("This script requires macOS because it uses PDFKit via Swift.")
    if not Path("/usr/bin/swift").exists():
        raise SystemExit("Missing /usr/bin/swift.")


def parse_euro(text: str) -> Decimal:
    return Decimal(text.replace(" €", "").replace(".", "").replace(",", "."))


def format_decimal(value: Optional[Decimal]) -> str:
    if value is None:
        return ""
    return f"{value:.2f}"


def join_texts(parts: Iterable[str]) -> str:
    joined = ""
    for part in parts:
        compact = re.sub(r"\s+", " ", part.strip())
        if not compact:
            continue
        if not joined:
            joined = compact
        elif joined.endswith("-"):
            joined += compact.lstrip()
        else:
            joined += f" {compact}"
    return re.sub(r"\s+", " ", joined).strip()


def parse_date(date_text: str) -> str:
    tokens = date_text.split()
    if len(tokens) < 3:
        return ""
    day = tokens[0].replace(".", "")
    month = MONTHS.get(tokens[1], MONTHS.get(tokens[1].rstrip(".")))
    year = tokens[2]
    if not month:
        return ""
    return f"{year}-{month}-{int(day):02d}"


def split_type_and_description(body_without_amounts: str) -> tuple[str, str]:
    for known_type in KNOWN_TRANSACTION_TYPES:
        if body_without_amounts == known_type:
            return known_type, ""
        prefix = f"{known_type} "
        if body_without_amounts.startswith(prefix):
            return known_type, body_without_amounts[len(prefix) :].strip()
    first, _, rest = body_without_amounts.partition(" ")
    return first, rest.strip()


def run_swift_extraction(pdf_path: Path) -> list[Fragment]:
    with tempfile.NamedTemporaryFile("w", suffix=".swift", delete=False) as handle:
        handle.write(SWIFT_EXTRACTION_SCRIPT)
        swift_path = Path(handle.name)
    try:
        raw = subprocess.check_output(
            ["/usr/bin/swift", str(swift_path), str(pdf_path)],
            text=True,
        )
    finally:
        swift_path.unlink(missing_ok=True)
    decoded = json.loads(raw)
    return [Fragment(**item) for item in decoded]


def group_pages(fragments: list[Fragment]) -> dict[int, list[Fragment]]:
    pages: dict[int, list[Fragment]] = defaultdict(list)
    for fragment in fragments:
        pages[fragment.page].append(fragment)
    return pages


def cluster_date_fragments(fragments: list[Fragment]) -> list[list[Fragment]]:
    date_fragments = sorted(
        [fragment for fragment in fragments if fragment.x < 100],
        key=lambda fragment: -fragment.y,
    )
    clusters: list[list[Fragment]] = []
    for fragment in date_fragments:
        if not clusters or clusters[-1][-1].y - fragment.y > 12:
            clusters.append([fragment])
        else:
            clusters[-1].append(fragment)
    return clusters


def get_starting_balance(page_one_fragments: list[Fragment]) -> Decimal:
    for fragment in page_one_fragments:
        if fragment.text.startswith("Cashkonto "):
            amounts = EURO_RE.findall(fragment.text)
            if amounts:
                return parse_euro(amounts[0])
    return Decimal("0.00")


def build_transaction_rows(
    page_number: int,
    page_fragments: list[Fragment],
) -> list[dict[str, object]]:
    headers = [fragment for fragment in page_fragments if fragment.text == MAIN_HEADER]
    if not headers:
        return []

    header_y = max(fragment.y for fragment in headers)
    content = [fragment for fragment in page_fragments if 95 < fragment.y < header_y - 1]
    row_clusters = cluster_date_fragments(content)
    row_tops = [cluster[0].y for cluster in row_clusters]

    rows: list[dict[str, object]] = []
    for index, cluster in enumerate(row_clusters):
        row_top = cluster[0].y
        row_bottom = row_tops[index + 1] if index + 1 < len(row_tops) else 95
        band = [fragment for fragment in content if row_bottom < fragment.y <= row_top + 0.01]
        cluster_keys = {(fragment.x, fragment.y, fragment.text) for fragment in cluster}

        date_parts: list[tuple[float, str]] = []
        lead_parts: list[tuple[float, str]] = []
        description_parts: list[tuple[float, str]] = []
        amount_parts: list[tuple[float, float, str]] = []

        for fragment in band:
            fragment_key = (fragment.x, fragment.y, fragment.text)
            if fragment_key in cluster_keys and fragment.x < 100:
                match = re.match(r"^(\d{4})\s+(.*)$", fragment.text)
                if match:
                    date_parts.append((fragment.y, match.group(1)))
                    remainder = match.group(2).strip()
                    if remainder:
                        lead_parts.append((fragment.y, remainder))
                else:
                    date_parts.append((fragment.y, fragment.text))
            else:
                if fragment.x < 160:
                    lead_parts.append((fragment.y, fragment.text))
                elif fragment.x < 360:
                    description_parts.append((fragment.y, fragment.text))
                else:
                    amount_parts.append((fragment.y, fragment.x, fragment.text))

        date_original = join_texts(
            part for _, part in sorted(date_parts, key=lambda item: -item[0])
        )
        raw_row = join_texts(
            [
                join_texts(part for _, part in sorted(lead_parts, key=lambda item: -item[0])),
                join_texts(
                    part for _, part in sorted(description_parts, key=lambda item: -item[0])
                ),
                join_texts(
                    part
                    for _, _, part in sorted(
                        amount_parts, key=lambda item: (-item[0], item[1])
                    )
                ),
            ]
        )
        if not raw_row:
            continue

        amount_matches = list(EURO_RE.finditer(raw_row))
        amount_value: Optional[Decimal] = None
        balance_value: Optional[Decimal] = None
        description_body = raw_row
        if len(amount_matches) >= 2:
            amount_value = parse_euro(amount_matches[-2].group(0))
            balance_value = parse_euro(amount_matches[-1].group(0))
            description_body = raw_row[: amount_matches[-2].start()].rstrip(" ,")

        row_type, description = split_type_and_description(description_body)
        rows.append(
            {
                "page": page_number,
                "date_original": date_original,
                "date": parse_date(date_original),
                "type": row_type,
                "description": description,
                "amount_value": amount_value,
                "balance_value": balance_value,
                "raw_row": raw_row,
            }
        )
    return rows


def build_fund_rows(page_number: int, page_fragments: list[Fragment]) -> list[FundRow]:
    headers = [fragment for fragment in page_fragments if fragment.text == FUND_HEADER]
    if not headers:
        return []

    header_y = max(fragment.y for fragment in headers)
    content = [fragment for fragment in page_fragments if 95 < fragment.y < header_y - 1]
    row_clusters = cluster_date_fragments(content)
    row_tops = [cluster[0].y for cluster in row_clusters]

    rows: list[FundRow] = []
    for index, cluster in enumerate(row_clusters):
        row_top = cluster[0].y
        row_bottom = row_tops[index + 1] if index + 1 < len(row_tops) else 95
        band = [fragment for fragment in content if row_bottom < fragment.y <= row_top + 0.01]
        left_text = join_texts(
            fragment.text
            for fragment in sorted(
                [fragment for fragment in band if fragment.x < 197],
                key=lambda fragment: (-fragment.y, fragment.x),
            )
        )
        right_text = join_texts(
            fragment.text
            for fragment in sorted(
                [fragment for fragment in band if fragment.x >= 197],
                key=lambda fragment: (-fragment.y, fragment.x),
            )
        )
        raw_row = join_texts([left_text, right_text])
        match = FUND_RE.match(raw_row)
        if not match:
            rows.append(
                FundRow(
                    page=page_number,
                    date_original="",
                    date="",
                    payment_type="",
                    fund="",
                    isin="",
                    units="",
                    price_per_unit="",
                    amount="",
                    raw_row=raw_row,
                )
            )
            continue

        rows.append(
            FundRow(
                page=page_number,
                date_original=match.group("date"),
                date=parse_date(match.group("date")),
                payment_type=match.group("payment_type"),
                fund=match.group("fund"),
                isin=match.group("isin"),
                units=format_decimal(parse_euro(f"{match.group('units')} €")),
                price_per_unit=format_decimal(parse_euro(match.group("price"))),
                amount=format_decimal(parse_euro(match.group("amount"))),
                raw_row=raw_row,
            )
        )
    return rows


def finalize_transaction_rows(
    rows: list[dict[str, object]], starting_balance: Decimal
) -> list[TransactionRow]:
    finalized: list[TransactionRow] = []
    previous_balance = starting_balance

    for row in rows:
        amount_value = row["amount_value"]
        balance_value = row["balance_value"]
        amount_in = ""
        amount_out = ""
        signed_amount = ""

        if isinstance(amount_value, Decimal) and isinstance(balance_value, Decimal):
            diff = balance_value - previous_balance
            if abs(diff - amount_value) <= Decimal("0.02"):
                amount_in = format_decimal(amount_value)
                signed_amount = format_decimal(amount_value)
            elif abs(diff + amount_value) <= Decimal("0.02"):
                amount_out = format_decimal(amount_value)
                signed_amount = format_decimal(-amount_value)
            else:
                if diff > 0:
                    amount_in = format_decimal(diff)
                elif diff < 0:
                    amount_out = format_decimal(-diff)
                signed_amount = format_decimal(diff)
            previous_balance = balance_value

        finalized.append(
            TransactionRow(
                page=int(row["page"]),
                date_original=str(row["date_original"]),
                date=str(row["date"]),
                type=str(row["type"]),
                description=str(row["description"]),
                amount_in=amount_in,
                amount_out=amount_out,
                signed_amount=signed_amount,
                balance=format_decimal(balance_value)
                if isinstance(balance_value, Decimal)
                else "",
                raw_row=str(row["raw_row"]),
            )
        )
    return finalized


def write_transaction_csv(path: Path, rows: list[TransactionRow]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "row_id",
                "page",
                "date",
                "date_original",
                "type",
                "description",
                "signed_amount_eur",
                "payment_in_eur",
                "payment_out_eur",
                "balance_eur",
                "raw_row",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "row_id": transaction_row_id(row),
                    "page": row.page,
                    "date": row.date,
                    "date_original": row.date_original,
                    "type": row.type,
                    "description": row.description,
                    "signed_amount_eur": row.signed_amount,
                    "payment_in_eur": row.amount_in,
                    "payment_out_eur": row.amount_out,
                    "balance_eur": row.balance,
                    "raw_row": row.raw_row,
                }
            )


def write_fund_csv(path: Path, rows: list[FundRow]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "row_id",
                "page",
                "date",
                "date_original",
                "payment_type",
                "fund",
                "isin",
                "units",
                "price_per_unit_eur",
                "amount_eur",
                "raw_row",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "row_id": fund_row_id(row),
                    "page": row.page,
                    "date": row.date,
                    "date_original": row.date_original,
                    "payment_type": row.payment_type,
                    "fund": row.fund,
                    "isin": row.isin,
                    "units": row.units,
                    "price_per_unit_eur": row.price_per_unit,
                    "amount_eur": row.amount,
                    "raw_row": row.raw_row,
                }
            )


def write_combined_csv(
    path: Path, transaction_rows: list[TransactionRow], fund_rows: list[FundRow]
) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "row_id",
                "section",
                "page",
                "date",
                "date_original",
                "type",
                "description",
                "signed_amount_eur",
                "payment_in_eur",
                "payment_out_eur",
                "balance_eur",
                "payment_type",
                "fund",
                "isin",
                "units",
                "price_per_unit_eur",
                "amount_eur",
                "raw_row",
            ],
        )
        writer.writeheader()

        for row in transaction_rows:
            writer.writerow(
                {
                    "row_id": transaction_row_id(row),
                    "section": "transactions",
                    "page": row.page,
                    "date": row.date,
                    "date_original": row.date_original,
                    "type": row.type,
                    "description": row.description,
                    "signed_amount_eur": row.signed_amount,
                    "payment_in_eur": row.amount_in,
                    "payment_out_eur": row.amount_out,
                    "balance_eur": row.balance,
                    "payment_type": "",
                    "fund": "",
                    "isin": "",
                    "units": "",
                    "price_per_unit_eur": "",
                    "amount_eur": "",
                    "raw_row": row.raw_row,
                }
            )
        for row in fund_rows:
            writer.writerow(
                {
                    "row_id": fund_row_id(row),
                    "section": "money_market_fund",
                    "page": row.page,
                    "date": row.date,
                    "date_original": row.date_original,
                    "type": "",
                    "description": "",
                    "signed_amount_eur": "",
                    "payment_in_eur": "",
                    "payment_out_eur": "",
                    "balance_eur": "",
                    "payment_type": row.payment_type,
                    "fund": row.fund,
                    "isin": row.isin,
                    "units": row.units,
                    "price_per_unit_eur": row.price_per_unit,
                    "amount_eur": row.amount,
                    "raw_row": row.raw_row,
                }
            )

def main() -> None:
    ensure_environment()
    args = parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else pdf_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = args.prefix or english_output_name(pdf_path.stem)

    fragments = run_swift_extraction(pdf_path)
    pages = group_pages(fragments)
    starting_balance = get_starting_balance(pages.get(1, []))

    transaction_rows_raw: list[dict[str, object]] = []
    fund_rows: list[FundRow] = []
    for page_number in sorted(pages):
        transaction_rows_raw.extend(build_transaction_rows(page_number, pages[page_number]))
        fund_rows.extend(build_fund_rows(page_number, pages[page_number]))

    transaction_rows = finalize_transaction_rows(transaction_rows_raw, starting_balance)
    transaction_rows, transaction_duplicates_dropped = dedupe_transaction_rows(transaction_rows)
    fund_rows, fund_duplicates_dropped = dedupe_fund_rows(fund_rows)

    transactions_path = output_dir / f"{prefix}_transactions.csv"
    fund_path = output_dir / f"{prefix}_money_market_fund.csv"
    combined_path = output_dir / f"{prefix}_all_rows.csv"
    parse_meta_path = output_dir / f"{prefix}_parse_meta.json"

    write_transaction_csv(transactions_path, transaction_rows)
    write_fund_csv(fund_path, fund_rows)
    write_combined_csv(combined_path, transaction_rows, fund_rows)
    write_parse_metadata(
        parse_meta_path,
        transaction_rows,
        fund_rows,
        transaction_duplicates_dropped,
        fund_duplicates_dropped,
    )

    print(f"Wrote {len(transaction_rows)} transaction rows to {transactions_path}")
    print(f"Wrote {len(fund_rows)} money market fund rows to {fund_path}")
    print(f"Wrote {len(transaction_rows) + len(fund_rows)} total rows to {combined_path}")
    print(
        "Dropped "
        f"{transaction_duplicates_dropped + fund_duplicates_dropped} exact duplicate parsed rows "
        f"({transaction_duplicates_dropped} transactions, {fund_duplicates_dropped} fund rows)"
    )
    print(f"Wrote parse metadata to {parse_meta_path}")


if __name__ == "__main__":
    main()
