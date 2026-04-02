import { eachDayOfInterval, format, parseISO } from "date-fns";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import {
  FIXED_COST_CATEGORIES,
  bucketLabel,
  categoryLabel,
  deriveCashflowBucket,
  deriveGroupFromCategory,
  groupLabel,
  normalizeCategoryKey,
  sourceLabel,
} from "./category-config";
import { normalizeInvestmentAssetClass } from "./investment-asset-class";
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
  POSITION_VALUATION_OVERRIDES_PATH,
  ROW_OVERRIDES_PATH,
  type ManualTransactionRecord,
  type InstrumentRegistryEntry,
  type ManualRuleRecord,
  type RowOverrideRecord,
  type TransactionLinkRole,
} from "./config-store";
import { loadOfficialEtfExposures, type OfficialEtfExposure } from "./etf-lookthrough";
import { loadHistoricalUnitEstimates, loadLiveQuotes } from "./live-quotes";
import type {
  HistoricalUnitEstimate,
  LiveQuote,
  PositionUnitOverride,
  PositionUnitOverridesByInstrument,
  PositionValuationOverride,
  PositionValuationOverridesByInstrument,
} from "./investment-positions";
import { matchesManualRule } from "./rule-matching";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data", "processed");
const CATEGORIZED_CSV = "statement_transactions_categorized.csv";
const CASH_CSV = "statement_transactions.csv";
const FUND_CSV = "statement_money_market_fund.csv";
const POSITION_OVERRIDES_CSV = "position_unit_overrides.csv";
const POSITION_VALUATION_OVERRIDES_CSV = "position_valuation_overrides.csv";
const LIVE_MARKET_TTL_MS = 10 * 60 * 1000;

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

function buildDisplayDescription(description: string) {
  return compactCounterpartyLabel(description) || normalizeWhitespace(description) || "Untitled transaction";
}

function normalizeLinkRole(value: string | undefined): TransactionLinkRole {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "net" || normalized === "member") {
    return normalized;
  }
  return "";
}

function readLinkMetadata(row: Record<string, string>) {
  const directGroupId = normalizeWhitespace(row.link_group_id);
  const directRole = normalizeLinkRole(row.link_role);
  if (directGroupId || directRole) {
    return {
      linkGroupId: directGroupId,
      linkRole: directRole,
    };
  }
  const legacySubcategory = normalizeWhitespace(row.subcategory);
  if (legacySubcategory.startsWith("connected_expense_net:")) {
    return {
      linkGroupId: legacySubcategory.slice("connected_expense_net:".length),
      linkRole: "net" as const,
    };
  }
  if (legacySubcategory.startsWith("connected_expense_member:")) {
    return {
      linkGroupId: legacySubcategory.slice("connected_expense_member:".length),
      linkRole: "member" as const,
    };
  }
  return {
    linkGroupId: "",
    linkRole: "" as const,
  };
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
  const nextCategory = normalizeCategoryKey(matchedRule.category || row.category) || row.category;
  const nextGroup = deriveGroupFromCategory(nextCategory);
  const nextBucket = deriveCashflowBucket(nextGroup, nextCategory);
  const nextGroupLabel = groupLabel(nextGroup);
  const nextCategoryLabel = categoryLabel(nextCategory);
  const nextBucketLabel = bucketLabel(nextBucket);

  return {
    ...row,
    group: nextGroup,
    groupLabel: nextGroupLabel,
    category: nextCategory,
    categoryLabel: nextCategoryLabel,
    cashflowBucket: nextBucket,
    cashflowBucketLabel: nextBucketLabel,
    isFixedCost: nextGroup === "expense" && FIXED_COST_CATEGORIES.has(nextCategory),
    classificationSource: "manual_rule",
    classificationSourceLabel: sourceLabel("manual_rule"),
  };
}

function applyRowOverrideToRow(row: TransactionRecord, override: RowOverrideRecord): TransactionRecord {
  const nextCategory = normalizeCategoryKey(override.category || row.category) || row.category;
  const nextGroup = deriveGroupFromCategory(nextCategory);
  const nextBucket = deriveCashflowBucket(nextGroup, nextCategory);
  const nextGroupLabel = groupLabel(nextGroup);
  const nextCategoryLabel = categoryLabel(nextCategory);
  const nextBucketLabel = bucketLabel(nextBucket);
  const assetClassOverride = normalizeInvestmentAssetClass(override.assetClass);
  const classifiedInvestmentAssetClass = row.classifiedInvestmentAssetClass || row.investmentAssetClass;
  const nextSource = override.source || "row_override";

  return {
    ...row,
    group: nextGroup,
    groupLabel: nextGroupLabel,
    category: nextCategory,
    categoryLabel: nextCategoryLabel,
    cashflowBucket: nextBucket,
    cashflowBucketLabel: nextBucketLabel,
    isFixedCost: nextGroup === "expense" && FIXED_COST_CATEGORIES.has(nextCategory),
    classificationSource: nextSource,
    classificationSourceLabel: sourceLabel(nextSource),
    categoryOverride: normalizeCategoryKey(override.category) || "",
    investmentAssetClass: assetClassOverride || classifiedInvestmentAssetClass,
    classifiedInvestmentAssetClass,
    investmentAssetClassOverride: assetClassOverride,
    linkGroupId: override.linkGroupId || row.linkGroupId,
    linkRole: override.linkRole || row.linkRole,
  };
}

