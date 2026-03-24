"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountsData } from "@/lib/accounts-data";
import {
  annotateMonthLabel,
  applyCapitalFilters,
  applyTransactionFilters,
  dataDatesFromCapital,
  formatAsOfDate,
  formatDateRange,
  formatDisplayDate,
  formatEuro,
  incompleteMonthLabels,
  monthlyAccountMovements,
  reserveFundRowsInRange,
} from "@/lib/dashboard-utils";
import { buildInvestmentAnalytics } from "@/lib/investment-performance";
import type { OfficialEtfExposure } from "@/lib/etf-lookthrough";
import type { DetailView } from "./dashboard-ui";
import { CategoryEditor, ClickableMetricGrid, DashboardShell, DataTable, DetailSheet, FilterBar, PageToolbar, Panel, PositionUnitsEditor, Section, SignedAmount, chartTooltipContentStyle, defaultFilterState } from "./dashboard-ui";

const ASSET_CLASS_LABELS: Record<string, string> = {
  crypto: "Crypto",
  etf: "ETFs",
  bond_etf: "Bond ETFs",
  gold: "Gold",
  stock: "Stocks",
  bond: "Bonds",
  other: "Other",
};

type BreakdownEntry = {
  name: string;
  value: number;
  share: number;
};

type BreakdownContribution = {
  name: string;
  value: number;
  instrument: string;
  assetClass: string;
  appliedShare: number;
  method: string;
  asOf: string;
};

