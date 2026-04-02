#!/usr/bin/python3

import argparse
import csv
import hashlib
import json
import re
import sys
import time
import urllib.request
import urllib.error
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
DEFAULT_PROMPT_TEMPLATE_PATH = PROJECT_ROOT / "config" / "classifier_prompt_template.txt"
DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE_PATH = PROJECT_ROOT / "config" / "investment_asset_class_prompt_template.txt"
ALLOWED_CATEGORIES = [
    "salary",
    "bonus_cashback",
    "interest_dividend",
    "refund",
    "groceries",
    "restaurants_takeaway",
    "transport",
    "travel",
    "shopping",
    "subscriptions",
    "software_ai",
    "education",
    "health",
    "insurance",
    "fitness_sports",
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
ALLOWED_ASSET_CLASSES = [
    "etf",
    "commodity",
    "bond",
    "private_market",
    "stock",
    "crypto",
    "other",
]
CATEGORY_ALIASES = {
    "bars_cafes": "restaurants_takeaway",
    "dining": "restaurants_takeaway",
}
CATEGORY_GROUP_MAP = {
    "salary": "income",
    "bonus_cashback": "income",
    "interest_dividend": "income",
    "refund": "income",
    "groceries": "expense",
    "restaurants_takeaway": "expense",
    "transport": "expense",
    "travel": "expense",
    "shopping": "expense",
    "subscriptions": "expense",
    "software_ai": "expense",
    "education": "expense",
    "health": "expense",
    "insurance": "expense",
    "fitness_sports": "expense",
    "housing": "expense",
    "utilities": "expense",
    "telecom": "expense",
    "entertainment": "expense",
    "gifts": "expense",
    "fees": "expense",
    "internal_transfer": "transfer",
    "peer_transfer": "transfer",
    "investing": "investment",
    "crypto": "investment",
    "taxes": "tax",
    "other": "other",
}
FIXED_COST_CATEGORIES = {
    "education",
    "health",
    "insurance",
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
    amount_eur: str


@dataclass(frozen=True)
class ManualRule:
    rule_id: str
    name: str
    match_type: str
    pattern: str
    transaction_type: str
    amount_sign: str
    category: str


@dataclass(frozen=True)
class RowOverride:
    row_id: str
    category: Optional[str]
    asset_class: Optional[str]
    source: Optional[str]
    link_group_id: Optional[str]
    link_role: Optional[str]
    description: Optional[str]
    transaction_type: Optional[str]
    amount_sign: Optional[str]

    def has_changes(self) -> bool:
        return any(
            value is not None
            for value in (
                self.category,
                self.asset_class,
                self.source,
                self.link_group_id,
                self.link_role,
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
    parser.add_argument("--batch-size", type=int, default=3, help="Number of unique descriptions per LLM request.")
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
            "row_id, enabled, category, asset_class, source, "
            "link_group_id, link_role."
        ),
    )
    parser.add_argument(
        "--summary-json",
        default=None,
        help="Optional path for a pipeline summary JSON file.",
    )
    parser.add_argument(
        "--prompt-addendum-file",
        default=None,
        help="Optional path to extra instructions appended to the built-in classifier prompt.",
    )
    parser.add_argument(
        "--prompt-template-file",
        default=None,
        help=(
            "Optional path to a prompt template override. "
            "Supports {{response_example_json}}, {{taxonomy}}, and {{account_holder_hint}} placeholders. "
            "Examples, extra instructions, and transactions are appended automatically."
        ),
    )
    parser.add_argument(
        "--user-name",
        default="",
        help="Optional account holder name used to detect internal transfers mentioning the user's own name.",
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


def normalize_category(category: Optional[str]) -> str:
    value = (category or "").strip()
    if not value:
        return ""
    return CATEGORY_ALIASES.get(value, value)


def normalize_asset_class(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    if normalized == "gold":
        return "commodity"
    if normalized == "bond_etf":
        return "etf"
    if normalized in ALLOWED_ASSET_CLASSES:
        return normalized
    return "other"


def derive_group_from_category(category: str) -> str:
    return CATEGORY_GROUP_MAP.get(normalize_category(category), "other")


def format_category_taxonomy_for_prompt() -> str:
    category_descriptions = {
        "salary": "payroll or employer salary income",
        "bonus_cashback": "cashback, referral bonus, or other bonus income",
        "interest_dividend": "interest payments or dividends",
        "refund": "refunds, reimbursements, or money returned after a charge",
        "groceries": "supermarkets, grocery stores, and staple household food shopping",
        "restaurants_takeaway": "restaurants, cafes, bars, takeaway, food delivery, and similar food-out spending",
        "transport": "everyday mobility such as trains, metro, buses, taxis, scooter sharing, or parking",
        "travel": "flights, hotels, vacation bookings, and longer-distance travel spending",
        "shopping": "general retail, e-commerce, clothes, home goods, and non-essential purchases",
        "subscriptions": "recurring memberships or consumer subscriptions",
        "software_ai": "software tools, SaaS, AI services, and digital work tools",
        "education": "courses, tuition, books, certifications, and academic costs",
        "health": "medical, pharmacy, therapy, and healthcare spending",
        "insurance": "insurance premiums, policies, and insurance providers",
        "fitness_sports": "gyms, sports memberships, exercise classes, and sport-related memberships",
        "housing": "rent and direct housing costs",
        "utilities": "electricity, water, heating, broadcasting fees, and similar household utilities",
        "telecom": "phone, mobile plan, and internet bills",
        "entertainment": "cinema, games, concerts, streaming add-ons, and leisure entertainment",
        "gifts": "gifts, donations, and presents for others",
        "fees": "bank fees, platform fees, penalties, commissions, or administrative charges",
        "internal_transfer": "money moved between the user's own accounts",
        "peer_transfer": "money sent to or received from another person",
        "investing": "ETF, stock, broker, and non-crypto investment activity",
        "crypto": "crypto trading, crypto purchases, and crypto platform activity",
        "taxes": "tax payments, tax adjustments, and tax-related entries",
        "other": "only use this when no category fits confidently",
    }
    return "\n".join(
        f"- {category}: {category_descriptions[category]}"
        for category in ALLOWED_CATEGORIES
    )


def format_asset_class_taxonomy_for_prompt() -> str:
    asset_class_descriptions = {
        "etf": "any listed ETF or UCITS ETF, including bond ETFs and index ETFs",
        "commodity": "commodity exposure such as gold ETC, gold ETP, or physical-gold-like instrument",
        "bond": "direct sovereign or corporate bond, note, or debenture",
        "private_market": "private equity, private credit, venture, ELTIF, infrastructure, or similar private-market exposure",
        "stock": "single-company equity or common stock",
        "crypto": "crypto coin, token, or crypto ETP/ETN exposure",
        "other": "use this when the transaction is not an investment trade or the asset type is unclear",
    }
    return "\n".join(
        f"- {asset_class}: {asset_class_descriptions[asset_class]}"
        for asset_class in ALLOWED_ASSET_CLASSES
    )

def load_prompt_addendum(path_value: Optional[str]) -> str:
    if not path_value:
        return ""
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def load_prompt_template(path_value: Optional[str]) -> str:
    if not path_value:
        return ""
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


DEFAULT_PROMPT_TEMPLATE = load_prompt_template(str(DEFAULT_PROMPT_TEMPLATE_PATH))
DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE = load_prompt_template(str(DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE_PATH))


def render_prompt_template(template: str, values: dict[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", value)
    return rendered.strip()


def derive_amount_sign(value: Optional[str]) -> Optional[str]:
    text = clean_optional_text(value)
    if text is None:
        return None
    try:
        amount = parse_decimal(text)
    except ValueError:
        return None
    if amount > 0:
        return "income"
    if amount < 0:
        return "expense"
    return "zero"


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
                    category=normalize_category(row.get("category") or "other") or "other",
                )
            )
    return rules


def normalize_link_role(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip().lower()
    if normalized in {"net", "member"}:
        return normalized
    return None


def extract_legacy_link_metadata(subcategory: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    value = (subcategory or "").strip()
    if value.startswith("connected_expense_net:"):
        return ((value.removeprefix("connected_expense_net:").strip() or None), "net")
    if value.startswith("connected_expense_member:"):
        return ((value.removeprefix("connected_expense_member:").strip() or None), "member")
    return (None, None)


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

            link_group_id = clean_optional_text(row.get("link_group_id"))
            link_role = normalize_link_role(row.get("link_role"))
            if link_group_id is None and link_role is None:
                link_group_id, link_role = extract_legacy_link_metadata(row.get("subcategory"))
            override = RowOverride(
                row_id=row_id,
                category=normalize_category(clean_optional_text(row.get("category"))) or None,
                asset_class=(
                    normalize_asset_class(row.get("asset_class"))
                    if clean_optional_text(row.get("asset_class")) is not None
                    else None
                ),
                source=clean_optional_text(row.get("source")),
                link_group_id=link_group_id,
                link_role=link_role,
                description=clean_optional_text(row.get("description")),
                transaction_type=clean_optional_text(row.get("transaction_type")),
                amount_sign=derive_amount_sign(row.get("signed_amount")),
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
    category: str,
    source: str,
) -> dict:
    normalized_category = normalize_category(category) or "other"
    return {
        "category": normalized_category,
        "source": source,
    }


def normalize_cached_classification(raw: dict) -> dict:
    category = normalize_category(raw.get("category", "other")) or "other"
    if category not in ALLOWED_CATEGORIES:
        category = "other"

    source = clean_optional_text(raw.get("source")) or "llm"
    asset_class = normalize_asset_class(raw.get("asset_class", "other"))
    if category == "crypto":
        asset_class = "crypto"
    elif category != "investing":
        asset_class = "other"

    return {
        "category": category,
        "asset_class": asset_class,
        "source": source,
    }


def build_prompt_examples(
    manual_rules: list[ManualRule],
    row_overrides: dict[str, RowOverride],
    limit: int = 12,
) -> list[dict[str, str]]:
    examples: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()

    def add_example(tx_type: Optional[str], sign: Optional[str], description: Optional[str], category: Optional[str]) -> None:
        normalized_category = normalize_category(category) or "other"
        normalized_description = clean_optional_text(description)
        normalized_type = clean_optional_text(tx_type) or ""
        if (
            not normalized_description
            or normalized_category not in ALLOWED_CATEGORIES
            or normalized_category == "other"
        ):
            return
        dedupe_key = (
            normalized_type,
            normalize_description_for_classification(normalized_description),
            normalized_category,
        )
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)
        example = {
            "description": normalized_description,
            "category": normalized_category,
        }
        if normalized_type:
            example["type"] = normalized_type
        examples.append(example)

    for override in row_overrides.values():
        add_example(override.transaction_type, override.amount_sign, override.description, override.category)
        if len(examples) >= limit:
            return examples[:limit]

    for rule in manual_rules:
        if rule.match_type == "regex":
            continue
        add_example(rule.transaction_type, rule.amount_sign, rule.pattern, rule.category)
        if len(examples) >= limit:
            return examples[:limit]

    return examples[:limit]


def apply_row_override(classification: dict, override: RowOverride) -> dict:
    updated = dict(classification)

    if override.category is not None:
        updated["category"] = override.category if override.category in ALLOWED_CATEGORIES else "other"

    if override.asset_class is not None:
        if updated["category"] == "crypto":
            updated["asset_class"] = "crypto"
        elif updated["category"] == "investing":
            updated["asset_class"] = normalize_asset_class(override.asset_class)
        else:
            updated["asset_class"] = "other"

    updated["source"] = override.source or "row_override"
    return updated


def build_prompt_fingerprint(
    prompt_template: str,
    asset_class_prompt_template: str,
    prompt_addendum: str,
    account_holder_name: str,
    prompt_examples: list[dict[str, str]],
) -> str:
    payload = {
        "classifier_mode": "llm_only_v4_two_step_asset_class",
        "template": prompt_template.strip() or DEFAULT_PROMPT_TEMPLATE,
        "asset_class_template": asset_class_prompt_template.strip() or DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE,
        "addendum": prompt_addendum.strip(),
        "account_holder_name": re.sub(r"\s+", " ", account_holder_name).strip(),
        "examples": prompt_examples,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_cache(path: Path, refresh_cache: bool, model: str, prompt_fingerprint: str) -> dict[str, dict]:
    if refresh_cache or not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if payload.get("model") != model:
        return {}
    if payload.get("prompt_fingerprint") != prompt_fingerprint:
        return {}
    return payload.get("entries", {})


def save_cache(path: Path, model: str, prompt_fingerprint: str, entries: dict[str, dict]) -> None:
    payload = {
        "version": 2,
        "model": model,
        "prompt_fingerprint": prompt_fingerprint,
        "updated_at_epoch": int(time.time()),
        "entries": entries,
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=True)


def sanitize_category_classification(raw: dict) -> dict:
    category = normalize_category(raw.get("category", "other")) or "other"

    if category not in ALLOWED_CATEGORIES:
        category = "other"

    return {
        "category": category,
        "source": "llm",
    }


def sanitize_asset_class_classification(raw: dict, category: str) -> dict:
    normalized_category = normalize_category(category) or "other"
    asset_class = normalize_asset_class(raw.get("asset_class", "other"))
    if normalized_category == "crypto":
        asset_class = "crypto"
    elif normalized_category != "investing":
        asset_class = "other"

    return {
        "asset_class": asset_class,
        "source": "llm",
    }


def ollama_chat(model: str, prompt: str, response_schema: dict, timeout_seconds: int) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "think": False,
        "stream": False,
        "format": response_schema,
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


def build_category_prompt(
    items: list[ClassificationItem],
    prompt_template: str = "",
    prompt_addendum: str = "",
    account_holder_name: str = "",
    prompt_examples: Optional[list[dict[str, str]]] = None,
) -> str:
    example_shape = {
        "results": [
            {
                "id": "1",
                "category": "software_ai",
            }
        ]
    }
    payload = []
    for index, item in enumerate(items, start=1):
        payload.append(
            {
                "id": str(index),
                "type": item.tx_type,
                "description": item.description,
                "amount_eur": item.amount_eur,
            }
        )
    extra_instructions = prompt_addendum.strip()
    extra_block = (
        f"Run-specific extra instructions:\n{extra_instructions}\n"
        if extra_instructions
        else ""
    )
    account_holder = re.sub(r"\s+", " ", account_holder_name).strip()
    account_holder_block = (
        f"Account holder hint:\n- The user's name for this run is {json.dumps(account_holder, ensure_ascii=False)}.\n"
        "- Transactions that clearly mention that same person as sender or recipient are usually internal_transfer.\n"
        if account_holder
        else ""
    )
    prompt_template_value = prompt_template.strip() or DEFAULT_PROMPT_TEMPLATE
    static_prompt = render_prompt_template(
        prompt_template_value,
        {
            "response_example_json": json.dumps(example_shape, ensure_ascii=False),
            "taxonomy": format_category_taxonomy_for_prompt(),
            "account_holder_hint": account_holder_block,
        },
    )
    prompt_examples = prompt_examples or []
    examples_block = (
        "Examples from prior manual corrections and rules:\n"
        f"{json.dumps(prompt_examples, ensure_ascii=False)}\n"
        if prompt_examples
        else ""
    )
    parts = [static_prompt]
    if examples_block:
        parts.append(examples_block.strip())
    if extra_block:
        parts.append(extra_block.strip())
    parts.append(f"Transactions:\n{json.dumps(payload, ensure_ascii=False)}")
    return "\n\n".join(part for part in parts if part)


def build_asset_class_prompt(
    items: list[ClassificationItem],
    prompt_addendum: str = "",
    asset_class_prompt_template: str = "",
) -> str:
    example_shape = {
        "results": [
            {
                "id": "1",
                "asset_class": "etf",
            }
        ]
    }
    payload = []
    for index, item in enumerate(items, start=1):
        payload.append(
            {
                "id": str(index),
                "category": item.sign,
                "type": item.tx_type,
                "description": item.description,
                "amount_eur": item.amount_eur,
            }
        )
    extra_instructions = prompt_addendum.strip()
    extra_block = (
        f"Run-specific extra instructions:\n{extra_instructions}\n"
        if extra_instructions
        else ""
    )
    prompt_template_value = asset_class_prompt_template.strip() or DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE
    static_prompt = render_prompt_template(
        prompt_template_value,
        {
            "response_example_json": json.dumps(example_shape, ensure_ascii=False),
            "asset_class_taxonomy": format_asset_class_taxonomy_for_prompt(),
        },
    )
    parts = [static_prompt]
    if extra_block:
        parts.append(extra_block.strip())
    parts.append(f"Investment transactions:\n{json.dumps(payload, ensure_ascii=False)}")
    return "\n\n".join(part for part in parts if part)


def call_category_llm_batch(
    model: str,
    items: list[ClassificationItem],
    prompt_template: str = "",
    prompt_addendum: str = "",
    account_holder_name: str = "",
    prompt_examples: Optional[list[dict[str, str]]] = None,
) -> dict[str, dict]:
    response_schema = {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "category": {"type": "string", "enum": ALLOWED_CATEGORIES},
                    },
                    "required": ["id", "category"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["results"],
        "additionalProperties": False,
    }
    prompt = build_category_prompt(
        items,
        prompt_template=prompt_template,
        prompt_addendum=prompt_addendum,
        account_holder_name=account_holder_name,
        prompt_examples=prompt_examples,
    )
    content = ollama_chat(model=model, prompt=prompt, response_schema=response_schema, timeout_seconds=240)
    parsed = json.loads(content)
    if isinstance(parsed, list):
        results = parsed
    else:
        results = parsed.get("results", [])
    if not isinstance(results, list):
        raise ValueError("LLM response did not contain a results array.")

    by_id: dict[str, dict] = {}
    item_by_id = {str(index): item for index, item in enumerate(items, start=1)}
    for item in results:
        if not isinstance(item, dict) or "id" not in item:
            continue
        item_id = str(item["id"])
        if item_by_id.get(item_id) is None:
            continue
        by_id[item_by_id[item_id].cache_key] = sanitize_category_classification(item)

    expected_ids = {item.cache_key for item in items}
    if set(by_id) != expected_ids:
        missing = expected_ids - set(by_id)
        extra = set(by_id) - expected_ids
        raise ValueError(f"LLM response ids mismatch. missing={sorted(missing)} extra={sorted(extra)}")
    return by_id


def call_asset_class_llm_batch(
    model: str,
    items: list[ClassificationItem],
    prompt_addendum: str = "",
    asset_class_prompt_template: str = "",
) -> dict[str, dict]:
    response_schema = {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "asset_class": {"type": "string", "enum": ALLOWED_ASSET_CLASSES},
                    },
                    "required": ["id", "asset_class"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["results"],
        "additionalProperties": False,
    }
    prompt = build_asset_class_prompt(
        items,
        prompt_addendum=prompt_addendum,
        asset_class_prompt_template=asset_class_prompt_template,
    )
    content = ollama_chat(model=model, prompt=prompt, response_schema=response_schema, timeout_seconds=240)
    parsed = json.loads(content)
    if isinstance(parsed, list):
        results = parsed
    else:
        results = parsed.get("results", [])
    if not isinstance(results, list):
        raise ValueError("LLM response did not contain a results array.")

    by_id: dict[str, dict] = {}
    item_by_id = {str(index): item for index, item in enumerate(items, start=1)}
    for item in results:
        if not isinstance(item, dict) or "id" not in item:
            continue
        item_id = str(item["id"])
        source_item = item_by_id.get(item_id)
        if source_item is None:
            continue
        by_id[source_item.cache_key] = sanitize_asset_class_classification(item, source_item.sign)

    expected_ids = {item.cache_key for item in items}
    if set(by_id) != expected_ids:
        missing = expected_ids - set(by_id)
        extra = set(by_id) - expected_ids
        raise ValueError(f"LLM response ids mismatch. missing={sorted(missing)} extra={sorted(extra)}")
    return by_id


def classify_categories_with_llm(
    model: str,
    items: list[ClassificationItem],
    prompt_template: str = "",
    prompt_addendum: str = "",
    account_holder_name: str = "",
    prompt_examples: Optional[list[dict[str, str]]] = None,
) -> dict[str, dict]:
    if not items:
        return {}

    try:
        return call_category_llm_batch(
            model=model,
            items=items,
            prompt_template=prompt_template,
            prompt_addendum=prompt_addendum,
            account_holder_name=account_holder_name,
            prompt_examples=prompt_examples,
        )
    except (json.JSONDecodeError, urllib.error.URLError, TimeoutError, ValueError) as exc:
        if len(items) == 1:
            item = items[0]
            return {
                item.cache_key: default_classification(
                    category="other",
                    source="fallback",
                )
            }
        middle = max(1, len(items) // 2)
        left = classify_categories_with_llm(
            model=model,
            items=items[:middle],
            prompt_template=prompt_template,
            prompt_addendum=prompt_addendum,
            account_holder_name=account_holder_name,
            prompt_examples=prompt_examples,
        )
        right = classify_categories_with_llm(
            model=model,
            items=items[middle:],
            prompt_template=prompt_template,
            prompt_addendum=prompt_addendum,
            account_holder_name=account_holder_name,
            prompt_examples=prompt_examples,
        )
        return {**left, **right}


def classify_asset_classes_with_llm(
    model: str,
    items: list[ClassificationItem],
    prompt_addendum: str = "",
    asset_class_prompt_template: str = "",
) -> dict[str, dict]:
    if not items:
        return {}

    try:
        return call_asset_class_llm_batch(
            model=model,
            items=items,
            prompt_addendum=prompt_addendum,
            asset_class_prompt_template=asset_class_prompt_template,
        )
    except (json.JSONDecodeError, urllib.error.URLError, TimeoutError, ValueError):
        if len(items) == 1:
            item = items[0]
            return {
                item.cache_key: {
                    "asset_class": "crypto" if item.sign == "crypto" else "other",
                    "source": "fallback",
                }
            }
        middle = max(1, len(items) // 2)
        left = classify_asset_classes_with_llm(
            model=model,
            items=items[:middle],
            prompt_addendum=prompt_addendum,
            asset_class_prompt_template=asset_class_prompt_template,
        )
        right = classify_asset_classes_with_llm(
            model=model,
            items=items[middle:],
            prompt_addendum=prompt_addendum,
            asset_class_prompt_template=asset_class_prompt_template,
        )
        return {**left, **right}


def chunked(items: list[ClassificationItem], size: int) -> list[list[ClassificationItem]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def month_index(month_value: str) -> int:
    year, month = month_value.split("-")
    return int(year) * 12 + int(month)


def detect_recurring_patterns(rows: list[dict]) -> dict[str, dict]:
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        group = derive_group_from_category(row["category"])
        if group not in {"income", "expense", "tax"}:
            continue
        grouped[(row["category"], row["normalized_description"].strip().upper())].append(row)

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
        category = key[0]
        group = derive_group_from_category(category)
        if stable_ratio < 0.6 and group != "income":
            continue

        confidence = min(0.99, 0.48 + 0.07 * len(distinct_months) + 0.18 * consecutive_ratio + 0.16 * stable_ratio)
        is_fixed_cost = group == "expense" and (category in FIXED_COST_CATEGORIES or confidence >= 0.82)
        recurrence_key = f"{group}|{key[1]}|{category}"
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
    group = derive_group_from_category(row["category"])
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
            extrasaction="ignore",
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
                "category",
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
                "classification_source",
                "classification_key",
                "asset_class",
                "link_group_id",
                "link_role",
                "raw_row",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

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

        group = derive_group_from_category(row["category"])
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
    buckets: dict[tuple[str, str], dict] = defaultdict(
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
        group = derive_group_from_category(row["category"])
        key = (row[period_field], row["category"])
        amount = parse_decimal(row["signed_amount_eur"])
        bucket = buckets[key]
        bucket[period_field] = row[period_field]
        bucket["group"] = group
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
        print(
            f"Loaded {len(manual_rules)} manual rules from {rules_path} for prompt examples.",
            file=sys.stderr,
        )
    else:
        print(f"No manual rules loaded from {rules_path}.", file=sys.stderr)
    row_overrides = load_row_overrides(row_overrides_path) if row_overrides_path else {}
    prompt_template = load_prompt_template(args.prompt_template_file)
    asset_class_prompt_template = DEFAULT_ASSET_CLASS_PROMPT_TEMPLATE
    prompt_addendum = load_prompt_addendum(args.prompt_addendum_file)
    account_holder_name = re.sub(r"\s+", " ", args.user_name).strip()
    prompt_examples = build_prompt_examples(manual_rules, row_overrides)
    prompt_fingerprint = build_prompt_fingerprint(
        prompt_template=prompt_template,
        asset_class_prompt_template=asset_class_prompt_template,
        prompt_addendum=prompt_addendum,
        account_holder_name=account_holder_name,
        prompt_examples=prompt_examples,
    )
    if row_overrides_path is not None:
        if row_overrides:
            print(f"Loaded {len(row_overrides)} row overrides from {row_overrides_path}.", file=sys.stderr)
        else:
            print(f"No row overrides loaded from {row_overrides_path}.", file=sys.stderr)
    if prompt_examples:
        print(f"Loaded {len(prompt_examples)} prompt examples from manual corrections and rules.", file=sys.stderr)

    existing_cache_entries = {
        key: normalize_cached_classification(value if isinstance(value, dict) else {})
        for key, value in load_cache(
            cache_path,
            refresh_cache=args.refresh_cache,
            model=args.model,
            prompt_fingerprint=prompt_fingerprint,
        ).items()
    }
    cache_entries = dict(existing_cache_entries)
    items_by_key: dict[str, ClassificationItem] = {}
    classification_by_key: dict[str, dict] = {}
    resolution_by_key: dict[str, str] = {}

    for row in transactions:
        cache_key = build_cache_key(row)
        sign = "income" if row.signed_amount > 0 else "expense" if row.signed_amount < 0 else "zero"

        if cache_key in classification_by_key:
            continue

        if cache_key in existing_cache_entries:
            classification_by_key[cache_key] = existing_cache_entries[cache_key]
            resolution_by_key[cache_key] = "cache"
            continue

        if cache_key not in items_by_key:
            items_by_key[cache_key] = ClassificationItem(
                cache_key=cache_key,
                tx_type=row.tx_type,
                sign=sign,
                description=row.description,
                amount_eur=format_decimal(row.signed_amount),
            )

    pending_items = list(items_by_key.values())
    if pending_items:
        print(
            f"Classifying categories for {len(pending_items)} unique descriptions with {args.model} in batches of {args.batch_size}...",
            file=sys.stderr,
        )
        for batch_index, batch in enumerate(chunked(pending_items, args.batch_size), start=1):
            print(
                f"  Category batch {batch_index}/{(len(pending_items) + args.batch_size - 1) // args.batch_size}: {len(batch)} items",
                file=sys.stderr,
            )
            batch_results = classify_categories_with_llm(
                model=args.model,
                items=batch,
                prompt_template=prompt_template,
                prompt_addendum=prompt_addendum,
                account_holder_name=account_holder_name,
                prompt_examples=prompt_examples,
            )
            for cache_key, classification in batch_results.items():
                merged_classification = dict(classification)
                if merged_classification["category"] == "crypto":
                    merged_classification["asset_class"] = "crypto"
                else:
                    merged_classification["asset_class"] = "other"
                classification_by_key[cache_key] = merged_classification
                cache_entries[cache_key] = merged_classification
                resolution_by_key[cache_key] = "llm" if classification.get("source") == "llm" else "fallback"

        investment_asset_items = [
            ClassificationItem(
                cache_key=item.cache_key,
                tx_type=item.tx_type,
                sign=classification_by_key[item.cache_key]["category"],
                description=item.description,
                amount_eur=item.amount_eur,
            )
            for item in pending_items
            if classification_by_key.get(item.cache_key, {}).get("category") in {"investing", "crypto"}
        ]
        if investment_asset_items:
            print(
                f"Classifying asset classes for {len(investment_asset_items)} investment descriptions with {args.model} in batches of {args.batch_size}...",
                file=sys.stderr,
            )
            for batch_index, batch in enumerate(chunked(investment_asset_items, args.batch_size), start=1):
                print(
                    f"  Asset class batch {batch_index}/{(len(investment_asset_items) + args.batch_size - 1) // args.batch_size}: {len(batch)} items",
                    file=sys.stderr,
                )
                batch_results = classify_asset_classes_with_llm(
                    model=args.model,
                    items=batch,
                    prompt_addendum=prompt_addendum,
                    asset_class_prompt_template=asset_class_prompt_template,
                )
                for cache_key, asset_classification in batch_results.items():
                    current = dict(classification_by_key.get(cache_key) or {})
                    if not current:
                        continue
                    current["asset_class"] = asset_classification.get("asset_class", current.get("asset_class", "other"))
                    classification_by_key[cache_key] = current
                    cache_entries[cache_key] = current
        else:
            print("No investment descriptions required LLM asset classification.", file=sys.stderr)
    else:
        print("No uncached descriptions required LLM classification.", file=sys.stderr)

    save_cache(cache_path, model=args.model, prompt_fingerprint=prompt_fingerprint, entries=cache_entries)

    resolution_counts = Counter()
    row_override_hits = 0
    categorized_rows: list[dict] = []
    for row in transactions:
        cache_key = build_cache_key(row)
        classification = classification_by_key.get(cache_key) or cache_entries.get(cache_key)
        resolution = resolution_by_key.get(cache_key)
        if classification is None:
            classification = default_classification(
                category="other",
                source="fallback",
            )
            resolution = "fallback"
            resolution_by_key[cache_key] = resolution

        resolution_counts[resolution or "fallback"] += 1
        effective_classification = dict(classification)
        override = row_overrides.get(row.row_id)
        link_group_id = ""
        link_role = ""
        if override is not None:
            effective_classification = apply_row_override(effective_classification, override)
            link_group_id = override.link_group_id or ""
            link_role = override.link_role or ""
            row_override_hits += 1

        month = row.date[:7]
        year = row.date[:4]
        effective_group = derive_group_from_category(effective_classification["category"])
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
                "group": effective_group,
                "category": effective_classification["category"],
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
                    effective_group in {"income", "expense", "tax", "other"}
                ).lower(),
                "classification_source": effective_classification["source"],
                "classification_key": cache_key,
                "asset_class": effective_classification.get("asset_class", "other"),
                "link_group_id": link_group_id,
                "link_role": link_role,
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

    completed_at = timestamp_now()
    output_files = {
        "categorized_csv": str(categorized_path),
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
                "cache_entry_count": len(cache_entries),
                "cache_hits": resolution_counts["cache"],
                "cache_misses": resolution_counts["llm"] + resolution_counts["fallback"],
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
    print(f"Wrote monthly overview to {monthly_overview_path}")
    print(f"Wrote yearly overview to {yearly_overview_path}")
    print(f"Wrote monthly categories to {monthly_categories_path}")
    print(f"Wrote yearly categories to {yearly_categories_path}")
    print(f"Wrote classification cache to {cache_path}")
    if summary_json_path is not None:
        print(f"Wrote pipeline summary to {summary_json_path}")


if __name__ == "__main__":
    main()
