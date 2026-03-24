"use client";

import { useState, type CSSProperties } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Bar,
} from "recharts";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  annotateMonthLabel,
  applyTransactionFilters,
  formatEuro,
  formatAsOfDate,
  formatDateRange,
  formatDisplayDate,
  formatPercent,
  incompleteMonthLabels,
  sumIncome,
  sumInvesting,
  summarizeMonthlyStory,
  sumNetResult,
  sumSpending,
  SPENDING_BUCKETS,
  topIncomeSources,
  topSpendingCategories,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import type { DetailView } from "./dashboard-ui";
import { CategoryBadge, CategoryEditor, ClickableMetricGrid, DashboardShell, DataTable, DetailSheet, FilterBar, PageToolbar, Panel, Section, SignedAmount, chartTooltipContentStyle, defaultFilterState } from "./dashboard-ui";

const CATEGORY_COLORS = [
  "hsl(var(--accent-primary))",
  "hsl(var(--accent-secondary))",
  "hsl(var(--accent-tertiary))",
  "hsl(var(--accent-quaternary))",
  "hsl(280 100% 70%)", // Purple
  "hsl(190 100% 50%)", // Cyan
  "hsl(150 100% 50%)", // Mint
  "hsl(350 100% 70%)", // Rose
];

export function OverviewDashboard({ transactions }: { transactions: TransactionRecord[] }) {
  const dates = uniqueTransactionDates(transactions);
  const [filters, setFilters] = useState(() => defaultFilterState(dates));
  const [detail, setDetail] = useState<DetailView | null>(null);

  const filteredTransactions = applyTransactionFilters(transactions, filters);
  const partialMonths = incompleteMonthLabels(filters);
  const monthly = summarizeMonthlyStory(filteredTransactions).map((row) => ({
    ...row,
    displayMonthLabel: annotateMonthLabel(row.monthLabel, filters),
  }));
  const categories = topSpendingCategories(filteredTransactions);
  const incomeSources = topIncomeSources(filteredTransactions);
  const activeWindowLabel = filters.activeQuickLabel ? `${filters.activeQuickKind === "month" ? "Month" : "Year"}: ${filters.activeQuickLabel}` : "All data";
  const kpiScopeNote =
    filters.activeQuickKind === "month"
      ? filters.activeQuickLabel
      : filters.activeQuickKind === "year"
        ? `${filters.activeQuickLabel} total`
        : "Across all data";
  const incomeTotal = sumIncome(filteredTransactions);
  const spendingTotal = sumSpending(filteredTransactions);
  const investingTotal = sumInvesting(filteredTransactions);
  const netResultTotal = sumNetResult(filteredTransactions);
  const incomeSourcesWithShare = incomeSources.map((row) => ({
    ...row,
    share: incomeTotal > 0 ? (row.amount / incomeTotal) * 100 : 0,
  }));
  const spendingCategoriesWithShare = categories.map((row) => ({
    ...row,
    share: spendingTotal > 0 ? (row.amount / spendingTotal) * 100 : 0,
  }));

  const buildSummary = (rows: typeof filteredTransactions) => {
    const total = rows.reduce((sum, row) => sum + row.signedAmount, 0);
    const allOutflows = rows.length > 0 && rows.every((row) => row.signedAmount <= 0);
    return [
      { label: "Rows", value: rows.length.toLocaleString("en-US") },
      {
        label: allOutflows ? "Outflow" : "Net amount",
        value: allOutflows ? formatEuro(Math.abs(total)) : formatEuro(total, { signed: true }),
      },
      { label: "Range", value: formatDateRange(filters.startDate, filters.endDate) },
    ];
  };

  const metricItems = [
    {
      label: "In",
      value: formatEuro(incomeTotal),
      note: kpiScopeNote,
    },
    {
      label: "Out",
      value: formatEuro(spendingTotal),
      note: kpiScopeNote,
    },
    {
      label: "Money invested",
      value: formatEuro(investingTotal),
      note: kpiScopeNote,
    },
    {
      label: "Net result",
      value: formatEuro(netResultTotal, { signed: true }),
      note: kpiScopeNote,
    },
  ];

  const openTransactionDetail = (title: string, rows: typeof filteredTransactions, meta?: string) => {
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
          txType: row.txType,
          description: row.description,
          merchant: row.merchant,
          category: row.categoryLabel,
          categoryKey: row.category,
          categoryLabel: row.categoryLabel,
          signedAmount: row.signedAmount,
          amount: row.signedAmount,
        })),
      columns: [
        { key: "date", label: "Date" },
        { key: "merchant", label: "Merchant" },
        { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
        { key: "amount", label: "Amount", render: (value) => <SignedAmount value={Number(value)} /> },
      ],
    });
  };

  const openMetricDetail = (label: string) => {
    if (label === "In") {
      openTransactionDetail("In transactions", filteredTransactions.filter((row) => row.group === "income" && row.signedAmount > 0));
      return;
    }
    if (label === "Out") {
      openTransactionDetail("Out transactions", filteredTransactions.filter((row) => SPENDING_BUCKETS.has(row.cashflowBucket) && row.signedAmount < 0));
      return;
    }
    if (label === "Money invested") {
      openTransactionDetail("Investment transactions", filteredTransactions.filter((row) => row.group === "investment"));
      return;
    }
    openTransactionDetail("All transactions in view", filteredTransactions);
  };

  return (
    <DashboardShell
      kicker="Home"
      description="Cashflow summary for the selected period."
      meta={`Updated as of ${formatAsOfDate(transactions.at(-1)?.date ?? filters.endDate)}`}
    >
      <PageToolbar
        items={[
          activeWindowLabel,
          filters.excludeIncompleteMonths ? "Incomplete last month hidden" : "",
          partialMonths.length > 0 ? `Includes partial months: ${partialMonths.join(", ")}` : "",
        ]}
      >
        <FilterBar dates={dates} filters={filters} onChange={setFilters} compact summaryLabel="Period" />
      </PageToolbar>

      <ClickableMetricGrid items={metricItems} onSelect={(item) => openMetricDetail(item.label)} />

      <Section
        title="Monthly flow"
        note="In, out, investing, and net result over time."
      >
        <div className="panel">
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={monthly}
                onClick={(state: any) => {
                  const payload = state?.activePayload?.[0]?.payload as { monthLabel?: string; displayMonthLabel?: string } | undefined;
                  const monthLabel = payload?.monthLabel;
                  const displayMonthLabel = payload?.displayMonthLabel;
                  if (!monthLabel) {
                    return;
                  }
                  openTransactionDetail(
                    `Transactions in ${displayMonthLabel ?? monthLabel}`,
                    filteredTransactions.filter((row) => row.monthLabel === monthLabel),
                    `Month: ${displayMonthLabel ?? monthLabel}`,
                  );
                }}
              >
                <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
                <XAxis dataKey="displayMonthLabel" stroke="hsl(var(--text-muted))" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                <YAxis stroke="hsl(var(--text-muted))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
                <Tooltip 
                  contentStyle={chartTooltipContentStyle}
                  itemStyle={{ fontSize: "13px", fontWeight: "600" }}
                  formatter={(value) => formatEuro(Number(value ?? 0))} 
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: "20px" }} />
                <Bar dataKey="income" name="In" fill="hsl(var(--accent-primary))" barSize={24} />
                <Bar dataKey="spending" name="Out" fill="hsl(var(--accent-secondary))" barSize={24} />
                <Bar dataKey="investing" name="Investing" fill="hsl(var(--accent-tertiary))" barSize={24} />
                <Line 
                  type="monotone" 
                  dataKey="netResult" 
                  name="Net result" 
                  stroke="hsl(var(--accent-quaternary))" 
                  strokeWidth={4} 
                  dot={{ r: 6, fill: "hsl(var(--accent-quaternary))", strokeWidth: 2, stroke: "hsl(var(--bg))" }} 
                  activeDot={{ r: 8, strokeWidth: 0 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Section>

      <Section
        title="Main drivers"
        note="The biggest drivers of money in and money out in the current view."
      >
        <div className="panel-grid">
          <Panel
            title="Top income sources"
            note="Who or what is sending the most income."
          >
            <DataTable
              density="compact"
              rows={incomeSourcesWithShare.map((row) => ({
                merchant: row.merchant,
                category: row.categoryLabel,
                categoryKey: filteredTransactions.find((item) => item.merchant === row.merchant && item.categoryLabel === row.categoryLabel)?.category ?? "other",
                categoryLabel: row.categoryLabel,
                share: row.share,
                amount: row.amount,
              }))}
              columns={[
                {
                  key: "merchant",
                  label: "Source",
                  render: (value, row) => (
                    <button
                      type="button"
                      className="table-link-button"
                      onClick={() =>
                        openTransactionDetail(
                          `${String(value)} income`,
                          filteredTransactions.filter(
                            (item) =>
                              item.group === "income" &&
                              item.signedAmount > 0 &&
                              item.merchant === String(value) &&
                              item.categoryLabel === String(row.categoryLabel ?? row.category ?? ""),
                          ),
                          `Source: ${String(value)}`,
                        )
                      }
                    >
                      {String(value)}
                    </button>
                  ),
                },
                { key: "category", label: "Category", render: (_value, row) => <CategoryBadge category={String(row.categoryKey ?? "other")} label={String(row.categoryLabel ?? row.category ?? "")} /> },
                { key: "share", label: "Share", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatPercent(Number(value))}</span> },
                { key: "amount", label: "Amount", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
              ]}
            />
          </Panel>

          <Panel
            title="Spending categories"
            note="Tap a bubble to inspect the category transactions behind the spend."
          >
            {spendingCategoriesWithShare.length === 0 ? (
              <div className="empty">No spending categories are available in this view.</div>
            ) : (
              <div className="category-bubble-strip" aria-label="Spending categories">
                {spendingCategoriesWithShare.map((entry, index) => (
                  <button
                    key={entry.categoryLabel}
                    type="button"
                    className="category-bubble"
                    style={
                      {
                        "--bubble-color": CATEGORY_COLORS[index % CATEGORY_COLORS.length],
                      } as CSSProperties
                    }
                    onClick={() =>
                      openTransactionDetail(
                        `${entry.categoryLabel} expenses`,
                        filteredTransactions.filter((row) => SPENDING_BUCKETS.has(row.cashflowBucket) && row.categoryLabel === entry.categoryLabel),
                        `Category: ${entry.categoryLabel}`,
                      )
                    }
                  >
                    <span className="category-bubble-head">
                      <span className="category-bubble-dot" />
                      <span className="category-bubble-label">{entry.categoryLabel}</span>
                    </span>
                    <span className="category-bubble-share">{formatPercent(entry.share)}</span>
                    <span className="category-bubble-amount">{formatEuro(entry.amount)}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </Section>

      <DetailSheet open={Boolean(detail)} detail={detail} onClose={() => setDetail(null)} />
    </DashboardShell>
  );
}
