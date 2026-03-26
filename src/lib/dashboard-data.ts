import { eachDayOfInterval, format, parseISO } from "date-fns";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { FIXED_COST_CATEGORIES, bucketLabel, categoryLabel, deriveCashflowBucket, deriveGroupFromCategory, groupLabel, sourceLabel } from "./category-config";
import {
  CONFIG_DIR,
  INSTRUMENT_REGISTRY_PATH,
  MANUAL_TRANSACTIONS_PATH,
  loadInstrumentRegistrySync,
  loadManualTransactionsSync,
  loadManualRulesSync,
  loadRowOverridesSync,
  MANUAL_RULES_PATH,
  POSITION_OVERRIDES_PATH,
  ROW_OVERRIDES_PATH,
  type ManualTransactionRecord,
  type InstrumentRegistryEntry,
  type ManualRuleRecord,
  type RowOverrideRecord,
} from "./config-store";
import { loadOfficialEtfExposures, type OfficialEtfExposure } from "./etf-lookthrough";
import { loadHistoricalCryptoUnitEstimates, loadLiveQuotes } from "./live-quotes";
import type { HistoricalUnitEstimate, LiveQuote, PositionUnitOverride } from "./investment-positions";
import { matchesManualRule } from "./rule-matching";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data", "processed");
const CATEGORIZED_CSV = "statement_transactions_categorized.csv";
const CASH_CSV = "statement_transactions.csv";
const FUND_CSV = "statement_money_market_fund.csv";
const POSITION_OVERRIDES_CSV = "position_unit_overrides.csv";
const LIVE_MARKET_TTL_MS = 10 * 60 * 1000;
const GENERIC_MERCHANT_ALIASES = new Set([
  "AI Software",
  "Bar",
  "Broadcast Fee",
  "Dining",
  "Groceries",
  "Health",
  "Refund",
  "Retail",
  "Transport",
]);

type PromiseCacheEntry<T> = {
  key: string;
  promise: Promise<T>;
};

let baseDashboardDataCache: PromiseCacheEntry<BaseDashboardData> | null = null;
let dashboardDataCache: PromiseCacheEntry<DashboardData> | null = null;

