"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountsData } from "@/lib/accounts-data";
import {
  createInitialFilterState,
  formatAsOfDate,
  formatDateRange,
  formatDisplayDate,
  formatEuro,
  resolvePeriodBounds,
  uniqueTransactionDates,
  type FilterState,
} from "@/lib/dashboard-utils";
import type {
  HistoricalPriceSeries,
  PortfolioHistoryPoint,
  PositionPerformanceRecord,
} from "@/lib/investment-performance";
import { buildInvestmentAnalytics, historicalPriceOnOrBefore } from "@/lib/investment-performance";
import { extractInvestmentTrades, resolveInstrument } from "@/lib/investment-positions";
import type { DetailTrendView, DetailView, TableColumn, TableSortState } from "./dashboard-ui";
import {
  CategoryEditor,
  ChartTooltipContent,
  DashboardShell,
  DataTable,
  DetailSheet,
  FilterBar,
  MetricGrid,
  Panel,
  PositionHoldingEditor,
  SignedAmount,
} from "./dashboard-ui";

type PortfolioTrendGranularity = "month" | "year";
type PortfolioTrendViewMode = "visual" | "table";
type PortfolioComponentsViewMode = "grouped" | "detailed" | "table";

type PortfolioTrendRow = {
  periodKey: string;
  displayLabel: string;
  date: string;
  marketValueEur: number;
  cashValueEur: number;
  totalValueEur: number;
  costBasisEur: number;
  periodReturnPct: number | null;
  unrealizedPnlEur: number;
  realizedPnlEur: number;
  dividendsEur: number;
  componentValues: Record<string, number>;
};

type HoldingRow = {
  kind: "position" | "cash";
  instrumentKey: string;
  isin: string;
  instrument: string;
  assetClass: string;
  units: number;
  unitsKnown: boolean;
  effectiveDate: string;
  priceEur: number;
  priceScale: "absolute" | "percent_of_par";
  marketValueEur: number;
  costBasisEur: number;
  unrealizedPnlEur: number;
  returnPct: number;
  share: number;
  color: string;
  valuationSource: string;
  valuationSourceLabel: string;
  valuationAsOf: string;
};

type PortfolioComponentGroupRow = {
  componentKey: string;
  label: string;
  note: string;
  marketValueEur: number;
  share: number;
  color: string;
  rows: HoldingRow[];
  kind: "assetClass" | "cash";
};

const PORTFOLIO_COLORS = [
  "hsl(350 76% 63%)",
  "hsl(196 78% 64%)",
  "hsl(42 90% 60%)",
  "hsl(168 54% 56%)",
  "hsl(260 72% 69%)",
  "hsl(132 50% 54%)",
  "hsl(18 82% 62%)",
  "hsl(212 22% 72%)",
  "hsl(88 56% 56%)",
  "hsl(316 60% 61%)",
];
const CASH_COMPONENT_KEY = "__cash__";
const CASH_COMPONENT_COLOR = "hsl(212 20% 72%)";
const PORTFOLIO_VALUE_COLOR = "hsl(208 88% 66%)";
const COST_BASIS_COLOR = "hsl(276 78% 68%)";
const COMPONENT_COLOR_MAP: Record<string, string> = {
  cash: CASH_COMPONENT_COLOR,
  etf: "hsl(350 72% 62%)",
  bond_etf: "hsl(18 78% 60%)",
  gold: "hsl(42 92% 58%)",
  crypto: "hsl(170 54% 54%)",
  stock: "hsl(132 50% 54%)",
  bond: "hsl(88 48% 58%)",
  private_market: "hsl(302 52% 60%)",
  other: "hsl(264 60% 67%)",
};
const COMPONENT_ORDER = ["etf", "stock", "crypto", "gold", "bond_etf", "bond", "private_market", "other", "cash"];

const detailTrendPeriodFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

const portfolioTableSortCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

function sameRange(startDate: string, endDate: string, nextStartDate: string, nextEndDate: string) {
  return startDate === nextStartDate && endDate === nextEndDate;
}

