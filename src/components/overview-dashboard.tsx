"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AccountsData } from "@/lib/accounts-data";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  averageMonthlyStory,
  applyCapitalFilters,
  applyTransactionFilters,
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
  topIncomeSources,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import { buildInvestmentAnalytics } from "@/lib/investment-performance";
import { resolveCategoryTheme } from "@/lib/category-config";
import {
  buildIncomeCategoryScopeProfiles,
  matchesIncomeCategoryScope,
  resolveIncomeCategoryScopeTheme,
} from "@/lib/income-category-scope";
import type { DetailTrendView, DetailView } from "./dashboard-ui";
import { CategoryEditor, ChartTooltipContent, ClickableMetricGrid, DashboardShell, DataTable, DetailSheet, FilterBar, Panel, SignedAmount, defaultFilterState } from "./dashboard-ui";

const TREEMAP_EURO_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});
const TREEMAP_WEIGHT_EXPONENT = 0.45;
const TREEMAP_BALANCED_FLOOR_FACTOR = 0.55;
const TREEMAP_CANVAS_WIDTH = 1000;
const TREEMAP_CANVAS_HEIGHT = 620;
const TREEMAP_TILE_GAP = 14;
const TREEMAP_COLUMN_COUNT = 3;
const DETAIL_TREND_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

type SpendingRankEntry = {
  categoryLabel: string;
  categoryKeys: string[];
  amount: number;
  share: number;
  color: string;
  treemapWeight: number;
};

type SpendingTreemapTile = SpendingRankEntry & {
  layoutKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: "hero" | "large" | "medium" | "small" | "tiny";
};

type WidgetViewMode = "visual" | "treemap" | "table";
type HomeWidgetKey = "spending" | "income";
type MetricViewMode = "total" | "average";
const WIDGET_VISUAL_LABELS: Record<HomeWidgetKey, string> = {
  spending: "Bar chart",
  income: "Donut",
};

type SpendingDetailPayload = Pick<SpendingRankEntry, "categoryLabel" | "categoryKeys" | "amount" | "share">;
type ActiveChartState<TPayload> = {
  activePayload?: Array<{
    payload?: TPayload;
  }>;
};

function sameRange(startDate: string, endDate: string, nextStartDate: string, nextEndDate: string) {
  return startDate === nextStartDate && endDate === nextEndDate;
}

function getActiveChartPayload<TPayload>(state: ActiveChartState<TPayload> | undefined): TPayload | undefined {
  return state?.activePayload?.[0]?.payload;
}

function buildDetailTrendMonths(endMonthLabel: string, count = 12) {
  const [endYear, endMonth] = endMonthLabel.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    const date = new Date(Date.UTC(endYear, endMonth - 1 - offset, 1));
    const monthLabel = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      monthLabel,
      displayMonthLabel: DETAIL_TREND_MONTH_FORMATTER.format(date),
    };
  });
}

function buildTransactionDetailTrend(
  rows: TransactionRecord[],
  endMonthLabel: string,
  direction: "inflow" | "outflow",
  color: string,
): DetailTrendView {
  const monthWindow = buildDetailTrendMonths(endMonthLabel);
  const totals = new Map(monthWindow.map((month) => [month.monthLabel, 0]));

  for (const row of rows) {
    if (!totals.has(row.monthLabel)) {
      continue;
    }

    if (direction === "outflow" && row.signedAmount < 0) {
      totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + Math.abs(row.signedAmount));
      continue;
    }

    if (direction === "inflow" && row.signedAmount > 0) {
      totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + row.signedAmount);
    }
  }

  return {
    title: `${direction === "outflow" ? "Outflow" : "Inflow"} trend`,
    note: `Last 12 months to ${formatMonthTitle(endMonthLabel)}`,
    valueLabel: direction === "outflow" ? "Outflow" : "Inflow",
    color,
    data: monthWindow.map((month) => ({
      monthLabel: month.monthLabel,
      displayMonthLabel: month.displayMonthLabel,
      value: totals.get(month.monthLabel) ?? 0,
    })),
  };
}

function buildSpendingRankings(transactions: TransactionRecord[]): SpendingRankEntry[] {
  const totals = new Map<string, { categoryLabel: string; amount: number }>();
  for (const row of transactions) {
    if (row.signedAmount >= 0 || row.group === "investment") continue;
    const current = totals.get(row.category) ?? { categoryLabel: row.categoryLabel, amount: 0 };
    current.amount += Math.abs(row.signedAmount);
    totals.set(row.category, current);
  }
  const totalSpending = [...totals.values()].reduce((sum, row) => sum + row.amount, 0);
  if (totalSpending <= 0) return [];
  const ranked = [...totals.entries()]
    .map(([categoryKey, row]) => ({
      categoryLabel: row.categoryLabel,
      categoryKeys: [categoryKey],
      amount: row.amount,
      share: (row.amount / totalSpending) * 100,
    }))
    .sort((left, right) => right.amount - left.amount);
  const balancedWeights = ranked.map((row) => Math.pow(row.amount, TREEMAP_WEIGHT_EXPONENT));
  const averageBalancedWeight = balancedWeights.reduce((sum, value) => sum + value, 0) / balancedWeights.length;
  const balancedFloor = averageBalancedWeight * TREEMAP_BALANCED_FLOOR_FACTOR;
  return ranked.map((row, index) => ({
    ...row,
    color: resolveCategoryTheme(row.categoryKeys[0]).solid,
    treemapWeight: Math.max(balancedWeights[index] ?? 0, balancedFloor),
  }));
}

