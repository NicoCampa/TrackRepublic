#!/usr/bin/python3

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from statistics import median
from typing import Optional


OLLAMA_API_URL = "http://127.0.0.1:11434/api/chat"
DEFAULT_MODEL = "qwen3.5:9b"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANUAL_RULES = PROJECT_ROOT / "config" / "manual_category_rules.csv"
ALLOWED_GROUPS = ["income", "expense", "transfer", "investment", "tax", "other"]
ALLOWED_CATEGORIES = [
    "salary",
    "bonus_cashback",
    "interest_dividend",
    "refund",
    "groceries",
    "dining",
    "bars_cafes",
    "transport",
    "travel",
    "shopping",
    "subscriptions",
    "software_ai",
    "education",
    "health",
    "housing",
    "utilities",
    "telecom",
    "entertainment",
    "gifts",
    "fees",
    "internal_transfer",
    "peer_transfer",
    "investing",
    "crypto",
    "taxes",
    "other",
]
SELF_NAME_HINTS = [
    "NICOLO CAMPAGNOLI",
    "NICOLO' CAMPAGNOLI",
    "NICOLO CAMPAGNOLI",
    "NICOLO CAMPAGNOLI",
    "NICOLÒ CAMPAGNOLI",
    "CAMPAGNOLI NICOLO",
]
FIXED_COST_CATEGORIES = {
    "education",
    "health",
    "housing",
    "subscriptions",
    "telecom",
    "utilities",
}


def english_output_name(value: str) -> str:
    translated = value
    translated = re.sub(r"(?i)kontoauszug", "statement", translated)
    translated = re.sub(r"(?i)geldmarktfonds", "money_market_fund", translated)
    return translated


@dataclass(frozen=True)
class TransactionRow:
    row_id: str
    page: str
    date: str
    date_original: str
    tx_type: str
    description: str
    signed_amount: Decimal
    payment_in: str
    payment_out: str
    balance: str
    raw_row: str


@dataclass(frozen=True)
class ClassificationItem:
    cache_key: str
    tx_type: str
    sign: str
    description: str
    normalized_description: str
    example_amount: str


@dataclass(frozen=True)
class ManualRule:
    rule_id: str
    name: str
    match_type: str
    pattern: str
    transaction_type: str
    amount_sign: str
    merchant: str
    group: str
    category: str
    subcategory: str
    confidence: float
    needs_review: bool


@dataclass(frozen=True)
class RowOverride:
    row_id: str
    merchant: Optional[str]
    group: Optional[str]
    category: Optional[str]
    subcategory: Optional[str]
    confidence: Optional[float]
    needs_review: Optional[bool]
    source: Optional[str]
    reason: Optional[str]

    def has_changes(self) -> bool:
        return any(
            value is not None
            for value in (
                self.merchant,
                self.group,
                self.category,
                self.subcategory,
                self.confidence,
                self.needs_review,
                self.source,
                self.reason,
            )
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Categorize Trade Republic transactions with a local Ollama model."
    )
    parser.add_argument(
        "transactions_csv",
        help="Path to the *_transactions.csv file produced by convert_trade_republic_statement.py",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model name. Default: {DEFAULT_MODEL}")
    parser.add_argument("--batch-size", type=int, default=20, help="Number of unique descriptions per LLM request.")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N rows. Useful for testing.")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for generated files. Defaults to the input CSV directory.",
    )
    parser.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Ignore any existing classification cache and rebuild it.",
    )
    parser.add_argument(
        "--rules-file",
        default=None,
        help=f"Path to a manual rule CSV. Defaults to {DEFAULT_MANUAL_RULES}.",
    )
    parser.add_argument(
        "--row-overrides-file",
        default=None,
        help=(
            "Path to a row override CSV keyed by row_id. Supported columns: "
            "row_id, enabled, merchant, group, category, subcategory, confidence, "
            "needs_review, source, reason."
        ),
    )
    parser.add_argument(
        "--summary-json",
        default=None,
        help="Optional path for a pipeline summary JSON file.",
    )
    return parser.parse_args()


def parse_decimal(text: str) -> Decimal:
    cleaned = text.strip()
    if not cleaned:
        return Decimal("0")
    try:
        return Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid decimal value: {text}") from exc


def format_decimal(value: Decimal) -> str:
    return f"{value:.2f}"


def parse_bool(text: str, default: bool = False) -> bool:
    value = (text or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "y"}


def clean_optional_text(text: Optional[str]) -> Optional[str]:
    value = (text or "").strip()
    return value or None


def parse_optional_float(text: Optional[str]) -> Optional[float]:
    value = clean_optional_text(text)
    if value is None:
        return None
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"Invalid float value: {text}") from exc


def timestamp_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_transactions(path: Path, limit: Optional[int]) -> list[TransactionRow]:
    rows: list[TransactionRow] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for index, row in enumerate(reader):
            if limit is not None and index >= limit:
                break
            if not row.get("date"):
                continue
            rows.append(
                TransactionRow(
                    row_id=row["row_id"],
                    page=row["page"],
                    date=row["date"],
                    date_original=row["date_original"],
                    tx_type=row["type"],
                    description=row["description"],
                    signed_amount=parse_decimal(row["signed_amount_eur"]),
                    payment_in=row["payment_in_eur"],
                    payment_out=row["payment_out_eur"],
                    balance=row["balance_eur"],
                    raw_row=row["raw_row"],
                )
            )
    return rows


