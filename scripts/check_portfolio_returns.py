#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TypeVar


EPSILON = 1e-7
T = TypeVar("T")
ISIN_RE = re.compile(r"\b[A-Z0-9]{12}\b")
QUANTITY_RE = re.compile(r"quantity:\s*([0-9.]+)", re.IGNORECASE)

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

DESCRIPTION_ALIASES: list[tuple[re.Pattern[str], dict[str, str]]] = [
    (
        re.compile(r"VANGUARD FTSE ALL-WORLD UCITS ETF", re.IGNORECASE),
        {
            "isin": "IE00BK5BQT80",
            "instrument": "Vanguard FTSE All-World UCITS ETF",
            "symbol": "IE00BK5BQT80.SG",
            "search_query": "IE00BK5BQT80",
            "asset_class": "etf",
        },
    ),
    (
        re.compile(r"ISHARES PHYSICAL GOLD ETC", re.IGNORECASE),
        {
            "isin": "IE00B4ND3602",
            "instrument": "iShares Physical Gold ETC",
            "symbol": "SGLN.MI",
            "search_query": "iShares Physical Gold ETC",
            "asset_class": "gold",
        },
    ),
    (
        re.compile(r"AMUNDI .* STOXX EUROPE 600", re.IGNORECASE),
        {
            "isin": "LU0908500753",
            "instrument": "Amundi Core Stoxx Europe 600 UCITS ETF Acc",
            "symbol": "MEUD.PA",
            "search_query": "LU0908500753",
            "asset_class": "etf",
        },
    ),
    (
        re.compile(r"ISHARES CORE S&P 500 UCITS ETF", re.IGNORECASE),
        {
            "isin": "IE00B5BMR087",
            "instrument": "iShares Core S&P 500 UCITS ETF USD (Acc)",
            "symbol": "SXR8.DE",
            "search_query": "IE00B5BMR087",
            "asset_class": "etf",
        },
    ),
    (
        re.compile(r"\bBITCOIN\b", re.IGNORECASE),
        {
            "isin": "XF000BTC0017",
            "instrument": "Bitcoin",
            "symbol": "BTC-USD",
            "search_query": "Bitcoin",
            "asset_class": "crypto",
        },
    ),
    (
        re.compile(r"\bETH(?:EREUM)?\b", re.IGNORECASE),
        {
            "isin": "XF000ETH0019",
            "instrument": "Ethereum",
            "symbol": "ETH-USD",
            "search_query": "Ethereum",
            "asset_class": "crypto",
        },
    ),
]

MANUAL_ISIN_ALIASES: dict[str, dict[str, str]] = {
    "IE00BK5BQT80": {
        "isin": "IE00BK5BQT80",
        "instrument": "Vanguard FTSE All-World UCITS ETF",
        "symbol": "IE00BK5BQT80.SG",
        "search_query": "IE00BK5BQT80",
        "asset_class": "etf",
    },
    "IE00B4ND3602": {
        "isin": "IE00B4ND3602",
        "instrument": "iShares Physical Gold ETC",
        "symbol": "SGLN.MI",
        "search_query": "iShares Physical Gold ETC",
        "asset_class": "gold",
    },
    "LU0908500753": {
        "isin": "LU0908500753",
        "instrument": "Amundi Core Stoxx Europe 600 UCITS ETF Acc",
        "symbol": "MEUD.PA",
        "search_query": "LU0908500753",
        "asset_class": "etf",
    },
    "IE00B5BMR087": {
        "isin": "IE00B5BMR087",
        "instrument": "iShares Core S&P 500 UCITS ETF USD (Acc)",
        "symbol": "SXR8.DE",
        "search_query": "IE00B5BMR087",
        "asset_class": "etf",
    },
    "IE00B4L5Y983": {
        "isin": "IE00B4L5Y983",
        "instrument": "iShares Core MSCI World UCITS ETF USD (Acc)",
        "symbol": "EUNL.DE",
        "search_query": "IE00B4L5Y983",
        "asset_class": "etf",
    },
    "IE00B53SZB19": {
        "isin": "IE00B53SZB19",
        "instrument": "iShares Nasdaq 100 UCITS ETF USD (Acc)",
        "symbol": "CNDX.L",
        "search_query": "IE00B53SZB19",
        "asset_class": "etf",
    },
    "IE00B3WJKG14": {
        "isin": "IE00B3WJKG14",
        "instrument": "iShares S&P 500 Information Technology Sector UCITS ETF USD (Acc)",
        "symbol": "IUIT.L",
        "search_query": "IE00B3WJKG14",
        "asset_class": "etf",
    },
    "XF000BTC0017": {
        "isin": "XF000BTC0017",
        "instrument": "Bitcoin",
        "symbol": "BTC-USD",
        "search_query": "Bitcoin",
        "asset_class": "crypto",
    },
    "XF000ETH0019": {
        "isin": "XF000ETH0019",
        "instrument": "Ethereum",
        "symbol": "ETH-USD",
        "search_query": "Ethereum",
        "asset_class": "crypto",
    },
    "US0378331005": {
        "isin": "US0378331005",
        "instrument": "Apple",
        "symbol": "AAPL",
        "search_query": "US0378331005",
        "asset_class": "stock",
    },
    "US67066G1040": {
        "isin": "US67066G1040",
        "instrument": "NVIDIA",
        "symbol": "NVDA",
        "search_query": "US67066G1040",
        "asset_class": "stock",
    },
    "US0231351067": {
        "isin": "US0231351067",
        "instrument": "Amazon",
        "symbol": "AMZN",
        "search_query": "US0231351067",
        "asset_class": "stock",
    },
    "US0079031078": {
        "isin": "US0079031078",
        "instrument": "AMD",
        "symbol": "AMD",
        "search_query": "US0079031078",
        "asset_class": "stock",
    },
    "US30303M1027": {
        "isin": "US30303M1027",
        "instrument": "Meta",
        "symbol": "META",
        "search_query": "US30303M1027",
        "asset_class": "stock",
    },
    "US64110L1061": {
        "isin": "US64110L1061",
        "instrument": "Netflix",
        "symbol": "NFLX",
        "search_query": "US64110L1061",
        "asset_class": "stock",
    },
    "US90353T1007": {
        "isin": "US90353T1007",
        "instrument": "Uber",
        "symbol": "UBER",
        "search_query": "US90353T1007",
        "asset_class": "stock",
    },
    "US33813J1060": {
        "isin": "US33813J1060",
        "instrument": "Fisker",
        "symbol": "FSR",
        "search_query": "US33813J1060",
        "asset_class": "stock",
    },
}


@dataclass
class Transaction:
    row_id: str
    date: str
    tx_type: str
    description: str
    group: str
    category: str
    signed_amount: float
    balance: float
    investment_asset_class: str = ""
    category_override: str = ""


@dataclass
class ManualTransaction:
    row_id: str
    date: str
    transaction_type: str
    description: str
    signed_amount: float
    category: str