function formatPercent(value: number) {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function buildPortfolioRangeIncreaseSummary(rows: PortfolioTrendRow[]) {
  const orderedRows = rows.slice().sort((left, right) => left.date.localeCompare(right.date));
  const startPoint = orderedRows[0] ?? null;
  const endPoint = orderedRows.at(-1) ?? null;
  if (!startPoint || !endPoint) {
    return {
      increasePct: null,
      increaseEur: null,
      startValueEur: null,
      endValueEur: null,
    };
  }

  const increaseEur = endPoint.totalValueEur - startPoint.totalValueEur;
  return {
    increasePct:
      Math.abs(startPoint.totalValueEur) > 0.0000001
        ? (increaseEur / startPoint.totalValueEur) * 100
        : Math.abs(increaseEur) <= 0.0000001
          ? 0
          : null,
    increaseEur,
    startValueEur: startPoint.totalValueEur,
    endValueEur: endPoint.totalValueEur,
  };
}

function buildPortfolioIncreaseRows(rows: PortfolioTrendRow[]) {
  const orderedRows = rows.slice().sort((left, right) => left.date.localeCompare(right.date));
  let previousRow: PortfolioTrendRow | null = null;

  return orderedRows.map((row) => {
    const increasePct =
      previousRow && Math.abs(previousRow.totalValueEur) > 0.0000001
        ? ((row.totalValueEur - previousRow.totalValueEur) / previousRow.totalValueEur) * 100
        : previousRow
          ? 0
          : null;
    previousRow = row;

    return {
      ...row,
      periodReturnPct: increasePct,
    };
  });
}

function comparePortfolioValues(left: unknown, right: unknown) {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return portfolioTableSortCollator.compare(String(left), String(right));
}

function buildPortfolioHistoryRows(history: PortfolioHistoryPoint[], filters: FilterState) {
  let previousRealized = 0;
  let previousDividends = 0;

  const monthlyRows = history
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((point) => {
      const realizedPnlEur = point.realizedPnlEur - previousRealized;
      const dividendsEur = point.dividendIncomeEur - previousDividends;
      previousRealized = point.realizedPnlEur;
      previousDividends = point.dividendIncomeEur;

      const periodKey = point.date.slice(0, 7);
      return {
        periodKey,
        displayLabel: detailTrendPeriodFormatter.format(new Date(`${periodKey}-01T00:00:00Z`)),
        date: point.date,
        marketValueEur: point.marketValueEur,
        cashValueEur: point.cashValueEur,
        totalValueEur: point.totalValueEur,
        costBasisEur: point.costBasisEur,
        periodReturnPct: null,
        unrealizedPnlEur: point.marketValueEur - point.costBasisEur,
        realizedPnlEur,
        dividendsEur,
        componentValues: point.componentValues,
      } satisfies PortfolioTrendRow;
    })
    .filter((row) => row.date >= filters.startDate && row.date <= filters.endDate);

  const yearlyRows = Array.from(
    monthlyRows.reduce((accumulator, row) => {
      const yearKey = row.periodKey.slice(0, 4);
      const current = accumulator.get(yearKey) ?? {
        periodKey: yearKey,
        displayLabel: yearKey,
        date: row.date,
        marketValueEur: row.marketValueEur,
        cashValueEur: row.cashValueEur,
        totalValueEur: row.totalValueEur,
        costBasisEur: row.costBasisEur,
        periodReturnPct: null,
        unrealizedPnlEur: row.unrealizedPnlEur,
        realizedPnlEur: 0,
        dividendsEur: 0,
        componentValues: row.componentValues,
      };

      current.date = row.date;
      current.marketValueEur = row.marketValueEur;
      current.cashValueEur = row.cashValueEur;
      current.totalValueEur = row.totalValueEur;
      current.costBasisEur = row.costBasisEur;
      current.unrealizedPnlEur = row.unrealizedPnlEur;
      current.realizedPnlEur += row.realizedPnlEur;
      current.dividendsEur += row.dividendsEur;
      current.componentValues = row.componentValues;
      accumulator.set(yearKey, current);
      return accumulator;
    }, new Map<string, PortfolioTrendRow>()),
  )
    .map(([, row]) => row)
    .sort((left, right) => left.periodKey.localeCompare(right.periodKey));

  return { monthlyRows, yearlyRows };
}

function buildPortfolioDetailTrend(
  rows: PortfolioTrendRow[],
  selectedPeriodKey: string,
  granularity: PortfolioTrendGranularity,
): DetailTrendView | undefined {
  const selectedIndex = rows.findIndex((row) => row.periodKey === selectedPeriodKey);
  if (selectedIndex === -1) {
    return undefined;
  }

  const slice = rows.slice(Math.max(0, selectedIndex - 11), selectedIndex + 1);
  if (slice.length === 0) {
    return undefined;
  }

  return {
    title: "Total value trend",
    note:
      granularity === "year"
        ? `Last ${slice.length} ${slice.length === 1 ? "year" : "years"}`
        : `Last ${slice.length} ${slice.length === 1 ? "month" : "months"}`,
    valueLabel: "Total value",
    color: PORTFOLIO_VALUE_COLOR,
    data: slice.map((row) => ({
      monthLabel: row.periodKey,
      displayMonthLabel: row.displayLabel,
      value: row.totalValueEur,
    })),
  };
}

function normalizeComponentKey(assetClass: string) {
  return assetClass.trim().toLowerCase().replaceAll(" ", "_");
}

function buildHoldingRows(
  positions: PositionPerformanceRecord[],
  colorMap: Map<string, string>,
  cashBalanceEur: number,
  historicalSeries?: HistoricalPriceSeries,
  valuationDate?: string,
) {
  const valuedRows: HoldingRow[] = positions
    .map((row) => {
      const historicalPrice =
        valuationDate ? historicalPriceOnOrBefore(historicalSeries?.[row.instrumentKey] ?? {}, valuationDate) : null;
      const marketValueEur =
        historicalPrice && row.unitsKnown && row.valuationSource === "live_quote"
          ? (row.priceScale === "percent_of_par" ? historicalPrice * row.units : historicalPrice * row.units)
          : row.marketValueEur;
      const unrealizedPnlEur = marketValueEur - row.costBasisEur;
      const returnPct =
        row.grossInvestedEur > 0
          ? ((unrealizedPnlEur + row.realizedPnlAllTimeEur + row.dividendIncomeAllTimeEur) / row.grossInvestedEur) * 100
          : 0;

      return {
        kind: "position",
        instrumentKey: row.instrumentKey,
        isin: row.isin,
        instrument: row.instrument,
        assetClass: row.assetClass.toUpperCase().replaceAll("_", " "),
        units: row.units,
        unitsKnown: row.unitsKnown,
        effectiveDate: valuationDate ?? row.valuationAsOf.slice(0, 10) ?? row.asOf.slice(0, 10),
        priceEur: historicalPrice && row.valuationSource === "live_quote" ? historicalPrice : row.priceEur,
        priceScale: row.priceScale,
        marketValueEur,
        costBasisEur: row.costBasisEur,
        unrealizedPnlEur,
        returnPct,
        share: 0,
        color: colorMap.get(row.instrumentKey) ?? PORTFOLIO_COLORS[0],
        valuationSource: row.valuationSource,
        valuationSourceLabel: row.valuationSourceLabel,
        valuationAsOf: valuationDate ?? row.valuationAsOf,
      } satisfies HoldingRow;
    })
    .sort((left, right) => right.marketValueEur - left.marketValueEur);

  if (cashBalanceEur > 0.0000001) {
    valuedRows.push({
      kind: "cash",
      instrumentKey: CASH_COMPONENT_KEY,
      isin: "",
      instrument: "Cash",
      assetClass: "CASH",
      units: 0,
      unitsKnown: true,
      effectiveDate: valuationDate ?? "",
      priceEur: cashBalanceEur,
      priceScale: "absolute",
      marketValueEur: cashBalanceEur,
      costBasisEur: 0,
      unrealizedPnlEur: 0,
      returnPct: 0,
      share: 0,
      color: CASH_COMPONENT_COLOR,
      valuationSource: "cost_basis",
      valuationSourceLabel: "Cash",
      valuationAsOf: valuationDate ?? "",
    });
    valuedRows.sort((left, right) => right.marketValueEur - left.marketValueEur);
  }

  const totalMarketValueEur = valuedRows.reduce((sum, row) => sum + row.marketValueEur, 0);
  return valuedRows.map((row) => ({
    ...row,
    share: totalMarketValueEur > 0 ? (row.marketValueEur / totalMarketValueEur) * 100 : 0,
  }));
}

function formatComponentLabel(assetClass: string) {
  switch (assetClass) {
    case "cash":
      return "Cash";
    case "crypto":
      return "Crypto";
    case "gold":
      return "Commodity";
    case "bond_etf":
      return "ETF";
    case "bond":
      return "Bonds";
    case "private_market":
      return "Private markets";
    case "stock":
      return "Stocks";
    case "etf":
      return "ETF";
    default:
      return assetClass.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
  }
}

function componentColorForKey(componentKey: string) {
  return COMPONENT_COLOR_MAP[componentKey] ?? PORTFOLIO_COLORS[0];
}

function buildPortfolioComponentGroups(rows: HoldingRow[]): PortfolioComponentGroupRow[] {
  const totalValueEur = rows.reduce((sum, row) => sum + row.marketValueEur, 0);
  const groups = new Map<
    string,
    {
      componentKey: string;
      label: string;
      marketValueEur: number;
      color: string;
      rows: HoldingRow[];
      kind: "assetClass" | "cash";
    }
  >();

  for (const row of rows) {
    const isCash = row.kind === "cash";
    const componentKey = isCash ? "cash" : normalizeComponentKey(row.assetClass);
    const current = groups.get(componentKey) ?? {
      componentKey,
      label: formatComponentLabel(componentKey),
      marketValueEur: 0,
      color: componentColorForKey(componentKey),
      rows: [],
      kind: isCash ? ("cash" as const) : ("assetClass" as const),
    };

    current.marketValueEur += row.marketValueEur;
    current.rows.push(row);
    groups.set(componentKey, current);
  }

  return [...groups.values()]
    .map((group) => ({
      componentKey: group.componentKey,
      label: group.label,
      note:
        group.kind === "cash"
          ? "Available balance"
          : `${group.rows.length} ${group.rows.length === 1 ? "holding" : "holdings"}`,
      marketValueEur: group.marketValueEur,
      share: totalValueEur > 0 ? (group.marketValueEur / totalValueEur) * 100 : 0,
      color: group.color,
      rows: group.rows,
      kind: group.kind,
    }))
    .sort((left, right) => right.marketValueEur - left.marketValueEur);
}

export function PortfolioDashboard({ data }: { data: AccountsData }) {
  const dates = uniqueTransactionDates(data.transactions);
  const [filters, setFilters] = useState(() => createInitialFilterState(dates, "last12"));
  const [baseFilters, setBaseFilters] = useState(() => createInitialFilterState(dates, "last12"));
  const [showCustomPeriod, setShowCustomPeriod] = useState(false);
  const [trendGranularity, setTrendGranularity] = useState<PortfolioTrendGranularity>("month");
  const [trendViewMode, setTrendViewMode] = useState<PortfolioTrendViewMode>("visual");
  const [componentsViewMode, setComponentsViewMode] = useState<PortfolioComponentsViewMode>("grouped");
  const [selectedTrendPeriodKey, setSelectedTrendPeriodKey] = useState("");
  const [holdingsSort, setHoldingsSort] = useState<TableSortState>({
    key: "marketValueEur",
    direction: "desc",
  });
  const [detail, setDetail] = useState<DetailView | null>(null);

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
      data.transactions,
      filters.endDate,
      filters.startDate,
    ],
  );

  const filteredTransactions = useMemo(
    () => data.transactions.filter((row) => row.date >= filters.startDate && row.date <= filters.endDate),
    [data.transactions, filters.endDate, filters.startDate],
  );
  const investmentTradeMap = useMemo(
    () => new Map(extractInvestmentTrades(data.transactions, data.instrumentRegistry).map((row) => [row.rowId, row])),
    [data.instrumentRegistry, data.transactions],
  );
  const transactionInstrumentKeyMap = useMemo(
    () =>
      new Map(
        data.transactions.map((row) => {
          if (row.group === "investment") {
            return [row.rowId, investmentTradeMap.get(row.rowId)?.instrumentKey ?? ""] as const;
          }
          if (row.category === "interest_dividend" && row.signedAmount > 0) {
            return [row.rowId, resolveInstrument(row.description, data.instrumentRegistry).key] as const;
          }
          return [row.rowId, ""] as const;
        }),
      ),
    [data.instrumentRegistry, data.transactions, investmentTradeMap],
  );

  const { monthlyRows, yearlyRows } = useMemo(() => buildPortfolioHistoryRows(analytics.history, filters), [analytics.history, filters]);
  const monthlyTrendRows = useMemo(() => buildPortfolioIncreaseRows(monthlyRows), [monthlyRows]);
  const yearlyTrendRows = useMemo(() => buildPortfolioIncreaseRows(yearlyRows), [yearlyRows]);
  const trendRows = trendGranularity === "year" ? yearlyTrendRows : monthlyTrendRows;
  const trendPeriodLookup = new Map(trendRows.map((row) => [row.displayLabel, row]));
  const selectedTrendRow = trendRows.find((row) => row.periodKey === selectedTrendPeriodKey) ?? null;

  useEffect(() => {
    if (selectedTrendPeriodKey && !selectedTrendRow) {
      setSelectedTrendPeriodKey("");
    }
  }, [selectedTrendPeriodKey, selectedTrendRow]);

  const cashBalance = analytics.snapshot.availableCash;
  const totalValueEur = analytics.snapshot.totalMarketValue;

  const historicalHoldingsAnalytics = useMemo(() => {
    if (!selectedTrendRow) {
      return null;
    }

    return buildInvestmentAnalytics({
      transactions: data.transactions,
      capitalSeries: data.capitalSeries,
      liveQuotes: data.liveQuotes,
      historicalSeries: data.historicalMarketSeries,
      endDate: selectedTrendRow.date,
      rangeStartDate: filters.startDate,
      historicalUnitEstimates: data.historicalUnitEstimates,
      positionUnitOverrides: data.positionUnitOverrides,
      positionValuationOverrides: data.positionValuationOverrides,
      registry: data.instrumentRegistry,
    });
  }, [
    data.capitalSeries,
    data.historicalMarketSeries,
    data.historicalUnitEstimates,
    data.instrumentRegistry,
    data.liveQuotes,
    data.positionUnitOverrides,
    data.positionValuationOverrides,
    data.transactions,
    filters.startDate,
    selectedTrendRow,
  ]);

  const instrumentColorMap = useMemo(
    () =>
      new Map(
        [...new Set([...transactionInstrumentKeyMap.values()].filter(Boolean))].map((instrumentKey, index) => [
          instrumentKey,
          PORTFOLIO_COLORS[index % PORTFOLIO_COLORS.length],
        ]),
      ),
    [transactionInstrumentKeyMap],
  );

  const holdingsRows = useMemo(
    () => {
      const selectedCashBalance = selectedTrendRow
        ? (historicalHoldingsAnalytics?.snapshot.availableCash ?? 0)
        : cashBalance;

      return selectedTrendRow && historicalHoldingsAnalytics
        ? buildHoldingRows(
            historicalHoldingsAnalytics.positions,
            instrumentColorMap,
            selectedCashBalance,
            data.historicalMarketSeries,
            selectedTrendRow.date,
          )
        : buildHoldingRows(analytics.positions, instrumentColorMap, selectedCashBalance);
    },
    [analytics.positions, cashBalance, data.historicalMarketSeries, historicalHoldingsAnalytics, instrumentColorMap, selectedTrendRow],
  );

  const sortedHoldingsRows = useMemo(() => {
    return holdingsRows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const comparison = comparePortfolioValues(
          left.row[holdingsSort.key as keyof HoldingRow],
          right.row[holdingsSort.key as keyof HoldingRow],
        );

        if (comparison !== 0) {
          return holdingsSort.direction === "asc" ? comparison : -comparison;
        }

        return left.index - right.index;
      })
      .map(({ row }) => row);
  }, [holdingsRows, holdingsSort]);
  const groupedComponentRows = useMemo(() => buildPortfolioComponentGroups(sortedHoldingsRows), [sortedHoldingsRows]);
  const trendComponentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of trendRows) {
      for (const [componentKey, value] of Object.entries(row.componentValues)) {
        if (value > 0.0000001) {
          keys.add(componentKey);
        }
      }
    }

    const ordered = COMPONENT_ORDER.filter((key) => keys.has(key));
    const extras = [...keys].filter((key) => !COMPONENT_ORDER.includes(key)).sort();
    return [...ordered, ...extras];
  }, [trendRows]);
  const trendChartRows = useMemo(
    () =>
      trendRows.map((row) => ({
        ...row,
        ...Object.fromEntries(trendComponentKeys.map((componentKey) => [`component_${componentKey}`, row.componentValues[componentKey] ?? 0])),
      })),
    [trendComponentKeys, trendRows],
  );

  const allTimeRange = resolvePeriodBounds(dates, "allTime");
  const yearToDateRange = resolvePeriodBounds(dates, "yearToDate");
  const lastTwelveRange = resolvePeriodBounds(dates, "last12");
  const activePreset =
    sameRange(filters.startDate, filters.endDate, allTimeRange.startDate, allTimeRange.endDate)
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
        : formatDateRange(filters.startDate, filters.endDate);
  const periodReturnSummary = useMemo(
    () => buildPortfolioRangeIncreaseSummary(trendRows),
    [trendRows],
  );
  const holdingsAsOfDate = selectedTrendRow?.date ?? analytics.snapshot.positionsAsOf;
  const holdingCount = holdingsRows.filter((row) => row.kind === "position").length;
  const hasCashComponent = holdingsRows.some((row) => row.kind === "cash");
  const holdingsSelectionLabel = selectedTrendRow
    ? `${selectedTrendRow.displayLabel} snapshot`
    : hasCashComponent
      ? `${holdingCount} holdings + cash`
      : `${holdingCount} holdings`;
  const componentEndDate = selectedTrendRow?.date ?? filters.endDate;
  const componentTransactions = useMemo(
    () => data.transactions.filter((row) => row.date >= filters.startDate && row.date <= componentEndDate),
    [componentEndDate, data.transactions, filters.endDate, filters.startDate],
  );

  const kpiItems = [
    { label: "Net worth", value: formatEuro(totalValueEur), note: `As of ${formatAsOfDate(filters.endDate)}`, tone: "positive" as const },
    { label: "Portfolio value", value: formatEuro(analytics.portfolioValueEur), note: `As of ${formatAsOfDate(analytics.snapshot.positionsAsOf)}`, tone: "positive" as const },
    { label: "Cost basis", value: formatEuro(analytics.costBasisEur), note: activeWindowLabel, tone: "neutral" as const },
    {
      label: "Increase",
      value: periodReturnSummary.increaseEur === null ? "—" : formatEuro(periodReturnSummary.increaseEur, { signed: true }),
      note:
        periodReturnSummary.increaseEur === null
          ? `${activeWindowLabel} · no value history`
          : periodReturnSummary.startValueEur === null
            ? activeWindowLabel
            : periodReturnSummary.increasePct === null
              ? `${activeWindowLabel} · vs ${formatEuro(periodReturnSummary.startValueEur)} start`
              : `${activeWindowLabel} · ${formatPercent(periodReturnSummary.increasePct)} vs ${formatEuro(periodReturnSummary.startValueEur)} start`,
      tone:
        periodReturnSummary.increaseEur === null
          ? ("neutral" as const)
          : periodReturnSummary.increaseEur < 0
            ? ("negative" as const)
            : ("accent" as const),
    },
    { label: "Cash balance", value: formatEuro(cashBalance), note: `As of ${formatAsOfDate(filters.endDate)}`, tone: "neutral" as const },
  ];

  const openTransactionDetail = (
    title: string,
    rows: typeof filteredTransactions,
    meta?: string,
    trend?: DetailTrendView,
    range?: { startDate: string; endDate: string },
  ) => {
    const detailRange = range ?? { startDate: filters.startDate, endDate: filters.endDate };

    setDetail({
      title,
      meta: meta ?? `${rows.length.toLocaleString("en-US")} rows in the current view`,
      summary: [
        { label: "Rows", value: rows.length.toLocaleString("en-US") },
        { label: "Net amount", value: formatEuro(rows.reduce((sum, row) => sum + row.signedAmount, 0), { signed: true }) },
        { label: "Range", value: formatDateRange(detailRange.startDate, detailRange.endDate) },
      ],
      trend,
      rows: rows
        .slice()
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
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

  const openPositionsDetail = (title: string, rows = sortedHoldingsRows, meta?: string) => {
    const positionRows = rows.filter((row) => row.kind === "position");
    const includedCashBalance = rows.find((row) => row.kind === "cash")?.marketValueEur ?? 0;

    setDetail({
      title,
      meta: meta ?? `Components as of ${formatAsOfDate(holdingsAsOfDate)}`,
      summary: [
        { label: "Holdings", value: positionRows.length.toLocaleString("en-US") },
        { label: "Cash", value: formatEuro(includedCashBalance) },
        { label: "Total value", value: formatEuro(rows.reduce((sum, row) => sum + row.marketValueEur, 0)) },
      ],
      rows: rows.map((row) => ({
        kind: row.kind,
        instrumentKey: row.instrumentKey,
        isin: row.isin,
        instrument: row.instrument,
        assetClass: row.assetClass,
        share: row.share,
        units: row.units,
        unitsKnown: row.unitsKnown,
        effectiveDate: row.effectiveDate,
        priceEur: row.priceEur,
        priceScale: row.priceScale,
        costBasisEur: row.costBasisEur,
        marketValueEur: row.marketValueEur,
        unrealizedPnlEur: row.unrealizedPnlEur,
        returnPct: row.returnPct,
        valuationSource: row.valuationSource,
        valuationSourceLabel: row.valuationSourceLabel,
      })),
      columns: [
        { key: "instrument", label: "Component" },
        { key: "assetClass", label: "Class" },
        { key: "share", label: "Share", sortable: true, sortDefaultDirection: "desc", render: (value) => <span>{formatPercent(Number(value))}</span> },
        {
          key: "units",
          label: "Units",
          sortable: true,
          sortDefaultDirection: "desc",
          render: (value, row) => <span>{row.kind === "cash" || row.unitsKnown === false ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>,
        },
        {
          key: "costBasisEur",
          label: "Cost basis",
          sortable: true,
          sortDefaultDirection: "desc",
          render: (value, row) => <span>{row.kind === "cash" ? "—" : formatEuro(Number(value))}</span>,
        },
        { key: "marketValueEur", label: "Market value", sortable: true, sortDefaultDirection: "desc", render: (value) => <span>{formatEuro(Number(value))}</span> },
        {
          key: "unrealizedPnlEur",
          label: "Unrealized",
          sortable: true,
          sortDefaultDirection: "desc",
          render: (value, row) => (row.kind === "cash" ? <span>—</span> : <SignedAmount value={Number(value)} />),
        },
        {
          key: "returnPct",
          label: "Return %",
          sortable: true,
          sortDefaultDirection: "desc",
          render: (value, row) => <span>{row.kind === "cash" ? "—" : formatPercent(Number(value))}</span>,
        },
        {
          key: "priceEur",
          label: "Adjust",
          render: (_value, row) => (row.kind === "cash" ? <span>—</span> : <PositionHoldingEditor row={row} />),
        },
      ],
    });
  };

  const openHoldingDetail = (holding?: HoldingRow) => {
    if (!holding) {
      return;
    }

    if (holding.kind === "cash") {
      openTransactionDetail(
        "Cash activity",
        componentTransactions,
        selectedTrendRow ? `Cash balance · ${selectedTrendRow.displayLabel}` : "Rows affecting available cash",
        undefined,
        { startDate: filters.startDate, endDate: componentEndDate },
      );
      return;
    }

    const rows = componentTransactions.filter((row) => {
      const instrumentKey = transactionInstrumentKeyMap.get(row.rowId);
      return instrumentKey === holding.instrumentKey;
    });

    openTransactionDetail(
      `${holding.instrument} activity`,
      rows,
      selectedTrendRow ? `Holding: ${holding.instrument} · ${selectedTrendRow.displayLabel}` : `Holding: ${holding.instrument}`,
      undefined,
      { startDate: filters.startDate, endDate: componentEndDate },
    );
  };

  const openComponentGroupDetail = (group?: PortfolioComponentGroupRow) => {
    if (!group) {
      return;
    }

    if (group.kind === "cash") {
      openHoldingDetail(group.rows[0]);
      return;
    }

    openPositionsDetail(
      `${group.label} breakdown`,
      group.rows,
      `${group.label} · ${group.rows.length} ${group.rows.length === 1 ? "holding" : "holdings"}`,
    );
  };

  const openTrendPeriodActivity = (row?: PortfolioTrendRow) => {
    if (!row) {
      return;
    }

    const detailRows = filteredTransactions.filter((transaction) => {
      const isInvestmentEvent = transaction.group === "investment" || (transaction.category === "interest_dividend" && transaction.signedAmount > 0);
      if (!isInvestmentEvent) {
        return false;
      }

      return trendGranularity === "year" ? transaction.yearLabel === row.periodKey : transaction.monthLabel === row.periodKey;
    });

    openTransactionDetail(
      `${row.displayLabel} portfolio activity`,
      detailRows,
      `${trendGranularity === "year" ? "Year" : "Month"}: ${row.displayLabel}`,
      buildPortfolioDetailTrend(trendRows, row.periodKey, trendGranularity),
      {
        startDate:
          trendGranularity === "year"
            ? (filters.startDate > `${row.periodKey}-01-01` ? filters.startDate : `${row.periodKey}-01-01`)
            : (filters.startDate > `${row.periodKey}-01` ? filters.startDate : `${row.periodKey}-01`),
        endDate: row.date,
      },
    );
  };

  const toggleTrendPeriodSelection = (row?: PortfolioTrendRow) => {
    if (!row) {
      return;
    }

    if (selectedTrendPeriodKey === row.periodKey) {
      setSelectedTrendPeriodKey("");
      setFilters(baseFilters);
      setShowCustomPeriod(baseFilters.preset === "custom" || Boolean(baseFilters.activeQuickLabel));
      return;
    }

    const nextRange = resolvePeriodBounds(
      dates,
      "custom",
      trendGranularity === "year" ? `${row.periodKey}-01-01` : `${row.periodKey}-01`,
      row.date,
    );

    setSelectedTrendPeriodKey(row.periodKey);
    setShowCustomPeriod(true);
    setFilters((current) => ({
      ...current,
      preset: "custom",
      startDate: nextRange.startDate,
      endDate: nextRange.endDate,
      activeQuickKind: trendGranularity === "year" ? "year" : "month",
      activeQuickLabel: row.displayLabel,
    }));
  };

  const restoreTrendWindowSelection = () => {
    setSelectedTrendPeriodKey("");
    setFilters(baseFilters);
    setShowCustomPeriod(baseFilters.preset === "custom" || Boolean(baseFilters.activeQuickLabel));
  };

  const applyPreset = (preset: "yearToDate" | "last12") => {
    setShowCustomPeriod(false);
    const nextFilters = createInitialFilterState(dates, preset);
    setSelectedTrendPeriodKey("");
    setFilters(nextFilters);
    setBaseFilters(nextFilters);
  };

  const applyAllTime = () => {
    setShowCustomPeriod(false);
    const nextFilters = createInitialFilterState(dates, "allTime");
    setSelectedTrendPeriodKey("");
    setFilters(nextFilters);
    setBaseFilters(nextFilters);
  };

  const holdingsTableColumns: Array<TableColumn<HoldingRow>> = [
    {
      key: "instrument",
      label: "Component",
      render: (_value, row) => (
        <div className="table-transaction-cell">
          <strong>{row.instrument}</strong>
          <small>
            {row.assetClass}
            {row.kind === "cash" ? "" : ` · ${row.valuationSourceLabel}`}
          </small>
        </div>
      ),
    },
    { key: "share", label: "Share", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value) => <span>{formatPercent(Number(value))}</span> },
    { key: "marketValueEur", label: "Market value", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
    { key: "costBasisEur", label: "Cost basis", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value, row) => <span>{row.kind === "cash" ? "—" : formatEuro(Number(value))}</span> },
    { key: "unrealizedPnlEur", label: "Unrealized", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value, row) => (row.kind === "cash" ? <span>—</span> : <SignedAmount value={Number(value)} />) },
    { key: "units", label: "Units", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value, row) => <span>{row.kind === "cash" || row.unitsKnown === false ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 })}</span> },
    { key: "returnPct", label: "Return %", align: "right", sortable: true, sortDefaultDirection: "desc", cellClassName: "cell-nowrap", render: (value, row) => <span>{row.kind === "cash" ? "—" : formatPercent(Number(value))}</span> },
    { key: "priceEur", label: "Adjust", align: "right", cellClassName: "cell-nowrap", render: (_value, row) => (row.kind === "cash" ? <span>—</span> : <PositionHoldingEditor row={row} />) },
  ];

  return (
    <DashboardShell kicker="Portfolio" description="Portfolio value over time and current components." hideHero viewportLocked>
      <section className="home-commandbar">
        <div className="home-commandbar-row">
          <div className="home-commandbar-title"><strong>Portfolio</strong></div>
          <div className="trend-commandbar-controls">
            <div className="home-period-bar" aria-label="Portfolio period presets">
              <button type="button" className="quick-button" data-active={activePreset === "allTime"} onClick={applyAllTime}>All</button>
              <button type="button" className="quick-button" data-active={activePreset === "last12"} onClick={() => applyPreset("last12")}>12M</button>
              <button type="button" className="quick-button" data-active={activePreset === "yearToDate"} onClick={() => applyPreset("yearToDate")}>YTD</button>
              <button type="button" className="quick-button quick-button-ghost" data-active={showCustomPeriod || activePreset === "custom"} onClick={() => setShowCustomPeriod((current) => !current)}>Custom</button>
            </div>
          </div>
          <div className="home-commandbar-meta">
            <span className="home-updated">Prices {formatAsOfDate(analytics.snapshot.pricesAsOf.slice(0, 10) || analytics.snapshot.positionsAsOf)}</span>
          </div>
        </div>
        {showCustomPeriod ? (
          <div className="home-commandbar-custom">
            <FilterBar
              dates={dates}
              filters={filters}
              onChange={(next) => {
                setSelectedTrendPeriodKey("");
                setFilters(next);
                setBaseFilters(next);
              }}
            />
          </div>
        ) : null}
      </section>

      <MetricGrid items={kpiItems} />

      <section className="home-primary-grid portfolio-primary-grid">
        <Panel
          title="Portfolio trend"
          actions={
            <div className="trend-panel-actions">
              {selectedTrendRow ? (
                <button type="button" className="quick-button quick-button-ghost" onClick={() => openTrendPeriodActivity(selectedTrendRow)}>
                  Activity
                </button>
              ) : null}
              {selectedTrendRow ? (
                <button type="button" className="quick-button quick-button-ghost" onClick={restoreTrendWindowSelection}>
                  Current
                </button>
              ) : null}
              <div className="trend-granularity-toggle" role="group" aria-label="portfolio trend granularity" data-active-value={trendGranularity}>
                <span className="trend-granularity-thumb" aria-hidden="true" />
                <button type="button" className="trend-granularity-option" data-active={trendGranularity === "month"} aria-pressed={trendGranularity === "month"} onClick={() => setTrendGranularity("month")}>Month</button>
                <button type="button" className="trend-granularity-option" data-active={trendGranularity === "year"} aria-pressed={trendGranularity === "year"} onClick={() => setTrendGranularity("year")}>Year</button>
              </div>
              <div className="panel-view-toggle" aria-label="portfolio trend view mode">
                <button type="button" className="quick-button" data-active={trendViewMode === "visual"} onClick={() => setTrendViewMode("visual")}>Trend</button>
                <button type="button" className="quick-button" data-active={trendViewMode === "table"} onClick={() => setTrendViewMode("table")}>Table</button>
              </div>
            </div>
          }
          className="home-panel-fixed home-panel-fixed-primary"
        >
          <div className="home-panel-stack">
            <div className="home-panel-context">
              <strong>{activeWindowLabel}</strong>
              <span>
                {selectedTrendRow
                  ? `${selectedTrendRow.displayLabel} selected`
                  : trendGranularity === "year"
                    ? `${trendRows.length} years`
                    : `${trendRows.length} months`}
              </span>
            </div>
            <div className="home-widget-body home-widget-body-primary">
              {trendRows.length === 0 ? (
                <div className="empty">No portfolio trend is available in this view.</div>
              ) : trendViewMode === "visual" ? (
                <div className="chart-box chart-home-trend-wide chart-box-interactive">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={trendChartRows}
                      margin={{ top: 18, right: 8, left: 0, bottom: 6 }}
                      onClick={(state: any) => toggleTrendPeriodSelection(state?.activePayload?.[0]?.payload)}
                    >
                      <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
                      {selectedTrendRow ? (
                        <ReferenceLine
                          x={selectedTrendRow.displayLabel}
                          stroke="rgba(245, 248, 255, 0.48)"
                          strokeDasharray="4 4"
                        />
                      ) : null}
                      <XAxis
                        dataKey="displayLabel"
                        stroke="hsl(var(--text-muted))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={16}
                        tick={({ x = 0, y = 0, payload }) => {
                          const lookup = trendPeriodLookup.get(String(payload?.value ?? ""));
                          return (
                            <g transform={`translate(${Number(x)}, ${Number(y)})`}>
                              <text
                                className="trend-axis-month-tick"
                                x={0}
                                y={16}
                                textAnchor="middle"
                                onClick={
                                  lookup
                                    ? (event) => {
                                        event.stopPropagation();
                                        toggleTrendPeriodSelection(lookup);
                                      }
                                    : undefined
                                }
                              >
                                {String(payload?.value ?? "")}
                              </text>
                            </g>
                          );
                        }}
                      />
                      <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => `€${value}`} />
                      <Tooltip
                        cursor={{ stroke: "rgba(223, 231, 243, 0.18)", strokeDasharray: "3 3" }}
                        content={
                          <ChartTooltipContent
                            formatLabel={(label) => String(label ?? "")}
                            formatValue={(value) => formatEuro(Number(value ?? 0))}
                            sortPayload={(left, right) => Number(right?.value ?? 0) - Number(left?.value ?? 0)}
                          />
                        }
                      />
                      <Legend iconType="circle" />
                      {trendComponentKeys.map((componentKey) => (
                        <Area
                          key={componentKey}
                          type="monotone"
                          dataKey={`component_${componentKey}`}
                          name={formatComponentLabel(componentKey)}
                          stackId="portfolio"
                          stroke={componentColorForKey(componentKey)}
                          fill={componentColorForKey(componentKey)}
                          fillOpacity={0.16}
                          strokeOpacity={0.96}
                        />
                      ))}
                      <Line type="monotone" dataKey="totalValueEur" name="Total value" stroke={PORTFOLIO_VALUE_COLOR} strokeWidth={3} dot={{ r: 3, fill: PORTFOLIO_VALUE_COLOR }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="costBasisEur" name="Cost basis" stroke={COST_BASIS_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, fill: COST_BASIS_COLOR, stroke: COST_BASIS_COLOR }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="home-table-panel">
                  <DataTable
                    density="compact"
                    rows={trendRows.slice().reverse()}
                    rowKey="periodKey"
                    onRowClick={(row) => toggleTrendPeriodSelection(row)}
                    columns={[
                      {
                        key: "displayLabel",
                        label: trendGranularity === "year" ? "Year" : "Month",
                        render: (value, row) => (
                          <span>
                            {String(value)}
                            {row.periodKey === selectedTrendPeriodKey ? " · selected" : ""}
                          </span>
                        ),
                      },
                      { key: "totalValueEur", label: "Total value", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                      { key: "cashValueEur", label: "Cash", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                      { key: "costBasisEur", label: "Cost basis", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
                      {
                        key: "periodReturnPct",
                        label: "Increase %",
                        align: "right",
                        cellClassName: "cell-nowrap",
                        render: (value) => (
                          <span>{typeof value === "number" && Number.isFinite(value) ? formatPercent(Number(value)) : "—"}</span>
                        ),
                      },
                      { key: "realizedPnlEur", label: "Realized", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
                      { key: "dividendsEur", label: "Dividends", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
                    ]}
                  />
                </div>
              )}
            </div>
          </div>
        </Panel>

        <Panel
          title="Portfolio components"
          actions={
            <div className="panel-view-toggle" aria-label="portfolio components view mode">
              <button type="button" className="quick-button" data-active={componentsViewMode === "grouped"} onClick={() => setComponentsViewMode("grouped")}>Donut</button>
              <button type="button" className="quick-button" data-active={componentsViewMode === "detailed"} onClick={() => setComponentsViewMode("detailed")}>Detailed</button>
              <button type="button" className="quick-button" data-active={componentsViewMode === "table"} onClick={() => setComponentsViewMode("table")}>Table</button>
            </div>
          }
          className="home-panel-fixed home-panel-fixed-primary"
        >
          <div className="home-panel-stack">
            <div className="home-panel-context">
              <strong>{formatAsOfDate(holdingsAsOfDate)}</strong>
              <span>{selectedTrendRow ? `${holdingsSelectionLabel} · ${hasCashComponent ? `${holdingCount} holdings + cash` : `${holdingCount} holdings`}` : holdingsSelectionLabel}</span>
            </div>
            <div className="home-widget-body home-widget-body-primary">
              {holdingsRows.length === 0 ? (
                <div className="empty">
                  {selectedTrendRow ? "No holdings were open at the selected period." : "No current holdings are available in this view."}
                </div>
              ) : componentsViewMode === "grouped" ? (
                <div className="portfolio-components-visual" data-mode="grouped">
                  <div className="portfolio-components-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
	                        <Pie
	                          data={groupedComponentRows}
	                          dataKey="marketValueEur"
	                          nameKey="label"
	                          innerRadius={64}
	                          outerRadius={96}
	                          paddingAngle={4}
	                          onClick={(_, index) => openComponentGroupDetail(groupedComponentRows[index])}
	                        >
                          {groupedComponentRows.map((row) => (
                            <Cell key={row.componentKey} fill={row.color} stroke="none" />
                          ))}
                        </Pie>
                        <Tooltip
                          content={
                            <ChartTooltipContent
                              formatLabel={(label) => String(label ?? "")}
                              formatValue={(value, name, item) => [formatEuro(Number(value ?? 0)), `${formatPercent(Number(item?.payload?.share ?? 0))}`]}
                            />
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="portfolio-components-list">
                    {groupedComponentRows.map((row) => (
                      <button key={row.componentKey} type="button" className="portfolio-components-row" onClick={() => openComponentGroupDetail(row)}>
                        <span className="portfolio-components-row-main">
                          <span className="portfolio-components-swatch" style={{ backgroundColor: row.color }} />
                          <span className="portfolio-components-labels">
                            <strong>{row.label}</strong>
                          </span>
                        </span>
                        <span className="portfolio-components-row-meta">
                          <strong>{formatEuro(row.marketValueEur)}</strong>
                          <small>{formatPercent(row.share)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : componentsViewMode === "detailed" ? (
                <div className="portfolio-components-visual">
                  <div className="portfolio-components-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
	                        <Pie
	                          data={holdingsRows}
	                          dataKey="marketValueEur"
	                          nameKey="instrument"
	                          innerRadius={64}
	                          outerRadius={96}
	                          paddingAngle={3}
	                          onClick={(_, index) => openHoldingDetail(holdingsRows[index])}
	                        >
                          {holdingsRows.map((row) => (
                            <Cell key={row.instrumentKey} fill={row.color} stroke="none" />
                          ))}
                        </Pie>
                        <Tooltip
                          content={
                            <ChartTooltipContent
                              formatLabel={(label) => String(label ?? "")}
                              formatValue={(value, name, item) => [formatEuro(Number(value ?? 0)), `${formatPercent(Number(item?.payload?.share ?? 0))}`]}
                            />
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="portfolio-components-list">
                    {sortedHoldingsRows.map((row) => (
                      <button key={row.instrumentKey} type="button" className="portfolio-components-row" onClick={() => openHoldingDetail(row)}>
                        <span className="portfolio-components-row-main">
                          <span className="portfolio-components-swatch" style={{ backgroundColor: row.color }} />
                          <span className="portfolio-components-labels">
                            <strong>{row.instrument}</strong>
                            <small>{row.kind === "cash" ? row.assetClass : `${row.assetClass} · ${row.valuationSourceLabel}`}</small>
                          </span>
                        </span>
                        <span className="portfolio-components-row-meta">
                          <strong>{formatEuro(row.marketValueEur)}</strong>
                          <small>{formatPercent(row.share)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="home-table-panel">
                  <DataTable
                    density="compact"
                    rows={sortedHoldingsRows}
                    rowKey="instrumentKey"
                    onRowClick={(row) => openHoldingDetail(row)}
                    columns={holdingsTableColumns}
                    sortState={holdingsSort}
                    onSortChange={setHoldingsSort}
                  />
                </div>
              )}
            </div>
          </div>
        </Panel>
      </section>

      <DetailSheet open={Boolean(detail)} detail={detail} onClose={() => setDetail(null)} />
    </DashboardShell>
  );
}