function parseNumber(value: string | undefined): number {
  const numeric = Number(value ?? "0");
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseBoolean(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function normalizeWhitespace(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactCounterpartyLabel(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^incoming transfer from\s+/i, "")
    .replace(/^outgoing transfer for\s+/i, "")
    .replace(/\s+\([A-Z]{2}\d[^)]*\)\s*$/i, "")
    .replace(/,\s*exchange rate:.*$/i, "")
    .replace(/,\s*ecb rate:.*$/i, "")
    .replace(/,\s*markup:.*$/i, "")
    .trim();
}

function deriveDisplayMerchant(args: {
  merchant: string;
  description: string;
  categoryLabel: string;
  groupLabel: string;
  cashflowBucketLabel: string;
}) {
  const merchant = normalizeWhitespace(args.merchant);
  const description = compactCounterpartyLabel(args.description);
  const merchantIsGeneric =
    !merchant ||
    merchant === "Unknown merchant" ||
    GENERIC_MERCHANT_ALIASES.has(merchant) ||
    merchant === args.categoryLabel ||
    merchant === args.groupLabel ||
    merchant === args.cashflowBucketLabel;

  if (merchantIsGeneric && description) {
    return description;
  }

  return merchant || description || "Unknown merchant";
}

function readCsv(name: string): Record<string, string>[] {
  const filePath = path.join(DATA_DIR, name);
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

function applyManualRuleToRow(row: TransactionRecord, matchedRule: ManualRuleRecord): TransactionRecord {
  const nextCategory = matchedRule.category || row.category;
  const nextGroup = matchedRule.group || deriveGroupFromCategory(nextCategory);
  const nextBucket = deriveCashflowBucket(nextGroup, nextCategory);
  const nextMerchant = matchedRule.merchant || row.merchant;
  const nextGroupLabel = groupLabel(nextGroup);
  const nextCategoryLabel = categoryLabel(nextCategory);
  const nextBucketLabel = bucketLabel(nextBucket);

  return {
    ...row,
    merchant: nextMerchant,
    displayMerchant: deriveDisplayMerchant({
      merchant: nextMerchant,
      description: row.description,
      categoryLabel: nextCategoryLabel,
      groupLabel: nextGroupLabel,
      cashflowBucketLabel: nextBucketLabel,
    }),
    group: nextGroup,
    groupLabel: nextGroupLabel,
    category: nextCategory,
    categoryLabel: nextCategoryLabel,
    subcategory: matchedRule.subcategory || row.subcategory,
    cashflowBucket: nextBucket,
    cashflowBucketLabel: nextBucketLabel,
    needsReview: matchedRule.needsReview,
    isFixedCost: nextGroup === "expense" && FIXED_COST_CATEGORIES.has(nextCategory),
    confidence: matchedRule.confidence || row.confidence,
    classificationSource: "manual_rule",
    classificationSourceLabel: sourceLabel("manual_rule"),
  };
}

function applyRowOverrideToRow(row: TransactionRecord, override: RowOverrideRecord): TransactionRecord {
  const nextCategory = override.category || row.category;
  const nextGroup = override.group || deriveGroupFromCategory(nextCategory);
  const nextBucket = deriveCashflowBucket(nextGroup, nextCategory);
  const nextMerchant = override.merchant || row.merchant;
  const nextGroupLabel = groupLabel(nextGroup);
  const nextCategoryLabel = categoryLabel(nextCategory);
  const nextBucketLabel = bucketLabel(nextBucket);

  return {
    ...row,
    merchant: nextMerchant,
    displayMerchant: deriveDisplayMerchant({
      merchant: nextMerchant,
      description: row.description,
      categoryLabel: nextCategoryLabel,
      groupLabel: nextGroupLabel,
      cashflowBucketLabel: nextBucketLabel,
    }),
    group: nextGroup,
    groupLabel: nextGroupLabel,
    category: nextCategory,
    categoryLabel: nextCategoryLabel,
    subcategory: override.subcategory || row.subcategory,
    cashflowBucket: nextBucket,
    cashflowBucketLabel: nextBucketLabel,
    needsReview: override.needsReview,
    isFixedCost: nextGroup === "expense" && FIXED_COST_CATEGORIES.has(nextCategory),
    confidence: override.confidence || row.confidence,
    classificationSource: override.source || "row_override",
    classificationSourceLabel: sourceLabel(override.source || "row_override"),
  };
}

function applyConfiguredOverrides(transactions: TransactionRecord[]): TransactionRecord[] {
  const rowOverrides = loadRowOverridesSync();
  const manualRules = loadManualRulesSync();
  const rowOverrideMap = rowOverrides.reduce<Record<string, RowOverrideRecord>>((acc, row) => {
    acc[row.rowId] = row;
    return acc;
  }, {});

  const withRowOverrides = transactions.map((row) => {
    const rowOverride = rowOverrideMap[row.rowId];
    return rowOverride ? applyRowOverrideToRow(row, rowOverride) : row;
  });

  const rules = manualRules;
  if (rules.length === 0) {
    return withRowOverrides;
  }

  return withRowOverrides.map((row) => {
    if (rowOverrideMap[row.rowId]) {
      return row;
    }
    const matchedRule = rules.find((rule) => matchesManualRule(row, rule));
    if (!matchedRule) {
      return row;
    }
    return applyManualRuleToRow(row, matchedRule);
  });
}

export type TransactionRecord = {
  rowId: string;
  date: string;
  monthLabel: string;
  yearLabel: string;
  txType: string;
  merchant: string;
  displayMerchant: string;
  description: string;
  group: string;
  groupLabel: string;
  category: string;
  categoryLabel: string;
  subcategory: string;
  cashflowBucket: string;
  cashflowBucketLabel: string;
  signedAmount: number;
  balance: number;
  needsReview: boolean;
  isRecurring: boolean;
  isFixedCost: boolean;
  confidence: number;
  classificationSource: string;
  classificationSourceLabel: string;
};

export type CashBalancePoint = {
  date: string;
  cashBalance: number;
  cashChange: number;
};

export type FundRecord = {
  date: string;
  paymentType: string;
  paymentLabel: string;
  fund: string;
  isin: string;
  units: number;
  pricePerUnit: number;
  amount: number;
  signedAmount: number;
};

export type CapitalPoint = {
  date: string;
  cashBalance: number;
  fundValue: number;
  availableCash: number;
  investedCapital: number;
  trackedCapital: number;
};

export type DashboardData = {
  transactions: TransactionRecord[];
  cashBalances: CashBalancePoint[];
  fundRows: FundRecord[];
  capitalSeries: CapitalPoint[];
  liveQuotes: LiveQuote[];
  officialEtfExposures: Record<string, OfficialEtfExposure>;
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate>;
  positionUnitOverrides: Record<string, PositionUnitOverride>;
  instrumentRegistry: Record<string, InstrumentRegistryEntry>;
};

export type BaseDashboardData = Omit<DashboardData, "liveQuotes" | "officialEtfExposures" | "historicalUnitEstimates">;

function currentLiveMarketWindow() {
  return Math.floor(Date.now() / LIVE_MARKET_TTL_MS);
}

function buildFileSignature(filePaths: string[]) {
  return filePaths
    .map((filePath) => {
      if (!existsSync(filePath)) {
        return `${filePath}:missing`;
      }
      const stats = statSync(filePath);
      return `${filePath}:${stats.mtimeMs}:${stats.size}`;
    })
    .join("|");
}

function collectConfigFilePaths() {
  return [MANUAL_RULES_PATH, ROW_OVERRIDES_PATH, MANUAL_TRANSACTIONS_PATH, POSITION_OVERRIDES_PATH, INSTRUMENT_REGISTRY_PATH];
}

function collectProcessedFilePaths() {
  return [CATEGORIZED_CSV, CASH_CSV, FUND_CSV].map((name) => path.join(DATA_DIR, name));
}

export function getBaseDashboardSnapshotKey() {
  return buildFileSignature([...collectConfigFilePaths(), ...collectProcessedFilePaths()]);
}

export function getDashboardSnapshotKey() {
  return `${getBaseDashboardSnapshotKey()}:live:${currentLiveMarketWindow()}`;
}

function loadPositionUnitOverrides(): Record<string, PositionUnitOverride> {
  try {
    const raw = readFileSync(path.join(CONFIG_DIR, POSITION_OVERRIDES_CSV), "utf8");
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];

    return rows.reduce<Record<string, PositionUnitOverride>>((acc, row) => {
      const instrumentKey = (row.instrument_key ?? "").trim();
      const units = parseNumber(row.units);
      if (!instrumentKey || !Number.isFinite(units) || units < 0) {
        return acc;
      }
      acc[instrumentKey] = {
        instrumentKey,
        isin: (row.isin ?? "").trim(),
        instrument: (row.instrument ?? "").trim(),
        units,
        effectiveDate: (row.effective_date ?? "").trim(),
        updatedAt: (row.updated_at ?? "").trim(),
      };
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function loadTransactions(): TransactionRecord[] {
  const transactions = readCsv(CATEGORIZED_CSV)
    .map((row) => {
      const nextGroupLabel = groupLabel(row.group);
      const nextCategoryLabel = categoryLabel(row.category);
      const nextBucketLabel = bucketLabel(row.cashflow_bucket);
      const merchant = row.merchant || "Unknown merchant";
      const description = row.description;
      return {
        rowId: row.row_id,
        date: row.date,
        monthLabel: row.month,
        yearLabel: row.year,
        txType: row.type,
        merchant,
        displayMerchant: deriveDisplayMerchant({
          merchant,
          description,
          categoryLabel: nextCategoryLabel,
          groupLabel: nextGroupLabel,
          cashflowBucketLabel: nextBucketLabel,
        }),
        description,
        group: row.group,
        groupLabel: nextGroupLabel,
        category: row.category,
        categoryLabel: nextCategoryLabel,
        subcategory: row.subcategory,
        cashflowBucket: row.cashflow_bucket,
        cashflowBucketLabel: nextBucketLabel,
        signedAmount: parseNumber(row.signed_amount_eur),
        balance: parseNumber(row.balance_eur),
        needsReview: parseBoolean(row.needs_review),
        isRecurring: parseBoolean(row.is_recurring),
        isFixedCost: parseBoolean(row.is_fixed_cost),
        confidence: parseNumber(row.confidence),
        classificationSource: row.classification_source,
        classificationSourceLabel: sourceLabel(row.classification_source),
      };
    })
    .sort((left, right) => `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`));

  const manualTransactions = loadManualTransactionsSync();
  return applyConfiguredOverrides(mergeManualTransactions(transactions, manualTransactions));
}

function manualTransactionToRow(transaction: ManualTransactionRecord): TransactionRecord {
  const group = deriveGroupFromCategory(transaction.category);
  const bucket = deriveCashflowBucket(group, transaction.category);
  const merchant = transaction.merchant || "Manual entry";
  const description = transaction.description || transaction.merchant || "Manual entry";
  const nextGroupLabel = groupLabel(group);
  const nextCategoryLabel = categoryLabel(transaction.category);
  const nextBucketLabel = bucketLabel(bucket);
  return {
    rowId: transaction.rowId,
    date: transaction.date,
    monthLabel: transaction.date.slice(0, 7),
    yearLabel: transaction.date.slice(0, 4),
    txType: transaction.transactionType || "Manual",
    merchant,
    displayMerchant: deriveDisplayMerchant({
      merchant,
      description,
      categoryLabel: nextCategoryLabel,
      groupLabel: nextGroupLabel,
      cashflowBucketLabel: nextBucketLabel,
    }),
    description,
    group,
    groupLabel: nextGroupLabel,
    category: transaction.category,
    categoryLabel: nextCategoryLabel,
    subcategory: transaction.subcategory || "manual_entry",
    cashflowBucket: bucket,
    cashflowBucketLabel: nextBucketLabel,
    signedAmount: transaction.signedAmount,
    balance: 0,
    needsReview: false,
    isRecurring: false,
    isFixedCost: group === "expense" && FIXED_COST_CATEGORIES.has(transaction.category),
    confidence: 0.99,
    classificationSource: "manual_entry",
    classificationSourceLabel: sourceLabel("manual_entry"),
  };
}

function mergeManualTransactions(
  transactions: TransactionRecord[],
  manualTransactions: ManualTransactionRecord[],
): TransactionRecord[] {
  if (manualTransactions.length === 0) {
    return transactions;
  }

  const manualRows = manualTransactions.map(manualTransactionToRow);
  const merged = [...transactions, ...manualRows].sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }
    const leftManual = left.classificationSource === "manual_entry";
    const rightManual = right.classificationSource === "manual_entry";
    if (leftManual !== rightManual) {
      return leftManual ? 1 : -1;
    }
    return left.rowId.localeCompare(right.rowId);
  });

  let manualDelta = 0;
  let lastAdjustedBalance: number | null = null;

  return merged.map((row) => {
    if (row.classificationSource === "manual_entry") {
      const adjustedBalance = (lastAdjustedBalance ?? 0) + row.signedAmount;
      manualDelta += row.signedAmount;
      lastAdjustedBalance = adjustedBalance;
      return {
        ...row,
        balance: adjustedBalance,
      };
    }

    const adjustedBalance = row.balance + manualDelta;
    lastAdjustedBalance = adjustedBalance;
    return {
      ...row,
      balance: adjustedBalance,
    };
  });
}

function loadCashBalances(manualTransactions: ManualTransactionRecord[] = []): CashBalancePoint[] {
  const rows = readCsv(CASH_CSV).sort((left, right) => `${left.date}-${left.row_id}`.localeCompare(`${right.date}-${right.row_id}`));
  const byDate = new Map<string, CashBalancePoint>();

  for (const row of rows) {
    const date = row.date;
    const existing = byDate.get(date) ?? {
      date,
      cashBalance: 0,
      cashChange: 0,
    };
    existing.cashBalance = parseNumber(row.balance_eur);
    existing.cashChange += parseNumber(row.signed_amount_eur);
    byDate.set(date, existing);
  }

  if (manualTransactions.length === 0) {
    return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  const manualByDate = manualTransactions.reduce<Map<string, number>>((acc, row) => {
    acc.set(row.date, (acc.get(row.date) ?? 0) + row.signedAmount);
    return acc;
  }, new Map());
  const allDates = [...new Set([...byDate.keys(), ...manualByDate.keys()])].sort();
  const adjusted: CashBalancePoint[] = [];
  let currentCash = 0;
  let cumulativeManualDelta = 0;
  let seenCash = false;

  for (const date of allDates) {
    const base = byDate.get(date);
    if (base) {
      currentCash = base.cashBalance + cumulativeManualDelta;
      seenCash = true;
    }
    const manualDelta = manualByDate.get(date) ?? 0;
    if (!base && !seenCash) {
      currentCash = manualDelta;
      seenCash = true;
    } else {
      currentCash += manualDelta;
    }
    cumulativeManualDelta += manualDelta;
    adjusted.push({
      date,
      cashBalance: currentCash,
      cashChange: (base?.cashChange ?? 0) + manualDelta,
    });
  }

  return adjusted;
}

function loadFundRows(): FundRecord[] {
  return readCsv(FUND_CSV)
    .map((row) => {
      const amount = parseNumber(row.amount_eur);
      return {
        date: row.date,
        paymentType: row.payment_type,
        paymentLabel: row.payment_type === "Kauf" ? "Buy" : row.payment_type === "Verkauf" ? "Sell" : row.payment_type,
        fund: row.fund,
        isin: row.isin,
        units: parseNumber(row.units),
        pricePerUnit: parseNumber(row.price_per_unit_eur),
        amount,
        signedAmount: row.payment_type === "Kauf" ? -amount : amount,
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function buildCapitalSeries(
  cashBalances: CashBalancePoint[],
  fundRows: FundRecord[],
  transactions: TransactionRecord[],
): CapitalPoint[] {
  const fundDaily = new Map<string, { fundValue: number }>();
  let fundUnits = 0;
  let lastPrice = 0;
  const groupedFundRows = new Map<string, FundRecord[]>();
  for (const row of fundRows) {
    groupedFundRows.set(row.date, [...(groupedFundRows.get(row.date) ?? []), row]);
  }
  for (const date of [...groupedFundRows.keys()].sort()) {
    for (const row of groupedFundRows.get(date) ?? []) {
      fundUnits += row.paymentType === "Kauf" ? row.units : -row.units;
      lastPrice = row.pricePerUnit;
    }
    fundDaily.set(date, { fundValue: fundUnits * lastPrice });
  }

  const investingFlows = new Map<string, number>();
  for (const row of transactions) {
    if (row.group !== "investment") {
      continue;
    }
    investingFlows.set(row.date, (investingFlows.get(row.date) ?? 0) + -row.signedAmount);
  }

  const investingDaily = new Map<string, { investedCapital: number }>();
  let investedCapital = 0;
  for (const date of [...investingFlows.keys()].sort()) {
    investedCapital += investingFlows.get(date) ?? 0;
    investingDaily.set(date, { investedCapital });
  }

  const minDate = [cashBalances.at(0)?.date, fundRows.at(0)?.date, transactions.at(0)?.date]
    .filter(Boolean)
    .sort()[0];
  const maxDate = [cashBalances.at(-1)?.date, fundRows.at(-1)?.date, transactions.at(-1)?.date]
    .filter(Boolean)
    .sort()
    .at(-1);

  if (!minDate || !maxDate) {
    return [];
  }

  const cashByDate = new Map(cashBalances.map((row) => [row.date, row]));
  let currentCash = 0;
  let currentFund = 0;
  let currentInvested = 0;

  return eachDayOfInterval({ start: parseISO(minDate), end: parseISO(maxDate) }).map((day) => {
    const date = format(day, "yyyy-MM-dd");
    const cashRow = cashByDate.get(date);
    const fundRow = fundDaily.get(date);
    const investedRow = investingDaily.get(date);

    if (cashRow) {
      currentCash = cashRow.cashBalance;
    }
    if (fundRow) {
      currentFund = fundRow.fundValue;
    }
    if (investedRow) {
      currentInvested = investedRow.investedCapital;
    }

    const availableCash = currentCash + currentFund;
    return {
      date,
      cashBalance: currentCash,
      fundValue: currentFund,
      availableCash,
      investedCapital: currentInvested,
      trackedCapital: availableCash + currentInvested,
    };
  });
}

async function buildBaseDashboardData(): Promise<BaseDashboardData> {
  const transactions = loadTransactions();
  const manualTransactions = loadManualTransactionsSync();
  const cashBalances = loadCashBalances(manualTransactions);
  const fundRows = loadFundRows();
  const capitalSeries = buildCapitalSeries(cashBalances, fundRows, transactions);
  const positionUnitOverrides = loadPositionUnitOverrides();
  const instrumentRegistry = loadInstrumentRegistrySync();

  return {
    transactions,
    cashBalances,
    fundRows,
    capitalSeries,
    positionUnitOverrides,
    instrumentRegistry,
  };
}

export async function loadBaseDashboardData(): Promise<BaseDashboardData> {
  const cacheKey = getBaseDashboardSnapshotKey();
  if (baseDashboardDataCache?.key === cacheKey) {
    return baseDashboardDataCache.promise;
  }

  const promise = Promise.resolve()
    .then(() => buildBaseDashboardData())
    .catch((error) => {
      if (baseDashboardDataCache?.key === cacheKey) {
        baseDashboardDataCache = null;
      }
      throw error;
    });

  baseDashboardDataCache = { key: cacheKey, promise };
  return promise;
}

export async function loadDashboardData(): Promise<DashboardData> {
  const cacheKey = getDashboardSnapshotKey();
  if (dashboardDataCache?.key === cacheKey) {
    return dashboardDataCache.promise;
  }

  const promise = Promise.resolve()
    .then(async () => {
      const baseData = await loadBaseDashboardData();
  const [liveQuotes, officialEtfExposures, historicalUnitEstimates] = await Promise.all([
        loadLiveQuotes(baseData.transactions, baseData.instrumentRegistry),
        loadOfficialEtfExposures(baseData.transactions, baseData.instrumentRegistry),
        loadHistoricalCryptoUnitEstimates(baseData.transactions, baseData.instrumentRegistry),
  ]);

      return {
        ...baseData,
        liveQuotes,
        officialEtfExposures,
        historicalUnitEstimates,
      };
    })
    .catch((error) => {
      if (dashboardDataCache?.key === cacheKey) {
        dashboardDataCache = null;
      }
      throw error;
    });

  dashboardDataCache = { key: cacheKey, promise };
  return promise;
}