def load_manual_rules(path: Path) -> list[ManualRule]:
    if not path.exists():
        return []

    rules: list[ManualRule] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if not row or not any((value or "").strip() for value in row.values()):
                continue
            pattern = (row.get("pattern") or "").strip()
            if not pattern:
                continue
            if not parse_bool(row.get("enabled") or "", default=True):
                continue
            rule_id = (row.get("id") or "").strip()
            rules.append(
                ManualRule(
                    rule_id=rule_id,
                    name=(row.get("name") or "").strip() or rule_id or pattern,
                    match_type=((row.get("match_type") or "contains").strip().lower() or "contains"),
                    pattern=pattern,
                    transaction_type=(row.get("transaction_type") or "").strip(),
                    amount_sign=(row.get("amount_sign") or "").strip().lower(),
                    merchant=(row.get("merchant") or "").strip() or pattern,
                    group=(row.get("group") or "other").strip(),
                    category=(row.get("category") or "other").strip(),
                    subcategory=(row.get("subcategory") or "").strip() or "manual_rule",
                    confidence=float((row.get("confidence") or "0.99").strip() or "0.99"),
                    needs_review=parse_bool(row.get("needs_review") or "", default=False),
                )
            )
    return rules


def load_row_overrides(path: Path) -> dict[str, RowOverride]:
    if not path.exists():
        return {}

    overrides: dict[str, RowOverride] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if not row or not any((value or "").strip() for value in row.values()):
                continue
            row_id = clean_optional_text(row.get("row_id"))
            if row_id is None:
                continue
            if not parse_bool(row.get("enabled") or "", default=True):
                continue

            needs_review_text = clean_optional_text(row.get("needs_review"))
            override = RowOverride(
                row_id=row_id,
                merchant=clean_optional_text(row.get("merchant")),
                group=clean_optional_text(row.get("group")),
                category=clean_optional_text(row.get("category")),
                subcategory=clean_optional_text(row.get("subcategory")),
                confidence=parse_optional_float(row.get("confidence")),
                needs_review=parse_bool(needs_review_text, default=False) if needs_review_text is not None else None,
                source=clean_optional_text(row.get("source")),
                reason=clean_optional_text(row.get("reason")),
            )
            if override.has_changes():
                overrides[row_id] = override
    return overrides


