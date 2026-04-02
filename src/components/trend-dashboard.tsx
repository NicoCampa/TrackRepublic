"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bar, CartesianGrid, ComposedChart, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AccountsData } from "@/lib/accounts-data";
import { buildCategoryOptions, CATEGORY_LABELS, deriveGroupFromCategory } from "@/lib/category-config";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  annotateMonthLabel,
  applyCapitalFilters,
  applyTransactionFilters,
  averageMonthlyStory,
  createInitialFilterState,
  formatAsOfDate,
  formatDateRange,
  formatDisplayDate,
  formatEuro,
  formatMonthTitle,
  formatPercent,
  resolvePeriodBounds,
  sumInvesting,
  sumMoneyOut,
  sumNetResult,
  summarizeMonthlyStory,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import {
  buildIncomeCategoryScopeProfiles,
  matchesIncomeCategoryScope,
  resolveIncomeCategoryScopeBaseKey,
  resolveIncomeCategoryScopeKeyForRow,
  resolveIncomeCategoryScopeLabel,
  resolveIncomeCategoryScopeTheme,
} from "@/lib/income-category-scope";
import type { DetailView, TableColumn } from "./dashboard-ui";
import { CategoryBadge, CategoryEditor, ChartTooltipContent, ClickableMetricGrid, DashboardShell, DataTable, DetailSheet, FilterBar, Panel, SignedAmount } from "./dashboard-ui";

type TrendViewMode = "visual" | "table";
type TrendGranularity = "month" | "year";
type TrendScopeMode = "overview" | "category";
type MetricViewMode = "total" | "average";
type TrendCompareDirection = "in" | "out";
type TrendPeriodPayload = {
  periodKey?: string;
  displayLabel?: string;
};
type TrendMetricKey = "cashIn" | "cashOut" | "investing";
type TrendPeriodRow = {
  periodKey: string;
  displayLabel: string;
  cashIn: number;
  cashOut: number;
  investing: number;
  netResult: number;
};
type TrendDisplayRow = TrendPeriodRow & {
  share: number;
  amount: number;
  txCount: number;
};
type TrendCompareSeries = {
  categoryKey: string;
  label: string;
  color: string;
  dataKey: string;
};

type TrendCompareRow = {
  periodKey: string;
  displayLabel: string;
  total: number;
  txCount: number;
};

const HOME_TREND_MONTHS = 12;
const TREND_BAR_LABEL_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

function sameRange(startDate: string, endDate: string, nextStartDate: string, nextEndDate: string) {
  return startDate === nextStartDate && endDate === nextEndDate;
}

function formatTrendBarLabel(value: number) {
  return `~${TREND_BAR_LABEL_FORMATTER.format(Math.abs(value))}`;
}

