"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildCategoryOptionGroupsForAmount, buildCategoryOptions, categoryLabel, deriveGroupFromCategory } from "@/lib/category-config";
import type { ManualTransactionRecord, RowOverrideRecord } from "@/lib/config-store";
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

type ManualTransactionDraft = {
  date: string;
  signedAmount: string;
  category: string;
  merchant: string;
  description: string;
  transactionType: string;
};

function createManualDraft(defaultDate: string): ManualTransactionDraft {
  return {
    date: defaultDate,
    signedAmount: "",
    category: "other",
    merchant: "",
    description: "",
    transactionType: "Manual",
  };
}

export function TransactionsDashboard({
  transactions,
  rowOverrides,
  manualTransactions,
}: {
  transactions: TransactionRecord[];
  rowOverrides: RowOverrideRecord[];
  manualTransactions: ManualTransactionRecord[];
}) {
  const router = useRouter();
  const [isRefreshingData, startRefreshTransition] = useTransition();
  const dates = uniqueTransactionDates(transactions);
  const latestKnownDate = dates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState(() => defaultFilterState(dates));
  const [rowOverridesState, setRowOverridesState] = useState(rowOverrides);
  const [manualTransactionsState, setManualTransactionsState] = useState(manualTransactions);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedType, setSelectedType] = useState("");
  const [selectedDirection, setSelectedDirection] = useState<"" | "in" | "out">("");
  const [sortKey, setSortKey] = useState<"date_desc" | "date_asc" | "amount_desc" | "amount_asc">("date_desc");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [selectedReviewRows, setSelectedReviewRows] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState("other");
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualTransactionDraft>(() => createManualDraft(latestKnownDate));
  const [isSavingManual, setIsSavingManual] = useState(false);
  const [manualError, setManualError] = useState("");
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
  const reviewRows = useMemo(
    () =>
      filteredTransactions
        .filter((row) => row.needsReview)
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`)),
    [filteredTransactions],
  );
  const rowOverrideIds = useMemo(() => new Set(rowOverridesState.map((item) => item.rowId)), [rowOverridesState]);
  const selectedRows = useMemo(
    () => reviewRows.filter((row) => selectedReviewRows.includes(row.rowId)),
    [reviewRows, selectedReviewRows],
  );
  const selectedOverrideIds = useMemo(
    () => selectedRows.filter((row) => rowOverrideIds.has(row.rowId)).map((row) => row.rowId),
    [rowOverrideIds, selectedRows],
  );

  useEffect(() => {
    const visibleRowIds = new Set(reviewRows.map((row) => row.rowId));
    setSelectedReviewRows((current) => current.filter((rowId) => visibleRowIds.has(rowId)));
  }, [reviewRows]);

  useEffect(() => {
    setRowOverridesState(rowOverrides);
  }, [rowOverrides]);

  useEffect(() => {
    setManualTransactionsState(manualTransactions);
  }, [manualTransactions]);

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
  const manualCategoryGroups = buildCategoryOptionGroupsForAmount(
    Number(manualDraft.signedAmount || "0"),
    manualDraft.category,
  );

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
  const reviewTableRows = reviewRows.slice(0, 120).map((row) => ({
    selected: selectedReviewRows.includes(row.rowId),
    rowId: row.rowId,
    date: formatDisplayDate(row.date),
    merchant: row.merchant,
    description: row.description,
    txType: row.txType,
    category: row.categoryLabel,
    categoryKey: row.category,
    categoryLabel: row.categoryLabel,
    signedAmount: row.signedAmount,
    amount: row.signedAmount,
    source: row.classificationSourceLabel,
  }));
  const manualRows = manualTransactionsState
    .slice()
    .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
    .slice(0, 12)
    .map((row) => ({
      rowId: row.rowId,
      date: formatDisplayDate(row.date),
      merchant: row.merchant || "Manual entry",
      description: row.description,
      category: categoryLabel(row.category),
      categoryKey: row.category,
      categoryLabel: categoryLabel(row.category),
      amount: row.signedAmount,
      txType: row.transactionType || "Manual",
      action: row.rowId,
    }));

  const syncOverrides = async (response: Response) => {
    const payload = (await response.json()) as { overrides: RowOverrideRecord[] };
    setRowOverridesState(payload.overrides);
    setSelectedReviewRows([]);
    startRefreshTransition(() => router.refresh());
  };

  const syncManualTransactions = async (response: Response) => {
    const payload = (await response.json()) as { transactions: ManualTransactionRecord[] };
    setManualTransactionsState(payload.transactions);
    startRefreshTransition(() => router.refresh());
  };

  const clearLocalFilters = () => {
    setSearchQuery("");
    setSelectedGroup("");
    setSelectedCategories([]);
    setSelectedSource("");
    setSelectedType("");
    setSelectedDirection("");
    setSortKey("date_desc");
    setNeedsReviewOnly(false);
    setSelectedReviewRows([]);
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category],
    );
  };

  const upsertOverrides = async (mode: "categorize" | "clear_review") => {
    if (selectedRows.length === 0 || isSavingReview || isRefreshingData) {
      return;
    }

    const overrides = selectedRows.map((row) => ({
      rowId: row.rowId,
      description: row.description,
      transactionType: row.txType,
      signedAmount: row.signedAmount,
      merchant: row.merchant,
      group: deriveGroupFromCategory(mode === "categorize" ? bulkCategory : row.category),
      category: mode === "categorize" ? bulkCategory : row.category,
      subcategory: "row_override",
      confidence: 0.99,
      needsReview: false,
      source: "row_override",
      updatedAt: new Date().toISOString(),
    }));

    setIsSavingReview(true);
    try {
      const response = await fetch("/api/row-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      if (!response.ok) {
        return;
      }

      await syncOverrides(response);
    } finally {
      setIsSavingReview(false);
    }
  };

  const deleteSelectedOverrides = async () => {
    if (selectedOverrideIds.length === 0 || isSavingReview || isRefreshingData) {
      return;
    }

    setIsSavingReview(true);
    try {
      const response = await fetch("/api/row-overrides", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIds: selectedOverrideIds }),
      });
      if (!response.ok) {
        return;
      }

      await syncOverrides(response);
    } finally {
      setIsSavingReview(false);
    }
  };

  const submitManualTransaction = async () => {
    const signedAmount = Number(manualDraft.signedAmount);
    if (!manualDraft.date || !Number.isFinite(signedAmount) || signedAmount === 0 || !manualDraft.category) {
      setManualError("Date, category, and a non-zero amount are required.");
      return;
    }

    setIsSavingManual(true);
    setManualError("");
    try {
      const response = await fetch("/api/manual-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: {
            date: manualDraft.date,
            transactionType: manualDraft.transactionType,
            merchant: manualDraft.merchant,
            description: manualDraft.description,
            signedAmount,
            category: manualDraft.category,
            subcategory: "manual_entry",
          },
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        setManualError(payload?.message ?? "Could not save the manual transaction.");
        return;
      }

      await syncManualTransactions(response);
      setManualDraft(createManualDraft(manualDraft.date));
    } finally {
      setIsSavingManual(false);
    }
  };

  const deleteManualTransaction = async (rowId: string) => {
    if (!rowId || isSavingManual || isRefreshingData) {
      return;
    }

    setIsSavingManual(true);
    setManualError("");
    try {
      const response = await fetch("/api/manual-transactions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        setManualError(payload?.message ?? "Could not delete the manual transaction.");
        return;
      }

      await syncManualTransactions(response);
    } finally {
      setIsSavingManual(false);
    }
  };

  return (
    <DashboardShell
      kicker="Transactions"
      title="Ledger and review"
      description="Search, fix, and clear the review queue from one place."
      meta={`Updated as of ${formatAsOfDate(transactions.at(-1)?.date ?? filters.endDate)}`}
    >
      <PageToolbar
        items={[
          activeWindowLabel,
          `Needs checking: ${reviewRows.length.toLocaleString("en-US")}`,
          `Overrides: ${rowOverridesState.length.toLocaleString("en-US")}`,
          `Manual entries: ${manualTransactionsState.length.toLocaleString("en-US")}`,
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
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Needs checking</span>
          <strong>{reviewRows.length.toLocaleString("en-US")}</strong>
        </div>
        <div className="ledger-summary-item">
          <span className="ledger-summary-label">Manual entries</span>
          <strong>{manualTransactionsState.length.toLocaleString("en-US")}</strong>
        </div>
      </div>

      <details className="details ledger-local-details ledger-details">
        <summary>
          <span className="filterbar-summary-title">Manual transaction</span>
          <span className="filterbar-summary-meta">Add cashflow that is missing from the imported ledger</span>
          {manualTransactionsState.length > 0 ? (
            <span className="filterbar-summary-badge">{manualTransactionsState.length} saved</span>
          ) : null}
        </summary>
        <div className="ledger-filter-bar">
          <div className="manual-transaction-grid">
            <div className="field">
              <label htmlFor="manualDate">Date</label>
              <input
                id="manualDate"
                type="date"
                value={manualDraft.date}
                min={dates[0]}
                max={today}
                onChange={(event) => setManualDraft((current) => ({ ...current, date: event.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="manualAmount">Amount</label>
              <input
                id="manualAmount"
                type="number"
                step="0.01"
                placeholder="-18.40 or 2500"
                value={manualDraft.signedAmount}
                onChange={(event) => setManualDraft((current) => ({ ...current, signedAmount: event.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="manualCategory">Category</label>
              <select
                id="manualCategory"
                value={manualDraft.category}
                onChange={(event) => setManualDraft((current) => ({ ...current, category: event.target.value }))}
              >
                {manualCategoryGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="manualType">Type</label>
              <input
                id="manualType"
                value={manualDraft.transactionType}
                placeholder="Manual"
                onChange={(event) => setManualDraft((current) => ({ ...current, transactionType: event.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="manualMerchant">Merchant</label>
              <input
                id="manualMerchant"
                value={manualDraft.merchant}
                placeholder="Merchant or source"
                onChange={(event) => setManualDraft((current) => ({ ...current, merchant: event.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="manualDescription">Description</label>
              <input
                id="manualDescription"
                value={manualDraft.description}
                placeholder="What happened"
                onChange={(event) => setManualDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </div>
          </div>

          <div className="button-row">
            <button
              type="button"
              className="quick-button"
              onClick={() => void submitManualTransaction()}
              disabled={isSavingManual || isRefreshingData}
            >
              Add transaction
            </button>
            <button
              type="button"
              className="quick-button quick-button-ghost"
              onClick={() => {
                setManualDraft(createManualDraft(latestKnownDate));
                setManualError("");
              }}
              disabled={isSavingManual || isRefreshingData}
            >
              Clear form
            </button>
            <span className="helper-copy">Use negative amounts for money out and positive amounts for money in.</span>
          </div>
          {manualError ? <div className="table-action-error">{manualError}</div> : null}

          <DataTable
            density="compact"
            rows={manualRows}
            emptyMessage="No manual transactions saved yet."
            columns={[
              { key: "date", label: "Date", cellClassName: "cell-nowrap" },
              { key: "txType", label: "Type", cellClassName: "cell-nowrap" },
              { key: "merchant", label: "Merchant" },
              { key: "description", label: "Description", cellClassName: "cell-description" },
              { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
              {
                key: "amount",
                label: "Amount",
                align: "right",
                cellClassName: "cell-nowrap",
                render: (value) => <SignedAmount value={Number(value)} />,
              },
              {
                key: "action",
                label: "",
                align: "right",
                cellClassName: "cell-nowrap",
                render: (_value, row) => (
                  <button
                    type="button"
                    className="table-action-button table-action-button-secondary"
                    onClick={() => void deleteManualTransaction(String(row.rowId))}
                    disabled={isSavingManual || isRefreshingData}
                  >
                    Delete
                  </button>
                ),
              },
            ]}
          />
        </div>
      </details>

      <details className="details ledger-local-details ledger-details">
        <summary>
          <span className="filterbar-summary-title">Review queue</span>
          <span className="filterbar-summary-meta">
            {reviewRows.length === 0
              ? "Nothing needs checking in this view"
              : `${reviewRows.length.toLocaleString("en-US")} rows need checking`}
          </span>
          {selectedReviewRows.length > 0 ? (
            <span className="filterbar-summary-badge">{selectedReviewRows.length} selected</span>
          ) : null}
        </summary>
        <div className="ledger-filter-bar">
          <div className="button-row">
            <div className="field">
              <label htmlFor="reviewBulkCategory">Category</label>
              <select id="reviewBulkCategory" value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}>
                {buildCategoryOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
              <button
                type="button"
                className="quick-button"
                onClick={() => void upsertOverrides("categorize")}
                disabled={selectedRows.length === 0 || isSavingReview || isRefreshingData}
              >
                Change category
              </button>
              <button
                type="button"
                className="quick-button"
                onClick={() => void upsertOverrides("clear_review")}
                disabled={selectedRows.length === 0 || isSavingReview || isRefreshingData}
              >
                Clear needs checking
              </button>
              <button
                type="button"
                className="quick-button quick-button-ghost"
                onClick={() => void deleteSelectedOverrides()}
                disabled={selectedOverrideIds.length === 0 || isSavingReview || isRefreshingData}
              >
                Delete row override
              </button>
            <span className="helper-copy">
              {selectedRows.length === 0
                ? "Select rows below to fix them in bulk."
                : `${selectedRows.length} selected${selectedOverrideIds.length > 0 ? ` · ${selectedOverrideIds.length} with overrides` : ""}`}
            </span>
          </div>

          <DataTable
            density="compact"
            rows={reviewTableRows}
            emptyMessage="No rows currently need checking."
            columns={[
              {
                key: "selected",
                label: "",
                render: (_value, row) => (
                  <input
                    type="checkbox"
                    checked={selectedReviewRows.includes(String(row.rowId))}
                    onChange={(event) =>
                      setSelectedReviewRows((current) =>
                        event.target.checked
                          ? [...current, String(row.rowId)]
                          : current.filter((value) => value !== String(row.rowId)),
                      )
                    }
                  />
                ),
                width: 42,
                cellClassName: "cell-nowrap",
              },
              { key: "date", label: "Date", cellClassName: "cell-nowrap" },
              { key: "merchant", label: "Merchant" },
              { key: "description", label: "Description", cellClassName: "cell-description" },
              { key: "category", label: "Category", render: (_value, row) => <CategoryEditor row={row} /> },
              {
                key: "amount",
                label: "Amount",
                align: "right",
                cellClassName: "cell-nowrap",
                render: (value) => <SignedAmount value={Number(value)} />,
              },
              { key: "source", label: "Source" },
            ]}
          />
        </div>
      </details>

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
