import {
  endOfMonth,
  format,
  parse,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";
import type { CapitalPoint, TransactionRecord } from "./dashboard-data";

export type PeriodPreset = "thisMonth" | "lastMonth" | "yearToDate" | "last12" | "allTime" | "custom";

export type FilterState = {
  preset: PeriodPreset;
  startDate: string;
  endDate: string;
  includeTransfers: boolean;
  excludeIncompleteMonths: boolean;
  activeQuickLabel: string;
  activeQuickKind: "month" | "year" | "";
};

export type QuickRange = {
  label: string;
  startDate: string;
  endDate: string;
  kind: "month" | "year";
};

export const SPENDING_BUCKETS = new Set(["fixed_cost", "variable_cost", "tax"]);

function asDate(value: string): Date {
  return parseISO(value);
}

function validDate(value: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatEuro(value: number, options?: { signed?: boolean; absolute?: boolean }): string {
  const signed = options?.signed ?? false;
  const absolute = options?.absolute ?? false;
  const amount = absolute ? Math.abs(value) : value;
  const prefix = signed && amount > 0 ? "+" : "";
  return `${prefix}EUR ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export function formatMonthTitle(monthLabel: string): string {
  return format(parse(`${monthLabel}-01`, "yyyy-MM-dd", new Date()), "MMMM yyyy");
}

export function formatDisplayDate(date: string): string {
  const parsed = validDate(date);
  return parsed ? format(parsed, "dd MMM yyyy") : "No date";
}

export function formatAsOfDate(date: string): string {
  const parsed = validDate(date);
  return parsed ? format(parsed, "dd MMM yyyy") : "No data";
}

export function formatDateRange(startDate: string, endDate: string): string {
  if (!startDate || !endDate) {
    return "No data loaded";
  }
  return `${formatDisplayDate(startDate)} to ${formatDisplayDate(endDate)}`;
}

export function formatMaybeDisplayDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDisplayDate(value) : value;
}

export function uniqueTransactionDates(transactions: TransactionRecord[]): string[] {
  return [...new Set(transactions.map((row) => row.date))].sort();
}

export function resolvePeriodBounds(
  dates: string[],
  preset: PeriodPreset,
  customStart?: string,
  customEnd?: string,
): { startDate: string; endDate: string; label: string } {
  const minDate = dates[0];
  const maxDate = dates.at(-1);
  if (!minDate || !maxDate) {
    return { startDate: "", endDate: "", label: "" };
  }

  const latest = asDate(maxDate);
  let start = asDate(minDate);
  let end = latest;

  if (preset === "thisMonth") {
    start = startOfMonth(latest);
  } else if (preset === "lastMonth") {
    const priorMonth = subMonths(startOfMonth(latest), 1);
    start = priorMonth;
    end = endOfMonth(priorMonth);
  } else if (preset === "yearToDate") {
    start = parse(`${format(latest, "yyyy")}-01-01`, "yyyy-MM-dd", new Date());
  } else if (preset === "last12") {
    start = startOfMonth(subMonths(latest, 11));
  } else if (preset === "custom" && customStart && customEnd) {
    start = asDate(customStart);
    end = asDate(customEnd);
  }

  const boundedStart = start < asDate(minDate) ? asDate(minDate) : start;
  const boundedEnd = end > latest ? latest : end;
  return {
    startDate: format(boundedStart, "yyyy-MM-dd"),
    endDate: format(boundedEnd, "yyyy-MM-dd"),
    label: `${format(boundedStart, "yyyy-MM-dd")} to ${format(boundedEnd, "yyyy-MM-dd")}`,
  };
}

export function createInitialFilterState(dates: string[], preset: PeriodPreset = "allTime"): FilterState {
  const range = resolvePeriodBounds(dates, preset);
  return {
    preset,
    startDate: range.startDate,
    endDate: range.endDate,
    includeTransfers: true,
    excludeIncompleteMonths: false,
    activeQuickLabel: "",
    activeQuickKind: "",
  };
}

export function monthKeyFromDate(date: string): string {
  return date.slice(0, 7);
}

export function getIncompleteMonthKeys(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate) {
    return [];
  }

  const keys = new Set<string>();
  const start = asDate(startDate);
  const end = asDate(endDate);

  if (format(start, "yyyy-MM-dd") !== format(startOfMonth(start), "yyyy-MM-dd")) {
    keys.add(monthKeyFromDate(startDate));
  }
  if (format(end, "yyyy-MM-dd") !== format(endOfMonth(end), "yyyy-MM-dd")) {
    keys.add(monthKeyFromDate(endDate));
  }

  return [...keys].sort();
}

export function getTrailingIncompleteMonthKey(endDate: string): string | null {
  if (!endDate) {
    return null;
  }

  const end = asDate(endDate);
  if (format(end, "yyyy-MM-dd") === format(endOfMonth(end), "yyyy-MM-dd")) {
    return null;
  }

  return monthKeyFromDate(endDate);
}

export function isMonthIncomplete(monthLabel: string, filters: FilterState): boolean {
  return getIncompleteMonthKeys(filters.startDate, filters.endDate).includes(monthLabel);
}

export function incompleteMonthLabels(filters: FilterState): string[] {
  return getIncompleteMonthKeys(filters.startDate, filters.endDate).map((month) => formatMonthTitle(month));
}

export function annotateMonthLabel(monthLabel: string, filters: FilterState): string {
  return isMonthIncomplete(monthLabel, filters) ? `${formatMonthTitle(monthLabel)} *` : formatMonthTitle(monthLabel);
}

export function buildQuickMonthRanges(dates: string[], limit = 12): QuickRange[] {
  const uniqueMonths = [...new Set(dates.map((date) => date.slice(0, 7)))].sort().slice(-limit).reverse();
  const maxDate = dates.at(-1);
  if (!maxDate) {
    return [];
  }
  return uniqueMonths.map((month) => {
    const monthStart = `${month}-01`;
    const monthEnd = format(endOfMonth(asDate(monthStart)), "yyyy-MM-dd");
    return {
      label: formatMonthTitle(month),
      startDate: monthStart,
      endDate: monthEnd > maxDate ? maxDate : monthEnd,
      kind: "month",
    };
  });
}

export function buildQuickYearRanges(dates: string[]): QuickRange[] {
  const uniqueYears = [...new Set(dates.map((date) => date.slice(0, 4)))].sort().reverse();
  const minDate = dates[0];
  const maxDate = dates.at(-1);
  if (!minDate || !maxDate) {
    return [];
  }
  return uniqueYears.map((year) => ({
    label: year,
    startDate: `${year}-01-01` < minDate ? minDate : `${year}-01-01`,
    endDate: `${year}-12-31` > maxDate ? maxDate : `${year}-12-31`,
    kind: "year",
  }));
}

export function applyTransactionFilters(transactions: TransactionRecord[], filters: FilterState): TransactionRecord[] {
  const trailingIncompleteMonth = filters.excludeIncompleteMonths ? getTrailingIncompleteMonthKey(filters.endDate) : null;
  return transactions.filter((row) => {
    if (row.date < filters.startDate || row.date > filters.endDate) {
      return false;
    }
    if (!filters.includeTransfers && row.group === "transfer") {
      return false;
    }
    if (trailingIncompleteMonth && row.monthLabel === trailingIncompleteMonth) {
      return false;
    }
    return true;
  });
}

export function applyCapitalFilters(points: CapitalPoint[], filters: FilterState): CapitalPoint[] {
  const trailingIncompleteMonth = filters.excludeIncompleteMonths ? getTrailingIncompleteMonthKey(filters.endDate) : null;
  return points.filter(
    (row) => row.date >= filters.startDate && row.date <= filters.endDate && (!trailingIncompleteMonth || monthKeyFromDate(row.date) !== trailingIncompleteMonth),
  );
}

export function sumIncome(transactions: TransactionRecord[]): number {
  return transactions.reduce((sum, row) => sum + (row.signedAmount > 0 && row.group === "income" ? row.signedAmount : 0), 0);
}

export function sumSpending(transactions: TransactionRecord[]): number {
  return transactions.reduce(
    (sum, row) => sum + (SPENDING_BUCKETS.has(row.cashflowBucket) && row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0),
    0,
  );
}

export function sumMoneyIn(transactions: TransactionRecord[]): number {
  return transactions.reduce((sum, row) => sum + (row.signedAmount > 0 ? row.signedAmount : 0), 0);
}

export function sumMoneyOut(transactions: TransactionRecord[]): number {
  return transactions.reduce(
    (sum, row) => sum + (row.signedAmount < 0 && row.group !== "investment" ? Math.abs(row.signedAmount) : 0),
    0,
  );
}

export function sumInvesting(transactions: TransactionRecord[]): number {
  return transactions.reduce((sum, row) => sum + (row.group === "investment" ? -row.signedAmount : 0), 0);
}

export function visibleMonthCount(transactions: TransactionRecord[]): number {
  return new Set(transactions.map((row) => row.monthLabel)).size;
}

export function averageMonthlyStory(transactions: TransactionRecord[]) {
  const months = visibleMonthCount(transactions);
  if (months === 0) {
    return null;
  }

  return {
    months,
    income: sumMoneyIn(transactions) / months,
    spending: sumMoneyOut(transactions) / months,
    investing: sumInvesting(transactions) / months,
    netResult: sumNetResult(transactions) / months,
  };
}

export function averageYearlyStory(transactions: TransactionRecord[]) {
  const averageMonth = averageMonthlyStory(transactions);
  if (!averageMonth) {
    return null;
  }

  return {
    months: averageMonth.months,
    income: averageMonth.income * 12,
    spending: averageMonth.spending * 12,
    investing: averageMonth.investing * 12,
    netResult: averageMonth.netResult * 12,
  };
}

export function summarizeMonthlyStory(transactions: TransactionRecord[]) {
  const buckets = new Map<
    string,
    {
      monthLabel: string;
      income: number;
      spending: number;
      cashIn: number;
      cashOut: number;
      fixedCost: number;
      variableCost: number;
      tax: number;
      investing: number;
      netResult: number;
      reviewRows: number;
    }
  >();

  for (const row of transactions) {
    const bucket = buckets.get(row.monthLabel) ?? {
      monthLabel: row.monthLabel,
      income: 0,
      spending: 0,
      cashIn: 0,
      cashOut: 0,
      fixedCost: 0,
      variableCost: 0,
      tax: 0,
      investing: 0,
      netResult: 0,
      reviewRows: 0,
    };
    if (row.group === "income" && row.signedAmount > 0) {
      bucket.income += row.signedAmount;
    }
    if (row.signedAmount > 0) {
      bucket.cashIn += row.signedAmount;
    }
    if (SPENDING_BUCKETS.has(row.cashflowBucket) && row.signedAmount < 0) {
      bucket.spending += Math.abs(row.signedAmount);
    }
    if (row.signedAmount < 0 && row.group !== "investment") {
      bucket.cashOut += Math.abs(row.signedAmount);
    }
    if (row.cashflowBucket === "fixed_cost" && row.signedAmount < 0) {
      bucket.fixedCost += Math.abs(row.signedAmount);
    }
    if (row.cashflowBucket === "variable_cost" && row.signedAmount < 0) {
      bucket.variableCost += Math.abs(row.signedAmount);
    }
    if (row.cashflowBucket === "tax" && row.signedAmount < 0) {
      bucket.tax += Math.abs(row.signedAmount);
    }
    if (row.group === "investment") {
      bucket.investing += -row.signedAmount;
    }
    bucket.netResult += row.signedAmount;
    bucket.reviewRows += row.needsReview ? 1 : 0;
    buckets.set(row.monthLabel, bucket);
  }

  return [...buckets.values()].sort((left, right) => left.monthLabel.localeCompare(right.monthLabel));
}

export function buildMonthlySpendingSegments(monthly: ReturnType<typeof summarizeMonthlyStory>) {
  return monthly.flatMap((row) => [
    { monthLabel: row.monthLabel, segment: "Recurring bills", amount: row.fixedCost },
    { monthLabel: row.monthLabel, segment: "Flexible spending", amount: row.variableCost },
    { monthLabel: row.monthLabel, segment: "Taxes", amount: row.tax },
  ]);
}

export function topSpendingCategories(transactions: TransactionRecord[], limit = 8) {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    if (SPENDING_BUCKETS.has(row.cashflowBucket) && row.signedAmount < 0) {
      totals.set(row.categoryLabel, (totals.get(row.categoryLabel) ?? 0) + Math.abs(row.signedAmount));
    }
  }
  return [...totals.entries()]
    .map(([categoryLabel, amount]) => ({ categoryLabel, amount }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export function buildIncomeMix(transactions: TransactionRecord[], limit = 8) {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    if (row.group === "income" && row.signedAmount > 0) {
      totals.set(row.categoryLabel, (totals.get(row.categoryLabel) ?? 0) + row.signedAmount);
    }
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, limit);
}

export function topIncomeSources(transactions: TransactionRecord[], limit = 8) {
  const totals = new Map<
    string,
    {
      amount: number;
      categoryLabel: string;
      sourceLabel: string;
      sourceKind: "merchant" | "category";
      sourceValue: string;
    }
  >();
  for (const row of transactions) {
    if (row.group !== "income" || row.signedAmount <= 0) {
      continue;
    }

    const sourceKey = `category:${row.category}`;
    const existing = totals.get(sourceKey) ?? {
      amount: 0,
      categoryLabel: row.categoryLabel,
      sourceLabel: row.categoryLabel,
      sourceKind: "category" as const,
      sourceValue: row.category,
    };
    existing.amount += row.signedAmount;
    totals.set(sourceKey, existing);
  }
  return [...totals.values()]
    .map((value) => ({
      sourceLabel: value.sourceLabel,
      amount: value.amount,
      categoryLabel: value.categoryLabel,
      sourceKind: value.sourceKind,
      sourceValue: value.sourceValue,
    }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export function topRecurringMerchants(transactions: TransactionRecord[], limit = 8) {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    if (!row.isRecurring || row.signedAmount >= 0) {
      continue;
    }
    totals.set(row.displayMerchant, (totals.get(row.displayMerchant) ?? 0) + Math.abs(row.signedAmount));
  }
  return [...totals.entries()]
    .map(([merchant, amount]) => ({ merchant, amount }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export function buildSpendingMix(transactions: TransactionRecord[]) {
  const fixed = transactions.reduce((sum, row) => sum + (row.cashflowBucket === "fixed_cost" && row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0);
  const variable = transactions.reduce((sum, row) => sum + (row.cashflowBucket === "variable_cost" && row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0);
  const tax = transactions.reduce((sum, row) => sum + (row.cashflowBucket === "tax" && row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0);
  return [
    { name: "Recurring bills", value: fixed },
    { name: "Flexible spending", value: variable },
    { name: "Taxes", value: tax },
  ].filter((row) => row.value > 0);
}

export function reviewSummary(transactions: TransactionRecord[]) {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    if (!row.needsReview) {
      continue;
    }
    totals.set(row.classificationSourceLabel, (totals.get(row.classificationSourceLabel) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

export function monthlyReviewCounts(transactions: TransactionRecord[]) {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    if (!row.needsReview) {
      continue;
    }
    totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([monthLabel, rows]) => ({ monthLabel, rows }))
    .sort((left, right) => left.monthLabel.localeCompare(right.monthLabel));
}

export function monthlyAccountMovements(transactions: TransactionRecord[]) {
  const totals = new Map<string, Record<string, number>>();
  for (const row of transactions) {
    const bucket = totals.get(row.monthLabel) ?? {
      In: 0,
      Out: 0,
      Investing: 0,
      Transfers: 0,
      Other: 0,
    };
    if (row.group === "income") {
      bucket.In += row.signedAmount;
    } else if (SPENDING_BUCKETS.has(row.cashflowBucket)) {
      bucket.Out += row.signedAmount;
    } else if (row.group === "investment") {
      bucket.Investing += row.signedAmount;
    } else if (row.group === "transfer") {
      bucket.Transfers += row.signedAmount;
    } else {
      bucket.Other += row.signedAmount;
    }
    totals.set(row.monthLabel, bucket);
  }

  return [...totals.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .flatMap(([monthLabel, values]) =>
      Object.entries(values).map(([segment, amount]) => ({
        monthLabel,
        segment,
        amount,
      })),
    );
}

export function activeCategoryTransactions(transactions: TransactionRecord[], selectedCategory: string | null) {
  if (!selectedCategory) {
    return transactions.filter((row) => SPENDING_BUCKETS.has(row.cashflowBucket));
  }
  return transactions.filter((row) => SPENDING_BUCKETS.has(row.cashflowBucket) && row.categoryLabel === selectedCategory);
}

export function latestMonth(monthly: ReturnType<typeof summarizeMonthlyStory>) {
  return monthly.at(-1) ?? null;
}

export function previousMonth(monthly: ReturnType<typeof summarizeMonthlyStory>) {
  return monthly.at(-2) ?? null;
}

export function sumNetResult(transactions: TransactionRecord[]): number {
  return transactions.reduce((sum, row) => sum + row.signedAmount, 0);
}

export function clampDateRange(dates: string[], startDate: string, endDate: string) {
  const minDate = dates[0] ?? "";
  const maxDate = dates.at(-1) ?? "";
  const clampedStart = startDate < minDate ? minDate : startDate;
  const clampedEnd = endDate > maxDate ? maxDate : endDate;
  return clampedStart > clampedEnd ? { startDate: clampedStart, endDate: clampedStart } : { startDate: clampedStart, endDate: clampedEnd };
}

export function lastDelta(current: number, previous: number) {
  const delta = current - previous;
  return `${delta > 0 ? "+" : ""}${formatEuro(delta)} vs previous month`;
}

export function reserveFundRowsInRange<Row extends { date: string }>(fundRows: Row[], filters: FilterState) {
  return fundRows.filter((row) => row.date >= filters.startDate && row.date <= filters.endDate);
}

export function dataDatesFromCapital(points: CapitalPoint[]) {
  return points.map((row) => row.date);
}

export function monthRangeLabel(startDate: string, endDate: string) {
  return `${startDate} to ${endDate}`;
}

export function accountChange(current: number, first: number) {
  return current - first;
}

export function previousDayLabel(dateValue: string) {
  return format(subDays(asDate(dateValue), 1), "yyyy-MM-dd");
}