function formatTreemapAmount(amount: number, compact: boolean) {
  if (!compact) return formatEuro(amount);
  return TREEMAP_EURO_FORMATTER.format(amount);
}

function splitSpendingTreemapColumns(rows: SpendingRankEntry[]) {
  const columnCount = Math.min(TREEMAP_COLUMN_COUNT, rows.length);
  const groups: SpendingRankEntry[][] = [];
  let startIndex = 0;

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const remainingRows = rows.length - startIndex;
    const remainingColumns = columnCount - columnIndex;
    const nextColumnSize = Math.ceil(remainingRows / remainingColumns);
    groups.push(rows.slice(startIndex, startIndex + nextColumnSize));
    startIndex += nextColumnSize;
  }

  return groups.filter((group) => group.length > 0);
}

function classifyTreemapTileSize(width: number, height: number): SpendingTreemapTile["size"] {
  const areaRatio = (width * height) / (TREEMAP_CANVAS_WIDTH * TREEMAP_CANVAS_HEIGHT);
  if (areaRatio >= 0.2 || (width >= 300 && height >= 170)) {
    return "hero";
  }
  if (areaRatio >= 0.11 || (width >= 220 && height >= 110)) {
    return "large";
  }
  if (areaRatio >= 0.055 || (width >= 150 && height >= 72)) {
    return "medium";
  }
  if (areaRatio >= 0.025 || (width >= 110 && height >= 54)) {
    return "small";
  }
  return "tiny";
}

function resolveTreemapTileContent(tile: SpendingTreemapTile) {
  const availableWidth = Math.max(0, tile.width - 24);
  const availableHeight = Math.max(0, tile.height - 18);
  const maxLabelFontPx = tile.size === "hero" ? 16 : tile.size === "large" ? 14.5 : tile.size === "medium" ? 13 : 11.5;
  const minLabelFontPx = tile.size === "tiny" ? 7.2 : 8;
  const labelLineHeight = 1.08;
  const candidateLineClamps = [3, 2, 1].filter((lines) => availableHeight >= lines * minLabelFontPx * labelLineHeight + 4);

  let bestLabelFit: { lines: number; fontPx: number } | null = null;

  for (const lines of candidateLineClamps) {
    const approxCharsPerLine = Math.ceil(tile.categoryLabel.length / lines);
    const widthFitPx = availableWidth / Math.max(approxCharsPerLine * 0.61, 1);
    const heightFitPx = (availableHeight - 2) / (lines * labelLineHeight);
    const fontPx = Math.min(maxLabelFontPx, widthFitPx, heightFitPx);

    if (fontPx < minLabelFontPx) {
      continue;
    }

    if (!bestLabelFit || fontPx > bestLabelFit.fontPx || (fontPx === bestLabelFit.fontPx && lines < bestLabelFit.lines)) {
      bestLabelFit = { lines, fontPx };
    }
  }

  const showLabel = Boolean(bestLabelFit) && availableWidth >= 68 && availableHeight >= 18;
  const labelLineClamp = bestLabelFit?.lines ?? 1;
  const labelFontPx = bestLabelFit?.fontPx ?? minLabelFontPx;
  const labelHeight = showLabel ? labelFontPx * labelLineHeight * labelLineClamp : 0;
  const remainingHeight = Math.max(0, availableHeight - labelHeight - 4);
  const showValue = showLabel && tile.size !== "tiny" && availableWidth >= 88 && remainingHeight >= 14;
  const showShare = (tile.size === "hero" || tile.size === "large") && availableWidth >= 116 && remainingHeight >= 26;

  return { showLabel, showValue, showShare, labelFontPx, labelLineClamp };
}

