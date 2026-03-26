"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AccountsData } from "@/lib/accounts-data";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  averageMonthlyStory,
  annotateMonthLabel,
  applyCapitalFilters,
  applyTransactionFilters,
  buildQuickYearRanges,
  createInitialFilterState,
  formatAsOfDate,
  formatDateRange,
  formatDisplayDate,
  formatEuro,
  formatMonthTitle,
  formatPercent,
  incompleteMonthLabels,
  resolvePeriodBounds,
  SPENDING_BUCKETS,
  sumInvesting,
  sumMoneyIn,
  sumMoneyOut,
  sumNetResult,
  summarizeMonthlyStory,
  topIncomeSources,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import { buildInvestmentAnalytics } from "@/lib/investment-performance";
import { CATEGORY_THEME } from "@/lib/category-config";
import type { DetailView } from "./dashboard-ui";
import { ChartTooltipContent, ClickableMetricGrid, DashboardShell, DataTable, DetailSheet, FilterBar, Panel, SignedAmount, defaultFilterState } from "./dashboard-ui";

const CATEGORY_COLORS = [
  "hsl(var(--accent-primary))",
  "hsl(var(--accent-secondary))",
  "hsl(var(--accent-tertiary))",
  "hsl(var(--accent-quaternary))",
  "hsl(280 100% 70%)",
  "hsl(190 100% 50%)",
  "hsl(150 100% 50%)",
];
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
const TREEMAP_TAIL_TARGET_COUNT = 4;

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
type HomeWidgetKey = "spending" | "trend" | "income";
type MetricViewMode = "total" | "average";
const HOME_TREND_MONTHS = 12;
const WIDGET_VISUAL_LABELS: Record<HomeWidgetKey, string> = {
  spending: "Bar chart",
  trend: "Trend",
  income: "Donut",
};

type SpendingDetailPayload = Pick<SpendingRankEntry, "categoryLabel" | "categoryKeys" | "amount" | "share">;
type TrendMonthPayload = {
  monthLabel?: string;
  displayMonthLabel?: string;
};
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

function buildSpendingRankings(transactions: TransactionRecord[]): SpendingRankEntry[] {
  const totals = new Map<string, { categoryLabel: string; amount: number }>();
  for (const row of transactions) {
    if (!SPENDING_BUCKETS.has(row.cashflowBucket) || row.signedAmount >= 0) continue;
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
    color: CATEGORY_THEME[row.categoryKeys[0]]?.solid ?? CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    treemapWeight: Math.max(balancedWeights[index] ?? 0, balancedFloor),
  }));
}

function formatTreemapAmount(amount: number, compact: boolean) {
  if (!compact) return formatEuro(amount);
  return TREEMAP_EURO_FORMATTER.format(amount);
}

function splitSpendingTreemapColumns(rows: SpendingRankEntry[]) {
  if (rows.length <= 3) {
    return [rows];
  }

  if (rows.length <= 6) {
    return [rows.slice(0, 2), rows.slice(2)];
  }

  const leadCount = 2;
  const tailCount = Math.min(TREEMAP_TAIL_TARGET_COUNT, Math.max(3, rows.length - leadCount - 1));
  const middleCount = Math.max(0, rows.length - leadCount - tailCount);
  const groups = [
    rows.slice(0, leadCount),
    rows.slice(leadCount, leadCount + middleCount),
    rows.slice(leadCount + middleCount),
  ].filter((group) => group.length > 0);

  return groups;
}