@dataclass
class CashBalancePoint:
    date: str
    cash_balance: float
    cash_change: float


@dataclass
class FundRow:
    date: str
    payment_type: str
    units: float
    price_per_unit: float
    amount: float
    signed_amount: float


@dataclass
class CapitalPoint:
    date: str
    available_cash: float


@dataclass
class InstrumentDefinition:
    key: str
    isin: str
    instrument: str
    asset_class: str
    price_scale: str
    fallback_valuation: str
    symbol: str = ""
    search_query: str = ""


@dataclass
class ParsedTrade:
    row_id: str
    date: str
    signed_amount: float
    isin: str
    instrument_key: str
    instrument: str
    asset_class: str
    price_scale: str
    fallback_valuation: str
    symbol: str
    units: float | None


@dataclass
class PositionUnitOverride:
    instrument_key: str
    units: float
    effective_date: str
    updated_at: str


@dataclass
class PositionValuationOverride:
    instrument_key: str
    price_eur: float
    effective_date: str
    updated_at: str


@dataclass
class InstrumentState:
    instrument_key: str
    isin: str
    instrument: str
    asset_class: str
    price_scale: str
    fallback_valuation: str
    symbol: str
    units: float = 0.0
    cost_basis_current: float = 0.0
    realized_pnl_all_time: float = 0.0
    gross_invested_eur: float = 0.0
    rows_without_quantity: int = 0
    manual_units_override: bool = False
    last_known_price_eur: float | None = None
    last_known_price_date: str = ""


@dataclass
class PortfolioPoint:
    date: str
    total_value_eur: float
    market_value_eur: float
    cash_value_eur: float
    cost_basis_eur: float
    realized_pnl_eur: float
    dividend_income_eur: float


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Independent portfolio return checker for Track Republic data."
    )
    parser.add_argument("--start-date", help="Inclusive range start in YYYY-MM-DD.")
    parser.add_argument("--end-date", help="Inclusive range end in YYYY-MM-DD.")
    parser.add_argument(
        "--categorized-csv",
        type=Path,
        default=repo_root / "data" / "processed" / "statement_transactions_categorized.csv",
    )
    parser.add_argument(
        "--cash-csv",
        type=Path,
        default=repo_root / "data" / "processed" / "statement_transactions.csv",
    )
    parser.add_argument(
        "--fund-csv",
        type=Path,
        default=repo_root / "data" / "processed" / "statement_money_market_fund.csv",
    )
    parser.add_argument(
        "--registry-csv",
        type=Path,
        default=repo_root / "config" / "instrument_registry.csv",
    )
    parser.add_argument(
        "--transaction-overrides-csv",
        type=Path,
        default=repo_root / "config" / "transaction_overrides.csv",
    )
    parser.add_argument(
        "--manual-transactions-csv",
        type=Path,
        default=repo_root / "config" / "manual_transactions.csv",
    )
    parser.add_argument(
        "--position-unit-overrides-csv",
        type=Path,
        default=repo_root / "config" / "position_unit_overrides.csv",
    )
    parser.add_argument(
        "--position-valuation-overrides-csv",
        type=Path,
        default=repo_root / "config" / "position_valuation_overrides.csv",
    )
    parser.add_argument(
        "--price-cache",
        type=Path,
        default=repo_root / "data" / "processed" / "portfolio_return_price_cache.json",
    )
    parser.add_argument("--refresh-cache", action="store_true", help="Ignore cached Yahoo history.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON output.")
    parser.add_argument("--show-daily", type=int, default=0, help="Include the first N and last N daily return points.")
    return parser.parse_args()


def parse_number(value: str | None) -> float:
    try:
        return float(value or "0")
    except (TypeError, ValueError):
        return 0.0


def normalize_category(value: str | None) -> str:
    category = (value or "").strip()
    if not category:
        return ""
    return CATEGORY_ALIASES.get(category, category)


def derive_group_from_category(category: str) -> str:
    normalized = normalize_category(category)
    return CATEGORY_GROUP_MAP.get(normalized, "other")


def normalize_asset_class(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"commodity", "gold"}:
        return "gold"
    if normalized == "bond_etf":
        return "etf"
    if normalized in {"crypto", "etf", "stock", "bond", "private_market"}:
        return normalized
    return "other"