function buildSpendingTreemapLayout(rows: SpendingRankEntry[]): SpendingTreemapTile[] {
  if (rows.length === 0) {
    return [];
  }

  const groups = splitSpendingTreemapColumns(rows);
  const usableWidth = TREEMAP_CANVAS_WIDTH - TREEMAP_TILE_GAP * Math.max(0, groups.length - 1);
  const baseColumnWidth = Math.floor(usableWidth / groups.length);
  const layout: SpendingTreemapTile[] = [];
  let currentX = 0;

  groups.forEach((group, groupIndex) => {
    const isLastColumn = groupIndex === groups.length - 1;
    const columnWidth = isLastColumn
      ? TREEMAP_CANVAS_WIDTH - currentX
      : Math.max(96, baseColumnWidth);
    const usableHeight = TREEMAP_CANVAS_HEIGHT - TREEMAP_TILE_GAP * Math.max(0, group.length - 1);
    const columnWeight = group.reduce((sum, row) => sum + row.treemapWeight, 0) || 1;
    let currentY = 0;

    group.forEach((row, rowIndex) => {
      const isLastRow = rowIndex === group.length - 1;
      const rawHeight = usableHeight * (row.treemapWeight / columnWeight);
      const tileHeight = isLastRow
        ? TREEMAP_CANVAS_HEIGHT - currentY
        : Math.max(48, Math.round(rawHeight));

      layout.push({
        ...row,
        layoutKey: `${groupIndex}-${rowIndex}-${row.categoryKeys.join("-")}`,
        x: currentX,
        y: currentY,
        width: columnWidth,
        height: tileHeight,
        size: classifyTreemapTileSize(columnWidth, tileHeight),
      });

      currentY += tileHeight + TREEMAP_TILE_GAP;
    });

    currentX += columnWidth + TREEMAP_TILE_GAP;
  });

  return layout;
}