function buildTreemapColumnShares(groups: SpendingRankEntry[][]) {
  const baseWeights = groups.map((group) => group.reduce((sum, row) => sum + row.treemapWeight, 0));
  if (baseWeights.length === 1) {
    return [1];
  }

  const floorShares =
    baseWeights.length === 2
      ? [0.46, 0.34]
      : [0.36, 0.22, 0.28].slice(0, baseWeights.length);
  const floored = baseWeights.map((weight, index) => Math.max(weight, floorShares[index] ?? 0));
  const total = floored.reduce((sum, weight) => sum + weight, 0) || 1;
  return floored.map((weight) => weight / total);
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

function buildSpendingTreemapLayout(rows: SpendingRankEntry[]): SpendingTreemapTile[] {
  if (rows.length === 0) {
    return [];
  }

  const groups = splitSpendingTreemapColumns(rows);
  const columnShares = buildTreemapColumnShares(groups);
  const usableWidth = TREEMAP_CANVAS_WIDTH - TREEMAP_TILE_GAP * Math.max(0, groups.length - 1);
  const layout: SpendingTreemapTile[] = [];
  let currentX = 0;

  groups.forEach((group, groupIndex) => {
    const isLastColumn = groupIndex === groups.length - 1;
    const rawWidth = usableWidth * (columnShares[groupIndex] ?? 0);
    const columnWidth = isLastColumn
      ? TREEMAP_CANVAS_WIDTH - currentX
      : Math.max(96, Math.round(rawWidth));
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
  const [hoveredTrendMonth, setHoveredTrendMonth] = useState<TrendMonthPayload | null>(null);
  const [widgetViewModes, setWidgetViewModes] = useState<Record<HomeWidgetKey, WidgetViewMode>>({
    spending: "visual",
    trend: "visual",
    income: "visual",
  });

  const filteredTransactions = applyTransactionFilters(data.transactions, filters);
  const filteredCapitalSeries = applyCapitalFilters(data.capitalSeries, filters);
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
        registry: data.instrumentRegistry,
      }),
    [
      data.capitalSeries,
      data.historicalMarketSeries,
      data.historicalUnitEstimates,
      data.instrumentRegistry,
      data.liveQuotes,
      data.positionUnitOverrides,
      data.transactions,
      filters.endDate,
      filters.startDate,
    ],
  );

  const partialMonths = incompleteMonthLabels(filters);
  const thisMonthRange = resolvePeriodBounds(dates, "thisMonth");
  const lastMonthRange = resolvePeriodBounds(dates, "lastMonth");
  const yearToDateRange = resolvePeriodBounds(dates, "yearToDate");
  const lastTwelveRange = resolvePeriodBounds(dates, "last12");
  const allTimeRange = resolvePeriodBounds(dates, "allTime");
  const filterStartMonth = filters.startDate.slice(0, 7);
  const filterEndMonth = filters.endDate.slice(0, 7);
  const allMonthly = summarizeMonthlyStory(data.transactions);
  const visibleMonthly = allMonthly.filter((row) => row.monthLabel >= filterStartMonth && row.monthLabel <= filterEndMonth);
  const useRecentContextTrend = visibleMonthly.length < 2;
  const trendSource = useRecentContextTrend ? allMonthly.filter((row) => row.monthLabel <= filterEndMonth) : visibleMonthly;
  const recentMonthly = trendSource.slice(-HOME_TREND_MONTHS).map((row) => ({ ...row, displayMonthLabel: annotateMonthLabel(row.monthLabel, filters) }));
  const spendingRankings = buildSpendingRankings(filteredTransactions);
  const monthlyAverage = averageMonthlyStory(filteredTransactions);
  const widgetAverageMonthCount = monthlyAverage?.months ?? 0;
  const showAverageWidgetValues = metricViewMode === "average" && widgetAverageMonthCount > 0;
  const widgetAmountDivisor = showAverageWidgetValues ? widgetAverageMonthCount : 1;
  const incomeTotal = sumMoneyIn(filteredTransactions);
  const spendingTotal = sumMoneyOut(filteredTransactions);
  const investingTotal = sumInvesting(filteredTransactions);
  const netResultTotal = sumNetResult(filteredTransactions);
  const latestCapitalPoint = filteredCapitalSeries.at(-1) ?? data.capitalSeries.at(-1) ?? null;
  const cashBalance = latestCapitalPoint?.availableCash ?? analytics.snapshot.availableCash;
  const spendingWidgetRows = spendingRankings.map((row) => ({
    ...row,
    amount: row.amount / widgetAmountDivisor,
  }));
  const spendingTreemapTiles = useMemo(() => buildSpendingTreemapLayout(spendingWidgetRows), [spendingWidgetRows]);
  const incomeRows = topIncomeSources(filteredTransactions, 5).map((row) => ({
    label: row.sourceLabel,
    sourceKind: row.sourceKind,
    sourceValue: row.sourceValue,
    share: incomeTotal > 0 ? (row.amount / incomeTotal) * 100 : 0,
    amount: row.amount / widgetAmountDivisor,
    color: CATEGORY_COLORS[row.sourceLabel.length % CATEGORY_COLORS.length],
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
  const kpiAverageNote = monthlyAverage ? `Avg / month over ${monthlyAverage.months} visible months` : "No visible months";
  const widgetAverageNote = showAverageWidgetValues ? `Avg / month over ${widgetAverageMonthCount} visible months` : "";
  const topStatus = filters.excludeIncompleteMonths
    ? "Partial hidden"
    : partialMonths.length > 0
      ? `Partial · ${partialMonths.length === 1 ? partialMonths[0] : `${partialMonths.length} months`}`
      : "";
  const trendTitle = useRecentContextTrend ? `Last ${recentMonthly.length} months to ${explicitMonthLabel}` : `Last ${recentMonthly.length} visible months`;
  const spendingTableRows = spendingWidgetRows.map((row) => ({
    categoryLabel: row.categoryLabel,
    share: row.share,
    amount: row.amount,
    categoryKeys: row.categoryKeys,
  }));
  const monthlyTableRows = recentMonthly
    .map((row) => ({
      monthLabel: row.monthLabel,
      displayMonthLabel: row.displayMonthLabel,
      cashIn: row.cashIn,
      cashOut: row.cashOut,
      investing: row.investing,
      netResult: row.netResult,
    }))
    .reverse();
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
      : `${spendingWidgetRows.length} visible categories`;
  const incomeContextMeta = showAverageWidgetValues ? widgetAverageNote : `${incomeRows.length} visible sources`;
  const spendingValueLabel = showAverageWidgetValues ? "Out / month" : "Out";
  const incomeValueLabel = showAverageWidgetValues ? "In / month" : "In";
  const trendContextMeta = showAverageWidgetValues ? "Month-by-month actuals" : "In, out, invested, and net";

  const metricItems =
    metricViewMode === "average"
      ? [
          { label: "In", value: formatEuro(monthlyAverage?.income ?? 0), note: kpiAverageNote, tone: "positive" as const },
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
          date: formatDisplayDate(row.date),
          merchant: row.displayMerchant,
          category: row.categoryLabel,
          amount: row.signedAmount,
        })),
      columns: [
        { key: "date", label: "Date" },
        { key: "merchant", label: "Merchant" },
        { key: "category", label: "Category" },
        { key: "amount", label: "Amount", render: (value) => <SignedAmount value={Number(value)} /> },
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
    if (label === "In") return openTransactionDetail("In transactions", filteredTransactions.filter((row) => row.signedAmount > 0));
    if (label === "Out") return openTransactionDetail("Out transactions", filteredTransactions.filter((row) => row.signedAmount < 0));
    if (label === "Invested") return openTransactionDetail("Investment transactions", filteredTransactions.filter((row) => row.group === "investment"));
    if (label === "Portfolio value") return openPortfolioDetail();
    return openTransactionDetail("All transactions in view", filteredTransactions);
  };

  const openSpendingCategoryDetail = (payload?: SpendingDetailPayload) => {
    if (!payload) return;
    openTransactionDetail(
      `${payload.categoryLabel} expenses`,
      filteredTransactions.filter((row) => SPENDING_BUCKETS.has(row.cashflowBucket) && payload.categoryKeys.includes(row.category)),
      `Category: ${payload.categoryLabel}`,
    );
  };

  const openIncomeSourceDetail = (payload?: { label: string; sourceKind: "merchant" | "category"; sourceValue: string }) => {
    if (!payload) return;

    const matchingRows = filteredTransactions.filter((row) => {
      if (row.group !== "income" || row.signedAmount <= 0) {
        return false;
      }

      return payload.sourceKind === "category" ? row.category === payload.sourceValue : row.displayMerchant === payload.sourceValue;
    });

    openTransactionDetail(`${payload.label} income`, matchingRows, `Source: ${payload.label}`);
  };

  const openTrendMonthDetail = (payload?: TrendMonthPayload | null) => {
    const monthLabel = payload?.monthLabel;
    if (!monthLabel) return;
    const displayMonthLabel = payload?.displayMonthLabel ?? monthLabel;
    openTransactionDetail(
      `Transactions in ${displayMonthLabel}`,
      filteredTransactions.filter((row) => row.monthLabel === monthLabel),
      `Month: ${displayMonthLabel}`,
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
    <DashboardShell kicker="Cashflow" description="Cashflow summary for the selected period." hideHero>
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
            {topStatus ? <span className="home-status-pill">{topStatus}</span> : null}
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
                  <div className="chart-box chart-home-primary">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={spendingWidgetRows}
                        layout="vertical"
                        margin={{ top: 4, right: 130, left: 0, bottom: 4 }}
                        onClick={(state) => openSpendingCategoryDetail(getActiveChartPayload<SpendingDetailPayload>(state as ActiveChartState<SpendingDetailPayload>))}
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
                  </div>
                ) : widgetViewModes.spending === "treemap" ? (
                  <div className="chart-box chart-home-primary chart-home-treemap">
                    <div className="spending-treemap-board" role="list" aria-label="Spending treemap">
                      {spendingTreemapTiles.map((tile) => {
                        const isHovered = hoveredSpendingCategory === tile.categoryLabel;
                        const isDimmed = Boolean(hoveredSpendingCategory) && !isHovered;
                        const compactAmount = tile.size !== "hero" && tile.size !== "large";

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
                              <strong className="spending-treemap-tile-label">{tile.categoryLabel}</strong>
                              <span className="spending-treemap-tile-value">{formatTreemapAmount(tile.amount, compactAmount)}</span>
                              <span className="spending-treemap-tile-share">{formatPercent(tile.share)}</span>
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

        <Panel title="Income sources" actions={renderWidgetViewToggle("income")} className="home-panel-fixed home-panel-fixed-primary">
          {incomeRows.length === 0 ? (
            <div className="empty">No income sources in this view.</div>
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
                            const sourceKind = entry?.sourceKind === "category" ? "category" : "merchant";
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
                          sourceKind: row.sourceKind === "category" ? "category" : "merchant",
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

      <section className="home-secondary-grid home-secondary-grid-single">
        <Panel title="Monthly trend" actions={renderWidgetViewToggle("trend")} className="home-panel-fixed home-panel-fixed-trend">
          {recentMonthly.length === 0 ? (
            <div className="empty">No monthly trend is available in this view.</div>
          ) : (
            <div className="home-panel-stack">
              <div className="home-panel-context"><strong>{trendTitle}</strong><span>{trendContextMeta}</span></div>
              <div className="home-widget-body home-widget-body-trend">
                {widgetViewModes.trend === "visual" ? (
                  <div className="chart-box chart-home-trend-wide chart-box-interactive">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={recentMonthly}
                        onMouseMove={(state: any) => {
                          const payload = getActiveChartPayload<TrendMonthPayload>(state as ActiveChartState<TrendMonthPayload>);
                          setHoveredTrendMonth(payload?.monthLabel ? payload : null);
                        }}
                        onMouseLeave={() => setHoveredTrendMonth(null)}
                        onClick={(state: any) => {
                          const payload = getActiveChartPayload<TrendMonthPayload>(state as ActiveChartState<TrendMonthPayload>) ?? hoveredTrendMonth;
                          openTrendMonthDetail(payload);
                        }}
                      >
                        <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
                        <XAxis dataKey="displayMonthLabel" stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} dy={8} minTickGap={16} />
                        <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
                        <Tooltip
                          cursor={{ fill: "hsla(var(--text), 0.03)" }}
                          content={
                            <ChartTooltipContent
                              formatLabel={(label) => String(label ?? "")}
                              formatValue={(value) => formatEuro(Number(value ?? 0))}
                            />
                          }
                        />
                        <Legend iconType="circle" wrapperStyle={{ paddingTop: "12px" }} />
                        <Bar dataKey="cashIn" name="In" fill="hsl(var(--accent-primary))" barSize={18} cursor="pointer" />
                        <Bar dataKey="cashOut" name="Out" fill="hsl(var(--accent-secondary))" barSize={18} cursor="pointer" />
                        <Bar dataKey="investing" name="Invested" fill="hsl(var(--accent-tertiary))" barSize={18} cursor="pointer" />
                        <Line type="monotone" dataKey="netResult" name="Net" stroke="hsl(var(--accent-quaternary))" strokeWidth={3} cursor="pointer" dot={{ r: 4, fill: "hsl(var(--accent-quaternary))", strokeWidth: 2, stroke: "hsl(var(--bg))" }} activeDot={{ r: 6, strokeWidth: 0 }} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="home-table-panel">
                    <DataTable
                      density="compact"
                      rows={monthlyTableRows}
                      onRowClick={(row) =>
                        openTrendMonthDetail({
                          monthLabel: String(row.monthLabel),
                          displayMonthLabel: String(row.displayMonthLabel),
                        })
                      }
                      columns={[
                        {
                          key: "displayMonthLabel",
                          label: "Month",
                          render: (value) => <span>{String(value)}</span>,
                        },
                        { key: "cashIn", label: "In", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                        { key: "cashOut", label: "Out", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                        { key: "investing", label: "Invested", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                        { key: "netResult", label: "Net", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
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