def normalize_description_for_classification(description: str) -> str:
    original = re.sub(r"\s+", " ", description.upper().strip())
    normalized = original
    normalized = re.sub(r",\s*EXCHANGE RATE:.*$", "", normalized)
    normalized = re.sub(r",\s*ECB RATE:.*$", "", normalized)
    normalized = re.sub(r",\s*MARKUP:.*$", "", normalized)
    normalized = re.sub(r"\([A-Z0-9]{10,}\)", "", normalized)
    normalized = re.sub(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b", "<ACCOUNT>", normalized)
    normalized = re.sub(r"\b[A-Z0-9*:/._-]*\d[A-Z0-9*:/._-]{5,}\b", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    normalized = normalized.strip(" ,-")
    return normalized or original


def build_cache_key(row: TransactionRow) -> str:
    sign = "income" if row.signed_amount > 0 else "expense" if row.signed_amount < 0 else "zero"
    normalized = normalize_description_for_classification(row.description)
    return f"{row.tx_type}|{sign}|{normalized}"


def default_classification(
    group: str,
    category: str,
    merchant: str,
    subcategory: str,
    confidence: float,
    needs_review: bool,
    reason: str,
    source: str,
) -> dict:
    return {
        "merchant": merchant,
        "group": group,
        "category": category,
        "subcategory": subcategory,
        "confidence": round(confidence, 2),
        "needs_review": needs_review,
        "reason": reason,
        "source": source,
    }


def looks_like_self_transfer(description_upper: str) -> bool:
    return any(name in description_upper for name in SELF_NAME_HINTS)


def match_manual_rule(row: TransactionRow, rules: list[ManualRule]) -> Optional[dict]:
    description = row.description
    description_upper = description.upper()
    normalized = normalize_description_for_classification(description)
    sign = "income" if row.signed_amount > 0 else "expense" if row.signed_amount < 0 else "zero"

    for rule in rules:
        if rule.transaction_type and rule.transaction_type != row.tx_type:
            continue
        if rule.amount_sign and rule.amount_sign != sign:
            continue

        matched = False
        if rule.match_type == "contains":
            matched = rule.pattern.upper() in description_upper
        elif rule.match_type == "exact":
            matched = normalize_description_for_classification(rule.pattern) == normalized
        elif rule.match_type == "regex":
            matched = re.search(rule.pattern, description, re.IGNORECASE) is not None
        if not matched:
            continue

        confidence = min(max(rule.confidence, 0.0), 0.99)
        rule_label = rule.rule_id or rule.name
        return default_classification(
            group=rule.group if rule.group in ALLOWED_GROUPS else "other",
            category=rule.category if rule.category in ALLOWED_CATEGORIES else "other",
            merchant=rule.merchant,
            subcategory=rule.subcategory,
            confidence=confidence,
            needs_review=rule.needs_review,
            reason=f"Manual rule matched: {rule_label}",
            source="manual_rule",
        )
    return None


def apply_row_override(classification: dict, override: RowOverride) -> dict:
    updated = dict(classification)

    if override.merchant is not None:
        updated["merchant"] = override.merchant
    if override.group is not None:
        updated["group"] = override.group if override.group in ALLOWED_GROUPS else "other"
    if override.category is not None:
        updated["category"] = override.category if override.category in ALLOWED_CATEGORIES else "other"
    if override.subcategory is not None:
        updated["subcategory"] = override.subcategory
    if override.confidence is not None:
        updated["confidence"] = round(min(max(override.confidence, 0.0), 1.0), 2)
    if override.needs_review is not None:
        updated["needs_review"] = override.needs_review

    updated["source"] = override.source or "row_override"
    updated["reason"] = override.reason or f"Row override applied for {override.row_id}"
    return updated


def match_keyword_rule(description_upper: str, rules: list[tuple[list[str], str, str, str, str]]) -> Optional[dict]:
    for keywords, merchant, group, category, subcategory in rules:
        if any(keyword in description_upper for keyword in keywords):
            return default_classification(
                group=group,
                category=category,
                merchant=merchant,
                subcategory=subcategory,
                confidence=0.97,
                needs_review=False,
                reason=f"Merchant keyword rule matched: {', '.join(keywords)}",
                source="rule",
            )
    return None


def classify_rule_based(row: TransactionRow) -> Optional[dict]:
    description_upper = row.description.upper()
    amount_sign = "buy" if row.signed_amount < 0 else "sell" if row.signed_amount > 0 else "flat"

    if row.tx_type == "Handel":
        if any(token in description_upper for token in ["BTC", "ETH", "XF000BTC0017", "XF000ETH0019"]):
            return default_classification(
                group="investment",
                category="crypto",
                merchant="Trade Republic",
                subcategory=amount_sign,
                confidence=0.99,
                needs_review=False,
                reason="Trade execution mentioning BTC/ETH or crypto instruments.",
                source="rule",
            )
        return default_classification(
            group="investment",
            category="investing",
            merchant="Trade Republic",
            subcategory=amount_sign,
            confidence=0.99,
            needs_review=False,
            reason="Trade execution for securities or funds.",
            source="rule",
        )

    if row.tx_type == "Steuern":
        return default_classification(
            group="tax",
            category="taxes",
            merchant="Tax Authority",
            subcategory="investment_tax",
            confidence=0.98,
            needs_review=False,
            reason="Explicit tax entry.",
            source="rule",
        )

    if row.tx_type == "Zinsen":
        return default_classification(
            group="income",
            category="interest_dividend",
            merchant="Trade Republic",
            subcategory="interest",
            confidence=0.98,
            needs_review=False,
            reason="Interest payment.",
            source="rule",
        )

    if row.tx_type == "Ertrag":
        return default_classification(
            group="income",
            category="interest_dividend",
            merchant="Trade Republic",
            subcategory="dividend",
            confidence=0.98,
            needs_review=False,
            reason="Dividend or cash yield payment.",
            source="rule",
        )

    if row.tx_type == "Bonus":
        return default_classification(
            group="income",
            category="bonus_cashback",
            merchant="Trade Republic",
            subcategory="saveback",
            confidence=0.98,
            needs_review=False,
            reason="Bonus or saveback payment.",
            source="rule",
        )

    if row.tx_type == "Empfehlung":
        return default_classification(
            group="income",
            category="refund",
            merchant="Trade Republic",
            subcategory="referral_or_reimbursement",
            confidence=0.92,
            needs_review=False,
            reason="Referral or reimbursement payment.",
            source="rule",
        )

    if row.tx_type == "Überweisung":
        if "EINZAHLUNG AKZEPTIERT" in description_upper or "TOP UP" in description_upper:
            return default_classification(
                group="transfer",
                category="internal_transfer",
                merchant="Own Account",
                subcategory="top_up_or_deposit",
                confidence=0.99,
                needs_review=False,
                reason="Explicit deposit/top-up wording.",
                source="rule",
            )
        if looks_like_self_transfer(description_upper):
            return default_classification(
                group="transfer",
                category="internal_transfer",
                merchant="Own Account",
                subcategory="self_transfer",
                confidence=0.99,
                needs_review=False,
                reason="Transfer references the user's own name.",
                source="rule",
            )
        if "INCOMING TRANSFER FROM CAPGEMINI" in description_upper:
            return default_classification(
                group="income",
                category="salary",
                merchant="Capgemini",
                subcategory="payroll",
                confidence=0.99,
                needs_review=False,
                reason="Incoming transfer from employer.",
                source="rule",
            )
        if "OUTGOING TRANSFER FOR LMU MUENCHEN" in description_upper or "DEUTSCHKURSE BEI DER UNIVERSITAET MUENCHEN" in description_upper:
            return default_classification(
                group="expense",
                category="education",
                merchant="LMU Muenchen",
                subcategory="tuition_or_course",
                confidence=0.96,
                needs_review=False,
                reason="University or language-course transfer.",
                source="rule",
            )
        if "INCOMING TRANSFER FROM APPLE INC" in description_upper or "INCOMING TRANSFER FROM TECHNIKER KRANKENKASSE" in description_upper:
            return default_classification(
                group="income",
                category="refund",
                merchant="Refund",
                subcategory="institutional_refund",
                confidence=0.93,
                needs_review=False,
                reason="Incoming transfer from a company or insurer that is typically a refund.",
                source="rule",
            )
        if "INCOMING TRANSFER FROM STOK BAY F FINANZAMT" in description_upper or "INCOMING TRANSFER FROM FINANZAMT" in description_upper:
            return default_classification(
                group="tax",
                category="taxes",
                merchant="Finanzamt",
                subcategory="tax_refund",
                confidence=0.93,
                needs_review=False,
                reason="Incoming transfer from tax authority.",
                source="rule",
            )
        if (
            description_upper.startswith("INCOMING TRANSFER FROM ")
            or description_upper.startswith("OUTGOING TRANSFER FOR ")
        ):
            return default_classification(
                group="transfer",
                category="peer_transfer",
                merchant=row.description.split(" ", 3)[-1],
                subcategory="person_to_person",
                confidence=0.85,
                needs_review=False,
                reason="Named counterparty transfer without self-transfer markers.",
                source="rule",
            )

    merchant_rules = [
        (["PENNY", "LIDL", "REWE", "EDEKA", "GO ASIA", "COOP", "CONAD", "SUPERMERCATO"], "Groceries", "expense", "groceries", "supermarket"),
        (["MCDONALD", "MAMMA BAO", "YORMA", "WOLT", "UBER *EATS", "KFC", "RESTAURANT", "RISTOGEST", "SUMUP *BITES", "AUTOGRILL", "IMBISS", "LS PLEX COFFEE"], "Dining", "expense", "dining", "food_and_drink"),
        (["KILIANS IRISH PUB", "PUB", "BAR"], "Bar", "expense", "bars_cafes", "bar_or_pub"),
        (["BOLT", "TRAINLINE", "DB VERTRIEB", "TRENITALIA", "LUFTHANSA", "ITALOTRENO", "METRO DE MADRID", "EMMY SHARING", "APCOA", "HANDYPARKEN", "UBER *LIME", "MUE VERKEHRSGESELLS", "MUENCHNER VERKEHRSGE", "TPER SPA"], "Transport", "expense", "transport", "mobility"),
        (["OPENAI", "CLAUDE.AI", "CURSOR"], "AI Software", "expense", "software_ai", "software_subscription"),
        (["ILIAD"], "Iliad", "expense", "telecom", "mobile_plan"),
        (["TECHNIKER KRANKENKASSE", "UNOBRAVO"], "Health", "expense", "health", "healthcare"),
        (["AMAZON", "AMZN", "WOOLWORTH", "DECATHLON", "PUMA", "IKEA", "DM-DROGERIE"], "Retail", "expense", "shopping", "retail"),
        (["GETSAFE"], "Getsafe", "expense", "utilities", "insurance"),
        (["AMAZON PRIME"], "Amazon Prime", "expense", "subscriptions", "media_subscription"),
        (["STUDIERENDENWERK"], "Studierendenwerk", "expense", "dining", "student_cafeteria"),
        (["RUNDUNK", "RUNDFUNK ARD", "ZDF"], "Broadcast Fee", "expense", "utilities", "public_fee"),
        (["TAXFIX"], "Taxfix", "tax", "taxes", "tax_service"),
    ]
    merchant_rule = match_keyword_rule(description_upper, merchant_rules)
    if merchant_rule is not None:
        return merchant_rule

    return None


def load_cache(path: Path, refresh_cache: bool) -> dict[str, dict]:
    if refresh_cache or not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload.get("entries", {})


def save_cache(path: Path, model: str, entries: dict[str, dict]) -> None:
    payload = {
        "version": 1,
        "model": model,
        "updated_at_epoch": int(time.time()),
        "entries": entries,
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=True)


def sanitize_classification(raw: dict, fallback_description: str) -> dict:
    group = raw.get("group", "other")
    category = raw.get("category", "other")
    merchant = str(raw.get("merchant", "")).strip() or fallback_description
    subcategory = ""
    reason = "Classification came from the local LLM."
    confidence = 0.82

    if group not in ALLOWED_GROUPS:
        group = "other"
        confidence = min(confidence, 0.4)
    if category not in ALLOWED_CATEGORIES:
        category = "other"
        confidence = min(confidence, 0.4)

    needs_review = group == "other" or category == "other" or confidence < 0.65

    return {
        "merchant": merchant,
        "group": group,
        "category": category,
        "subcategory": subcategory,
        "confidence": round(confidence, 2),
        "needs_review": needs_review,
        "reason": reason,
        "source": "llm",
    }


def ollama_chat(model: str, prompt: str, timeout_seconds: int) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "think": False,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0,
            "num_predict": 900,
        },
    }
    request = urllib.request.Request(
        OLLAMA_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        decoded = json.load(response)
    return decoded["message"]["content"]


def build_prompt(items: list[ClassificationItem]) -> str:
    example_shape = {
        "results": [
            {
                "id": "example-1",
                "merchant": "OPENAI",
                "group": "expense",
                "category": "software_ai",
            }
        ]
    }
    payload = [
        {
            "id": item.cache_key,
            "type": item.tx_type,
            "sign": item.sign,
            "description": item.description,
            "normalized_description": item.normalized_description,
            "example_amount_eur": item.example_amount,
        }
        for item in items
    ]
    return (
        "You categorize personal finance transactions for a monthly and yearly cashflow dashboard.\n"
        "Return exactly one JSON object and no markdown.\n"
        f"The JSON must match this shape: {json.dumps(example_shape, ensure_ascii=False)}\n"
        f"Allowed groups: {', '.join(ALLOWED_GROUPS)}.\n"
        f"Allowed categories: {', '.join(ALLOWED_CATEGORIES)}.\n"
        "Rules:\n"
        "- The user is Nicolo Campagnoli.\n"
        "- Transfers involving Nicolo Campagnoli or CAMPAGNOLI NICOLO' are internal transfers.\n"
        "- Top-ups, deposits, and money moved between own accounts are transfer/internal_transfer.\n"
        "- Company payroll transfers are income/salary.\n"
        "- Refunds or reimbursements are income/refund.\n"
        "- AI software like OpenAI or Claude is expense/software_ai.\n"
        "- Restaurants, bars, pubs, takeaway, cafes, or food delivery are dining or bars_cafes.\n"
        "- Supermarkets and grocery stores are groceries.\n"
        "- Mobility, trains, flights, public transit, taxis, scooter sharing, and parking are transport or travel.\n"
        "- Brokerage, ETF, stock, BTC, ETH, or crypto trading is investment.\n"
        "- Use short, stable merchant names in merchant.\n"
        f"Transactions:\n{json.dumps(payload, ensure_ascii=False)}"
    )


def call_llm_batch(model: str, items: list[ClassificationItem]) -> dict[str, dict]:
    prompt = build_prompt(items)
    content = ollama_chat(model=model, prompt=prompt, timeout_seconds=240)
    parsed = json.loads(content)
    if isinstance(parsed, list):
        results = parsed
    else:
        results = parsed.get("results", [])
    if not isinstance(results, list):
        raise ValueError("LLM response did not contain a results array.")

    by_id: dict[str, dict] = {}
    for item in results:
        if not isinstance(item, dict) or "id" not in item:
            continue
        by_id[str(item["id"])] = sanitize_classification(item, fallback_description=str(item.get("merchant", "Other")).strip() or "Other")

    expected_ids = {item.cache_key for item in items}
    if set(by_id) != expected_ids:
        missing = expected_ids - set(by_id)
        extra = set(by_id) - expected_ids
        raise ValueError(f"LLM response ids mismatch. missing={sorted(missing)} extra={sorted(extra)}")
    return by_id


def classify_with_llm(model: str, items: list[ClassificationItem]) -> dict[str, dict]:
    if not items:
        return {}

    try:
        return call_llm_batch(model=model, items=items)
    except (json.JSONDecodeError, urllib.error.URLError, TimeoutError, ValueError) as exc:
        if len(items) == 1:
            item = items[0]
            return {
                item.cache_key: default_classification(
                    group="other",
                    category="other",
                    merchant=item.normalized_description or item.description,
                    subcategory="manual_review",
                    confidence=0.2,
                    needs_review=True,
                    reason=f"LLM fallback after error: {exc}",
                    source="fallback",
                )
            }
        middle = max(1, len(items) // 2)
        left = classify_with_llm(model=model, items=items[:middle])
        right = classify_with_llm(model=model, items=items[middle:])
        return {**left, **right}


def chunked(items: list[ClassificationItem], size: int) -> list[list[ClassificationItem]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def month_index(month_value: str) -> int:
    year, month = month_value.split("-")
    return int(year) * 12 + int(month)


def detect_recurring_patterns(rows: list[dict]) -> dict[str, dict]:
    grouped: dict[tuple[str, str, str, str], list[dict]] = defaultdict(list)
    for row in rows:
        group = row["group"]
        if group not in {"income", "expense", "tax"}:
            continue
        grouped[(group, row["merchant"].strip().upper(), row["category"], row["subcategory"])].append(row)

    recurring_by_row_id: dict[str, dict] = {}
    for key, entries in grouped.items():
        month_counts = Counter(entry["month"] for entry in entries)
        distinct_months = sorted(month_counts)
        if len(distinct_months) < 3:
            continue
        if max(month_counts.values()) > 2:
            continue

        gaps = [month_index(b) - month_index(a) for a, b in zip(distinct_months, distinct_months[1:])]
        if not gaps:
            continue
        consecutive_ratio = sum(1 for gap in gaps if gap == 1) / len(gaps)
        if consecutive_ratio < 0.6 and len(distinct_months) < 4:
            continue

        amounts = [abs(float(parse_decimal(entry["signed_amount_eur"]))) for entry in entries if parse_decimal(entry["signed_amount_eur"]) != 0]
        if not amounts:
            continue
        baseline = median(amounts)
        if baseline == 0:
            continue
        stable_ratio = sum(1 for amount in amounts if abs(amount - baseline) / baseline <= 0.30) / len(amounts)
        if stable_ratio < 0.6 and key[0] != "income":
            continue

        confidence = min(0.99, 0.48 + 0.07 * len(distinct_months) + 0.18 * consecutive_ratio + 0.16 * stable_ratio)
        is_fixed_cost = key[0] == "expense" and (key[2] in FIXED_COST_CATEGORIES or confidence >= 0.82)
        recurrence_key = f"{key[0]}|{key[1]}|{key[2]}|{key[3]}"
        for entry in entries:
            recurring_by_row_id[entry["row_id"]] = {
                "is_recurring": True,
                "recurrence_frequency": "monthly",
                "recurrence_key": recurrence_key,
                "recurrence_confidence": round(confidence, 2),
                "is_fixed_cost": is_fixed_cost,
            }
    return recurring_by_row_id


def apply_cashflow_bucket(row: dict) -> str:
    group = row["group"]
    category = row["category"]
    if group == "income":
        return "income"
    if group == "transfer":
        return "transfer"
    if group == "investment":
        return "investing"
    if group == "tax":
        return "tax"
    if group == "expense":
        if row["is_fixed_cost"] == "true" or category in FIXED_COST_CATEGORIES:
            return "fixed_cost"
        return "variable_cost"
    return "other"


def write_categorized_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "row_id",
                "page",
                "date",
                "month",
                "year",
                "date_original",
                "type",
                "description",
                "normalized_description",
                "merchant",
                "group",
                "category",
                "subcategory",
                "cashflow_bucket",
                "is_recurring",
                "recurrence_frequency",
                "recurrence_key",
                "recurrence_confidence",
                "is_fixed_cost",
                "signed_amount_eur",
                "payment_in_eur",
                "payment_out_eur",
                "balance_eur",
                "include_in_operating_cashflow",
                "needs_review",
                "confidence",
                "classification_source",
                "classification_key",
                "classification_reason",
                "raw_row",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_review_csv(path: Path, rows: list[dict]) -> None:
    review_rows = [row for row in rows if row["needs_review"] == "true"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "row_id",
                "date",
                "type",
                "description",
                "merchant",
                "group",
                "category",
                "cashflow_bucket",
                "is_recurring",
                "is_fixed_cost",
                "signed_amount_eur",
                "classification_source",
                "classification_key",
                "classification_reason",
                "raw_row",
            ],
        )
        writer.writeheader()
        for row in review_rows:
            writer.writerow(
                {
                    "row_id": row["row_id"],
                    "date": row["date"],
                    "type": row["type"],
                    "description": row["description"],
                    "merchant": row["merchant"],
                    "group": row["group"],
                    "category": row["category"],
                    "cashflow_bucket": row["cashflow_bucket"],
                    "is_recurring": row["is_recurring"],
                    "is_fixed_cost": row["is_fixed_cost"],
                    "signed_amount_eur": row["signed_amount_eur"],
                    "classification_source": row["classification_source"],
                    "classification_key": row["classification_key"],
                    "classification_reason": row["classification_reason"],
                    "raw_row": row["raw_row"],
                }
            )


def build_period_overview(rows: list[dict], period_field: str) -> list[dict]:
    periods: dict[str, dict] = defaultdict(
        lambda: {
            period_field: "",
            "transaction_count": 0,
            "income_eur": Decimal("0"),
            "expense_eur": Decimal("0"),
            "fixed_cost_eur": Decimal("0"),
            "variable_cost_eur": Decimal("0"),
            "tax_eur": Decimal("0"),
            "transfer_net_eur": Decimal("0"),
            "investment_net_eur": Decimal("0"),
            "investing_outflow_eur": Decimal("0"),
            "other_net_eur": Decimal("0"),
            "net_cashflow_eur": Decimal("0"),
            "operating_cashflow_eur": Decimal("0"),
            "recurring_fixed_eur": Decimal("0"),
            "savings_after_transfers_eur": Decimal("0"),
        }
    )

    for row in rows:
        period = row[period_field]
        amount = parse_decimal(row["signed_amount_eur"])
        bucket = periods[period]
        bucket[period_field] = period
        bucket["transaction_count"] += 1
        bucket["net_cashflow_eur"] += amount

        group = row["group"]
        cashflow_bucket = row.get("cashflow_bucket", "other")
        if group == "income":
            bucket["income_eur"] += amount
            bucket["operating_cashflow_eur"] += amount
        elif group == "expense":
            bucket["expense_eur"] += abs(amount)
            bucket["operating_cashflow_eur"] += amount
            if cashflow_bucket == "fixed_cost":
                bucket["fixed_cost_eur"] += abs(amount)
            else:
                bucket["variable_cost_eur"] += abs(amount)
        elif group == "tax":
            bucket["tax_eur"] += abs(amount)
            bucket["operating_cashflow_eur"] += amount
        elif group == "transfer":
            bucket["transfer_net_eur"] += amount
        elif group == "investment":
            bucket["investment_net_eur"] += amount
            if amount < 0:
                bucket["investing_outflow_eur"] += abs(amount)
        else:
            bucket["other_net_eur"] += amount
            bucket["operating_cashflow_eur"] += amount

        if row.get("is_fixed_cost") == "true" and amount < 0:
            bucket["recurring_fixed_eur"] += abs(amount)

    result: list[dict] = []
    for period in sorted(periods):
        bucket = periods[period]
        bucket["savings_after_transfers_eur"] = bucket["net_cashflow_eur"] - bucket["transfer_net_eur"]
        result.append(
            {
                period_field: bucket[period_field],
                "transaction_count": bucket["transaction_count"],
                "income_eur": format_decimal(bucket["income_eur"]),
                "expense_eur": format_decimal(bucket["expense_eur"]),
                "fixed_cost_eur": format_decimal(bucket["fixed_cost_eur"]),
                "variable_cost_eur": format_decimal(bucket["variable_cost_eur"]),
                "tax_eur": format_decimal(bucket["tax_eur"]),
                "transfer_net_eur": format_decimal(bucket["transfer_net_eur"]),
                "investment_net_eur": format_decimal(bucket["investment_net_eur"]),
                "investing_outflow_eur": format_decimal(bucket["investing_outflow_eur"]),
                "other_net_eur": format_decimal(bucket["other_net_eur"]),
                "net_cashflow_eur": format_decimal(bucket["net_cashflow_eur"]),
                "operating_cashflow_eur": format_decimal(bucket["operating_cashflow_eur"]),
                "recurring_fixed_eur": format_decimal(bucket["recurring_fixed_eur"]),
                "savings_after_transfers_eur": format_decimal(bucket["savings_after_transfers_eur"]),
            }
        )
    return result


def build_category_summary(rows: list[dict], period_field: str) -> list[dict]:
    buckets: dict[tuple[str, str, str], dict] = defaultdict(
        lambda: {
            period_field: "",
            "group": "",
            "category": "",
            "transaction_count": 0,
            "inflow_eur": Decimal("0"),
            "outflow_eur": Decimal("0"),
            "net_amount_eur": Decimal("0"),
        }
    )

    for row in rows:
        key = (row[period_field], row["group"], row["category"])
        amount = parse_decimal(row["signed_amount_eur"])
        bucket = buckets[key]
        bucket[period_field] = row[period_field]
        bucket["group"] = row["group"]
        bucket["category"] = row["category"]
        bucket["transaction_count"] += 1
        bucket["net_amount_eur"] += amount
        if amount >= 0:
            bucket["inflow_eur"] += amount
        else:
            bucket["outflow_eur"] += abs(amount)

    result: list[dict] = []
    for key in sorted(buckets):
        bucket = buckets[key]
        result.append(
            {
                period_field: bucket[period_field],
                "group": bucket["group"],
                "category": bucket["category"],
                "transaction_count": bucket["transaction_count"],
                "inflow_eur": format_decimal(bucket["inflow_eur"]),
                "outflow_eur": format_decimal(bucket["outflow_eur"]),
                "net_amount_eur": format_decimal(bucket["net_amount_eur"]),
            }
        )
    return result


def write_summary_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_summary_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main() -> None:
    started_at = timestamp_now()
    args = parse_args()
    input_path = Path(args.transactions_csv).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input CSV not found: {input_path}")

    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else input_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    stem = english_output_name(input_path.stem)
    categorized_path = output_dir / f"{stem}_categorized.csv"
    monthly_overview_path = output_dir / f"{stem}_monthly_overview.csv"
    yearly_overview_path = output_dir / f"{stem}_yearly_overview.csv"
    monthly_categories_path = output_dir / f"{stem}_monthly_categories.csv"
    yearly_categories_path = output_dir / f"{stem}_yearly_categories.csv"
    review_path = output_dir / f"{stem}_needs_review.csv"
    cache_path = output_dir / f"{stem}_category_cache.json"
    rules_path = (
        Path(args.rules_file).expanduser().resolve()
        if args.rules_file
        else (DEFAULT_MANUAL_RULES if DEFAULT_MANUAL_RULES.exists() else (input_path.parent / "manual_category_rules.csv").resolve())
    )
    row_overrides_path = Path(args.row_overrides_file).expanduser().resolve() if args.row_overrides_file else None
    summary_json_path = Path(args.summary_json).expanduser().resolve() if args.summary_json else None

    print(f"Loading transactions from {input_path}...", file=sys.stderr)
    transactions = load_transactions(input_path, limit=args.limit)
    print(f"Loaded {len(transactions)} rows.", file=sys.stderr)
    manual_rules = load_manual_rules(rules_path)
    if manual_rules:
        print(f"Loaded {len(manual_rules)} manual rules from {rules_path}.", file=sys.stderr)
    else:
        print(f"No manual rules loaded from {rules_path}.", file=sys.stderr)
    row_overrides = load_row_overrides(row_overrides_path) if row_overrides_path else {}
    if row_overrides_path is not None:
        if row_overrides:
            print(f"Loaded {len(row_overrides)} row overrides from {row_overrides_path}.", file=sys.stderr)
        else:
            print(f"No row overrides loaded from {row_overrides_path}.", file=sys.stderr)

    existing_cache_entries = load_cache(cache_path, refresh_cache=args.refresh_cache)
    cache_entries = dict(existing_cache_entries)
    items_by_key: dict[str, ClassificationItem] = {}
    classification_by_key: dict[str, dict] = {}
    resolution_by_key: dict[str, str] = {}

    for row in transactions:
        cache_key = build_cache_key(row)
        normalized_description = normalize_description_for_classification(row.description)
        sign = "income" if row.signed_amount > 0 else "expense" if row.signed_amount < 0 else "zero"

        if cache_key in classification_by_key:
            continue

        manual_result = match_manual_rule(row, manual_rules)
        if manual_result is not None:
            classification_by_key[cache_key] = manual_result
            resolution_by_key[cache_key] = "manual_rule"
            continue

        if cache_key in existing_cache_entries:
            classification_by_key[cache_key] = existing_cache_entries[cache_key]
            resolution_by_key[cache_key] = "cache"
            continue

        rule_result = classify_rule_based(row)
        if rule_result is not None:
            classification_by_key[cache_key] = rule_result
            cache_entries[cache_key] = rule_result
            resolution_by_key[cache_key] = "rule"
            continue

        if cache_key not in items_by_key:
            items_by_key[cache_key] = ClassificationItem(
                cache_key=cache_key,
                tx_type=row.tx_type,
                sign=sign,
                description=row.description,
                normalized_description=normalized_description,
                example_amount=format_decimal(row.signed_amount),
            )

    pending_items = list(items_by_key.values())
    if pending_items:
        print(
            f"Classifying {len(pending_items)} unique descriptions with {args.model} in batches of {args.batch_size}...",
            file=sys.stderr,
        )
        for batch_index, batch in enumerate(chunked(pending_items, args.batch_size), start=1):
            print(
                f"  Batch {batch_index}/{(len(pending_items) + args.batch_size - 1) // args.batch_size}: {len(batch)} items",
                file=sys.stderr,
            )
            batch_results = classify_with_llm(model=args.model, items=batch)
            for cache_key, classification in batch_results.items():
                classification_by_key[cache_key] = classification
                cache_entries[cache_key] = classification
                resolution_by_key[cache_key] = "llm" if classification.get("source") == "llm" else "fallback"
    else:
        print("No uncached descriptions required LLM classification.", file=sys.stderr)

    save_cache(cache_path, model=args.model, entries=cache_entries)

    resolution_counts = Counter()
    row_override_hits = 0
    categorized_rows: list[dict] = []
    for row in transactions:
        cache_key = build_cache_key(row)
        classification = classification_by_key.get(cache_key) or cache_entries.get(cache_key)
        resolution = resolution_by_key.get(cache_key)
        if classification is None:
            classification = default_classification(
                group="other",
                category="other",
                merchant=row.description,
                subcategory="missing_classification",
                confidence=0.1,
                needs_review=True,
                reason="No classification available.",
                source="fallback",
            )
            resolution = "fallback"
            resolution_by_key[cache_key] = resolution

        resolution_counts[resolution or "fallback"] += 1
        effective_classification = dict(classification)
        override = row_overrides.get(row.row_id)
        if override is not None:
            effective_classification = apply_row_override(effective_classification, override)
            row_override_hits += 1

        month = row.date[:7]
        year = row.date[:4]
        categorized_rows.append(
            {
                "row_id": row.row_id,
                "page": row.page,
                "date": row.date,
                "month": month,
                "year": year,
                "date_original": row.date_original,
                "type": row.tx_type,
                "description": row.description,
                "normalized_description": normalize_description_for_classification(row.description),
                "merchant": effective_classification["merchant"],
                "group": effective_classification["group"],
                "category": effective_classification["category"],
                "subcategory": effective_classification["subcategory"],
                "cashflow_bucket": "other",
                "is_recurring": "false",
                "recurrence_frequency": "none",
                "recurrence_key": "",
                "recurrence_confidence": "0.00",
                "is_fixed_cost": "false",
                "signed_amount_eur": format_decimal(row.signed_amount),
                "payment_in_eur": row.payment_in,
                "payment_out_eur": row.payment_out,
                "balance_eur": row.balance,
                "include_in_operating_cashflow": str(
                    effective_classification["group"] in {"income", "expense", "tax", "other"}
                ).lower(),
                "needs_review": str(bool(effective_classification["needs_review"])).lower(),
                "confidence": f"{effective_classification['confidence']:.2f}",
                "classification_source": effective_classification["source"],
                "classification_key": cache_key,
                "classification_reason": effective_classification["reason"],
                "raw_row": row.raw_row,
            }
        )

    recurrence_by_row_id = detect_recurring_patterns(categorized_rows)
    for row in categorized_rows:
        recurrence = recurrence_by_row_id.get(row["row_id"])
        if recurrence is not None:
            row["is_recurring"] = "true"
            row["recurrence_frequency"] = recurrence["recurrence_frequency"]
            row["recurrence_key"] = recurrence["recurrence_key"]
            row["recurrence_confidence"] = f"{recurrence['recurrence_confidence']:.2f}"
            row["is_fixed_cost"] = "true" if recurrence["is_fixed_cost"] else row["is_fixed_cost"]
        row["cashflow_bucket"] = apply_cashflow_bucket(row)

    monthly_overview = build_period_overview(categorized_rows, "month")
    yearly_overview = build_period_overview(categorized_rows, "year")
    monthly_categories = build_category_summary(categorized_rows, "month")
    yearly_categories = build_category_summary(categorized_rows, "year")

    write_categorized_csv(categorized_path, categorized_rows)
    write_review_csv(review_path, categorized_rows)
    write_summary_csv(
        monthly_overview_path,
        monthly_overview,
        [
            "month",
            "transaction_count",
            "income_eur",
            "expense_eur",
            "fixed_cost_eur",
            "variable_cost_eur",
            "tax_eur",
            "transfer_net_eur",
            "investment_net_eur",
            "investing_outflow_eur",
            "other_net_eur",
            "net_cashflow_eur",
            "operating_cashflow_eur",
            "recurring_fixed_eur",
            "savings_after_transfers_eur",
        ],
    )
    write_summary_csv(
        yearly_overview_path,
        yearly_overview,
        [
            "year",
            "transaction_count",
            "income_eur",
            "expense_eur",
            "fixed_cost_eur",
            "variable_cost_eur",
            "tax_eur",
            "transfer_net_eur",
            "investment_net_eur",
            "investing_outflow_eur",
            "other_net_eur",
            "net_cashflow_eur",
            "operating_cashflow_eur",
            "recurring_fixed_eur",
            "savings_after_transfers_eur",
        ],
    )
    write_summary_csv(
        monthly_categories_path,
        monthly_categories,
        ["month", "group", "category", "transaction_count", "inflow_eur", "outflow_eur", "net_amount_eur"],
    )
    write_summary_csv(
        yearly_categories_path,
        yearly_categories,
        ["year", "group", "category", "transaction_count", "inflow_eur", "outflow_eur", "net_amount_eur"],
    )

    review_count = sum(row["needs_review"] == "true" for row in categorized_rows)
    completed_at = timestamp_now()
    output_files = {
        "categorized_csv": str(categorized_path),
        "review_csv": str(review_path),
        "monthly_overview_csv": str(monthly_overview_path),
        "yearly_overview_csv": str(yearly_overview_path),
        "monthly_categories_csv": str(monthly_categories_path),
        "yearly_categories_csv": str(yearly_categories_path),
        "cache_json": str(cache_path),
    }
    if summary_json_path is not None:
        output_files["summary_json"] = str(summary_json_path)
        write_summary_json(
            summary_json_path,
            {
                "model": args.model,
                "transaction_row_count": len(transactions),
                "review_count": review_count,
                "cache_entry_count": len(cache_entries),
                "cache_hits": resolution_counts["cache"],
                "cache_misses": resolution_counts["rule"] + resolution_counts["llm"] + resolution_counts["fallback"],
                "manual_rule_hits": resolution_counts["manual_rule"],
                "built_in_rule_hits": resolution_counts["rule"],
                "llm_classifications": resolution_counts["llm"],
                "row_override_hits": row_override_hits,
                "output_files": output_files,
                "timestamps": {
                    "started_at": started_at,
                    "completed_at": completed_at,
                },
            },
        )

    print(f"Wrote categorized transactions to {categorized_path}")
    print(f"Wrote review rows to {review_path}")
    print(f"Wrote monthly overview to {monthly_overview_path}")
    print(f"Wrote yearly overview to {yearly_overview_path}")
    print(f"Wrote monthly categories to {monthly_categories_path}")
    print(f"Wrote yearly categories to {yearly_categories_path}")
    print(f"Wrote classification cache to {cache_path}")
    if summary_json_path is not None:
        print(f"Wrote pipeline summary to {summary_json_path}")
    print(f"Rows marked for review: {review_count}/{len(categorized_rows)}")


if __name__ == "__main__":
    main()
