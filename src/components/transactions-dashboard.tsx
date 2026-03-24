"use client";

import { useDeferredValue, useMemo, useState } from "react";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  applyTransactionFilters,
  formatAsOfDate,
  formatDisplayDate,
  formatEuro,
  incompleteMonthLabels,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import {
  CategoryEditor,
  DashboardShell,
  DataTable,
  FilterBar,
  PageToolbar,
  SignedAmount,
  defaultFilterState,
} from "./dashboard-ui";

function sumPositive(values: { signedAmount: number }[]) {
  return values.reduce((sum, row) => sum + (row.signedAmount > 0 ? row.signedAmount : 0), 0);
}

function sumNegativeAbsolute(values: { signedAmount: number }[]) {
  return values.reduce((sum, row) => sum + (row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0), 0);
}

export function TransactionsDashboard({ transactions }: { transactions: TransactionRecord[] }) {
  const dates = uniqueTransactionDates(transactions);
  const [filters, setFilters] = useState(() => defaultFilterState(dates));
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedType, setSelectedType] = useState("");
  const [selectedDirection, setSelectedDirection] = useState<"" | "in" | "out">("");
  const [sortKey, setSortKey] = useState<"date_desc" | "date_asc" | "amount_desc" | "amount_asc">("date_desc");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim().toLowerCase());

  const baseTransactions = applyTransactionFilters(transactions, filters);
  const filteredTransactions = useMemo(() => {
    const visible = baseTransactions.filter((row) => {
      if (deferredSearchQuery) {
        const haystack = `${row.date} ${formatDisplayDate(row.date)} ${row.merchant} ${row.description} ${row.txType} ${row.categoryLabel} ${row.groupLabel}`.toLowerCase();
        if (!haystack.includes(deferredSearchQuery)) {
          return false;
        }
      }
      if (selectedGroup && row.group !== selectedGroup) {
        return false;
      }
      if (selectedCategories.length > 0 && !selectedCategories.includes(row.category)) {
        return false;
      }
      if (selectedSource && row.classificationSource !== selectedSource) {
        return false;
      }
      if (selectedType && row.txType !== selectedType) {
        return false;
      }
      if (selectedDirection === "in" && row.signedAmount <= 0) {
        return false;
      }
      if (selectedDirection === "out" && row.signedAmount >= 0) {
        return false;
      }
      if (needsReviewOnly && !row.needsReview) {
        return false;
      }
      return true;
    });

    return visible.slice().sort((left, right) => {
      if (sortKey === "date_asc") {
        return `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`);
      }
      if (sortKey === "amount_desc") {
        return Math.abs(right.signedAmount) - Math.abs(left.signedAmount);
      }
      if (sortKey === "amount_asc") {
        return Math.abs(left.signedAmount) - Math.abs(right.signedAmount);
      }
      return `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`);
    });
  }, [
    baseTransactions,
    deferredSearchQuery,
    needsReviewOnly,
    selectedCategories,
    selectedDirection,
    selectedGroup,
    selectedSource,
    selectedType,
    sortKey,
  ]);

  const groupOptions = baseTransactions
    .map((row) => ({ value: row.group, label: row.groupLabel }))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.value === item.value) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
  const categoryOptions = baseTransactions
    .map((row) => ({ value: row.category, label: row.categoryLabel }))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.value === item.value) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
  const sourceOptions = baseTransactions
    .map((row) => ({ value: row.classificationSource, label: row.classificationSourceLabel }))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.value === item.value) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
  const typeOptions = baseTransactions
    .map((row) => row.txType)
    .filter((item, index, array) => array.indexOf(item) === index)
    .sort((left, right) => left.localeCompare(right));
  const topCategoryOptions = useMemo(
    () =>
      Object.values(
        baseTransactions.reduce<Record<string, { value: string; label: string; amount: number }>>((acc, row) => {
          if (!acc[row.category]) {
            acc[row.category] = {
              value: row.category,
              label: row.categoryLabel,
              amount: 0,
            };
          }
          acc[row.category].amount += Math.abs(row.signedAmount);
          return acc;
        }, {}),
      )
        .sort((left, right) => right.amount - left.amount)
        .slice(0, 10),
    [baseTransactions],
  );
  const activeWindowLabel = filters.activeQuickLabel
    ? `${filters.activeQuickKind === "month" ? "Month" : "Year"}: ${filters.activeQuickLabel}`
    : "All data";
  const partialMonths = incompleteMonthLabels(filters);
  const latestBalance = filteredTransactions[0]?.balance ?? baseTransactions.at(-1)?.balance ?? 0;
  const activeLocalFilterCount =
    Number(Boolean(selectedGroup)) +
    selectedCategories.length +
    Number(Boolean(selectedSource)) +
    Number(Boolean(selectedType)) +
    Number(Boolean(selectedDirection)) +
    Number(needsReviewOnly);
  const localFilterSummary =
    activeLocalFilterCount === 0 ? "No extra filters" : `${activeLocalFilterCount} active`;
  const selectedGroupLabel = groupOptions.find((option) => option.value === selectedGroup)?.label ?? "";
  const selectedSourceLabel = sourceOptions.find((option) => option.value === selectedSource)?.label ?? "";
  const selectedCategoryLabels = selectedCategories
    .map((value) => categoryOptions.find((option) => option.value === value)?.label ?? value)
    .slice(0, 3);
  const searchSummary = searchQuery.trim();

  const rows = filteredTransactions.map((row) => ({
    rowId: row.rowId,
    date: formatDisplayDate(row.date),
    txType: row.txType,
    merchant: row.merchant,
    description: row.description,
    group: row.groupLabel,
    category: row.categoryLabel,
    categoryKey: row.category,
    categoryLabel: row.categoryLabel,
    signedAmount: row.signedAmount,
    amount: row.signedAmount,
    balance: row.balance,
    source: row.classificationSourceLabel,
    needsReview: row.needsReview ? "Check" : "",
  }));

  const clearLocalFilters = () => {
    setSearchQuery("");
    setSelectedGroup("");
    setSelectedCategories([]);
    setSelectedSource("");
    setSelectedType("");
    setSelectedDirection("");
    setSortKey("date_desc");
    setNeedsReviewOnly(false);
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category],
    );
  };

  return (
    <DashboardShell
      kicker="Transactions"
      title="Full transaction ledger"
      description="Search, filter, and correct the ledger."
      meta={`Updated as of ${formatAsOfDate(transactions.at(-1)?.date ?? filters.endDate)}`}
    >
      <PageToolbar
        items={[
          activeWindowLabel,
          searchSummary ? `Search: ${searchSummary}` : "",
          selectedDirection === "in" ? "Money in only" : selectedDirection === "out" ? "Money out only" : "",
          selectedGroupLabel ? `Group: ${selectedGroupLabel}` : "",
          ...selectedCategoryLabels.map((label) => `Category: ${label}`),
          selectedCategories.length > selectedCategoryLabels.length
            ? `+${selectedCategories.length - selectedCategoryLabels.length} more categories`
            : "",
          selectedType ? `Type: ${selectedType}` : "",
          selectedSourceLabel ? `Source: ${selectedSourceLabel}` : "",
          needsReviewOnly ? "Needs checking only" : "",
          partialMonths.length > 0 ? `Partial months: ${partialMonths.join(", ")}` : "",
        ]}
      >
        <div className="ledger-toolbar-main">
          <FilterBar dates={dates} filters={filters} onChange={setFilters} compact summaryLabel="Period" />
          <div className="ledger-search-field field">
            <label htmlFor="transactionSearch">Search</label>
            <input
              id="transactionSearch"
              value={searchQuery}
              placeholder="Merchant, description, type, date"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div className="ledger-select-field field">
            <label htmlFor="transactionSort">Sort</label>
            <select id="transactionSort" value={sortKey} onChange={(event) => setSortKey(event.target.value as typeof sortKey)}>
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="amount_desc">Largest amount</option>
              <option value="amount_asc">Smallest amount</option>
            </select>
          </div>
          <div className="ledger-filter-actions">
            <button type="button" className="quick-button quick-button-ghost" onClick={clearLocalFilters}>
              Reset
            </button>
          </div>
        </div>

        <details className="details ledger-local-details">
          <summary>
            <span className="filterbar-summary-title">More filters</span>
            <span className="filterbar-summary-meta">{localFilterSummary}</span>
            {needsReviewOnly ? <span className="filterbar-summary-badge">Needs checking</span> : null}
          </summary>
          <div className="ledger-filter-bar">
            <div className="ledger-filter-top">
              <div className="ledger-select-field field">
                <label htmlFor="transactionCategoryAdd">Add category</label>
                <select
                  id="transactionCategoryAdd"
                  value=""
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value && !selectedCategories.includes(value)) {
                      setSelectedCategories((current) => [...current, value]);
                    }
                    event.currentTarget.value = "";
                  }}
                >
                  <option value="">Add category filter</option>
                  {categoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ledger-filter-actions">
                <button
                  type="button"
                  className="quick-button"
                  data-active={needsReviewOnly}
                  onClick={() => setNeedsReviewOnly((current) => !current)}
                >
                  Needs checking only
                </button>
              </div>
            </div>

            <div className="ledger-filter-rows">
              <div className="ledger-filter-row">
                <h3 className="ledger-filter-label">Flow</h3>
                <div className="ledger-chip-strip">
                  <button type="button" className="quick-button" data-active={!selectedDirection} onClick={() => setSelectedDirection("")}>
                    All
                  </button>
                  <button type="button" className="quick-button" data-active={selectedDirection === "in"} onClick={() => setSelectedDirection("in")}>
                    Money in
                  </button>
                  <button type="button" className="quick-button" data-active={selectedDirection === "out"} onClick={() => setSelectedDirection("out")}>
                    Money out
                  </button>
                </div>
              </div>

              <div className="ledger-filter-row">
                <h3 className="ledger-filter-label">Group</h3>
                <div className="ledger-chip-strip">
                  <button type="button" className="quick-button" data-active={!selectedGroup} onClick={() => setSelectedGroup("")}>
                    All
                  </button>
                  {groupOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="quick-button"
                      data-active={selectedGroup === option.value}
                      onClick={() => setSelectedGroup((current) => (current === option.value ? "" : option.value))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ledger-filter-row">
                <h3 className="ledger-filter-label">Categories</h3>
                <div className="ledger-chip-strip">
                  {topCategoryOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="quick-button"
                      data-active={selectedCategories.includes(option.value)}
                      onClick={() => toggleCategory(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="ledger-advanced-grid">
              <div className="field">
                <label htmlFor="transactionType">Type</label>
                <select id="transactionType" value={selectedType} onChange={(event) => setSelectedType(event.target.value)}>
                  <option value="">All types</option>
                  {typeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="transactionSource">Classification source</label>
                <select id="transactionSource" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}>
                  <option value="">All sources</option>
                  {sourceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </details>
      </PageToolbar>

      <div className="ledger-summary-strip" aria-label="Ledger summary">
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Rows</span>
          <strong>{filteredTransactions.length.toLocaleString("en-US")}</strong>
        </div>
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Money in</span>
          <strong>{formatEuro(sumPositive(filteredTransactions))}</strong>
        </div>
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Money out</span>
          <strong>{formatEuro(sumNegativeAbsolute(filteredTransactions))}</strong>
        </div>
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Last visible balance</span>
          <strong>{formatEuro(latestBalance)}</strong>
        </div>
      </div>

      <DataTable
        density="compact"
        rows={rows}
        emptyMessage="No transactions match the current filters."
        columns={[
          { key: "date", label: "Date", cellClassName: "cell-nowrap" },
          { key: "txType", label: "Type", cellClassName: "cell-nowrap" },
          { key: "merchant", label: "Merchant" },
          { key: "description", label: "Description", cellClassName: "cell-description" },
          { key: "group", label: "Group", cellClassName: "cell-nowrap" },
          { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
          { key: "amount", label: "Amount", align: "right", cellClassName: "cell-nowrap", render: (value) => <SignedAmount value={Number(value)} /> },
          { key: "balance", label: "Balance", align: "right", cellClassName: "cell-nowrap", render: (value) => <span>{formatEuro(Number(value))}</span> },
          { key: "source", label: "Source" },
          { key: "needsReview", label: "Check", cellClassName: "cell-nowrap" },
        ]}
      />
    </DashboardShell>
  );
}