function formatPercent(value: number) {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function buildBreakdown(items: Array<{ name: string; value: number }>, total: number): BreakdownEntry[] {
  const grouped = items.reduce<Map<string, number>>((acc, item) => {
    acc.set(item.name, (acc.get(item.name) ?? 0) + item.value);
    return acc;
  }, new Map<string, number>());

  return [...grouped.entries()]
    .map(([name, value]) => ({
      name,
      value,
      share: total > 0 ? (value / total) * 100 : 0,
    }))
    .sort((left, right) => right.value - left.value);
}

function buildExposureContributions(
  positions: ReturnType<typeof buildInvestmentAnalytics>["positions"],
  officialEtfExposures: Record<string, OfficialEtfExposure>,
  dimension: "country" | "sector" | "currency",
): BreakdownContribution[] {
  return positions.flatMap((row) => {
    const exposure = officialEtfExposures[row.instrumentKey];
    const assetClassLabel = ASSET_CLASS_LABELS[row.assetClass] ?? row.assetClass;
    const fallbackLabel =
      dimension === "country"
        ? row.country
        : dimension === "currency"
          ? row.quoteCurrency
          : row.sector || row.industry;

    const slices =
      dimension === "country"
        ? exposure?.countries
        : dimension === "currency"
          ? exposure?.currencies
          : exposure?.sectors;

    if (!slices || slices.length === 0) {
      return [
        {
          name: fallbackLabel,
          value: row.marketValueEur,
          instrument: row.instrument,
          assetClass: assetClassLabel,
          appliedShare: 100,
          method: "Direct position",
          asOf: formatAsOfDate(row.asOf.slice(0, 10)),
        },
      ];
    }

    return slices.map((slice) => ({
      name: slice.name,
      value: row.marketValueEur * (slice.share / 100),
      instrument: row.instrument,
      assetClass: assetClassLabel,
      appliedShare: slice.share,
      method:
        dimension === "currency"
          ? `${exposure.source} (currency derived from official country allocation)`
          : exposure.source,
      asOf: formatAsOfDate(exposure.asOf || row.asOf.slice(0, 10)),
    }));
  });
}

export function AccountsDashboard({ data }: { data: AccountsData }) {
  const dates = dataDatesFromCapital(data.capitalSeries);
  const [filters, setFilters] = useState(() => defaultFilterState(dates));
  const [detail, setDetail] = useState<DetailView | null>(null);

  const capitalSeries = applyCapitalFilters(data.capitalSeries, filters);
  const transactionRows = applyTransactionFilters(data.transactions, filters);
  const reserveRows = reserveFundRowsInRange(data.fundRows, filters);
  const investmentRows = transactionRows.filter((row) => row.group === "investment");
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

  const historyInRange = analytics.history.filter((point) => point.date >= filters.startDate && point.date <= filters.endDate);
  const latestCapital = capitalSeries.at(-1);
  const firstCapital = capitalSeries.at(0);
  const activeWindowLabel = filters.activeQuickLabel ? `${filters.activeQuickKind === "month" ? "Month" : "Year"}: ${filters.activeQuickLabel}` : "All data";
  const positionsAsOfLabel = formatAsOfDate(analytics.snapshot.positionsAsOf);
  const pricesAsOfLabel = formatAsOfDate(analytics.snapshot.pricesAsOf.slice(0, 10) || analytics.snapshot.positionsAsOf);
  const partialMonths = incompleteMonthLabels(filters);
  const accountValueEur = analytics.snapshot.availableCash + analytics.portfolioValueEur;
  const manualPositions = analytics.positions.filter((row) => row.coverage === "Manual").length;
  const estimatedOrPartialPositions = analytics.positions.filter((row) => row.coverage === "Estimated" || row.coverage === "Partial").length;
  const accountMovementRows = monthlyAccountMovements(transactionRows).map((row) => ({
    ...row,
    displayMonthLabel: annotateMonthLabel(row.monthLabel, filters),
  }));

  const portfolioMix = buildBreakdown(
    analytics.positions.map((row) => ({
      name: ASSET_CLASS_LABELS[row.assetClass] ?? row.assetClass,
      value: row.marketValueEur,
    })),
    analytics.portfolioValueEur,
  );
  const countryContributions = buildExposureContributions(analytics.positions, data.officialEtfExposures, "country");
  const currencyContributions = buildExposureContributions(analytics.positions, data.officialEtfExposures, "currency");
  const sectorContributions = buildExposureContributions(analytics.positions, data.officialEtfExposures, "sector");
  const countryMix = buildBreakdown(countryContributions.map((row) => ({ name: row.name, value: row.value })), analytics.portfolioValueEur);
  const currencyMix = buildBreakdown(currencyContributions.map((row) => ({ name: row.name, value: row.value })), analytics.portfolioValueEur);
  const industryMix = buildBreakdown(sectorContributions.map((row) => ({ name: row.name, value: row.value })), analytics.portfolioValueEur);
  const split = [
    { name: "Available cash", value: analytics.snapshot.availableCash },
    { name: "Portfolio value", value: analytics.portfolioValueEur },
  ].filter((entry) => entry.value > 0);

  const buildTransactionSummary = (rows: typeof transactionRows) => {
    const total = rows.reduce((sum, row) => sum + row.signedAmount, 0);
    return [
      { label: "Rows", value: rows.length.toLocaleString("en-US") },
      { label: "Net amount", value: formatEuro(total, { signed: true }) },
      { label: "Range", value: formatDateRange(filters.startDate, filters.endDate) },
    ];
  };

  const openTransactionDetail = (title: string, rows: typeof transactionRows, meta?: string) => {
    setDetail({
      title,
      meta: meta ?? `${rows.length.toLocaleString("en-US")} rows in the current view`,
      summary: buildTransactionSummary(rows),
      rows: rows
        .slice()
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
        .slice(0, 200)
        .map((row) => ({
          rowId: row.rowId,
          date: formatDisplayDate(row.date),
          merchant: row.merchant,
          category: row.categoryLabel,
          categoryKey: row.category,
          categoryLabel: row.categoryLabel,
          amount: row.signedAmount,
          balance: row.balance,
        })),
      columns: [
        { key: "date", label: "Date" },
        { key: "merchant", label: "Merchant" },
        { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
        { key: "amount", label: "Amount", render: (value) => <SignedAmount value={Number(value)} /> },
        { key: "balance", label: "Balance", render: (value) => <span>{formatEuro(Number(value))}</span> },
      ],
    });
  };

  const openPositionDetail = (title: string, rows = analytics.positions, meta?: string) => {
    setDetail({
      title,
      meta: meta ?? `Positions as of ${positionsAsOfLabel}, priced as of ${pricesAsOfLabel}`,
      summary: [
        { label: "Assets", value: rows.length.toLocaleString("en-US") },
        { label: "Portfolio value", value: formatEuro(rows.reduce((sum, row) => sum + row.marketValueEur, 0)) },
        { label: "Cost basis", value: formatEuro(rows.reduce((sum, row) => sum + row.costBasisEur, 0)) },
      ],
      rows: rows.map((row) => ({
        instrumentKey: row.instrumentKey,
        isin: row.isin,
        instrument: row.instrument,
        assetClass: ASSET_CLASS_LABELS[row.assetClass] ?? row.assetClass,
        units: row.units,
        effectiveDate: analytics.snapshot.positionsAsOf,
        costBasis: row.costBasisEur,
        value: row.marketValueEur,
        unrealized: row.unrealizedPnlEur,
        realized: row.realizedPnlRangeEur,
        dividends: row.dividendIncomeRangeEur,
        returnPct: row.totalReturnPct,
        coverage: row.coverage,
      })),
      columns: [
        { key: "instrument", label: "Asset" },
        { key: "assetClass", label: "Class" },
        { key: "units", label: "Units", render: (_value, row) => <PositionUnitsEditor row={row} /> },
        { key: "costBasis", label: "Cost basis", render: (value) => <span>{formatEuro(Number(value))}</span> },
        { key: "value", label: "Market value", render: (value) => <span>{formatEuro(Number(value))}</span> },
        { key: "unrealized", label: "Unrealized", render: (value) => <SignedAmount value={Number(value)} /> },
        { key: "realized", label: "Realized", render: (value) => <SignedAmount value={Number(value)} /> },
        { key: "dividends", label: "Dividends", render: (value) => <SignedAmount value={Number(value)} /> },
        { key: "returnPct", label: "Return %", render: (value) => <span>{formatPercent(Number(value))}</span> },
        { key: "coverage", label: "Coverage" },
      ],
    });
  };

  const openExposureDetail = (title: string, rows: BreakdownContribution[], meta: string) => {
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    setDetail({
      title,
      meta,
      summary: [
        { label: "Assets", value: rows.length.toLocaleString("en-US") },
        { label: "Exposure value", value: formatEuro(total) },
        { label: "Portfolio %", value: formatPercent(analytics.portfolioValueEur > 0 ? (total / analytics.portfolioValueEur) * 100 : 0) },
      ],
      rows: rows
        .slice()
        .sort((left, right) => right.value - left.value)
        .map((row) => ({
          instrument: row.instrument,
          assetClass: row.assetClass,
          appliedShare: row.appliedShare,
          value: row.value,
          method: row.method,
          asOf: row.asOf,
        })),
      columns: [
        { key: "instrument", label: "Asset" },
        { key: "assetClass", label: "Class" },
        { key: "appliedShare", label: "Applied %", render: (value) => <span>{formatPercent(Number(value))}</span> },
        { key: "value", label: "Value", render: (value) => <span>{formatEuro(Number(value))}</span> },
        { key: "method", label: "Source" },
        { key: "asOf", label: "As of" },
      ],
    });
  };

  return (
    <DashboardShell
      kicker="Portfolio"
      title="Portfolio overview"
      description="Value, performance, and exposure."
      meta={`Updated as of ${formatAsOfDate(data.capitalSeries.at(-1)?.date ?? filters.endDate)}`}
    >
      <PageToolbar
        items={[
          activeWindowLabel,
          `Positions as of ${positionsAsOfLabel}`,
          `Prices as of ${pricesAsOfLabel}`,
          manualPositions > 0 ? `Manual units: ${manualPositions}` : "",
          estimatedOrPartialPositions > 0 ? `Estimated or partial: ${estimatedOrPartialPositions}` : "",
          filters.excludeIncompleteMonths ? "Incomplete last month hidden" : "",
          partialMonths.length > 0 ? `Partial months: ${partialMonths.join(", ")}` : "",
        ]}
      >
        <FilterBar dates={dates} filters={filters} onChange={setFilters} compact summaryLabel="Period" />
      </PageToolbar>

      <Section title="Value" note="What the portfolio is worth at the selected end date.">
        <ClickableMetricGrid
          items={[
            { label: "Portfolio value", value: formatEuro(analytics.portfolioValueEur), note: "Live market value" },
            { label: "Cost basis", value: formatEuro(analytics.costBasisEur), note: "Current average cost" },
            { label: "Unrealized P&L", value: formatEuro(analytics.unrealizedPnlEur, { signed: true }), note: "Value minus cost basis" },
            { label: "Realized P&L", value: formatEuro(analytics.realizedPnlRangeEur, { signed: true }), note: "Inside the active range" },
          ]}
          onSelect={(item) => {
            if (item.label === "Portfolio value" || item.label === "Cost basis" || item.label === "Unrealized P&L") {
              openPositionDetail("Current positions");
              return;
            }
            openTransactionDetail("Investment trades", investmentRows, "Investment rows inside the active range");
          }}
        />

        <div className="panel-grid">
          <Panel title="Current snapshot" note="The key current values behind the portfolio view.">
            <div className="micro-grid">
              <div className="micro-stat">
                <div className="micro-label">Available cash</div>
                <div className="micro-value">{formatEuro(analytics.snapshot.availableCash)}</div>
                <div className="micro-note">Cash outside market positions</div>
              </div>
              <div className="micro-stat">
                <div className="micro-label">Account value</div>
                <div className="micro-value">{formatEuro(accountValueEur)}</div>
                <div className="micro-note">Cash plus portfolio value</div>
              </div>
              <div className="micro-stat">
                <div className="micro-label">Dividends in range</div>
                <div className="micro-value">{formatEuro(analytics.dividendsRangeEur, { signed: true })}</div>
                <div className="micro-note">Positive cashflow from holdings</div>
              </div>
              <div className="micro-stat">
                <div className="micro-label">Open positions</div>
                <div className="micro-value">{analytics.positions.length.toLocaleString("en-US")}</div>
                <div className="micro-note">Holdings priced in this view</div>
              </div>
            </div>
          </Panel>

          <Panel title="Current split" note="Available cash versus current portfolio value.">
            {split.length === 0 ? (
              <div className="empty">No split is available in this view.</div>
            ) : (
              <div className="chart-box chart-short">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={split} dataKey="value" nameKey="name" innerRadius={78} outerRadius={110} paddingAngle={10}>
                      {split.map((entry, index) => (
                        <Cell key={entry.name} fill={index === 0 ? "hsl(var(--accent-primary))" : "hsl(var(--accent-secondary))"} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={chartTooltipContentStyle} formatter={(value) => formatEuro(Number(value))} />
                    <Legend iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>
        </div>
      </Section>

      <Section title="Performance" note="How the portfolio value and returns evolved in the selected range.">
        <div className="panel-grid">
          <Panel title="Portfolio value vs cost basis" note="Month-end holdings valued with historical prices, plus the current end-date point.">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={historyInRange}>
                  <CartesianGrid stroke="hsla(var(--text), 0.05)" vertical={false} />
                  <XAxis dataKey="date" stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => formatDisplayDate(String(value))} />
                  <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => `€${value}`} />
                  <Tooltip contentStyle={chartTooltipContentStyle} labelFormatter={(value) => formatDisplayDate(String(value))} formatter={(value) => formatEuro(Number(value))} />
                  <Legend iconType="circle" />
                  <Line type="monotone" dataKey="marketValueEur" name="Portfolio value" stroke="hsl(var(--accent-primary))" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="costBasisEur" name="Cost basis" stroke="hsl(var(--accent-secondary))" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Realized P&L and dividends" note="Cumulative month-end realized gains/losses and dividend income.">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={historyInRange}>
                  <CartesianGrid stroke="hsla(var(--text), 0.05)" vertical={false} />
                  <XAxis dataKey="date" stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => formatDisplayDate(String(value))} />
                  <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => `€${value}`} />
                  <Tooltip contentStyle={chartTooltipContentStyle} labelFormatter={(value) => formatDisplayDate(String(value))} formatter={(value) => formatEuro(Number(value), { signed: true })} />
                  <Legend iconType="circle" />
                  <Bar dataKey="realizedPnlEur" name="Realized P&L" fill="hsl(var(--accent-tertiary))" />
                  <Bar dataKey="dividendIncomeEur" name="Dividends" fill="hsl(var(--accent-primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

        <Panel title="Positions" note="Current holdings at the selected end date. Realized P&L and dividends reflect the active date range.">
          <DataTable
            density="compact"
            rows={analytics.positions.map((row) => ({
              instrumentKey: row.instrumentKey,
              isin: row.isin,
              instrument: row.instrument,
              assetClass: ASSET_CLASS_LABELS[row.assetClass] ?? row.assetClass,
              units: row.units,
              effectiveDate: analytics.snapshot.positionsAsOf,
              costBasis: row.costBasisEur,
              value: row.marketValueEur,
              unrealized: row.unrealizedPnlEur,
              realized: row.realizedPnlRangeEur,
              dividends: row.dividendIncomeRangeEur,
              returnPct: row.totalReturnPct,
              coverage: row.coverage,
            }))}
            columns={[
              { key: "instrument", label: "Asset" },
              { key: "assetClass", label: "Class" },
              { key: "units", label: "Units", align: "right", cellClassName: "cell-nowrap", render: (_value, row) => <PositionUnitsEditor row={row} /> },
              { key: "costBasis", label: "Cost basis", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
              { key: "value", label: "Market value", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
              { key: "unrealized", label: "Unrealized", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
              { key: "realized", label: "Realized", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
              { key: "dividends", label: "Dividends", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
              { key: "returnPct", label: "Return %", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatPercent(Number(value))}</span> },
              { key: "coverage", label: "Coverage", cellClassName: "cell-nowrap" },
            ]}
          />
        </Panel>
      </Section>

      <Section title="Exposure" note="What the current portfolio is made of.">
        <div className="panel-grid panel-grid-three">
          <Panel title="Portfolio mix" note="Current market value by asset class, including bond support.">
            <div className="breakdown-list">
              {portfolioMix.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="breakdown-row"
                  onClick={() =>
                    openPositionDetail(
                      `${entry.name} positions`,
                      analytics.positions.filter((row) => (ASSET_CLASS_LABELS[row.assetClass] ?? row.assetClass) === entry.name),
                    )
                  }
                >
                  <span className="breakdown-label">{entry.name}</span>
                  <span className="breakdown-meta">
                    <strong>{formatPercent(entry.share)}</strong>
                    <small>{formatEuro(entry.value)}</small>
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Countries" note="Current portfolio share by country exposure.">
            <div className="breakdown-list">
              {countryMix.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="breakdown-row"
                  onClick={() =>
                    openExposureDetail(
                      `${entry.name} exposure`,
                      countryContributions.filter((row) => row.name === entry.name),
                      "Portfolio country exposure using direct positions and official ETF look-through",
                    )
                  }
                >
                  <span className="breakdown-label">{entry.name}</span>
                  <span className="breakdown-meta">
                    <strong>{formatPercent(entry.share)}</strong>
                    <small>{formatEuro(entry.value)}</small>
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Currencies" note="Current portfolio share by currency exposure.">
            <div className="breakdown-list">
              {currencyMix.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="breakdown-row"
                  onClick={() =>
                    openExposureDetail(
                      `${entry.name} exposure`,
                      currencyContributions.filter((row) => row.name === entry.name),
                      "Portfolio currency exposure using direct positions and official ETF country allocations",
                    )
                  }
                >
                  <span className="breakdown-label">{entry.name}</span>
                  <span className="breakdown-meta">
                    <strong>{formatPercent(entry.share)}</strong>
                    <small>{formatEuro(entry.value)}</small>
                  </span>
                </button>
              ))}
            </div>
          </Panel>
        </div>

        <Panel title="Sectors & industries" note="Current portfolio share by sector and industry.">
          <div className="breakdown-list">
            {industryMix.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className="breakdown-row"
                onClick={() =>
                  openExposureDetail(
                    `${entry.name} exposure`,
                    sectorContributions.filter((row) => row.name === entry.name),
                    "Portfolio sector and industry exposure using official ETF look-through where available",
                  )
                }
              >
                <span className="breakdown-label">{entry.name}</span>
                <span className="breakdown-meta">
                  <strong>{formatPercent(entry.share)}</strong>
                  <small>{formatEuro(entry.value)}</small>
                </span>
              </button>
            ))}
          </div>
        </Panel>
      </Section>

      <Section title="Activity and source rows" note="Underlying movement and source data behind the portfolio view.">
        <div className="section">
          <details className="details">
            <summary>Account movements by month</summary>
            <div className="panel">
              <div className="chart-box chart-short">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={accountMovementRows}>
                    <CartesianGrid stroke="hsla(var(--text), 0.05)" vertical={false} />
                    <XAxis dataKey="displayMonthLabel" stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => `€${value}`} />
                    <Tooltip contentStyle={chartTooltipContentStyle} formatter={(value) => formatEuro(Number(value), { signed: true })} />
                    <Legend iconType="circle" />
                    <Bar dataKey="amount" name="Net flow">
                      {accountMovementRows.map((entry) => (
                        <Cell
                          key={`${entry.monthLabel}-${entry.segment}`}
                          fill={
                            entry.segment === "In"
                              ? "hsl(var(--accent-primary))"
                              : entry.segment === "Out"
                                ? "hsl(var(--accent-tertiary))"
                                : entry.segment === "Investing"
                                  ? "hsl(var(--accent-secondary))"
                                  : entry.segment === "Transfers"
                                    ? "hsl(var(--accent-quaternary))"
                                    : "hsl(var(--accent-primary))"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </details>
        </div>

        <div className="section">
          <details className="details">
            <summary>Reserve fund activity</summary>
            <DataTable
              density="compact"
              rows={reserveRows
                .slice()
                .sort((left, right) => right.date.localeCompare(left.date))
                .map((row) => ({
                  date: formatDisplayDate(row.date),
                  action: row.paymentLabel,
                  fund: row.fund,
                  isin: row.isin,
                  units: row.units.toFixed(4),
                  price: formatEuro(row.pricePerUnit),
                  amount: row.amount,
                }))}
              columns={[
                { key: "date", label: "Date", cellClassName: "cell-nowrap" },
                { key: "action", label: "Action" },
                { key: "fund", label: "Fund" },
                { key: "isin", label: "ISIN", cellClassName: "cell-nowrap" },
                { key: "units", label: "Units", align: "right", cellClassName: "cell-nowrap" },
                { key: "price", label: "Price per unit", align: "right", cellClassName: "cell-nowrap" },
                { key: "amount", label: "Amount", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
              ]}
            />
          </details>
        </div>

        <div className="section">
          <details className="details">
            <summary>Investment trades</summary>
            <DataTable
              density="compact"
              rows={investmentRows
                .slice()
                .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
                .map((row) => ({
                  rowId: row.rowId,
                  date: formatDisplayDate(row.date),
                  merchant: row.merchant,
                  category: row.categoryLabel,
                  categoryKey: row.category,
                  categoryLabel: row.categoryLabel,
                  amount: row.signedAmount,
                  description: row.description,
                }))}
              columns={[
                { key: "date", label: "Date", cellClassName: "cell-nowrap" },
                { key: "merchant", label: "Merchant" },
                { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
                { key: "amount", label: "Amount", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
                { key: "description", label: "Description", cellClassName: "cell-description" },
              ]}
            />
          </details>
        </div>
      </Section>

      <DetailSheet open={Boolean(detail)} detail={detail} onClose={() => setDetail(null)} />
    </DashboardShell>
  );
}