def normalize_price_scale(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if normalized in {"absolute", "percent_of_par"}:
        return normalized
    return None


def normalize_fallback_valuation(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if normalized in {"statement_price", "cost_basis"}:
        return normalized
    return None


def default_price_scale(asset_class: str) -> str:
    return "percent_of_par" if asset_class == "bond" else "absolute"


def default_fallback_valuation(asset_class: str) -> str:
    return "cost_basis" if asset_class == "private_market" else "statement_price"


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def previous_date(value: str) -> str:
    current = datetime.strptime(value, "%Y-%m-%d").date()
    return (current - timedelta(days=1)).isoformat()


def date_range(start: str, end: str) -> list[str]:
    start_date = datetime.strptime(start, "%Y-%m-%d").date()
    end_date = datetime.strptime(end, "%Y-%m-%d").date()
    days = (end_date - start_date).days
    return [(start_date + timedelta(days=offset)).isoformat() for offset in range(days + 1)]


def compound_returns(values: list[float | None]) -> float | None:
    factor = 1.0
    has_value = False
    for value in values:
        if value is None or not math.isfinite(value):
            continue
        factor *= 1.0 + value / 100.0
        has_value = True
    return (factor - 1.0) * 100.0 if has_value else None


def annualize_return(return_pct: float | None, start_date: str, end_date: str) -> float | None:
    if return_pct is None:
        return None
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    days = (end - start).days
    if days <= 0:
        return None
    factor = 1.0 + return_pct / 100.0
    if factor <= 0:
        return None
    return (factor ** (365.2425 / days) - 1.0) * 100.0


def build_range_summary(return_series: list[dict[str, Any]], start_date: str, end_date: str) -> dict[str, Any] | None:
    points = [point for point in return_series if start_date <= point["date"] <= end_date]
    if not points:
        return None

    previous_point = next((point for point in reversed(return_series) if point["date"] < start_date), None)
    end_point = points[-1]
    external_flow_eur = sum(point["external_flow_eur"] for point in points)
    return_eur = (
        end_point["total_value_eur"] - previous_point["total_value_eur"] - external_flow_eur
        if previous_point
        else None
    )
    total_days = (
        datetime.strptime(end_point["date"], "%Y-%m-%d").date()
        - datetime.strptime(previous_point["date"], "%Y-%m-%d").date()
    ).days if previous_point else 0
    weighted_external_flow_eur = (
        sum(
            point["external_flow_eur"]
            * max(
                0,
                (
                    datetime.strptime(end_point["date"], "%Y-%m-%d").date()
                    - datetime.strptime(point["date"], "%Y-%m-%d").date()
                ).days,
            )
            / max(1, total_days)
            for point in points
        )
        if previous_point
        else None
    )
    denominator = (
        previous_point["total_value_eur"] + weighted_external_flow_eur
        if previous_point and weighted_external_flow_eur is not None
        else None
    )
    modified_dietz_return_pct = None
    if denominator is not None:
        if abs(denominator) > EPSILON and return_eur is not None:
            modified_dietz_return_pct = (return_eur / denominator) * 100.0
        elif return_eur is not None and abs(return_eur) <= EPSILON:
            modified_dietz_return_pct = 0.0
    return {
        "start_date": start_date,
        "end_date": end_date,
        "start_value_eur": previous_point["total_value_eur"] if previous_point else None,
        "end_value_eur": end_point["total_value_eur"],
        "external_flow_eur": external_flow_eur,
        "return_eur": return_eur,
        "modified_dietz_return_pct": modified_dietz_return_pct,
        "annualized_modified_dietz_return_pct": annualize_return(modified_dietz_return_pct, start_date, end_date),
        "days": (datetime.strptime(end_date, "%Y-%m-%d").date() - datetime.strptime(start_date, "%Y-%m-%d").date()).days,
    }


def build_yearly_summaries(return_series: list[dict[str, Any]], start_date: str, end_date: str) -> list[dict[str, Any]]:
    start_year = int(start_date[:4])
    end_year = int(end_date[:4])
    summaries: list[dict[str, Any]] = []
    for year in range(start_year, end_year + 1):
        year_start = max(start_date, f"{year}-01-01")
        year_end = min(end_date, f"{year}-12-31")
        summary = build_range_summary(return_series, year_start, year_end)
        if not summary:
            continue
        summaries.append(
            {
                "year": str(year),
                **summary,
            }
        )
    return summaries


def latest_before_or_on(series: dict[str, float], target_date: str) -> float | None:
    latest: float | None = None
    for key in sorted(series):
        if key > target_date:
            break
        latest = series[key]
    return latest


def normalize_price(raw_price: float, currency: str) -> tuple[float, str]:
    if currency == "GBp":
        return raw_price / 100.0, "GBP"
    return raw_price, currency


def normalize_instrument_price(price: float, price_scale: str) -> float:
    return price / 100.0 if price_scale == "percent_of_par" else price


def clean_instrument_name(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", value)
    return re.sub(r"^[-,\s]+|[-,\s]+$", "", cleaned).strip()


def extract_instrument_name(description: str, isin: str) -> str:
    text = re.sub(r",\s*quantity:.*$", "", description, flags=re.IGNORECASE)
    text = re.sub(
        r"^(Buy trade|Sell trade|Savings plan execution|Ausf.hrung Handel Direktkauf Kauf|Ausf.hrung Handel Direktverkauf Verkauf|Ausf.hrung Direktkauf|Ausf.hrung Direktverkauf|Ertrag|Dividend)\s+",
        "",
        text,
        flags=re.IGNORECASE,
    )
    if isin:
        text = text.replace(isin, "")
    text = re.sub(r"\bC\d{8,}\b", "", text)
    text = re.sub(r"\b\d{10,}\b", "", text)
    text = re.sub(r"\bKW\b", "", text)
    text = re.sub(r"\bDL[ -]?,?0*\.?\d+\b", "", text)
    return clean_instrument_name(text)


def infer_asset_class(description: str, instrument: str) -> str:
    text = f"{description} {instrument}".upper()
    sovereign_bond_style = bool(
        re.search(
            r"\b(FRANKREICH|FRANCE|DEUTSCHLAND|GERMANY|BUND|ITALIEN|ITALY|SPANIEN|SPAIN|PORTUGAL|BELGIEN|BELGIUM|NIEDERLANDE|NETHERLANDS|OSTERREICH|AUSTRIA|TREASURY)\b",
            text,
        )
        and re.search(r"\b\d{2}/\d{2}\b", text)
    )
    if re.search(r"\bBITCOIN\b|\bETH(?:EREUM)?\b|XF000BTC0017|XF000ETH0019", text):
        return "crypto"
    if re.search(r"GOLD ETC|PHYSICAL GOLD", text):
        return "gold"
    if re.search(
        r"PRIVATE\s+MARKET|PRIVATE\s+EQUITY|PRIVATE\s+CREDIT|PRIVATE\s+DEBT|VENTURE\s+CAPITAL|VENTURE\b|SECONDAR(?:Y|IES)|INFRASTRUCTURE\s+FUND|ELTIF|GROWTH\s+EQUITY|BUYOUT|PRIVATE\s+ASSETS",
        text,
    ):
        return "private_market"
    if sovereign_bond_style or re.search(
        r"BOND|BONDS|TREASURY|ANLEIHE|ANLEIHEN|CORP(?:ORATE)?\.?\s*BOND|GOVT|GOVERNMENT|FIXED INCOME|NOTE\b|NOTES\b|DEBENTURE|SCHULDVERSCHREIBUNG|RENTE\b|OBLIGATION|OBLIGATIONS",
        text,
    ):
        return "etf" if re.search(r"ETF|UCITS|ISHARES|VANGUARD|AMUNDI", text) else "bond"
    if re.search(r"ETF|UCITS|ISHARES|VANGUARD|AMUNDI|MULTI UNITS|MSCI|NASDAQ", text):
        return "etf"
    if re.search(r"[A-Z]", instrument):
        return "stock"
    return "other"


def load_registry_lookup(path: Path) -> dict[str, dict[str, str]]:
    lookup: dict[str, dict[str, str]] = {}
    for row in load_csv_rows(path):
        entry = {
            "key": (row.get("key") or "").strip(),
            "isin": (row.get("isin") or "").strip(),
            "symbol": (row.get("symbol") or "").strip(),
            "instrument": (row.get("instrument") or "").strip(),
            "asset_class": (row.get("asset_class") or "").strip(),
            "price_scale": (row.get("price_scale") or "").strip(),
            "fallback_valuation": (row.get("fallback_valuation") or "").strip(),
            "search_query": (row.get("search_query") or "").strip(),
        }
        for key in {
            entry["key"],
            entry["isin"],
            entry["instrument"],
            entry["instrument"].upper(),
        }:
            if key:
                lookup[key] = entry
    return lookup


def alias_from_description(description: str) -> dict[str, str] | None:
    for pattern, alias in DESCRIPTION_ALIASES:
        if pattern.search(description):
            return alias
    return None


def registry_alias(description: str, detected_isin: str, registry: dict[str, dict[str, str]]) -> dict[str, str] | None:
    if detected_isin and detected_isin in registry:
        hit = registry[detected_isin]
        return {
            "isin": hit.get("isin") or detected_isin,
            "instrument": hit.get("instrument") or extract_instrument_name(description, detected_isin),
            "symbol": hit.get("symbol") or "",
            "search_query": hit.get("search_query") or hit.get("isin") or hit.get("symbol") or hit.get("instrument") or detected_isin,
            "asset_class": normalize_asset_class(hit.get("asset_class")),
            "price_scale": normalize_price_scale(hit.get("price_scale")) or "",
            "fallback_valuation": normalize_fallback_valuation(hit.get("fallback_valuation")) or "",
        }

    extracted = extract_instrument_name(description, detected_isin)
    for candidate in (extracted, extracted.upper()):
        if not candidate or candidate not in registry:
            continue
        hit = registry[candidate]
        return {
            "isin": hit.get("isin") or detected_isin,
            "instrument": hit.get("instrument") or extracted,
            "symbol": hit.get("symbol") or "",
            "search_query": hit.get("search_query") or hit.get("isin") or hit.get("symbol") or hit.get("instrument") or candidate,
            "asset_class": normalize_asset_class(hit.get("asset_class")),
            "price_scale": normalize_price_scale(hit.get("price_scale")) or "",
            "fallback_valuation": normalize_fallback_valuation(hit.get("fallback_valuation")) or "",
        }
    return None


def resolve_instrument(description: str, registry: dict[str, dict[str, str]]) -> InstrumentDefinition:
    isin_match = ISIN_RE.search(description)
    detected_isin = isin_match.group(0) if isin_match else ""
    registry_match = registry_alias(description, detected_isin, registry)
    direct_alias = MANUAL_ISIN_ALIASES.get(detected_isin)
    description_alias = alias_from_description(description)
    alias = registry_match or direct_alias or description_alias or {}
    isin = alias.get("isin") or detected_isin
    instrument = alias.get("instrument") or extract_instrument_name(description, detected_isin)
    key = registry_match.get("isin") if registry_match else ""
    if not key:
        key = registry_match.get("instrument") if registry_match else ""
    if not key:
        key = isin or instrument.upper()
    asset_class = alias.get("asset_class") or infer_asset_class(description, instrument)
    price_scale = alias.get("price_scale") or default_price_scale(asset_class)
    fallback_valuation = alias.get("fallback_valuation") or default_fallback_valuation(asset_class)
    return InstrumentDefinition(
        key=key,
        isin=isin,
        instrument=instrument,
        symbol=alias.get("symbol") or "",
        search_query=alias.get("search_query") or isin or instrument,
        asset_class=asset_class,
        price_scale=price_scale,
        fallback_valuation=fallback_valuation,
    )


def apply_preferred_asset_class(instrument: InstrumentDefinition, preferred_asset_class: str) -> InstrumentDefinition:
    if preferred_asset_class in {"", "other", instrument.asset_class}:
        return instrument
    return InstrumentDefinition(
        key=instrument.key,
        isin=instrument.isin,
        instrument=instrument.instrument,
        symbol=instrument.symbol,
        search_query=instrument.search_query,
        asset_class=preferred_asset_class,
        price_scale=default_price_scale(preferred_asset_class),
        fallback_valuation=default_fallback_valuation(preferred_asset_class),
    )


def load_row_override_map(path: Path) -> dict[str, dict[str, str]]:
    return {
        (row.get("row_id") or "").strip(): row
        for row in load_csv_rows(path)
        if (row.get("row_id") or "").strip()
    }


def load_manual_transactions(path: Path) -> list[ManualTransaction]:
    output: list[ManualTransaction] = []
    for row in load_csv_rows(path):
        row_id = (row.get("row_id") or "").strip()
        if not row_id:
            continue
        output.append(
            ManualTransaction(
                row_id=row_id,
                date=(row.get("date") or "").strip(),
                transaction_type=(row.get("transaction_type") or "Manual").strip(),
                description=(row.get("description") or "Manual entry").strip() or "Manual entry",
                signed_amount=parse_number(row.get("signed_amount")),
                category=normalize_category(row.get("category")) or "other",
            )
        )
    return output


def manual_transaction_to_row(transaction: ManualTransaction) -> Transaction:
    category = normalize_category(transaction.category) or "other"
    return Transaction(
        row_id=transaction.row_id,
        date=transaction.date,
        tx_type=transaction.transaction_type,
        description=transaction.description,
        group=derive_group_from_category(category),
        category=category,
        signed_amount=transaction.signed_amount,
        balance=0.0,
    )


def merge_manual_transactions(transactions: list[Transaction], manual_transactions: list[ManualTransaction]) -> list[Transaction]:
    if not manual_transactions:
        return transactions

    merged = list(transactions) + [manual_transaction_to_row(item) for item in manual_transactions]
    merged.sort(key=lambda row: (row.date, row.group == "manual_entry", row.row_id))

    manual_delta = 0.0
    last_adjusted_balance: float | None = None
    adjusted: list[Transaction] = []
    for row in merged:
        if row.row_id.startswith("manual_") or row.tx_type == "Manual":
            adjusted_balance = (last_adjusted_balance or 0.0) + row.signed_amount
            manual_delta += row.signed_amount
            last_adjusted_balance = adjusted_balance
            adjusted.append(
                Transaction(
                    row_id=row.row_id,
                    date=row.date,
                    tx_type=row.tx_type,
                    description=row.description,
                    group=row.group,
                    category=row.category,
                    signed_amount=row.signed_amount,
                    balance=adjusted_balance,
                    investment_asset_class=row.investment_asset_class,
                    category_override=row.category_override,
                )
            )
            continue

        adjusted_balance = row.balance + manual_delta
        last_adjusted_balance = adjusted_balance
        adjusted.append(
            Transaction(
                row_id=row.row_id,
                date=row.date,
                tx_type=row.tx_type,
                description=row.description,
                group=row.group,
                category=row.category,
                signed_amount=row.signed_amount,
                balance=adjusted_balance,
                investment_asset_class=row.investment_asset_class,
                category_override=row.category_override,
            )
        )
    return adjusted


def load_transactions(
    categorized_csv: Path,
    overrides_csv: Path,
    manual_transactions_csv: Path,
) -> list[Transaction]:
    base_transactions: list[Transaction] = []
    for row in load_csv_rows(categorized_csv):
        category = normalize_category(row.get("category")) or "other"
        group = derive_group_from_category(category)
        base_transactions.append(
            Transaction(
                row_id=(row.get("row_id") or "").strip(),
                date=(row.get("date") or "").strip(),
                tx_type=(row.get("type") or "").strip(),
                description=(row.get("description") or "").strip(),
                group=group,
                category=category,
                signed_amount=parse_number(row.get("signed_amount_eur")),
                balance=parse_number(row.get("balance_eur")),
                investment_asset_class=normalize_asset_class(row.get("asset_class") or ""),
            )
        )

    base_transactions.sort(key=lambda row: (row.date, row.row_id))
    manual_transactions = load_manual_transactions(manual_transactions_csv)
    merged = merge_manual_transactions(base_transactions, manual_transactions)
    row_overrides = load_row_override_map(overrides_csv)

    visible_transactions: list[Transaction] = []
    for row in merged:
        override = row_overrides.get(row.row_id)
        if override and (override.get("source") or "").strip() == "deleted_transaction":
            continue

        next_category = normalize_category((override or {}).get("category")) or row.category
        next_group = derive_group_from_category(next_category)
        asset_class_override = normalize_asset_class((override or {}).get("asset_class") or (override or {}).get("investment_asset_class") or "")
        visible_transactions.append(
            Transaction(
                row_id=row.row_id,
                date=row.date,
                tx_type=row.tx_type,
                description=row.description,
                group=next_group,
                category=next_category,
                signed_amount=row.signed_amount,
                balance=row.balance,
                investment_asset_class=asset_class_override or row.investment_asset_class,
                category_override=normalize_category((override or {}).get("category")),
            )
        )

    return visible_transactions


def load_cash_balances(cash_csv: Path, overrides_csv: Path, manual_transactions_csv: Path) -> list[CashBalancePoint]:
    overrides = load_row_override_map(overrides_csv)
    deleted_row_ids = {
        row_id for row_id, row in overrides.items() if (row.get("source") or "").strip() == "deleted_transaction"
    }
    rows = load_csv_rows(cash_csv)
    rows.sort(key=lambda row: ((row.get("date") or "").strip(), (row.get("row_id") or "").strip()))

    by_date: dict[str, CashBalancePoint] = {}
    deleted_delta = 0.0
    for row in rows:
        row_id = (row.get("row_id") or "").strip()
        signed_amount = parse_number(row.get("signed_amount_eur"))
        if row_id in deleted_row_ids:
            deleted_delta += signed_amount
            continue
        point = by_date.setdefault(
            (row.get("date") or "").strip(),
            CashBalancePoint(date=(row.get("date") or "").strip(), cash_balance=0.0, cash_change=0.0),
        )
        point.cash_balance = parse_number(row.get("balance_eur")) - deleted_delta
        point.cash_change += signed_amount

    manual_transactions = load_manual_transactions(manual_transactions_csv)
    if not manual_transactions:
        return sorted(by_date.values(), key=lambda row: row.date)

    manual_by_date: dict[str, float] = {}
    for row in manual_transactions:
        manual_by_date[row.date] = manual_by_date.get(row.date, 0.0) + row.signed_amount

    all_dates = sorted(set(by_date) | set(manual_by_date))
    adjusted: list[CashBalancePoint] = []
    current_cash = 0.0
    cumulative_manual_delta = 0.0
    seen_cash = False
    for current_date in all_dates:
        base = by_date.get(current_date)
        if base:
            current_cash = base.cash_balance + cumulative_manual_delta
            seen_cash = True
        manual_delta = manual_by_date.get(current_date, 0.0)
        if not base and not seen_cash:
            current_cash = manual_delta
            seen_cash = True
        else:
            current_cash += manual_delta
        cumulative_manual_delta += manual_delta
        adjusted.append(
            CashBalancePoint(
                date=current_date,
                cash_balance=current_cash,
                cash_change=(base.cash_change if base else 0.0) + manual_delta,
            )
        )
    return adjusted


def load_fund_rows(path: Path) -> list[FundRow]:
    output: list[FundRow] = []
    for row in load_csv_rows(path):
        amount = parse_number(row.get("amount_eur"))
        payment_type = (row.get("payment_type") or "").strip()
        output.append(
            FundRow(
                date=(row.get("date") or "").strip(),
                payment_type=payment_type,
                units=parse_number(row.get("units")),
                price_per_unit=parse_number(row.get("price_per_unit_eur")),
                amount=amount,
                signed_amount=-amount if payment_type == "Kauf" else amount,
            )
        )
    output.sort(key=lambda row: row.date)
    return output


def build_capital_series(
    cash_balances: list[CashBalancePoint],
    fund_rows: list[FundRow],
    transactions: list[Transaction],
) -> list[CapitalPoint]:
    fund_daily: dict[str, float] = {}
    fund_units = 0.0
    last_price = 0.0
    grouped_fund_rows: dict[str, list[FundRow]] = {}
    for row in fund_rows:
        grouped_fund_rows.setdefault(row.date, []).append(row)
    for current_date in sorted(grouped_fund_rows):
        for row in grouped_fund_rows[current_date]:
            fund_units += row.units if row.payment_type == "Kauf" else -row.units
            last_price = row.price_per_unit
        fund_daily[current_date] = fund_units * last_price

    min_date = sorted(
        value
        for value in [
            cash_balances[0].date if cash_balances else "",
            fund_rows[0].date if fund_rows else "",
            transactions[0].date if transactions else "",
        ]
        if value
    )
    max_date = sorted(
        value
        for value in [
            cash_balances[-1].date if cash_balances else "",
            fund_rows[-1].date if fund_rows else "",
            transactions[-1].date if transactions else "",
        ]
        if value
    )
    if not min_date or not max_date:
        return []

    start_date = min_date[0]
    end_date = max_date[-1]
    cash_by_date = {row.date: row for row in cash_balances}
    current_cash = 0.0
    current_fund = 0.0
    output: list[CapitalPoint] = []
    for current_date in date_range(start_date, end_date):
        if current_date in cash_by_date:
            current_cash = cash_by_date[current_date].cash_balance
        if current_date in fund_daily:
            current_fund = fund_daily[current_date]
        output.append(CapitalPoint(date=current_date, available_cash=current_cash + current_fund))
    return output


def load_position_unit_overrides(path: Path) -> dict[str, list[PositionUnitOverride]]:
    output: dict[str, list[PositionUnitOverride]] = {}
    for row in load_csv_rows(path):
        instrument_key = (row.get("instrument_key") or "").strip()
        effective_date = (row.get("effective_date") or "").strip()
        units = parse_number(row.get("units"))
        if not instrument_key or not effective_date:
            continue
        output.setdefault(instrument_key, []).append(
            PositionUnitOverride(
                instrument_key=instrument_key,
                units=units,
                effective_date=effective_date,
                updated_at=(row.get("updated_at") or "").strip(),
            )
        )
    for overrides in output.values():
        overrides.sort(key=lambda row: (row.effective_date, row.updated_at))
    return output


def load_position_valuation_overrides(path: Path) -> dict[str, list[PositionValuationOverride]]:
    output: dict[str, list[PositionValuationOverride]] = {}
    for row in load_csv_rows(path):
        instrument_key = (row.get("instrument_key") or "").strip()
        effective_date = (row.get("effective_date") or "").strip()
        price_eur = parse_number(row.get("price_eur"))
        if not instrument_key or not effective_date or price_eur <= 0:
            continue
        output.setdefault(instrument_key, []).append(
            PositionValuationOverride(
                instrument_key=instrument_key,
                price_eur=price_eur,
                effective_date=effective_date,
                updated_at=(row.get("updated_at") or "").strip(),
            )
        )
    for overrides in output.values():
        overrides.sort(key=lambda row: (row.effective_date, row.updated_at))
    return output


def pick_latest_override(items: list[T] | None, end_date: str) -> T | None:
    if not items:
        return None
    applicable = [item for item in items if getattr(item, "effective_date", "") <= end_date]
    if not applicable:
        return None
    applicable.sort(key=lambda item: (getattr(item, "effective_date", ""), getattr(item, "updated_at", "")))
    return applicable[-1]


def extract_investment_trades(transactions: list[Transaction], registry: dict[str, dict[str, str]]) -> list[ParsedTrade]:
    output: list[ParsedTrade] = []
    for row in transactions:
        if row.group != "investment":
            continue
        preferred_asset_class = normalize_asset_class(row.investment_asset_class)
        instrument = apply_preferred_asset_class(resolve_instrument(row.description, registry), preferred_asset_class)
        quantity_match = QUANTITY_RE.search(row.description)
        output.append(
            ParsedTrade(
                row_id=row.row_id,
                date=row.date,
                signed_amount=row.signed_amount,
                isin=instrument.isin,
                instrument_key=instrument.key,
                instrument=instrument.instrument,
                asset_class=instrument.asset_class,
                price_scale=instrument.price_scale,
                fallback_valuation=instrument.fallback_valuation,
                symbol=instrument.symbol,
                units=float(quantity_match.group(1)) if quantity_match else None,
            )
        )
    return output


class YahooPriceCache:
    def __init__(self, path: Path, refresh: bool = False):
        self.path = path
        self.refresh = refresh
        self._data: dict[str, Any] = {}
        if path.exists() and not refresh:
            try:
                self._data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self._data = {}

    def get(self, key: str) -> Any | None:
        return None if self.refresh else self._data.get(key)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2, sort_keys=True), encoding="utf-8")


def to_unix_seconds(value: str) -> int:
    dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def add_days(value: str, offset: int) -> str:
    return (datetime.strptime(value, "%Y-%m-%d").date() + timedelta(days=offset)).isoformat()


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "TrackRepublicReturnAudit/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def to_iso_date_from_timestamp(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()


def build_fx_map(currency: str, start_date: str, end_date: str, cache: YahooPriceCache) -> dict[str, float]:
    if currency == "EUR":
        return {}
    symbol = f"{currency}EUR=X"
    cache_key = f"chart:{symbol}:{add_days(start_date, -8)}:{add_days(end_date, 5)}:fx"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return {key: float(value) for key, value in cached.items()}

    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe='=')}"
        f"?period1={to_unix_seconds(add_days(start_date, -8))}"
        f"&period2={to_unix_seconds(add_days(end_date, 6))}"
        f"&interval=1d&includePrePost=false&events=div,splits"
    )
    try:
        payload = fetch_json(url)
        result = ((payload.get("chart") or {}).get("result") or [None])[0] or {}
        timestamps = result.get("timestamp") or []
        closes = (((result.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
        series: dict[str, float] = {}
        for timestamp, close in zip(timestamps, closes):
            if close is None:
                continue
            close_value = float(close)
            if not math.isfinite(close_value) or close_value <= 0:
                continue
            series[to_iso_date_from_timestamp(int(timestamp))] = close_value
        cache.set(cache_key, series)
        return series
    except urllib.error.URLError:
        return {}


def load_historical_eur_series(
    symbol: str,
    price_scale: str,
    start_date: str,
    end_date: str,
    cache: YahooPriceCache,
) -> dict[str, float]:
    if not symbol:
        return {}

    cache_key = f"chart:{symbol}:{price_scale}:{add_days(start_date, -5)}:{add_days(end_date, 5)}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return {key: float(value) for key, value in cached.items()}

    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe='=')}"
        f"?period1={to_unix_seconds(add_days(start_date, -5))}"
        f"&period2={to_unix_seconds(add_days(end_date, 6))}"
        f"&interval=1d&includePrePost=false&events=div,splits"
    )

    try:
        payload = fetch_json(url)
        result = ((payload.get("chart") or {}).get("result") or [None])[0] or {}
        meta = result.get("meta") or {}
        currency = str(meta.get("currency") or "EUR")
        timestamps = result.get("timestamp") or []
        closes = (((result.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
        fx_rates = build_fx_map(currency if currency != "GBp" else "GBP", start_date, end_date, cache)
        series: dict[str, float] = {}
        for timestamp, close in zip(timestamps, closes):
            if close is None:
                continue
            raw_price = float(close)
            if not math.isfinite(raw_price) or raw_price <= 0:
                continue
            date_key = to_iso_date_from_timestamp(int(timestamp))
            normalized_price, normalized_currency = normalize_price(raw_price, currency)
            fx_rate = 1.0 if normalized_currency == "EUR" else latest_before_or_on(fx_rates, date_key)
            if fx_rate is None or not math.isfinite(fx_rate) or fx_rate <= 0:
                continue
            series[date_key] = normalize_instrument_price(normalized_price, price_scale) * fx_rate
        cache.set(cache_key, series)
        return series
    except urllib.error.URLError:
        return {}


def build_historical_series_by_instrument(trades: list[ParsedTrade], cache: YahooPriceCache) -> dict[str, dict[str, float]]:
    ranges: dict[str, tuple[str, str, str, str]] = {}
    for trade in trades:
        if not trade.symbol:
            continue
        current = ranges.get(trade.instrument_key)
        if not current:
            ranges[trade.instrument_key] = (trade.symbol, trade.price_scale, trade.date, trade.date)
            continue
        symbol, price_scale, start_date, end_date = current
        ranges[trade.instrument_key] = (
            symbol,
            price_scale,
            min(start_date, trade.date),
            max(end_date, trade.date),
        )

    output: dict[str, dict[str, float]] = {}
    for instrument_key, (symbol, price_scale, start_date, end_date) in ranges.items():
        output[instrument_key] = load_historical_eur_series(symbol, price_scale, start_date, end_date, cache)
    return output


def build_historical_unit_estimates(
    trades: list[ParsedTrade],
    historical_series: dict[str, dict[str, float]],
) -> dict[str, float]:
    output: dict[str, float] = {}
    for trade in trades:
        if trade.units is not None:
            continue
        price_eur = latest_before_or_on(historical_series.get(trade.instrument_key, {}), trade.date)
        if price_eur is None or price_eur <= 0:
            continue
        output[trade.row_id] = abs(trade.signed_amount) / price_eur
    return output


def build_instrument_states(
    trades: list[ParsedTrade],
    end_date: str,
    position_unit_overrides: dict[str, list[PositionUnitOverride]],
    historical_unit_estimates: dict[str, float],
) -> dict[str, InstrumentState]:
    states: dict[str, InstrumentState] = {}
    ordered_trades = sorted(
        [trade for trade in trades if trade.date <= end_date],
        key=lambda trade: (trade.date, trade.row_id),
    )

    for trade in ordered_trades:
        state = states.get(trade.instrument_key) or InstrumentState(
            instrument_key=trade.instrument_key,
            isin=trade.isin,
            instrument=trade.instrument,
            asset_class=trade.asset_class,
            price_scale=trade.price_scale,
            fallback_valuation=trade.fallback_valuation,
            symbol=trade.symbol,
        )

        estimated_units = historical_unit_estimates.get(trade.row_id) if trade.units is None else None
        units = trade.units if trade.units is not None else estimated_units

        if units is None or units <= 0:
            state.rows_without_quantity += 1
            if trade.signed_amount < 0:
                state.cost_basis_current += abs(trade.signed_amount)
                state.gross_invested_eur += abs(trade.signed_amount)
            else:
                state.cost_basis_current = max(0.0, state.cost_basis_current - trade.signed_amount)
            states[trade.instrument_key] = state
            continue

        transaction_price_eur = abs(trade.signed_amount) / units if units > 0 else 0.0
        if math.isfinite(transaction_price_eur) and transaction_price_eur > 0:
            state.last_known_price_eur = transaction_price_eur
            state.last_known_price_date = trade.date

        if trade.signed_amount < 0:
            state.units += units
            state.cost_basis_current += abs(trade.signed_amount)
            state.gross_invested_eur += abs(trade.signed_amount)
        else:
            sell_units = min(units, state.units or units)
            average_cost = state.cost_basis_current / state.units if state.units > EPSILON else 0.0
            cost_removed = average_cost * sell_units
            realized = trade.signed_amount - cost_removed
            state.realized_pnl_all_time += realized
            state.units = max(0.0, state.units - sell_units)
            state.cost_basis_current = max(0.0, state.cost_basis_current - cost_removed)

        states[trade.instrument_key] = state

    for instrument_key, overrides in position_unit_overrides.items():
        override = pick_latest_override(overrides, end_date)
        if not override or instrument_key not in states:
            continue
        state = states[instrument_key]
        average_cost = state.cost_basis_current / state.units if state.units > EPSILON else 0.0
        state.units = override.units
        state.cost_basis_current = average_cost * override.units if average_cost > 0 else state.cost_basis_current
        state.manual_units_override = True
        state.rows_without_quantity = 0
        states[instrument_key] = state

    return states


def find_available_cash(capital_series: list[CapitalPoint], end_date: str) -> float:
    available_cash = 0.0
    for point in capital_series:
        if point.date > end_date:
            break
        available_cash = point.available_cash
    return available_cash


def build_portfolio_point(
    point_date: str,
    transactions: list[Transaction],
    capital_series: list[CapitalPoint],
    trades: list[ParsedTrade],
    historical_series: dict[str, dict[str, float]],
    historical_unit_estimates: dict[str, float],
    position_unit_overrides: dict[str, list[PositionUnitOverride]],
    position_valuation_overrides: dict[str, list[PositionValuationOverride]],
) -> PortfolioPoint:
    states = build_instrument_states(trades, point_date, position_unit_overrides, historical_unit_estimates)
    market_value = 0.0
    cost_basis = 0.0
    realized = 0.0

    for state in states.values():
        cost_basis += state.cost_basis_current
        realized += state.realized_pnl_all_time
        manual_price_override = pick_latest_override(position_valuation_overrides.get(state.instrument_key), point_date)
        units_known = state.manual_units_override or (state.rows_without_quantity == 0 and state.units > EPSILON)
        value = 0.0

        if state.units > EPSILON and units_known:
            price_eur = latest_before_or_on(historical_series.get(state.instrument_key, {}), point_date)
            if price_eur is not None and price_eur > 0:
                value = price_eur * state.units
            elif manual_price_override:
                value = manual_price_override.price_eur * state.units
            elif state.last_known_price_eur and state.fallback_valuation == "statement_price":
                value = state.last_known_price_eur * state.units
            elif state.cost_basis_current > 0:
                value = state.cost_basis_current
        elif state.cost_basis_current > 0:
            value = state.cost_basis_current

        if value > 0:
            market_value += value

    dividend_income = sum(
        row.signed_amount
        for row in transactions
        if row.category == "interest_dividend" and row.signed_amount > 0 and row.date <= point_date
    )
    cash_value = find_available_cash(capital_series, point_date)
    return PortfolioPoint(
        date=point_date,
        total_value_eur=cash_value + market_value,
        market_value_eur=market_value,
        cash_value_eur=cash_value,
        cost_basis_eur=cost_basis,
        realized_pnl_eur=realized,
        dividend_income_eur=dividend_income,
    )


def is_external_portfolio_flow(row: Transaction) -> bool:
    if row.group == "investment":
        return False
    if row.category in {"interest_dividend", "fees", "taxes"}:
        return False
    return True


def build_external_flow_by_date(transactions: list[Transaction], end_date: str) -> dict[str, float]:
    flows: dict[str, float] = {}
    for row in transactions:
        if row.date > end_date or not is_external_portfolio_flow(row):
            continue
        flows[row.date] = flows.get(row.date, 0.0) + row.signed_amount
    return flows


def build_return_series(
    transactions: list[Transaction],
    capital_series: list[CapitalPoint],
    trades: list[ParsedTrade],
    historical_series: dict[str, dict[str, float]],
    historical_unit_estimates: dict[str, float],
    position_unit_overrides: dict[str, list[PositionUnitOverride]],
    position_valuation_overrides: dict[str, list[PositionValuationOverride]],
    start_date: str,
    end_date: str,
) -> list[dict[str, Any]]:
    return_start_date = previous_date(start_date)
    return_dates = [point.date for point in capital_series if return_start_date <= point.date <= end_date]
    if return_start_date not in return_dates:
        return_dates.insert(0, return_start_date)
    if end_date not in return_dates:
        return_dates.append(end_date)
        return_dates.sort()

    external_flow_by_date = build_external_flow_by_date(transactions, end_date)
    timeline: dict[str, PortfolioPoint] = {}
    for current_date in return_dates:
        timeline[current_date] = build_portfolio_point(
            current_date,
            transactions,
            capital_series,
            trades,
            historical_series,
            historical_unit_estimates,
            position_unit_overrides,
            position_valuation_overrides,
        )

    output: list[dict[str, Any]] = []
    for index, current_date in enumerate(return_dates):
        point = timeline[current_date]
        previous_point = timeline[return_dates[index - 1]] if index > 0 else None
        external_flow = external_flow_by_date.get(current_date, 0.0)
        daily_return_pct = None
        if previous_point and abs(previous_point.total_value_eur) > EPSILON:
            daily_return_pct = (
                (point.total_value_eur - previous_point.total_value_eur - external_flow)
                / previous_point.total_value_eur
            ) * 100.0
        output.append(
            {
                "date": current_date,
                "total_value_eur": point.total_value_eur,
                "market_value_eur": point.market_value_eur,
                "cash_value_eur": point.cash_value_eur,
                "external_flow_eur": external_flow,
                "daily_return_pct": daily_return_pct,
            }
        )
    return output


def format_money(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"EUR {value:,.2f}"


def format_percent(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.2f}%"


def main() -> int:
    args = parse_args()
    if not args.categorized_csv.exists():
        print(f"Missing categorized transactions CSV: {args.categorized_csv}", file=sys.stderr)
        return 1

    registry = load_registry_lookup(args.registry_csv)
    transactions = load_transactions(
        categorized_csv=args.categorized_csv,
        overrides_csv=args.transaction_overrides_csv,
        manual_transactions_csv=args.manual_transactions_csv,
    )
    cash_balances = load_cash_balances(
        cash_csv=args.cash_csv,
        overrides_csv=args.transaction_overrides_csv,
        manual_transactions_csv=args.manual_transactions_csv,
    )
    fund_rows = load_fund_rows(args.fund_csv)
    capital_series = build_capital_series(cash_balances, fund_rows, transactions)
    if not capital_series:
        print("No capital series could be built from local files.", file=sys.stderr)
        return 1

    start_date = args.start_date or transactions[0].date
    end_date = args.end_date or capital_series[-1].date
    if start_date > end_date:
        print("Start date must be on or before end date.", file=sys.stderr)
        return 1

    price_cache = YahooPriceCache(args.price_cache, refresh=args.refresh_cache)
    trades = extract_investment_trades(transactions, registry)
    historical_series = build_historical_series_by_instrument(trades, price_cache)
    historical_unit_estimates = build_historical_unit_estimates(trades, historical_series)
    price_cache.save()

    position_unit_overrides = load_position_unit_overrides(args.position_unit_overrides_csv)
    position_valuation_overrides = load_position_valuation_overrides(args.position_valuation_overrides_csv)

    return_series = build_return_series(
        transactions=transactions,
        capital_series=capital_series,
        trades=trades,
        historical_series=historical_series,
        historical_unit_estimates=historical_unit_estimates,
        position_unit_overrides=position_unit_overrides,
        position_valuation_overrides=position_valuation_overrides,
        start_date=start_date,
        end_date=end_date,
    )

    range_summary = build_range_summary(return_series, start_date, end_date)
    if not range_summary:
        print("No return points exist for the requested range.", file=sys.stderr)
        return 1
    in_range_points = [point for point in return_series if start_date <= point["date"] <= end_date]
    yearly_summaries = build_yearly_summaries(return_series, start_date, end_date)

    end_portfolio_point = build_portfolio_point(
        end_date,
        transactions,
        capital_series,
        trades,
        historical_series,
        historical_unit_estimates,
        position_unit_overrides,
        position_valuation_overrides,
    )
    since_inception_start = next((trade.date for trade in sorted(trades, key=lambda trade: (trade.date, trade.row_id))), None)
    total_return_eur = (
        end_portfolio_point.market_value_eur
        - end_portfolio_point.cost_basis_eur
        + end_portfolio_point.realized_pnl_eur
        + end_portfolio_point.dividend_income_eur
    )
    gross_invested = sum(
        state.gross_invested_eur
        for state in build_instrument_states(
            trades,
            end_date,
            position_unit_overrides,
            historical_unit_estimates,
        ).values()
    )
    since_inception_total_return_pct = ((total_return_eur / gross_invested) * 100.0) if gross_invested > EPSILON else None
    since_inception_annualized_return_pct = (
        annualize_return(since_inception_total_return_pct, since_inception_start, end_date)
        if since_inception_start and since_inception_total_return_pct is not None
        else None
    )

    missing_symbols = sorted(
        {
            trade.instrument
            for trade in trades
            if not trade.symbol
        }
    )

    payload: dict[str, Any] = {
        "range": {
            **range_summary,
        },
        "by_year": yearly_summaries,
        "since_inception": {
            "start_date": since_inception_start,
            "gross_invested_eur": gross_invested,
            "market_value_eur": end_portfolio_point.market_value_eur,
            "cost_basis_eur": end_portfolio_point.cost_basis_eur,
            "unrealized_pnl_eur": end_portfolio_point.market_value_eur - end_portfolio_point.cost_basis_eur,
            "realized_pnl_eur": end_portfolio_point.realized_pnl_eur,
            "dividend_income_eur": end_portfolio_point.dividend_income_eur,
            "total_return_eur": total_return_eur,
            "total_return_pct": since_inception_total_return_pct,
            "annualized_total_return_pct": since_inception_annualized_return_pct,
        },
        "coverage": {
            "trade_count": len(trades),
            "estimated_unit_rows": len(historical_unit_estimates),
            "historical_price_series_count": len([key for key, series in historical_series.items() if series]),
            "missing_symbol_instruments": missing_symbols,
        },
    }

    if args.show_daily > 0:
        head = in_range_points[: args.show_daily]
        tail = in_range_points[-args.show_daily :] if len(in_range_points) > args.show_daily else []
        payload["daily_points"] = {
            "head": head,
            "tail": tail,
        }

    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    print("Portfolio Return Audit")
    print(f"Range:            {start_date} -> {end_date}")
    print(f"Start value:      {format_money(payload['range']['start_value_eur'])}")
    print(f"End value:        {format_money(payload['range']['end_value_eur'])}")
    print(f"External flows:   {format_money(payload['range']['external_flow_eur'])}")
    print(f"Return EUR:       {format_money(payload['range']['return_eur'])}")
    print(f"Modified Dietz:   {format_percent(payload['range']['modified_dietz_return_pct'])}")
    print(f"Annualized Dietz: {format_percent(payload['range']['annualized_modified_dietz_return_pct'])}")
    if payload["by_year"]:
        print("")
        print("By year")
        for year_summary in payload["by_year"]:
            print(
                f"{year_summary['year']}: "
                f"{format_money(year_summary['return_eur'])} | "
                f"{format_percent(year_summary['modified_dietz_return_pct'])} Dietz | "
                f"{format_percent(year_summary['annualized_modified_dietz_return_pct'])} annualized"
            )
    print("")
    print("Since inception cross-check")
    print(f"Start date:       {payload['since_inception']['start_date'] or 'n/a'}")
    print(f"Gross invested:   {format_money(payload['since_inception']['gross_invested_eur'])}")
    print(f"Market value:     {format_money(payload['since_inception']['market_value_eur'])}")
    print(f"Cost basis:       {format_money(payload['since_inception']['cost_basis_eur'])}")
    print(f"Unrealized P&L:   {format_money(payload['since_inception']['unrealized_pnl_eur'])}")
    print(f"Realized P&L:     {format_money(payload['since_inception']['realized_pnl_eur'])}")
    print(f"Dividends:        {format_money(payload['since_inception']['dividend_income_eur'])}")
    print(f"Total return EUR: {format_money(payload['since_inception']['total_return_eur'])}")
    print(f"Total return %:   {format_percent(payload['since_inception']['total_return_pct'])}")
    print(f"Annualized total: {format_percent(payload['since_inception']['annualized_total_return_pct'])}")
    if missing_symbols:
        print("")
        print("Missing symbols")
        for instrument in missing_symbols[:10]:
            print(f"- {instrument}")
        if len(missing_symbols) > 10:
            print(f"- ... and {len(missing_symbols) - 10} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