export function OverviewDashboard({ data }: { data: AccountsData }) {
  const dates = uniqueTransactionDates(data.transactions);
  const [filters, setFilters] = useState(() => defaultFilterState(dates));
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);
  const [metricViewMode, setMetricViewMode] = useState<MetricViewMode>("total");
  const [hoveredSpendingCategory, setHoveredSpendingCategory] = useState<string | null>(null);
  const [hoveredSpendingRow, setHoveredSpendingRow] = useState<SpendingDetailPayload | null>(null);
  const [widgetViewModes, setWidgetViewModes] = useState<Record<HomeWidgetKey, WidgetViewMode>>({
    spending: "visual",
    income: "visual",
  });

  const filteredTransactions = applyTransactionFilters(data.transactions, filters);
  const filteredCapitalSeries = applyCapitalFilters(data.capitalSeries, filters);
  const detailTrendEndMonth = filters.endDate.slice(0, 7);
  const analytics = useMemo(
    () =>
      buildInvestmentAnalytics({
        transactions: data.transactions,
        capitalSeries: data.capitalSeries,
        liveQuotes: data.liveQuotes,
        historicalSeries: data.historicalMarketSeries,
        endDate: filters.endDate,
        rangeStartDate: filters.startDate,
        historicalUnitEstimates: data.historicalUnitEstimates,
        positionUnitOverrides: data.positionUnitOverrides,
        positionValuationOverrides: data.positionValuationOverrides,
        registry: data.instrumentRegistry,
      }),
    [
      data.capitalSeries,
      data.historicalMarketSeries,
      data.historicalUnitEstimates,
      data.instrumentRegistry,
      data.liveQuotes,
      data.positionUnitOverrides,
      data.positionValuationOverrides,
      data.transactions,
      filters.endDate,
      filters.startDate,
    ],
  );

  const thisMonthRange = resolvePeriodBounds(dates, "thisMonth");
  const lastMonthRange = resolvePeriodBounds(dates, "lastMonth");
  const yearToDateRange = resolvePeriodBounds(dates, "yearToDate");
  const lastTwelveRange = resolvePeriodBounds(dates, "last12");
  const allTimeRange = resolvePeriodBounds(dates, "allTime");
  const spendingRankings = buildSpendingRankings(filteredTransactions);
  const incomeScopeProfiles = useMemo(() => buildIncomeCategoryScopeProfiles(data.transactions), [data.transactions]);
  const incomeScopeProfileMap = useMemo(() => new Map(incomeScopeProfiles.map((profile) => [profile.key, profile])), [incomeScopeProfiles]);
  const monthlyAverage = averageMonthlyStory(filteredTransactions);
  const widgetAverageMonthCount = monthlyAverage?.months ?? 0;
  const showAverageWidgetValues = metricViewMode === "average" && widgetAverageMonthCount > 0;
  const widgetAmountDivisor = showAverageWidgetValues ? widgetAverageMonthCount : 1;
  const incomeTotal = filteredTransactions.reduce((sum, row) => sum + (row.signedAmount > 0 && row.group !== "investment" ? row.signedAmount : 0), 0);
  const inflowTotal = filteredTransactions.reduce(
    (sum, row) => sum + (row.signedAmount > 0 && row.group !== "investment" ? row.signedAmount : 0),
    0,
  );
  const spendingTotal = sumMoneyOut(filteredTransactions);
  const investingTotal = sumInvesting(filteredTransactions);
  const netResultTotal = sumNetResult(filteredTransactions);
  const incomeAverage = widgetAverageMonthCount > 0 ? incomeTotal / widgetAverageMonthCount : 0;
  const latestCapitalPoint = filteredCapitalSeries.at(-1) ?? data.capitalSeries.at(-1) ?? null;
  const cashBalance = latestCapitalPoint?.availableCash ?? analytics.snapshot.availableCash;
  const spendingWidgetRows = spendingRankings.map((row) => ({
    ...row,
    amount: row.amount / widgetAmountDivisor,
  }));
  const spendingTreemapTiles = useMemo(() => buildSpendingTreemapLayout(spendingWidgetRows), [spendingWidgetRows]);
  const incomeRows = topIncomeSources(filteredTransactions, 5, incomeScopeProfiles).map((row) => ({
    label: row.sourceLabel,
    sourceKind: row.sourceKind,
    sourceValue: row.sourceValue,
    share: inflowTotal > 0 ? (row.amount / inflowTotal) * 100 : 0,
    amount: row.amount / widgetAmountDivisor,
    color: resolveIncomeCategoryScopeTheme(row.sourceValue, incomeScopeProfileMap).solid,
  }));

  const activePreset =
    sameRange(filters.startDate, filters.endDate, allTimeRange.startDate, allTimeRange.endDate) && !filters.activeQuickLabel
      ? "allTime"
      : sameRange(filters.startDate, filters.endDate, thisMonthRange.startDate, thisMonthRange.endDate)
      ? "thisMonth"
      : sameRange(filters.startDate, filters.endDate, lastMonthRange.startDate, lastMonthRange.endDate)
        ? "lastMonth"
        : sameRange(filters.startDate, filters.endDate, yearToDateRange.startDate, yearToDateRange.endDate)
        ? "yearToDate"
        : sameRange(filters.startDate, filters.endDate, lastTwelveRange.startDate, lastTwelveRange.endDate)
            ? "last12"
            : "custom";
  const activeWindowLabel =
    activePreset === "allTime"
      ? "All data"
      : activePreset === "thisMonth"
      ? "This month"
      : activePreset === "lastMonth"
        ? "Last month"
        : activePreset === "yearToDate"
        ? "Year to date"
        : activePreset === "last12"
            ? "Last 12 months"
            : filters.activeQuickLabel || formatDateRange(filters.startDate, filters.endDate);
  const explicitMonthLabel = filters.startDate ? formatMonthTitle(filters.startDate.slice(0, 7)) : activeWindowLabel;
  const contextPeriodLabel = filters.activeQuickLabel || (activePreset === "thisMonth" || activePreset === "lastMonth" ? explicitMonthLabel : activeWindowLabel);
  const kpiScopeNote = activeWindowLabel;
  const kpiAverageNote = monthlyAverage ? `Avg / month over ${monthlyAverage.months} months` : "No months";
  const widgetAverageNote = showAverageWidgetValues ? `Avg / month over ${widgetAverageMonthCount} months` : "";
  const spendingTableRows = spendingWidgetRows.map((row) => ({
    categoryLabel: row.categoryLabel,
    share: row.share,
    amount: row.amount,
    categoryKeys: row.categoryKeys,
  }));
  const incomeTableRows = incomeRows.map((row) => ({
    label: row.label,
    sourceKind: row.sourceKind,
    sourceValue: row.sourceValue,
    share: row.share,
    amount: row.amount,
  }));
  const spendingContextMeta =
    showAverageWidgetValues
      ? `${spendingWidgetRows.length} categories · ${widgetAverageNote}`
      : `${spendingWidgetRows.length} categories`;
  const incomeContextMeta = showAverageWidgetValues ? widgetAverageNote : `${incomeRows.length} sources`;
  const spendingValueLabel = showAverageWidgetValues ? "Out / month" : "Out";
  const incomeValueLabel = showAverageWidgetValues ? "In / month" : "In";
  const spendingBarChartHeight = Math.max(286, spendingWidgetRows.length * 30 + 20);
  const spendingBarRowHeight = spendingWidgetRows.length > 0 ? (spendingBarChartHeight - 8) / spendingWidgetRows.length : 0;

  const metricItems =
    metricViewMode === "average"
      ? [
          { label: "In", value: formatEuro(incomeAverage), note: kpiAverageNote, tone: "positive" as const },
          { label: "Out", value: formatEuro(monthlyAverage?.spending ?? 0), note: kpiAverageNote, tone: "negative" as const },
          { label: "Invested", value: formatEuro(monthlyAverage?.investing ?? 0), note: kpiAverageNote, tone: "accent" as const },
          {
            label: "Net",
            value: formatEuro(monthlyAverage?.netResult ?? 0, { signed: true }),
            note: kpiAverageNote,
            tone: (monthlyAverage?.netResult ?? 0) < 0 ? ("negative" as const) : ("positive" as const),
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

  const buildSummary = (rows: TransactionRecord[]) => {
    const total = rows.reduce((sum, row) => sum + row.signedAmount, 0);
    const allOutflows = rows.length > 0 && rows.every((row) => row.signedAmount <= 0);
    return [
      { label: "Rows", value: rows.length.toLocaleString("en-US") },
      { label: allOutflows ? "Outflow" : "Net amount", value: allOutflows ? formatEuro(Math.abs(total)) : formatEuro(total, { signed: true }) },
      { label: "Range", value: formatDateRange(filters.startDate, filters.endDate) },
    ];
  };

  const inferCategoryDetailTrend = (rows: TransactionRecord[]): DetailTrendView | undefined => {
    if (rows.length === 0) {
      return undefined;
    }

    const categoryKeys = [...new Set(rows.map((row) => row.category).filter(Boolean))];
    if (categoryKeys.length !== 1) {
      return undefined;
    }

    const hasPositive = rows.some((row) => row.signedAmount > 0);
    const hasNegative = rows.some((row) => row.signedAmount < 0);
    if (hasPositive === hasNegative) {
      return undefined;
    }

    const categoryKey = categoryKeys[0];
    const direction = hasNegative ? "outflow" as const : "inflow" as const;
    const historicalRows = data.transactions.filter((row) => {
      if (row.category !== categoryKey || row.monthLabel > detailTrendEndMonth) {
        return false;
      }
      if (direction === "outflow") {
        return row.signedAmount < 0 && row.group !== "investment";
      }
      return row.signedAmount > 0 && row.group !== "investment";
    });

    return buildTransactionDetailTrend(
      historicalRows,
      detailTrendEndMonth,
      direction,
      resolveCategoryTheme(categoryKey).solid,
    );
  };

  const openTransactionDetail = (
    title: string,
    rows: TransactionRecord[],
    meta?: string,
    trend?: DetailTrendView,
    trendCategoryKey?: string,
  ) => {
    setDetail({
      title,
      meta: meta ?? `${rows.length.toLocaleString("en-US")} rows in the current view`,
      summary: buildSummary(rows),
      trend: trend ?? inferCategoryDetailTrend(rows),
      actionHref: trendCategoryKey ? `/spending?category=${encodeURIComponent(trendCategoryKey)}` : undefined,
      actionLabel: trendCategoryKey ? "Open in Trend" : undefined,
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

  const openPortfolioDetail = () => {
    setDetail({
      title: "Portfolio snapshot",
      meta: `Positions as of ${formatAsOfDate(analytics.snapshot.positionsAsOf)}, priced as of ${formatAsOfDate(analytics.snapshot.pricesAsOf.slice(0, 10))}`,
      summary: [
        { label: "Holdings", value: analytics.positions.length.toLocaleString("en-US") },
        { label: "Portfolio value", value: formatEuro(analytics.portfolioValueEur) },
        { label: "Cost basis", value: formatEuro(analytics.costBasisEur) },
      ],
      rows: analytics.positions
        .slice()
        .sort((left, right) => right.marketValueEur - left.marketValueEur)
        .slice(0, 80)
        .map((row) => ({
          instrument: row.instrument,
          coverage: row.coverage,
          costBasis: row.costBasisEur,
          value: row.marketValueEur,
          unrealized: row.unrealizedPnlEur,
        })),
      columns: [
        { key: "instrument", label: "Asset" },
        { key: "coverage", label: "Coverage" },
        { key: "costBasis", label: "Cost basis", render: (value) => <span>{formatEuro(Number(value))}</span> },
        { key: "value", label: "Value", render: (value) => <span>{formatEuro(Number(value))}</span> },
        { key: "unrealized", label: "Unrealized", render: (value) => <SignedAmount value={Number(value)} /> },
      ],
    });
  };

  const openMetricDetail = (label: string) => {
    if (label === "In") return openTransactionDetail("In transactions", filteredTransactions.filter((row) => row.signedAmount > 0 && row.group !== "investment"));
    if (label === "Out") return openTransactionDetail("Out transactions", filteredTransactions.filter((row) => row.signedAmount < 0 && row.group !== "investment"));
    if (label === "Invested") return openTransactionDetail("Investment transactions", filteredTransactions.filter((row) => row.group === "investment"));
    if (label === "Portfolio value") return openPortfolioDetail();
    return openTransactionDetail("All transactions in view", filteredTransactions);
  };

  const openSpendingCategoryDetail = (payload?: SpendingDetailPayload) => {
    if (!payload) return;
    const currentRows = filteredTransactions.filter((row) => row.signedAmount < 0 && payload.categoryKeys.includes(row.category));
    const historicalRows = data.transactions.filter(
      (row) => row.signedAmount < 0 && row.group !== "investment" && row.monthLabel <= detailTrendEndMonth && payload.categoryKeys.includes(row.category),
    );
    openTransactionDetail(
      `${payload.categoryLabel} outflows`,
      currentRows,
      `Category: ${payload.categoryLabel}`,
      buildTransactionDetailTrend(
        historicalRows,
        detailTrendEndMonth,
        "outflow",
        resolveCategoryTheme(payload.categoryKeys[0]).solid,
      ),
      payload.categoryKeys.length === 1 ? payload.categoryKeys[0] : undefined,
    );
  };

  const openIncomeSourceDetail = (payload?: { label: string; sourceKind: "category"; sourceValue: string }) => {
    if (!payload) return;

    const matchingRows = filteredTransactions.filter((row) => {
      if (row.signedAmount <= 0) {
        return false;
      }

      return matchesIncomeCategoryScope(row, payload.sourceValue, incomeScopeProfileMap);
    });

    const historicalRows = data.transactions.filter((row) => {
      if (row.signedAmount <= 0 || row.group === "investment" || row.monthLabel > detailTrendEndMonth) {
        return false;
      }

      return matchesIncomeCategoryScope(row, payload.sourceValue, incomeScopeProfileMap);
    });

    openTransactionDetail(
      `${payload.label} inflows`,
      matchingRows,
      `Source: ${payload.label}`,
      buildTransactionDetailTrend(
        historicalRows,
        detailTrendEndMonth,
        "inflow",
        resolveIncomeCategoryScopeTheme(payload.sourceValue, incomeScopeProfileMap).solid,
      ),
      payload.sourceValue,
    );
  };

  const applyPreset = (preset: "thisMonth" | "lastMonth" | "yearToDate" | "last12") => {
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

  const renderSpendingLabel = ({ x = 0, y = 0, width = 0, height = 0, value, payload, index }: any) => {
    const rowShare = typeof index === "number" ? spendingWidgetRows[index]?.share : undefined;
    const share = Number(rowShare ?? payload?.payload?.share ?? payload?.share ?? 0);
    return (
      <text x={Number(x) + Number(width) + 10} y={Number(y) + Number(height) / 2} fill="hsl(var(--text-muted))" fontSize={12} fontWeight={600} dominantBaseline="middle">
        {`${formatPercent(share)} · ${formatEuro(Number(value ?? 0))}`}
      </text>
    );
  };

  const setWidgetViewMode = (key: HomeWidgetKey, mode: WidgetViewMode) => {
    if (key === "spending" && mode !== "treemap") {
      setHoveredSpendingCategory(null);
    }
    if (key === "spending" && mode !== "visual") {
      setHoveredSpendingRow(null);
    }
    setWidgetViewModes((current) => (current[key] === mode ? current : { ...current, [key]: mode }));
  };

  const renderSpendingViewToggle = () => (
    <div className="panel-view-toggle" aria-label="spending view mode">
      <button
        type="button"
        className="quick-button"
        data-active={widgetViewModes.spending === "visual"}
        onClick={() => setWidgetViewMode("spending", "visual")}
      >
        {WIDGET_VISUAL_LABELS.spending}
      </button>
      <button
        type="button"
        className="quick-button"
        data-active={widgetViewModes.spending === "treemap"}
        onClick={() => setWidgetViewMode("spending", "treemap")}
      >
        Treemap
      </button>
      <button
        type="button"
        className="quick-button"
        data-active={widgetViewModes.spending === "table"}
        onClick={() => setWidgetViewMode("spending", "table")}
      >
        Table
      </button>
    </div>
  );

  const renderWidgetViewToggle = (key: HomeWidgetKey) => (
    <div className="panel-view-toggle" aria-label={`${key} view mode`}>
      <button
        type="button"
        className="quick-button"
        data-active={widgetViewModes[key] === "visual"}
        onClick={() => setWidgetViewMode(key, "visual")}
      >
        {WIDGET_VISUAL_LABELS[key]}
      </button>
      <button
        type="button"
        className="quick-button"
        data-active={widgetViewModes[key] === "table"}
        onClick={() => setWidgetViewMode(key, "table")}
      >
        Table
      </button>
    </div>
  );

  return (
    <DashboardShell kicker="Cashflow" description="Cashflow summary for the selected period." hideHero viewportLocked>
      <section className="home-commandbar">
        <div className="home-commandbar-row">
          <div className="home-commandbar-title"><strong>Cashflow</strong></div>
          <div className="home-period-bar" aria-label="Period presets">
            <button type="button" className="quick-button" data-active={activePreset === "thisMonth"} onClick={() => applyPreset("thisMonth")}>This month</button>
            <button type="button" className="quick-button" data-active={activePreset === "lastMonth"} onClick={() => applyPreset("lastMonth")}>Last month</button>
            <button type="button" className="quick-button" data-active={activePreset === "yearToDate"} onClick={() => applyPreset("yearToDate")}>YTD</button>
            <button type="button" className="quick-button" data-active={activePreset === "last12"} onClick={() => applyPreset("last12")}>12M</button>
            <button type="button" className="quick-button" data-active={activePreset === "allTime"} onClick={applyAllTime}>All</button>
            <button type="button" className="quick-button quick-button-ghost" data-active={showCustomPeriod || activePreset === "custom"} onClick={() => setShowCustomPeriod((current) => !current)}>Custom</button>
          </div>
          <div className="home-commandbar-meta">
            <span className="home-updated">Updated {formatAsOfDate(data.transactions.at(-1)?.date ?? filters.endDate)}</span>
          </div>
        </div>
        <div className="home-kpi-mode" aria-label="cashflow metric mode">
          <span className="home-kpi-mode-label">Metrics</span>
          <div className="home-kpi-mode-buttons">
            <button type="button" className="quick-button" data-active={metricViewMode === "total"} onClick={() => setMetricViewMode("total")}>Totals</button>
            <button type="button" className="quick-button" data-active={metricViewMode === "average"} onClick={() => setMetricViewMode("average")}>Avg / month</button>
          </div>
        </div>
        {showCustomPeriod ? <div className="home-commandbar-custom"><FilterBar dates={dates} filters={filters} onChange={setFilters} /></div> : null}
      </section>

      <ClickableMetricGrid items={metricItems} onSelect={(item) => openMetricDetail(item.label)} />

      <section className="home-primary-grid">
        <Panel title="Out by category" actions={renderSpendingViewToggle()} className="home-panel-fixed home-panel-fixed-primary">
          {spendingRankings.length === 0 ? (
            <div className="empty">No spending categories are available in this view.</div>
          ) : (
            <div className="home-panel-stack">
              <div className="home-panel-context"><strong>{contextPeriodLabel}</strong><span>{spendingContextMeta}</span></div>
              <div className="home-widget-body home-widget-body-primary">
                {widgetViewModes.spending === "visual" ? (
                  <div className="chart-box chart-home-primary home-chart-scroll">
                    <div className="home-chart-scroll-content" style={{ height: spendingBarChartHeight }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={spendingWidgetRows}
                          layout="vertical"
                          margin={{ top: 4, right: 130, left: 0, bottom: 4 }}
                        >
                          <CartesianGrid stroke="rgba(223,231,243,0.06)" horizontal={false} />
                          <XAxis type="number" hide />
                          <YAxis dataKey="categoryLabel" type="category" width={138} tickLine={false} axisLine={false} stroke="hsl(var(--text-muted))" fontSize={12} />
                          <Tooltip
                            cursor={{ fill: "hsla(var(--text), 0.03)" }}
                            content={
                              <ChartTooltipContent
                                formatLabel={(_label, payload) => String(payload?.[0]?.payload?.categoryLabel ?? "")}
                                formatValue={(value, _name, item: any) => [
                                  `${formatEuro(Number(value))} · ${formatPercent(Number(item?.payload?.share ?? 0))}`,
                                  spendingValueLabel,
                                ]}
                              />
                            }
                          />
                          <Bar
                            dataKey="amount"
                            radius={[0, 0, 0, 0]}
                            barSize={18}
                            cursor="pointer"
                          >
                            {spendingWidgetRows.map((entry, index) => <Cell key={`${entry.categoryLabel}-${index}`} fill={entry.color} cursor="pointer" />)}
                            <LabelList dataKey="amount" position="right" content={renderSpendingLabel} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="spending-chart-hit-grid" aria-hidden="true">
                        {spendingWidgetRows.map((row, index) => (
                          <button
                            key={`${row.categoryLabel}-${index}-hit`}
                            type="button"
                            className="spending-chart-row-hit"
                            style={{
                              top: 4 + index * spendingBarRowHeight,
                              height: spendingBarRowHeight,
                            }}
                            onMouseEnter={() => setHoveredSpendingRow(row)}
                            onMouseLeave={() => setHoveredSpendingRow(null)}
                            onClick={() =>
                              openSpendingCategoryDetail({
                                categoryLabel: row.categoryLabel,
                                categoryKeys: row.categoryKeys,
                                amount: row.amount,
                                share: row.share,
                              })
                            }
                          >
                            <span className="sr-only">{`Open ${row.categoryLabel}`}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : widgetViewModes.spending === "treemap" ? (
                  <div className="chart-box chart-home-primary chart-home-treemap">
                    <div className="spending-treemap-board" role="list" aria-label="Spending treemap">
                      {spendingTreemapTiles.map((tile) => {
                        const isHovered = hoveredSpendingCategory === tile.categoryLabel;
                        const isDimmed = Boolean(hoveredSpendingCategory) && !isHovered;
                        const compactAmount = tile.size !== "hero" && tile.size !== "large";
                        const { showLabel, showValue, showShare, labelFontPx, labelLineClamp } = resolveTreemapTileContent(tile);

                        return (
                          <button
                            key={tile.layoutKey}
                            type="button"
                            className="spending-treemap-tile"
                            data-size={tile.size}
                            data-dimmed={isDimmed ? "true" : undefined}
                            style={{
                              left: `${(tile.x / TREEMAP_CANVAS_WIDTH) * 100}%`,
                              top: `${(tile.y / TREEMAP_CANVAS_HEIGHT) * 100}%`,
                              width: `${(tile.width / TREEMAP_CANVAS_WIDTH) * 100}%`,
                              height: `${(tile.height / TREEMAP_CANVAS_HEIGHT) * 100}%`,
                              backgroundColor: tile.color,
                            }}
                            title={`${tile.categoryLabel} · ${formatEuro(tile.amount)} · ${formatPercent(tile.share)}`}
                            onMouseEnter={() => setHoveredSpendingCategory(tile.categoryLabel)}
                            onMouseLeave={() => setHoveredSpendingCategory(null)}
                            onClick={() =>
                              openSpendingCategoryDetail({
                                categoryLabel: tile.categoryLabel,
                                categoryKeys: tile.categoryKeys,
                                amount: tile.amount,
                                share: tile.share,
                              })
                            }
                          >
                            <span className="spending-treemap-tile-inner">
                              {showLabel ? (
                                <strong
                                  className="spending-treemap-tile-label"
                                  style={{
                                    fontSize: `${labelFontPx}px`,
                                    WebkitLineClamp: labelLineClamp,
                                    lineHeight: labelLineClamp === 1 ? 1.12 : 1.14,
                                  }}
                                >
                                  {tile.categoryLabel}
                                </strong>
                              ) : null}
                              {showValue ? <span className="spending-treemap-tile-value">{formatTreemapAmount(tile.amount, compactAmount)}</span> : null}
                              {showShare ? <span className="spending-treemap-tile-share">{formatPercent(tile.share)}</span> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="home-table-panel">
                    <DataTable
                      density="compact"
                      rows={spendingTableRows}
                      onRowClick={(row) =>
                        openSpendingCategoryDetail({
                          categoryLabel: String(row.categoryLabel),
                          categoryKeys: row.categoryKeys as string[],
                          amount: Number(row.amount),
                          share: Number(row.share),
                        })
                      }
                      columns={[
                        {
                          key: "categoryLabel",
                          label: "Category",
                          render: (value) => <span>{String(value)}</span>,
                        },
                        { key: "share", label: "Share", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatPercent(Number(value))}</span> },
                        { key: "amount", label: spendingValueLabel, align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                      ]}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="In by category" actions={renderWidgetViewToggle("income")} className="home-panel-fixed home-panel-fixed-primary">
          {incomeRows.length === 0 ? (
            <div className="empty">No income categories are available in this view.</div>
          ) : (
            <div className="home-panel-stack">
              <div className="home-panel-context"><strong>{contextPeriodLabel}</strong><span>{incomeContextMeta}</span></div>
              <div className="home-widget-body home-widget-body-primary">
                {widgetViewModes.income === "visual" ? (
                  <div className="home-income-pie">
                    <div className="chart-box chart-home-secondary">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Tooltip
                            content={
                              <ChartTooltipContent
                                formatValue={(value, _name, item: any) => [
                                  `${formatEuro(Number(value ?? 0))} · ${formatPercent(Number(item?.payload?.share ?? 0))}`,
                                  incomeValueLabel,
                                ]}
                              />
                            }
                          />
                        <Pie
                          data={incomeRows}
                          dataKey="amount"
                          nameKey="label"
                          innerRadius={68}
                          outerRadius={108}
                          paddingAngle={3}
                          stroke="hsl(var(--bg))"
                          strokeWidth={2}
                          onClick={(entry: any) => {
                            const label = String(entry?.label ?? "");
                            const sourceValue = String(entry?.sourceValue ?? "");
                            const sourceKind = "category" as const;
                            if (label && sourceValue) {
                              openIncomeSourceDetail({ label, sourceKind, sourceValue });
                            }
                          }}
                        >
                          {incomeRows.map((entry) => (
                            <Cell key={`${entry.sourceKind}-${entry.sourceValue}`} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="income-legend-list">
                    {incomeRows.map((row) => (
                      <button
                        key={`${row.sourceKind}-${row.sourceValue}`}
                        type="button"
                        className="income-legend-row"
                        onClick={() => openIncomeSourceDetail(row)}
                      >
                        <span className="income-legend-main">
                          <span className="income-legend-dot" style={{ backgroundColor: row.color }} />
                          <strong>{row.label}</strong>
                        </span>
                        <span className="income-legend-meta">
                          <small>{formatPercent(row.share)}</small>
                          <span>{formatEuro(row.amount)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="home-table-panel">
                    <DataTable
                      density="compact"
                      rows={incomeTableRows}
                      onRowClick={(row) =>
                        openIncomeSourceDetail({
                          label: String(row.label),
                          sourceKind: "category",
                          sourceValue: String(row.sourceValue),
                        })
                      }
                    columns={[
                      {
                        key: "label",
                        label: "Source",
                        render: (value) => <span>{String(value)}</span>,
                      },
                        { key: "share", label: "Share", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatPercent(Number(value))}</span> },
                        { key: "amount", label: incomeValueLabel, align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                      ]}
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