function isDeletedTransactionOverride(override: RowOverrideRecord | undefined) {
  return override?.source === "deleted_transaction";
}

function applyConfiguredOverrides(transactions: TransactionRecord[]): TransactionRecord[] {
  const rowOverrides = loadRowOverridesSync();
  const manualRules = loadManualRulesSync();
  const rowOverrideMap = rowOverrides.reduce<Record<string, RowOverrideRecord>>((acc, row) => {
    acc[row.rowId] = row;
    return acc;
  }, {});
  const visibleTransactions = transactions.filter((row) => !isDeletedTransactionOverride(rowOverrideMap[row.rowId]));

  const withRowOverrides = visibleTransactions.map((row) => {
    const rowOverride = rowOverrideMap[row.rowId];
    return rowOverride ? applyRowOverrideToRow(row, rowOverride) : row;
  });

  const rules = manualRules;
  if (rules.length === 0) {
    return withRowOverrides;
  }

  return withRowOverrides.map((row) => {
    const rowOverride = rowOverrideMap[row.rowId];
    if (rowOverride && normalizeCategoryKey(rowOverride.category)) {
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
  description: string;
  displayDescription: string;
  group: string;
  groupLabel: string;
  category: string;
  categoryLabel: string;
  cashflowBucket: string;
  cashflowBucketLabel: string;
  signedAmount: number;
  balance: number;
  isRecurring: boolean;
  isFixedCost: boolean;
  classificationSource: string;
  classificationSourceLabel: string;
  categoryOverride: string;
  investmentAssetClass: string;
  classifiedInvestmentAssetClass: string;
  investmentAssetClassOverride: string;
  linkGroupId: string;
  linkRole: TransactionLinkRole;
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
  positionUnitOverrides: PositionUnitOverridesByInstrument;
  positionValuationOverrides: PositionValuationOverridesByInstrument;
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
  return [
    MANUAL_RULES_PATH,
    ROW_OVERRIDES_PATH,
    MANUAL_TRANSACTIONS_PATH,
    POSITION_OVERRIDES_PATH,
    POSITION_VALUATION_OVERRIDES_PATH,
    INSTRUMENT_REGISTRY_PATH,
  ];
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

function loadPositionUnitOverrides(): PositionUnitOverridesByInstrument {
  try {
    const raw = readFileSync(path.join(CONFIG_DIR, POSITION_OVERRIDES_CSV), "utf8");
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];

    return rows.reduce<PositionUnitOverridesByInstrument>((acc, row) => {
      const instrumentKey = (row.instrument_key ?? "").trim();
      const units = parseNumber(row.units);
      const effectiveDate = (row.effective_date ?? "").trim();
      if (!instrumentKey || !Number.isFinite(units) || units < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
        return acc;
      }
      const nextOverride: PositionUnitOverride = {
        instrumentKey,
        isin: (row.isin ?? "").trim(),
        instrument: (row.instrument ?? "").trim(),
        units,
        effectiveDate,
        updatedAt: (row.updated_at ?? "").trim(),
      };
      acc[instrumentKey] = [...(acc[instrumentKey] ?? []), nextOverride].sort((left, right) =>
        `${left.effectiveDate}-${left.updatedAt}`.localeCompare(`${right.effectiveDate}-${right.updatedAt}`),
      );
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function loadPositionValuationOverrides(): PositionValuationOverridesByInstrument {
  try {
    const raw = readFileSync(path.join(CONFIG_DIR, POSITION_VALUATION_OVERRIDES_CSV), "utf8");
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];

    return rows.reduce<PositionValuationOverridesByInstrument>((acc, row) => {
      const instrumentKey = (row.instrument_key ?? "").trim();
      const priceEur = parseNumber(row.price_eur);
      const effectiveDate = (row.effective_date ?? "").trim();
      if (!instrumentKey || !Number.isFinite(priceEur) || priceEur <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
        return acc;
      }
      const nextOverride: PositionValuationOverride = {
        instrumentKey,
        isin: (row.isin ?? "").trim(),
        instrument: (row.instrument ?? "").trim(),
        priceEur,
        effectiveDate,
        updatedAt: (row.updated_at ?? "").trim(),
      };
      acc[instrumentKey] = [...(acc[instrumentKey] ?? []), nextOverride].sort((left, right) =>
        `${left.effectiveDate}-${left.updatedAt}`.localeCompare(`${right.effectiveDate}-${right.updatedAt}`),
      );
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function loadTransactions(): TransactionRecord[] {
  const transactions = readCsv(CATEGORIZED_CSV)
    .map((row) => {
      const category = normalizeCategoryKey(row.category) || "other";
      const nextGroup = deriveGroupFromCategory(category);
      const nextGroupLabel = groupLabel(nextGroup);
      const nextCategoryLabel = categoryLabel(category);
      const nextBucket = row.cashflow_bucket || deriveCashflowBucket(nextGroup, category);
      const nextBucketLabel = bucketLabel(nextBucket);
      const description = row.description;
      const link = readLinkMetadata(row);
      const classifiedInvestmentAssetClass = normalizeInvestmentAssetClass(row.asset_class ?? "");
      return {
        rowId: row.row_id,
        date: row.date,
        monthLabel: row.month,
        yearLabel: row.year,
        txType: row.type,
        description,
        displayDescription: buildDisplayDescription(description),
        group: nextGroup,
        groupLabel: nextGroupLabel,
        category,
        categoryLabel: nextCategoryLabel,
        cashflowBucket: nextBucket,
        cashflowBucketLabel: nextBucketLabel,
        signedAmount: parseNumber(row.signed_amount_eur),
        balance: parseNumber(row.balance_eur),
        isRecurring: parseBoolean(row.is_recurring),
        isFixedCost: parseBoolean(row.is_fixed_cost),
        classificationSource: row.classification_source,
        classificationSourceLabel: sourceLabel(row.classification_source),
        categoryOverride: "",
        investmentAssetClass: classifiedInvestmentAssetClass,
        classifiedInvestmentAssetClass,
        investmentAssetClassOverride: "",
        linkGroupId: link.linkGroupId,
        linkRole: link.linkRole,
      };
    })
    .sort((left, right) => `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`));

  const manualTransactions = loadManualTransactionsSync();
  return applyConfiguredOverrides(mergeManualTransactions(transactions, manualTransactions));
}

function manualTransactionToRow(transaction: ManualTransactionRecord): TransactionRecord {
  const category = normalizeCategoryKey(transaction.category) || "other";
  const group = deriveGroupFromCategory(category);
  const bucket = deriveCashflowBucket(group, category);
  const description = transaction.description || "Manual entry";
  const nextGroupLabel = groupLabel(group);
  const nextCategoryLabel = categoryLabel(category);
  const nextBucketLabel = bucketLabel(bucket);
  return {
    rowId: transaction.rowId,
    date: transaction.date,
    monthLabel: transaction.date.slice(0, 7),
    yearLabel: transaction.date.slice(0, 4),
    txType: transaction.transactionType || "Manual",
    description,
    displayDescription: buildDisplayDescription(description),
    group,
    groupLabel: nextGroupLabel,
    category,
    categoryLabel: nextCategoryLabel,
    cashflowBucket: bucket,
    cashflowBucketLabel: nextBucketLabel,
    signedAmount: transaction.signedAmount,
    balance: 0,
    isRecurring: false,
    isFixedCost: group === "expense" && FIXED_COST_CATEGORIES.has(category),
    classificationSource: "manual_entry",
    classificationSourceLabel: sourceLabel("manual_entry"),
    categoryOverride: "",
    investmentAssetClass: "",
    classifiedInvestmentAssetClass: "",
    investmentAssetClassOverride: "",
    linkGroupId: transaction.linkGroupId,
    linkRole: transaction.linkRole,
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
  const deletedRowIds = new Set(
    loadRowOverridesSync()
      .filter((item) => item.source === "deleted_transaction")
      .map((item) => item.rowId),
  );
  const rows = readCsv(CASH_CSV).sort((left, right) => `${left.date}-${left.row_id}`.localeCompare(`${right.date}-${right.row_id}`));
  const byDate = new Map<string, CashBalancePoint>();
  let deletedDelta = 0;

  for (const row of rows) {
    const signedAmount = parseNumber(row.signed_amount_eur);
    if (deletedRowIds.has(row.row_id)) {
      deletedDelta += signedAmount;
      continue;
    }

    const date = row.date;
    const existing = byDate.get(date) ?? {
      date,
      cashBalance: 0,
      cashChange: 0,
    };
    existing.cashBalance = parseNumber(row.balance_eur) - deletedDelta;
    existing.cashChange += signedAmount;
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
  const positionValuationOverrides = loadPositionValuationOverrides();
  const instrumentRegistry = loadInstrumentRegistrySync();

  return {
    transactions,
    cashBalances,
    fundRows,
    capitalSeries,
    positionUnitOverrides,
    positionValuationOverrides,
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
      const liveQuotes = await loadLiveQuotes(baseData.transactions, baseData.instrumentRegistry);
      const [officialEtfExposures, historicalUnitEstimates] = await Promise.all([
        loadOfficialEtfExposures(baseData.transactions, baseData.instrumentRegistry),
        loadHistoricalUnitEstimates(baseData.transactions, liveQuotes, baseData.instrumentRegistry),
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