function formatTrendNetLabel(value: number) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${prefix}${TREND_BAR_LABEL_FORMATTER.format(Math.abs(value))}`;
}

function formatMetricCount(value: number, digits = 0) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function normalizeCompareDirection(value: string | null | undefined): TrendCompareDirection {
  return value === "out" ? "out" : "in";
}

const TREND_ACTIVE_BAR_STYLE = {
  stroke: "rgba(245, 248, 255, 0.82)",
  strokeWidth: 1.5,
  fillOpacity: 0.98,
};

function dedupeCategoryKeys(keys: string[]) {
  return keys.filter((key, index, collection) => CATEGORY_LABELS[key] && collection.indexOf(key) === index);
}

function formatCategorySelectionSummary(labels: string[]) {
  if (labels.length === 0) {
    return "Pick categories";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  return `${labels.length} selected`;
}

function resolveCategoryFlowDirection(flow?: { hasIn: boolean; hasOut: boolean }): TrendCompareDirection | "both" | "none" {
  if (flow?.hasIn && flow?.hasOut) {
    return "both";
  }
  if (flow?.hasIn) {
    return "in";
  }
  if (flow?.hasOut) {
    return "out";
  }
  return "none";
}

export function TrendDashboard({ data }: { data: AccountsData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dates = uniqueTransactionDates(data.transactions);
  const urlCategories = dedupeCategoryKeys(searchParams.getAll("category"));
  const urlDirection = normalizeCompareDirection(searchParams.get("direction"));
  const initialCategoryKey = urlCategories.join("|");
  const [filters, setFilters] = useState(() => createInitialFilterState(dates, "last12"));
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [viewMode, setViewMode] = useState<TrendViewMode>("visual");
  const [granularity, setGranularity] = useState<TrendGranularity>("month");
  const [scopeMode, setScopeMode] = useState<TrendScopeMode>(() => (urlCategories.length > 0 ? "category" : "overview"));
  const [metricViewMode, setMetricViewMode] = useState<MetricViewMode>("total");
  const [selectedCategories, setSelectedCategories] = useState<string[]>(urlCategories);
  const [compareDirection, setCompareDirection] = useState<TrendCompareDirection>(urlDirection);
  const [categorySearch, setCategorySearch] = useState("");
  const [isCategoryPickerOpen, setIsCategoryPickerOpen] = useState(false);

  useEffect(() => {
    if (urlCategories.length > 0) {
      setSelectedCategories((current) => (current.join("|") === initialCategoryKey ? current : urlCategories));
      setScopeMode("category");
      setCompareDirection(urlDirection);
    }
  }, [initialCategoryKey, urlCategories, urlDirection]);

  const syncCategoryQuery = (categoryKeys: string[], direction?: TrendCompareDirection | null) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("category");
    params.delete("direction");
    for (const categoryKey of categoryKeys) {
      params.append("category", categoryKey);
    }
    if (categoryKeys.length > 0 && direction) {
      params.set("direction", direction);
    }

    const nextQuery = params.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  };

  const filteredTransactions = applyTransactionFilters(data.transactions, filters);
  const filteredCapitalSeries = applyCapitalFilters(data.capitalSeries, filters);
  const incomeScopeProfiles = buildIncomeCategoryScopeProfiles(data.transactions);
  const incomeScopeProfileMap = new Map(incomeScopeProfiles.map((profile) => [profile.key, profile]));
  const incomeScopeSearchMap = new Map(incomeScopeProfiles.map((profile) => [profile.key, profile.sourceLabel.toLowerCase()]));
  const categoryOptions = [
    ...buildCategoryOptions().filter((option) => option.value !== "salary"),
    ...incomeScopeProfiles.map((profile) => ({ value: profile.key, label: profile.label })),
  ];
  const selectedCategorySet = new Set(selectedCategories);
  const normalizedCategorySearch = categorySearch.trim().toLowerCase();
  const matchingCategoryOptions = categoryOptions.filter(
    (option) =>
      normalizedCategorySearch.length === 0 ||
      option.label.toLowerCase().includes(normalizedCategorySearch) ||
      option.value.includes(normalizedCategorySearch) ||
      (incomeScopeSearchMap.get(option.value)?.includes(normalizedCategorySearch) ?? false),
  );
  const defaultCategory =
    [...filteredTransactions.reduce((accumulator, row) => {
      const scopeKey = resolveIncomeCategoryScopeKeyForRow(row, incomeScopeProfileMap);
      const scopeLabel = resolveIncomeCategoryScopeLabel(scopeKey, incomeScopeProfileMap);
      if (!scopeLabel) {
        return accumulator;
      }

      accumulator.set(scopeKey, (accumulator.get(scopeKey) ?? 0) + Math.abs(row.signedAmount));
      return accumulator;
    }, new Map<string, number>()).entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
  const categoryFlowPresence = filteredTransactions.reduce((accumulator, row) => {
    const scopeKey = resolveIncomeCategoryScopeKeyForRow(row, incomeScopeProfileMap);
    if (!CATEGORY_LABELS[resolveIncomeCategoryScopeBaseKey(scopeKey)] && !incomeScopeProfileMap.has(scopeKey)) {
      return accumulator;
    }

    const current = accumulator.get(scopeKey) ?? { hasIn: false, hasOut: false };
    if (row.signedAmount > 0) {
      current.hasIn = true;
    }
    if (row.signedAmount < 0) {
      current.hasOut = true;
    }
    accumulator.set(scopeKey, current);
    return accumulator;
  }, new Map<string, { hasIn: boolean; hasOut: boolean }>());
  const inferDirectionForCategory = (categoryKey: string, fallback = compareDirection): TrendCompareDirection => {
    const flowDirection = resolveCategoryFlowDirection(categoryFlowPresence.get(categoryKey));
    if (flowDirection === "in" || flowDirection === "out") {
      return flowDirection;
    }
    return fallback;
  };
  const selectedCategoryLabels = selectedCategories.map((categoryKey) => resolveIncomeCategoryScopeLabel(categoryKey, incomeScopeProfileMap));
  const selectedCategorySummary = formatCategorySelectionSummary(selectedCategoryLabels);
  const selectedCategoryMeta =
    selectedCategoryLabels.length === 0
      ? "No categories selected"
      : selectedCategoryLabels.length === 1
        ? selectedCategoryLabels[0]
        : `${selectedCategoryLabels[0]} + ${selectedCategoryLabels.length - 1} more`;
  const selectedCategoryOptions = selectedCategories.map((categoryKey) => ({
    value: categoryKey,
    label: resolveIncomeCategoryScopeLabel(categoryKey, incomeScopeProfileMap),
  }));
  const inCategoryOptions = matchingCategoryOptions.filter((option) => {
    const flow = categoryFlowPresence.get(option.value);
    return flow?.hasIn;
  });
  const outCategoryOptions = matchingCategoryOptions.filter((option) => {
    const flow = categoryFlowPresence.get(option.value);
    return flow?.hasOut;
  });
  const selectedCategoriesAtLimit = selectedCategories.length >= 4;
  const compareDirectionLabel = compareDirection === "in" ? "In" : "Out";
  const yearToDateRange = resolvePeriodBounds(dates, "yearToDate");
  const lastTwelveRange = resolvePeriodBounds(dates, "last12");
  const allTimeRange = resolvePeriodBounds(dates, "allTime");
  const filterStartMonth = filters.startDate.slice(0, 7);
  const filterEndMonth = filters.endDate.slice(0, 7);
  const allMonthly = summarizeMonthlyStory(data.transactions);
  const visibleMonthly = allMonthly.filter((row) => row.monthLabel >= filterStartMonth && row.monthLabel <= filterEndMonth);
  const useRecentContextTrend = visibleMonthly.length < 2;
  const trendSource = useRecentContextTrend ? allMonthly.filter((row) => row.monthLabel <= filterEndMonth) : visibleMonthly;
  const monthlyTrendRows: TrendPeriodRow[] = trendSource
    .slice(-HOME_TREND_MONTHS)
    .map((row) => ({
      periodKey: row.monthLabel,
      displayLabel: annotateMonthLabel(row.monthLabel, filters),
      cashIn: row.cashIn,
      cashOut: row.cashOut,
      investing: row.investing,
      netResult: row.netResult,
    }));
  const yearlyTrendRows: TrendPeriodRow[] = Array.from(
    filteredTransactions.reduce((accumulator, row) => {
      const yearKey = row.yearLabel;
      const current = accumulator.get(yearKey) ?? {
        periodKey: yearKey,
        displayLabel: yearKey,
        cashIn: 0,
        cashOut: 0,
        investing: 0,
        netResult: 0,
      };
      if (row.signedAmount > 0 && row.group !== "investment") {
        current.cashIn += row.signedAmount;
      }
      if (row.signedAmount < 0 && row.group !== "investment") {
        current.cashOut += Math.abs(row.signedAmount);
      }
      if (row.group === "investment") {
        current.investing += -row.signedAmount;
      }
      current.netResult += row.signedAmount;
      accumulator.set(yearKey, current);
      return accumulator;
    }, new Map<string, TrendPeriodRow>()),
  )
    .map(([, row]) => row)
    .sort((left, right) => left.periodKey.localeCompare(right.periodKey));
  const overviewTrendRows = granularity === "year" ? yearlyTrendRows : monthlyTrendRows;
  const overviewDisplayRows: TrendDisplayRow[] = overviewTrendRows.map((row) => ({
    ...row,
    share: 0,
    amount: 0,
    txCount: 0,
  }));
  const overviewPeriodKeys = new Set(overviewTrendRows.map((row) => row.periodKey));
  const categoryTrendSourceTransactions =
    granularity === "year"
      ? filteredTransactions
      : data.transactions.filter((row) => row.date <= filters.endDate && overviewPeriodKeys.has(row.monthLabel));
  const trendDetailSourceTransactions =
    granularity === "year" ? filteredTransactions : data.transactions.filter((row) => row.date <= filters.endDate);
  const selectedCategoriesIncludeInvestment = selectedCategories.some(
    (categoryKey) => deriveGroupFromCategory(resolveIncomeCategoryScopeBaseKey(categoryKey)) === "investment",
  );
  const selectedCompareSeries: TrendCompareSeries[] = selectedCategories.map((categoryKey, index) => ({
    categoryKey,
    label: resolveIncomeCategoryScopeLabel(categoryKey, incomeScopeProfileMap),
    color: resolveIncomeCategoryScopeTheme(categoryKey, incomeScopeProfileMap).solid,
    dataKey: `series_${index}`,
  }));
  const compareSeriesKeyByCategory = new Map(selectedCompareSeries.map((series) => [series.categoryKey, series.dataKey]));
  const categoryRowsInView =
    selectedCategories.length > 0
      ? filteredTransactions.filter((row) => selectedCategorySet.has(resolveIncomeCategoryScopeKeyForRow(row, incomeScopeProfileMap)))
      : [];
  const categoryCompareRows: Array<TrendCompareRow & Record<string, string | number>> = overviewTrendRows.map((row) => {
    const baseRow: TrendCompareRow & Record<string, string | number> = {
      periodKey: row.periodKey,
      displayLabel: row.displayLabel,
      total: 0,
      txCount: 0,
    };
    for (const series of selectedCompareSeries) {
      baseRow[series.dataKey] = 0;
    }
    return baseRow;
  });
  const categoryCompareRowMap = new Map(categoryCompareRows.map((row) => [row.periodKey, row]));
  for (const row of categoryTrendSourceTransactions) {
    const scopeKey = resolveIncomeCategoryScopeKeyForRow(row, incomeScopeProfileMap);
    const dataKey = compareSeriesKeyByCategory.get(scopeKey);
    if (!dataKey) {
      continue;
    }

    const amount =
      compareDirection === "in"
        ? row.signedAmount > 0
          ? row.signedAmount
          : 0
        : row.signedAmount < 0
          ? Math.abs(row.signedAmount)
          : 0;
    if (amount <= 0) {
      continue;
    }

    const periodKey = granularity === "year" ? row.yearLabel : row.monthLabel;
    const targetRow = categoryCompareRowMap.get(periodKey);
    if (!targetRow) {
      continue;
    }

    targetRow[dataKey] = Number(targetRow[dataKey] ?? 0) + amount;
    targetRow.total = Number(targetRow.total) + amount;
    targetRow.txCount = Number(targetRow.txCount) + 1;
  }
  const categoryHasDirectionValues = categoryCompareRows.some((row) => Number(row.total) > 0);
  const periodTotalsByKey = categoryTrendSourceTransactions.reduce((accumulator, row) => {
    const periodKey = granularity === "year" ? row.yearLabel : row.monthLabel;
    const current = accumulator.get(periodKey) ?? {
      positive: 0,
      positiveCore: 0,
      negative: 0,
      negativeCore: 0,
    };

    if (row.signedAmount > 0) {
      current.positive += row.signedAmount;
      if (row.group !== "investment") {
        current.positiveCore += row.signedAmount;
      }
    }

    if (row.signedAmount < 0) {
      current.negative += Math.abs(row.signedAmount);
      if (row.group !== "investment") {
        current.negativeCore += Math.abs(row.signedAmount);
      }
    }

    accumulator.set(periodKey, current);
    return accumulator;
  }, new Map<string, { positive: number; positiveCore: number; negative: number; negativeCore: number }>());

  const activePreset =
    sameRange(filters.startDate, filters.endDate, allTimeRange.startDate, allTimeRange.endDate) && !filters.activeQuickLabel
      ? "allTime"
      : sameRange(filters.startDate, filters.endDate, yearToDateRange.startDate, yearToDateRange.endDate)
        ? "yearToDate"
        : sameRange(filters.startDate, filters.endDate, lastTwelveRange.startDate, lastTwelveRange.endDate)
          ? "last12"
          : "custom";

  const activeWindowLabel =
    activePreset === "allTime"
      ? "All data"
      : activePreset === "yearToDate"
        ? "Year to date"
        : activePreset === "last12"
          ? "Last 12 months"
          : filters.activeQuickLabel || formatDateRange(filters.startDate, filters.endDate);

  const explicitMonthLabel = filters.startDate ? formatMonthTitle(filters.startDate.slice(0, 7)) : activeWindowLabel;
  const overviewTrendTitle =
    granularity === "year"
      ? `${yearlyTrendRows.length} years`
      : useRecentContextTrend
        ? `Last ${monthlyTrendRows.length} months to ${explicitMonthLabel}`
        : `Last ${monthlyTrendRows.length} months`;
  const isCategoryMode = scopeMode === "category";
  const trendRows: TrendDisplayRow[] = isCategoryMode ? [] : overviewDisplayRows;
  const compareTrendRows = isCategoryMode && categoryHasDirectionValues ? categoryCompareRows : [];
  const trendPeriodLookup = new Map((isCategoryMode ? compareTrendRows : trendRows).map((row) => [String(row.displayLabel), row]));
  const trendTableRows: Array<Record<string, unknown>> = (isCategoryMode ? compareTrendRows : trendRows).slice().reverse();
  const monthlyAverage = averageMonthlyStory(filteredTransactions);
  const metricAveragePeriodCount =
    granularity === "year" ? new Set(filteredTransactions.map((row) => row.yearLabel)).size : (monthlyAverage?.months ?? 0);
  const metricAverageUnitLabel = granularity === "year" ? "year" : "month";
  const metricAverageUnitLabelPlural = granularity === "year" ? "years" : "months";
  const incomeTotal = filteredTransactions.reduce((sum, row) => sum + (row.signedAmount > 0 && row.group !== "investment" ? row.signedAmount : 0), 0);
  const spendingTotal = sumMoneyOut(filteredTransactions);
  const investingTotal = sumInvesting(filteredTransactions);
  const netResultTotal = sumNetResult(filteredTransactions);
  const incomeAverage = metricAveragePeriodCount > 0 ? incomeTotal / metricAveragePeriodCount : 0;
  const spendingAverage = metricAveragePeriodCount > 0 ? spendingTotal / metricAveragePeriodCount : 0;
  const investingAverage = metricAveragePeriodCount > 0 ? investingTotal / metricAveragePeriodCount : 0;
  const netResultAverage = metricAveragePeriodCount > 0 ? netResultTotal / metricAveragePeriodCount : 0;
  const latestCapitalPoint = filteredCapitalSeries.at(-1) ?? data.capitalSeries.at(-1) ?? null;
  const cashBalance = latestCapitalPoint?.availableCash ?? 0;
  const kpiScopeNote = activeWindowLabel;
  const kpiAverageNote =
    metricAveragePeriodCount > 0
      ? `Avg / ${metricAverageUnitLabel} over ${metricAveragePeriodCount} ${metricAveragePeriodCount === 1 ? metricAverageUnitLabel : metricAverageUnitLabelPlural}`
      : `No ${metricAverageUnitLabelPlural}`;
  const categoryInTotal = categoryRowsInView.reduce((sum, row) => sum + (row.signedAmount > 0 ? row.signedAmount : 0), 0);
  const categoryOutTotal = categoryRowsInView.reduce((sum, row) => sum + (row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0);
  const categoryNetTotal = categoryRowsInView.reduce((sum, row) => sum + row.signedAmount, 0);
  const categoryTransactionCount = categoryRowsInView.length;
  const categoryShareDenominator =
    compareDirection === "in"
      ? filteredTransactions.reduce((sum, row) => {
          if (row.signedAmount <= 0) {
            return sum;
          }
          if (!selectedCategoriesIncludeInvestment && row.group === "investment") {
            return sum;
          }
          return sum + row.signedAmount;
        }, 0)
      : filteredTransactions.reduce((sum, row) => {
          if (row.signedAmount >= 0) {
            return sum;
          }
          if (!selectedCategoriesIncludeInvestment && row.group === "investment") {
            return sum;
          }
          return sum + Math.abs(row.signedAmount);
        }, 0);
  const categoryShareNumerator =
    compareDirection === "in" ? categoryInTotal : categoryOutTotal;
  const categoryShare = categoryShareDenominator > 0 ? (categoryShareNumerator / categoryShareDenominator) * 100 : 0;
  const categoryTransactionAverage = metricAveragePeriodCount > 0 ? categoryTransactionCount / metricAveragePeriodCount : 0;
  const categoryScopeNote =
    compareDirection === "in" ? "Share of total inflow in range" : "Share of total outflow in range";
  const overviewMetricItems =
    metricViewMode === "average"
      ? [
          { label: "In", value: formatEuro(incomeAverage), note: kpiAverageNote, tone: "positive" as const },
          { label: "Out", value: formatEuro(spendingAverage), note: kpiAverageNote, tone: "negative" as const },
          { label: "Invested", value: formatEuro(investingAverage), note: kpiAverageNote, tone: "accent" as const },
          {
            label: "Net",
            value: formatEuro(netResultAverage, { signed: true }),
            note: kpiAverageNote,
            tone: netResultAverage < 0 ? ("negative" as const) : ("positive" as const),
          },
          { label: "Cash balance", value: formatEuro(cashBalance), note: `Snapshot · ${formatAsOfDate(filters.endDate)}`, tone: "neutral" as const },
        ]
      : [
          { label: "In", value: formatEuro(incomeTotal), note: kpiScopeNote, tone: "positive" as const },
          { label: "Out", value: formatEuro(spendingTotal), note: kpiScopeNote, tone: "negative" as const },
          { label: "Invested", value: formatEuro(investingTotal), note: kpiScopeNote, tone: "accent" as const },
          { label: "Net", value: formatEuro(netResultTotal, { signed: true }), note: kpiScopeNote, tone: netResultTotal < 0 ? ("negative" as const) : ("positive" as const) },
          { label: "Cash balance", value: formatEuro(cashBalance), note: `As of ${formatAsOfDate(filters.endDate)}`, tone: "neutral" as const },
        ];
  const categoryMetricItems = [
    {
      label: "In",
      value: formatEuro(metricViewMode === "average" ? categoryInTotal / Math.max(metricAveragePeriodCount, 1) : categoryInTotal),
      note: metricViewMode === "average" ? kpiAverageNote : kpiScopeNote,
      tone: "positive" as const,
    },
    {
      label: "Out",
      value: formatEuro(metricViewMode === "average" ? categoryOutTotal / Math.max(metricAveragePeriodCount, 1) : categoryOutTotal),
      note: metricViewMode === "average" ? kpiAverageNote : kpiScopeNote,
      tone: "negative" as const,
    },
    {
      label: "Net",
      value: formatEuro(metricViewMode === "average" ? categoryNetTotal / Math.max(metricAveragePeriodCount, 1) : categoryNetTotal, { signed: true }),
      note: metricViewMode === "average" ? kpiAverageNote : kpiScopeNote,
      tone:
        (metricViewMode === "average" ? categoryNetTotal / Math.max(metricAveragePeriodCount, 1) : categoryNetTotal) < 0
          ? ("negative" as const)
          : ("positive" as const),
    },
    {
      label: "Share",
      value: formatPercent(categoryShare),
      note: categoryScopeNote,
      tone: "neutral" as const,
    },
    {
      label: "Transactions",
      value: metricViewMode === "average" ? formatMetricCount(categoryTransactionAverage, 1) : formatMetricCount(categoryTransactionCount),
      note: metricViewMode === "average" ? kpiAverageNote : kpiScopeNote,
      tone: "neutral" as const,
    },
  ];
  const metricItems = isCategoryMode ? categoryMetricItems : overviewMetricItems;
  const trendTitle = isCategoryMode ? selectedCategorySummary : overviewTrendTitle;
  const trendPanelTitle =
    isCategoryMode
      ? selectedCategories.length > 1
        ? "Category compare"
        : selectedCategories.length === 1
          ? `${selectedCategoryMeta} trend`
          : "Category trend"
      : "Trend";
  const trendContextTitle = isCategoryMode ? activeWindowLabel : trendTitle;
  const showInBar = !isCategoryMode;
  const showOutBar = !isCategoryMode;
  const showInvestingBar = !isCategoryMode;
  const trendLegendItems = isCategoryMode
    ? selectedCompareSeries.map((series) => ({
        id: series.categoryKey,
        value: series.label,
        color: series.color,
      }))
    : [
        {
          id: "cashIn",
          value: "In",
          color: "hsl(var(--accent-primary))",
        },
        {
          id: "cashOut",
          value: "Out",
          color: "hsl(var(--accent-secondary))",
        },
        {
          id: "investing",
          value: "Invested",
          color: "hsl(var(--accent-tertiary))",
        },
      ];
  const trendContextNote =
    isCategoryMode
      ? `${compareDirectionLabel} compare · ${overviewTrendTitle}${selectedCategories.length > 1 ? ` · ${selectedCategories.length} selected` : ""}`
      : "In, out, invested; net below";
  const trendTableColumns: Array<TableColumn<Record<string, unknown>>> = [
    {
      key: "displayLabel",
      label: granularity === "year" ? "Year" : "Month",
      render: (value: unknown) => <span>{String(value)}</span>,
    },
    ...(
      isCategoryMode
        ? [
            ...selectedCompareSeries.map((series) => ({
              key: series.dataKey,
              label: series.label,
              align: "right" as const,
              cellClassName: "cell-nowrap",
              render: (value: unknown) => <span>{formatEuro(Number(value ?? 0))}</span>,
            })),
            {
              key: "total",
              label: "Total",
              align: "right" as const,
              cellClassName: "cell-nowrap",
              render: (value: unknown) => <span>{formatEuro(Number(value ?? 0))}</span>,
            },
            {
              key: "txCount",
              label: "Tx count",
              align: "right" as const,
              cellClassName: "cell-nowrap",
              render: (value: unknown) => <span>{formatMetricCount(Number(value ?? 0))}</span>,
            },
          ]
        : [
            { key: "cashIn", label: "In", align: "right" as const, cellClassName: "cell-nowrap", render: (value: unknown) => <span>{formatEuro(Number(value))}</span> },
            { key: "cashOut", label: "Out", align: "right" as const, cellClassName: "cell-nowrap", render: (value: unknown) => <span>{formatEuro(Number(value))}</span> },
            { key: "investing", label: "Invested", align: "right" as const, cellClassName: "cell-nowrap", render: (value: unknown) => <span>{formatEuro(Number(value))}</span> },
            { key: "netResult", label: "Net", align: "right" as const, cellClassName: "cell-nowrap", render: (value: unknown) => <SignedAmount value={Number(value)} /> },
          ]
    ),
  ];
  const visibleTrendRows = isCategoryMode ? compareTrendRows : trendRows;
  const categoryCompareBarSize =
    granularity === "year"
      ? Math.max(14, 30 - selectedCompareSeries.length * 3)
      : Math.max(10, 22 - selectedCompareSeries.length * 3);
  const renderTrendBarLabel = ({ x = 0, y = 0, width = 0, value }: any) => {
    const amount = Number(value ?? 0);
    if (!Number.isFinite(amount) || amount <= 0 || Number(width) < 10) {
      return null;
    }

    const label = formatTrendBarLabel(amount);
    const labelWidth = Math.max(42, label.length * 6.6 + 12);
    const labelHeight = 16;
    const labelX = Number(x) + Number(width) / 2 - labelWidth / 2;
    const labelY = Math.max(Number(y) - 20, 8);

    return (
      <g pointerEvents="none" transform={`translate(${labelX}, ${labelY})`}>
        <rect width={labelWidth} height={labelHeight} fill="rgba(10, 12, 18, 0.92)" stroke="rgba(223, 231, 243, 0.12)" />
        <text
          x={labelWidth / 2}
          y={11}
          textAnchor="middle"
          fill="rgba(245, 248, 255, 0.96)"
          fontSize={10}
          fontWeight={800}
          fontFamily="Manrope, system-ui, sans-serif"
          letterSpacing="-0.01em"
        >
          {label}
        </text>
      </g>
    );
  };
  const renderTrendMonthTick = ({ x = 0, y = 0, payload }: any) => {
    const label = String(payload?.value ?? "");
    const period = trendPeriodLookup.get(label);
    return (
      <g transform={`translate(${Number(x)}, ${Number(y)})`}>
        <text
          className="trend-axis-month-tick"
          x={0}
          y={16}
          textAnchor="middle"
          onClick={period ? () => openTrendPeriodDetail({ periodKey: period.periodKey, displayLabel: period.displayLabel }) : undefined}
        >
          {label}
        </text>
      </g>
    );
  };

  const buildSummary = (rows: TransactionRecord[]) => {
    const total = rows.reduce((sum, row) => sum + row.signedAmount, 0);
    return [
      { label: "Rows", value: rows.length.toLocaleString("en-US") },
      { label: "Net amount", value: formatEuro(total, { signed: true }) },
      { label: "Range", value: formatDateRange(filters.startDate, filters.endDate) },
    ];
  };

  const openTransactionDetail = (title: string, rows: TransactionRecord[], meta?: string) => {
    setDetail({
      title,
      meta: meta ?? `${rows.length.toLocaleString("en-US")} rows in the current view`,
      summary: buildSummary(rows),
      rows: rows
        .slice()
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
        .slice(0, 160)
        .map((row) => ({
          rowId: row.rowId,
          date: formatDisplayDate(row.date),
          sortDate: row.date,
          displayDescription: row.displayDescription,
          description: row.description,
          txType: row.txType,
          groupKey: row.group,
          category: row.categoryLabel,
          categoryKey: row.category,
          categoryLabel: row.categoryLabel,
          categoryOverride: row.categoryOverride,
          investmentAssetClass: row.investmentAssetClass,
          classifiedInvestmentAssetClass: row.classifiedInvestmentAssetClass,
          investmentAssetClassOverride: row.investmentAssetClassOverride,
          amount: row.signedAmount,
          signedAmount: row.signedAmount,
        })),
      columns: [
        { key: "date", label: "Date", sortable: true, sortKey: "sortDate", sortDefaultDirection: "desc" },
        {
          key: "displayDescription",
          label: "Details",
          cellClassName: "cell-description",
          render: (_value, row) => (
            <div className="table-transaction-cell">
              <strong>{String(row.displayDescription)}</strong>
              <small>
                {String(row.txType)}
                {String(row.description) && String(row.description) !== String(row.displayDescription) ? ` · ${String(row.description)}` : ""}
              </small>
            </div>
          ),
        },
        { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
        { key: "amount", label: "Amount", sortable: true, sortDefaultDirection: "desc", render: (value) => <SignedAmount value={Number(value)} /> },
      ],
    });
  };

  const filterCategoryPeriodRows = (periodKey: string, categoryKeys: string[], direction: TrendCompareDirection) =>
    trendDetailSourceTransactions.filter((row) => {
      const matchesPeriod = granularity === "year" ? row.yearLabel === periodKey : row.monthLabel === periodKey;
      if (!matchesPeriod) {
        return false;
      }
      if (!categoryKeys.some((categoryKey) => matchesIncomeCategoryScope(row, categoryKey, incomeScopeProfileMap))) {
        return false;
      }
      return direction === "in" ? row.signedAmount > 0 : row.signedAmount < 0;
    });

  const openTrendPeriodDetail = (payload?: TrendPeriodPayload | null) => {
    const periodKey = payload?.periodKey;
    if (!periodKey) return;
    const displayLabel = payload?.displayLabel ?? periodKey;
    const rows =
      isCategoryMode && selectedCategories.length > 0
        ? filterCategoryPeriodRows(periodKey, selectedCategories, compareDirection)
        : trendDetailSourceTransactions.filter((row) => {
            const matchesPeriod = granularity === "year" ? row.yearLabel === periodKey : row.monthLabel === periodKey;
            return matchesPeriod;
          });
    openTransactionDetail(
      isCategoryMode && selectedCategories.length > 0
        ? `${selectedCategorySummary} ${compareDirection === "in" ? "inflows" : "outflows"} in ${displayLabel}`
        : `Transactions in ${displayLabel}`,
      rows,
      isCategoryMode && selectedCategories.length > 0
        ? `${granularity === "year" ? "Year" : "Month"}: ${displayLabel} · Categories: ${selectedCategoryMeta} · ${compareDirectionLabel}`
        : `${granularity === "year" ? "Year" : "Month"}: ${displayLabel}`,
    );
  };

  const openTrendCategoryDetail = (categoryKey: string, payload?: TrendPeriodPayload | null) => {
    const periodKey = payload?.periodKey;
    if (!periodKey) {
      return;
    }
    const displayLabel = payload?.displayLabel ?? periodKey;
    const rows = filterCategoryPeriodRows(periodKey, [categoryKey], compareDirection);
    const categoryLabel = resolveIncomeCategoryScopeLabel(categoryKey, incomeScopeProfileMap);
    openTransactionDetail(
      `${categoryLabel} ${compareDirection === "in" ? "inflows" : "outflows"} in ${displayLabel}`,
      rows,
      `${granularity === "year" ? "Year" : "Month"}: ${displayLabel} · Category: ${categoryLabel} · ${compareDirectionLabel}`,
    );
  };

  const openTrendMetricDetail = (
    metric: TrendMetricKey,
    payload?: TrendPeriodPayload,
  ) => {
    const periodKey = payload?.periodKey;
    if (!periodKey) return;

    const displayLabel = payload?.displayLabel ?? periodKey;
    const rows = trendDetailSourceTransactions.filter((row) => {
      const matchesPeriod = granularity === "year" ? row.yearLabel === periodKey : row.monthLabel === periodKey;
      if (!matchesPeriod) {
        return false;
      }
      if (metric === "cashIn") {
        return row.signedAmount > 0 && row.group !== "investment";
      }
      if (metric === "cashOut") {
        return row.signedAmount < 0 && row.group !== "investment";
      }
      return row.group === "investment";
    });

    const title =
      metric === "cashIn"
        ? `In transactions in ${displayLabel}`
        : metric === "cashOut"
          ? `Out transactions in ${displayLabel}`
          : `Investment transactions in ${displayLabel}`;

    const meta =
      metric === "cashIn"
        ? `${granularity === "year" ? "Year" : "Month"}: ${displayLabel} · In`
        : metric === "cashOut"
          ? `${granularity === "year" ? "Year" : "Month"}: ${displayLabel} · Out`
          : `${granularity === "year" ? "Year" : "Month"}: ${displayLabel} · Invested`;

    openTransactionDetail(title, rows, meta);
  };

  const openKpiDetail = (label: string) => {
    if (isCategoryMode && selectedCategories.length > 0) {
      if (label === "In") {
        return openTransactionDetail(
          `${selectedCategorySummary} inflows`,
          categoryRowsInView.filter((row) => row.signedAmount > 0),
          `Categories: ${selectedCategoryMeta} · In`,
        );
      }
      if (label === "Out") {
        return openTransactionDetail(
          `${selectedCategorySummary} outflows`,
          categoryRowsInView.filter((row) => row.signedAmount < 0),
          `Categories: ${selectedCategoryMeta} · Out`,
        );
      }
      return openTransactionDetail(
        `${selectedCategorySummary} transactions`,
        categoryRowsInView,
        `Categories: ${selectedCategoryMeta}`,
      );
    }

    if (label === "In") {
      return openTransactionDetail("In transactions", filteredTransactions.filter((row) => row.signedAmount > 0 && row.group !== "investment"));
    }
    if (label === "Out") {
      return openTransactionDetail("Out transactions", filteredTransactions.filter((row) => row.signedAmount < 0 && row.group !== "investment"));
    }
    if (label === "Invested") {
      return openTransactionDetail("Investment transactions", filteredTransactions.filter((row) => row.group === "investment"));
    }
    return openTransactionDetail("All transactions in view", filteredTransactions);
  };

  const applyPreset = (preset: "yearToDate" | "last12") => {
    setShowCustomPeriod(false);
    setFilters((current) => ({ ...current, ...createInitialFilterState(dates, preset), excludeIncompleteMonths: current.excludeIncompleteMonths }));
  };

  const applyAllTime = () => {
    setShowCustomPeriod(false);
    setFilters((current) => ({
      ...current,
      ...createInitialFilterState(dates, "allTime"),
      excludeIncompleteMonths: current.excludeIncompleteMonths,
    }));
  };

  const activateOverviewScope = () => {
    setScopeMode("overview");
    setIsCategoryPickerOpen(false);
    setCategorySearch("");
    syncCategoryQuery([], null);
  };

  const activateCategoryScope = () => {
    const nextCategories = selectedCategories.length > 0 ? selectedCategories : (defaultCategory ? [defaultCategory] : []);
    setScopeMode("category");
    if (nextCategories.length > 0) {
      const nextDirection = inferDirectionForCategory(nextCategories[0], compareDirection);
      setSelectedCategories(nextCategories);
      setCompareDirection(nextDirection);
      syncCategoryQuery(nextCategories, nextDirection);
    }
  };

  const toggleTrendCategory = (categoryKey: string, sourceDirection: TrendCompareDirection | "both") => {
    const isSelected = selectedCategorySet.has(categoryKey);
    const nextDirection = sourceDirection === "both" ? compareDirection : sourceDirection;
    setScopeMode("category");
    setCategorySearch("");
    if (isSelected) {
      if (sourceDirection !== "both" && sourceDirection !== compareDirection) {
        setSelectedCategories([categoryKey]);
        setCompareDirection(sourceDirection);
        syncCategoryQuery([categoryKey], sourceDirection);
        return;
      }

      const nextCategories = selectedCategories.filter((key) => key !== categoryKey);
      setSelectedCategories(nextCategories);
      syncCategoryQuery(nextCategories, nextCategories.length > 0 ? compareDirection : null);
      return;
    }

    if (sourceDirection !== "both" && sourceDirection !== compareDirection) {
      setSelectedCategories([categoryKey]);
      setCompareDirection(sourceDirection);
      syncCategoryQuery([categoryKey], sourceDirection);
      return;
    }

    if (selectedCategories.length >= 4) {
      return;
    }

    const nextCategories = [...selectedCategories, categoryKey];
    setSelectedCategories(nextCategories);
    setCompareDirection(nextDirection);
    syncCategoryQuery(nextCategories, nextDirection);
  };

  return (
    <DashboardShell kicker="Trend" description="Monthly cashflow trend for the selected period." hideHero viewportLocked>
      <section className="home-commandbar">
        <div className="home-commandbar-row">
          <div className="home-commandbar-title"><strong>Trend</strong></div>
          <div className="trend-commandbar-controls">
            <div className="home-period-bar" aria-label="Period presets">
              <button type="button" className="quick-button" data-active={activePreset === "allTime"} onClick={applyAllTime}>All</button>
              <button type="button" className="quick-button" data-active={activePreset === "last12"} onClick={() => applyPreset("last12")}>12M</button>
              <button type="button" className="quick-button" data-active={activePreset === "yearToDate"} onClick={() => applyPreset("yearToDate")}>YTD</button>
              <button type="button" className="quick-button quick-button-ghost" data-active={showCustomPeriod || activePreset === "custom"} onClick={() => setShowCustomPeriod((current) => !current)}>Custom</button>
            </div>
            <div className="trend-granularity-toggle" role="group" aria-label="trend scope mode" data-active-value={scopeMode}>
              <span className="trend-granularity-thumb" aria-hidden="true" />
              <button type="button" className="trend-granularity-option" data-active={scopeMode === "overview"} aria-pressed={scopeMode === "overview"} onClick={activateOverviewScope}>Overview</button>
              <button type="button" className="trend-granularity-option" data-active={scopeMode === "category"} aria-pressed={scopeMode === "category"} onClick={activateCategoryScope}>Category</button>
            </div>
            {scopeMode === "category" ? (
              <div className="trend-category-picker">
                <button
                  type="button"
                  className="trend-category-picker-trigger"
                  data-open={isCategoryPickerOpen}
                  aria-expanded={isCategoryPickerOpen}
                  aria-controls="trend-category-picker-panel"
                  onClick={() => setIsCategoryPickerOpen((current) => !current)}
                >
                  <span className="trend-category-picker-label">{selectedCategories.length > 1 ? "Categories" : "Category"}</span>
                  <span className={selectedCategories.length > 0 ? "trend-category-picker-value" : "trend-category-picker-placeholder"}>
                    {selectedCategories.length > 0 ? `${selectedCategorySummary} · ${compareDirectionLabel}` : "Pick categories"}
                  </span>
                  <span className="trend-category-picker-caret" aria-hidden="true">▾</span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="home-commandbar-meta">
            <span className="home-updated">Updated {formatAsOfDate(data.transactions.at(-1)?.date ?? filters.endDate)}</span>
          </div>
        </div>
        {showCustomPeriod ? <div className="home-commandbar-custom"><FilterBar dates={dates} filters={filters} onChange={setFilters} /></div> : null}
        {scopeMode === "category" && isCategoryPickerOpen ? (
          <div id="trend-category-picker-panel" className="trend-category-picker-panel">
            <input
              type="search"
              className="trend-category-search"
              placeholder="Search categories"
              value={categorySearch}
              onChange={(event) => setCategorySearch(event.target.value)}
            />
            {selectedCategoryOptions.length > 0 ? (
              <section className="trend-category-section">
                <div className="trend-category-section-head">
                  <strong>Selected</strong>
                  <button
                    type="button"
                    className="trend-category-clear"
                    onClick={() => {
                      setSelectedCategories([]);
                      syncCategoryQuery([], null);
                    }}
                  >
                    Clear all
                  </button>
                </div>
                <div className="trend-category-results" role="listbox" aria-label="Selected categories">
                  {selectedCategoryOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="trend-category-option"
                      data-active="true"
                      onClick={() => toggleTrendCategory(option.value, compareDirection)}
                    >
                      <CategoryBadge
                        category={option.value}
                        label={option.label}
                        theme={resolveIncomeCategoryScopeTheme(option.value, incomeScopeProfileMap)}
                      />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="trend-category-sections">
              {inCategoryOptions.length > 0 ? (
                <section className="trend-category-section">
                  <div className="trend-category-section-head">
                    <strong>In</strong>
                    <span>{inCategoryOptions.length}</span>
                  </div>
                  <div className="trend-category-results" role="listbox" aria-label="In categories">
                    {inCategoryOptions.map((option) => (
                      <button
                        key={option.value}
                      type="button"
                      className="trend-category-option"
                      data-active={selectedCategorySet.has(option.value)}
                      disabled={selectedCategoriesAtLimit && !selectedCategorySet.has(option.value)}
                      onClick={() => toggleTrendCategory(option.value, "in")}
                    >
                      <CategoryBadge
                        category={option.value}
                        label={option.label}
                        theme={resolveIncomeCategoryScopeTheme(option.value, incomeScopeProfileMap)}
                      />
                    </button>
                  ))}
                </div>
                </section>
              ) : null}
              {outCategoryOptions.length > 0 ? (
                <section className="trend-category-section">
                  <div className="trend-category-section-head">
                    <strong>Out</strong>
                    <span>{outCategoryOptions.length}</span>
                  </div>
                  <div className="trend-category-results" role="listbox" aria-label="Out categories">
                    {outCategoryOptions.map((option) => (
                      <button
                        key={option.value}
                      type="button"
                      className="trend-category-option"
                      data-active={selectedCategorySet.has(option.value)}
                      disabled={selectedCategoriesAtLimit && !selectedCategorySet.has(option.value)}
                      onClick={() => toggleTrendCategory(option.value, "out")}
                    >
                      <CategoryBadge
                        category={option.value}
                        label={option.label}
                        theme={resolveIncomeCategoryScopeTheme(option.value, incomeScopeProfileMap)}
                      />
                    </button>
                  ))}
                </div>
                </section>
              ) : null}
            </div>
            {selectedCategoryOptions.length === 0 && inCategoryOptions.length === 0 && outCategoryOptions.length === 0 ? (
              <div className="trend-category-empty">No categories match that search.</div>
            ) : null}
            <div className="trend-category-panel-meta">
              <span>{selectedCategories.length === 0 ? "Choose up to 4 categories." : `${selectedCategories.length}/4 selected · ${compareDirectionLabel} compare`}</span>
              <button type="button" className="trend-category-clear" onClick={() => setIsCategoryPickerOpen(false)}>Done</button>
            </div>
          </div>
        ) : null}
      </section>

      <div className="home-kpi-mode" aria-label="trend metric mode">
        <span className="home-kpi-mode-label">Metrics</span>
        <div className="home-kpi-mode-buttons">
          <button type="button" className="quick-button" data-active={metricViewMode === "total"} onClick={() => setMetricViewMode("total")}>Totals</button>
          <button type="button" className="quick-button" data-active={metricViewMode === "average"} onClick={() => setMetricViewMode("average")}>{`Avg / ${metricAverageUnitLabel}`}</button>
        </div>
      </div>

      <ClickableMetricGrid items={metricItems} onSelect={(item) => openKpiDetail(item.label)} />

      <section className="home-secondary-grid home-secondary-grid-single">
        <Panel title={trendPanelTitle} actions={
          <div className="trend-panel-actions">
            <div className="trend-granularity-toggle" role="group" aria-label="trend aggregation mode" data-active-value={granularity}>
              <span className="trend-granularity-thumb" aria-hidden="true" />
              <button type="button" className="trend-granularity-option" data-active={granularity === "month"} aria-pressed={granularity === "month"} onClick={() => setGranularity("month")}>Month</button>
              <button type="button" className="trend-granularity-option" data-active={granularity === "year"} aria-pressed={granularity === "year"} onClick={() => setGranularity("year")}>Year</button>
            </div>
            <div className="panel-view-toggle" aria-label="trend view mode">
              <button type="button" className="quick-button" data-active={viewMode === "visual"} onClick={() => setViewMode("visual")}>Trend</button>
              <button type="button" className="quick-button" data-active={viewMode === "table"} onClick={() => setViewMode("table")}>Table</button>
            </div>
          </div>
        } className="home-panel-fixed home-panel-fixed-trend">
          {visibleTrendRows.length === 0 ? (
            <div className="empty">{isCategoryMode ? (selectedCategories.length > 0 ? `No ${compareDirectionLabel.toLowerCase()} trend is available for ${selectedCategorySummary} in this view.` : "Choose up to 4 categories to compare them over time.") : "No trend is available in this view."}</div>
          ) : (
            <div className="home-panel-stack">
              <div className="home-panel-context"><strong>{trendContextTitle}</strong><span>{trendContextNote}</span></div>
              <div className="home-widget-body home-widget-body-trend">
                {viewMode === "visual" ? (
                  <div className="chart-box chart-home-trend-wide chart-box-interactive trend-visual-stack">
                    <div className="trend-visual-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          data={visibleTrendRows as Array<Record<string, unknown>>}
                          margin={{ top: 28, right: 8, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
                          <XAxis dataKey="displayLabel" tick={renderTrendMonthTick} stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} dy={8} minTickGap={16} />
                          <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
                          <Tooltip
                            cursor={false}
                            content={
                              <ChartTooltipContent
                                formatLabel={(label) => String(label ?? "")}
                              formatValue={(value) => formatEuro(Number(value ?? 0))}
                              />
                            }
                          />
                          <Legend
                            content={() => (
                              <div className="trend-custom-legend">
                                {trendLegendItems.map((item) => (
                                  <span key={item.id} className="trend-custom-legend-item">
                                    <span className="trend-custom-legend-dot" style={{ backgroundColor: item.color }} />
                                    <span className="trend-custom-legend-label">{item.value}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                            wrapperStyle={{ paddingTop: "12px" }}
                          />
                          {isCategoryMode
                            ? selectedCompareSeries.map((series) => (
                                <Bar
                                  key={series.categoryKey}
                                  dataKey={series.dataKey}
                                  name={series.label}
                                  fill={series.color}
                                  barSize={categoryCompareBarSize}
                                  activeBar={TREND_ACTIVE_BAR_STYLE}
                                  cursor="pointer"
                                  onClick={(state: any) =>
                                    openTrendCategoryDetail(series.categoryKey, {
                                      periodKey: state?.payload?.periodKey,
                                      displayLabel: state?.payload?.displayLabel,
                                    })
                                  }
                                >
                                  <LabelList dataKey={series.dataKey} position="top" content={renderTrendBarLabel} />
                                </Bar>
                              ))
                            : null}
                          {!isCategoryMode && showInBar ? (
                            <Bar
                              dataKey="cashIn"
                              name="In"
                              fill="hsl(var(--accent-primary))"
                              barSize={18}
                              activeBar={TREND_ACTIVE_BAR_STYLE}
                              cursor="pointer"
                              onClick={(state: any) =>
                                openTrendMetricDetail("cashIn", {
                                  periodKey: state?.payload?.periodKey,
                                  displayLabel: state?.payload?.displayLabel,
                                })
                              }
                            >
                              <LabelList dataKey="cashIn" position="top" content={renderTrendBarLabel} />
                            </Bar>
                          ) : null}
                          {!isCategoryMode && showOutBar ? (
                            <Bar
                              dataKey="cashOut"
                              name="Out"
                              fill="hsl(var(--accent-secondary))"
                              barSize={18}
                              activeBar={TREND_ACTIVE_BAR_STYLE}
                              cursor="pointer"
                              onClick={(state: any) =>
                                openTrendMetricDetail("cashOut", {
                                  periodKey: state?.payload?.periodKey,
                                  displayLabel: state?.payload?.displayLabel,
                                })
                              }
                            >
                              <LabelList dataKey="cashOut" position="top" content={renderTrendBarLabel} />
                            </Bar>
                          ) : null}
                          {!isCategoryMode && showInvestingBar ? (
                            <Bar
                              dataKey="investing"
                              name="Invested"
                              fill="hsl(var(--accent-tertiary))"
                              barSize={18}
                              activeBar={TREND_ACTIVE_BAR_STYLE}
                              cursor="pointer"
                              onClick={(state: any) =>
                                openTrendMetricDetail("investing", {
                                  periodKey: state?.payload?.periodKey,
                                  displayLabel: state?.payload?.displayLabel,
                                })
                              }
                            >
                              <LabelList dataKey="investing" position="top" content={renderTrendBarLabel} />
                            </Bar>
                          ) : null}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="trend-net-strip" aria-label={`${isCategoryMode ? `${compareDirectionLabel} total` : "Net result"} by ${granularity}`}>
                      <div className="trend-net-strip-label">{isCategoryMode ? `${compareDirectionLabel} total` : "Net"}</div>
                      <div
                        className="trend-net-strip-values"
                        style={{ gridTemplateColumns: `repeat(${visibleTrendRows.length}, minmax(0, 1fr))` }}
                      >
                        {visibleTrendRows.map((row) => (
                          <button
                            key={`${String(row.periodKey)}-summary`}
                            type="button"
                            className="trend-net-pill"
                            data-tone={isCategoryMode ? "positive" : (Number((row as TrendDisplayRow).netResult) >= 0 ? "positive" : "negative")}
                            onClick={() => openTrendPeriodDetail({ periodKey: String(row.periodKey), displayLabel: String(row.displayLabel) })}
                          >
                            {isCategoryMode ? formatEuro(Number((row as TrendCompareRow).total ?? 0)) : formatTrendNetLabel(Number((row as TrendDisplayRow).netResult))}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="home-table-panel">
                    <DataTable
                      density="compact"
                      rows={trendTableRows}
                      onRowClick={(row) =>
                        openTrendPeriodDetail({
                          periodKey: String(row.periodKey),
                          displayLabel: String(row.displayLabel),
                        })
                      }
                      columns={trendTableColumns}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>
      </section>

      <DetailSheet open={Boolean(detail)} detail={detail} onClose={() => setDetail(null)} />
    </DashboardShell>
  );
}
