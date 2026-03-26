"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CornerDownRight, Link2, X } from "lucide-react";
import { buildCategoryOptionGroupsForAmount, buildCategoryOptions, categoryLabel, deriveGroupFromCategory } from "@/lib/category-config";
import type { ManualTransactionRecord, RowOverrideRecord } from "@/lib/config-store";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  applyTransactionFilters,
  createInitialFilterState,
  formatAsOfDate,
  formatDisplayDate,
  formatEuro,
  sumMoneyIn,
  sumMoneyOut,
  sumNetResult,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import {
  CategoryEditor,
  DashboardShell,
  DataTable,
  FilterBar,
  SignedAmount,
  type TableSortState,
} from "./dashboard-ui";

type ManualTransactionDraft = {
  date: string;
  signedAmount: string;
  category: string;
  merchant: string;
  description: string;
  transactionType: string;
};

type ConnectedExpenseDraft = {
  date: string;
  category: string;
  merchant: string;
  description: string;
};

type ConnectedRole = "net" | "member" | null;

type TransactionSortKey = "date" | "merchant" | "group" | "category" | "amount";

const DEFAULT_TRANSACTION_SORT: TableSortState = {
  key: "date",
  direction: "desc",
};

const transactionSortCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

function compareTransactionRows(
  left: TransactionRecord,
  right: TransactionRecord,
  sortState: TableSortState,
) {
  let comparison = 0;

  switch (sortState.key as TransactionSortKey) {
    case "merchant":
      comparison = transactionSortCollator.compare(
        `${left.displayMerchant} ${left.description} ${left.txType}`,
        `${right.displayMerchant} ${right.description} ${right.txType}`,
      );
      break;
    case "group":
      comparison = transactionSortCollator.compare(
        `${left.groupLabel} ${left.displayMerchant}`,
        `${right.groupLabel} ${right.displayMerchant}`,
      );
      break;
    case "category":
      comparison = transactionSortCollator.compare(
        `${left.categoryLabel} ${left.displayMerchant}`,
        `${right.categoryLabel} ${right.displayMerchant}`,
      );
      break;
    case "amount":
      comparison = left.signedAmount - right.signedAmount;
      break;
    case "date":
    default:
      comparison = `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`);
      break;
  }

  if (comparison === 0) {
    comparison = `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`);
  }

  return sortState.direction === "asc" ? comparison : -comparison;
}

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

function createConnectedExpenseDraft(defaultDate: string): ConnectedExpenseDraft {
  return {
    date: defaultDate,
    category: "gifts",
    merchant: "Connected expense",
    description: "Connected expense adjustment",
  };
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseConnectedMeta(subcategory: string): { connectedGroupId: string | null; connectedRole: ConnectedRole } {
  if (subcategory.startsWith("connected_expense_net:")) {
    return {
      connectedGroupId: subcategory.slice("connected_expense_net:".length) || null,
      connectedRole: "net",
    };
  }
  if (subcategory.startsWith("connected_expense_member:")) {
    return {
      connectedGroupId: subcategory.slice("connected_expense_member:".length) || null,
      connectedRole: "member",
    };
  }
  return { connectedGroupId: null, connectedRole: null };
}

function buildConnectedGroupId(date: string) {
  return `connected-${date}-${Date.now()}`;
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
  const [filters, setFilters] = useState(() => createInitialFilterState(dates, "allTime"));
  const [rowOverridesState, setRowOverridesState] = useState(rowOverrides);
  const [manualTransactionsState, setManualTransactionsState] = useState(manualTransactions);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedType, setSelectedType] = useState("");
  const [selectedDirection, setSelectedDirection] = useState<"" | "in" | "out">("");
  const [sortState, setSortState] = useState<TableSortState>(DEFAULT_TRANSACTION_SORT);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [isConnectMode, setIsConnectMode] = useState(false);
  const [showConnectedComposer, setShowConnectedComposer] = useState(false);
  const [selectedConnectedRows, setSelectedConnectedRows] = useState<string[]>([]);
  const [selectedReviewRows, setSelectedReviewRows] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState("other");
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualTransactionDraft>(() => createManualDraft(latestKnownDate));
  const [connectedExpenseDraft, setConnectedExpenseDraft] = useState<ConnectedExpenseDraft>(() => createConnectedExpenseDraft(latestKnownDate));
  const [isSavingManual, setIsSavingManual] = useState(false);
  const [isSavingConnected, setIsSavingConnected] = useState(false);
  const [manualError, setManualError] = useState("");
  const [connectedExpenseError, setConnectedExpenseError] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery.trim().toLowerCase());

  const baseTransactions = applyTransactionFilters(transactions, filters);
  const matchingTransactions = useMemo(() => {
    return baseTransactions.filter((row) => {
      if (deferredSearchQuery) {
        const haystack = `${row.date} ${formatDisplayDate(row.date)} ${row.displayMerchant} ${row.merchant} ${row.description} ${row.txType} ${row.categoryLabel} ${row.groupLabel}`.toLowerCase();
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
  }, [
    baseTransactions,
    deferredSearchQuery,
    needsReviewOnly,
    selectedCategories,
    selectedDirection,
    selectedGroup,
    selectedSource,
    selectedType,
  ]);

  const filteredTransactions = useMemo(
    () => matchingTransactions.slice().sort((left, right) => compareTransactionRows(left, right, sortState)),
    [matchingTransactions, sortState],
  );
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
  const selectedConnectedTransactions = useMemo(
    () => filteredTransactions.filter((row) => selectedConnectedRows.includes(row.rowId)),
    [filteredTransactions, selectedConnectedRows],
  );
  const selectedOverrideIds = useMemo(
    () => selectedRows.filter((row) => rowOverrideIds.has(row.rowId)).map((row) => row.rowId),
    [rowOverrideIds, selectedRows],
  );

  useEffect(() => {
    const visibleRowIds = new Set(reviewRows.map((row) => row.rowId));
    setSelectedReviewRows((current) => {
      const next = current.filter((rowId) => visibleRowIds.has(rowId));
      return sameStringArray(current, next) ? current : next;
    });
  }, [reviewRows]);

  useEffect(() => {
    const visibleRowIds = new Set(filteredTransactions.map((row) => row.rowId));
    setSelectedConnectedRows((current) => {
      const next = current.filter((rowId) => visibleRowIds.has(rowId));
      return sameStringArray(current, next) ? current : next;
    });
  }, [filteredTransactions]);

  useEffect(() => {
    setRowOverridesState(rowOverrides);
  }, [rowOverrides]);

  useEffect(() => {
    setManualTransactionsState(manualTransactions);
  }, [manualTransactions]);

  useEffect(() => {
    const latestSelectedDate =
      selectedConnectedTransactions
        .map((row) => row.date)
        .sort()
        .at(-1) ?? latestKnownDate;
    setConnectedExpenseDraft((current) => (current.date === latestSelectedDate ? current : { ...current, date: latestSelectedDate }));
  }, [latestKnownDate, selectedConnectedTransactions]);

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
  const latestBalance = matchingTransactions.at(-1)?.balance ?? baseTransactions.at(-1)?.balance ?? 0;
  const activeLocalFilterCount =
    Number(Boolean(selectedGroup)) +
    selectedCategories.length +
    Number(Boolean(selectedSource)) +
    Number(Boolean(selectedType)) +
    Number(Boolean(selectedDirection)) +
    Number(needsReviewOnly);
  const localFilterSummary = activeLocalFilterCount === 0 ? "" : `${activeLocalFilterCount}`;
  const manualCategoryGroups = buildCategoryOptionGroupsForAmount(
    Number(manualDraft.signedAmount || "0"),
    manualDraft.category,
  );
  const connectedCollectedAmount = selectedConnectedTransactions.reduce(
    (sum, row) => sum + (row.signedAmount > 0 ? row.signedAmount : 0),
    0,
  );
  const connectedPaidAmount = selectedConnectedTransactions.reduce(
    (sum, row) => sum + (row.signedAmount < 0 ? Math.abs(row.signedAmount) : 0),
    0,
  );
  const connectedNetAmount = selectedConnectedTransactions.reduce((sum, row) => sum + row.signedAmount, 0);
  const connectedEligibleRows = selectedConnectedTransactions.filter((row) => row.classificationSource !== "manual_entry");
  const connectedManualRows = selectedConnectedTransactions.filter((row) => row.classificationSource === "manual_entry");
  const connectedExpenseCategoryGroups = buildCategoryOptionGroupsForAmount(
    connectedNetAmount,
    connectedExpenseDraft.category,
  );
  const compactSummaryItems = [
    { label: "Rows", text: `${filteredTransactions.length.toLocaleString("en-US")} rows` },
    { label: "Money in", text: `In ${formatEuro(sumMoneyIn(filteredTransactions))}` },
    { label: "Money out", text: `Out ${formatEuro(sumMoneyOut(filteredTransactions))}` },
    {
      label: "Transfers",
      text: `Transfers ${formatEuro(
        filteredTransactions.reduce((sum, row) => sum + (row.group === "transfer" ? Math.abs(row.signedAmount) : 0), 0),
      )}`,
    },
    { label: "Net", text: `Net ${formatEuro(sumNetResult(filteredTransactions), { signed: true })}` },
    { label: "Balance", text: `Bal ${formatEuro(latestBalance)}` },
  ];
  const transactionSortSummary = `${
    {
      date: "Date",
      merchant: "Details",
      group: "Group",
      category: "Category",
      amount: "Amount",
    }[sortState.key as TransactionSortKey] ?? "Date"
  } · ${sortState.direction === "asc" ? "ascending" : "descending"}`;

  const transactionRows = filteredTransactions.map((row) => {
    const connection = parseConnectedMeta(row.subcategory);
    return {
      selected: selectedConnectedRows.includes(row.rowId),
      rowId: row.rowId,
      date: formatDisplayDate(row.date),
      txType: row.txType,
      merchant: row.displayMerchant,
      description: row.description,
      group: row.groupLabel,
      category: row.categoryLabel,
      categoryKey: row.category,
      categoryLabel: row.categoryLabel,
      signedAmount: row.signedAmount,
      amount: row.signedAmount,
      balance: row.balance,
      sourceKey: row.classificationSource,
      needsReview: row.needsReview ? "Check" : "",
      connectedGroupId: connection.connectedGroupId,
      connectedRole: connection.connectedRole,
      isConnectedSelectable: row.classificationSource !== "manual_entry" && !connection.connectedGroupId,
    };
  });
  const rows = useMemo(() => {
    const groups = new Map<string, typeof transactionRows>();
    for (const row of transactionRows) {
      if (!row.connectedGroupId) {
        continue;
      }
      const current = groups.get(row.connectedGroupId) ?? [];
      current.push(row);
      groups.set(row.connectedGroupId, current);
    }

    const seenGroups = new Set<string>();
    const ordered: Array<(typeof transactionRows)[number] & { treeDepth: number; treeRole: ConnectedRole }> = [];

    for (const row of transactionRows) {
      if (!row.connectedGroupId) {
        ordered.push({ ...row, treeDepth: 0, treeRole: null });
        continue;
      }
      if (seenGroups.has(row.connectedGroupId)) {
        continue;
      }

      seenGroups.add(row.connectedGroupId);
      const cluster = groups.get(row.connectedGroupId) ?? [row];
      const netRow = cluster.find((item) => item.connectedRole === "net") ?? null;
      const members = cluster
        .filter((item) => item.connectedRole !== "net")
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`));

      if (netRow) {
        ordered.push({ ...netRow, treeDepth: 0, treeRole: "net" });
      }
      for (const member of members) {
        ordered.push({ ...member, treeDepth: netRow ? 1 : 0, treeRole: "member" });
      }
    }

    return ordered;
  }, [transactionRows]);
  const reviewTableRows = reviewRows.slice(0, 120).map((row) => ({
    selected: selectedReviewRows.includes(row.rowId),
    rowId: row.rowId,
    date: formatDisplayDate(row.date),
    merchant: row.displayMerchant,
    description: row.description,
    txType: row.txType,
    category: row.categoryLabel,
    categoryKey: row.category,
    categoryLabel: row.categoryLabel,
    signedAmount: row.signedAmount,
    amount: row.signedAmount,
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
    setFilters(createInitialFilterState(dates, "allTime"));
    setSearchQuery("");
    setSelectedGroup("");
    setSelectedCategories([]);
    setSelectedSource("");
    setSelectedType("");
    setSelectedDirection("");
    setSortState(DEFAULT_TRANSACTION_SORT);
    setNeedsReviewOnly(false);
    setIsConnectMode(false);
    setShowConnectedComposer(false);
    setSelectedConnectedRows([]);
    setSelectedReviewRows([]);
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category],
    );
  };

  const startConnectMode = (rowId: string) => {
    setIsConnectMode(true);
    setShowConnectedComposer(false);
    setConnectedExpenseError("");
    setSelectedConnectedRows((current) => (current.includes(rowId) ? current : [...current, rowId]));
  };

  const toggleConnectedRow = (rowId: string) => {
    setSelectedConnectedRows((current) => (current.includes(rowId) ? current.filter((value) => value !== rowId) : [...current, rowId]));
  };

  const cancelConnectMode = () => {
    setIsConnectMode(false);
    setShowConnectedComposer(false);
    setSelectedConnectedRows([]);
    setConnectedExpenseDraft(createConnectedExpenseDraft(latestKnownDate));
    setConnectedExpenseError("");
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
      merchant: row.displayMerchant,
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

  const submitSharedExpenseAdjustment = async () => {
    const signedAmount = connectedNetAmount;

    if (selectedConnectedTransactions.length === 0) {
      setConnectedExpenseError("Select the rows to connect from the transaction table first.");
      return;
    }

    if (connectedManualRows.length > 0) {
      setConnectedExpenseError("Connected expenses can only be created from imported rows, not existing manual rows.");
      return;
    }

    if (!connectedExpenseDraft.date || signedAmount === 0 || !connectedExpenseDraft.category) {
      setConnectedExpenseError("A date, category, and non-zero net amount are required.");
      return;
    }

    const rowId = `manual-${connectedExpenseDraft.date}-connected-expense-${Date.now()}`;
    const connectedGroupId = buildConnectedGroupId(connectedExpenseDraft.date);

    setIsSavingConnected(true);
    setConnectedExpenseError("");
    setManualError("");
    try {
      const manualResponse = await fetch("/api/manual-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: {
            rowId,
            date: connectedExpenseDraft.date,
            transactionType: "Connected expense",
            merchant: connectedExpenseDraft.merchant.trim() || "Connected expense",
            description: connectedExpenseDraft.description.trim() || "Connected expense adjustment",
            signedAmount,
            category: connectedExpenseDraft.category,
            subcategory: `connected_expense_net:${connectedGroupId}`,
          },
        }),
      });
      if (!manualResponse.ok) {
        const payload = (await manualResponse.json().catch(() => null)) as { message?: string } | null;
        setConnectedExpenseError(payload?.message ?? "Could not save the connected expense adjustment.");
        return;
      }

      const overrides = connectedEligibleRows.map((row) => ({
        rowId: row.rowId,
        description: row.description,
        transactionType: row.txType,
        signedAmount: row.signedAmount,
        merchant: row.merchant,
        group: "transfer",
        category: "peer_transfer",
        subcategory: `connected_expense_member:${connectedGroupId}`,
        confidence: 0.99,
        needsReview: false,
        source: "row_override",
        updatedAt: new Date().toISOString(),
      }));

      const overrideResponse = await fetch("/api/row-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });

      if (!overrideResponse.ok) {
        await fetch("/api/manual-transactions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rowId }),
        }).catch(() => null);
        const payload = (await overrideResponse.json().catch(() => null)) as { message?: string } | null;
        setConnectedExpenseError(payload?.message ?? "Could not connect the selected rows.");
        return;
      }

      await syncManualTransactions(manualResponse);
      await syncOverrides(overrideResponse);
      setIsConnectMode(false);
      setShowConnectedComposer(false);
      setSelectedConnectedRows([]);
      setConnectedExpenseDraft(createConnectedExpenseDraft(connectedExpenseDraft.date));
    } finally {
      setIsSavingConnected(false);
    }
  };

  return (
    <DashboardShell
      kicker="Transactions"
      description=""
      hideHero
    >
      <section className="ledger-commandbar">
        <div className="ledger-commandbar-row">
          <div className="ledger-commandbar-title">
            <strong>Transactions</strong>
          </div>
          <div className="ledger-commandbar-period">
            <FilterBar dates={dates} filters={filters} onChange={setFilters} compact summaryLabel="Period" />
          </div>
          <div className="ledger-commandbar-search">
            <label htmlFor="transactionSearch" className="sr-only">Search</label>
            <input
              id="transactionSearch"
              value={searchQuery}
              placeholder="Search merchant, note, or category"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <button type="button" className="quick-button quick-button-ghost ledger-commandbar-reset" onClick={clearLocalFilters}>
            Reset
          </button>
          <span className="ledger-commandbar-updated">Updated {formatAsOfDate(transactions.at(-1)?.date ?? filters.endDate)}</span>
        </div>

        <details className="details ledger-local-details ledger-inline-details">
          <summary>
            <span className="filterbar-summary-title">Filters</span>
            {localFilterSummary ? <span className="filterbar-summary-meta">{localFilterSummary} active</span> : null}
            {needsReviewOnly ? <span className="filterbar-summary-badge">Review only</span> : null}
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
      </section>

      <div className="ledger-summary-strip" aria-label="Ledger summary">
        {compactSummaryItems.map((item) => (
          <div key={item.label} className="ledger-summary-item" aria-label={`${item.label}: ${item.text}`}>
            <strong>{item.text}</strong>
          </div>
        ))}
        {reviewRows.length > 0 ? (
          <div className="ledger-summary-item" aria-label={`Review: ${reviewRows.length.toLocaleString("en-US")} rows`}>
            <strong>{reviewRows.length.toLocaleString("en-US")} review</strong>
          </div>
        ) : null}
        {manualTransactionsState.length > 0 ? (
          <div className="ledger-summary-item" aria-label={`Manual: ${manualTransactionsState.length.toLocaleString("en-US")} entries`}>
            <strong>{manualTransactionsState.length.toLocaleString("en-US")} manual</strong>
          </div>
        ) : null}
      </div>

      {isConnectMode ? (
        <section className="connect-mode-bar" aria-label="Connected expense mode">
          <div className="connect-mode-head">
            <span className="connect-mode-pill">
              <Link2 size={14} aria-hidden="true" />
              Connect mode
            </span>
            <strong>{selectedConnectedRows.length} selected</strong>
            <span>{`Collected ${formatEuro(connectedCollectedAmount)} · Paid ${formatEuro(connectedPaidAmount)} · Net ${formatEuro(connectedNetAmount, { signed: true })}`}</span>
          </div>
          <div className="connect-mode-actions">
            <button
              type="button"
              className="quick-button"
              onClick={() => setShowConnectedComposer((current) => !current)}
              disabled={isSavingConnected || isRefreshingData || selectedConnectedRows.length === 0}
            >
              {showConnectedComposer ? "Hide connect" : "Connect"}
            </button>
            <button
              type="button"
              className="quick-button quick-button-ghost"
              onClick={cancelConnectMode}
              disabled={isSavingConnected || isRefreshingData}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <section className="ledger-table-shell">
        <div className="ledger-table-head">
          <div className="ledger-table-head-main">
            <strong>Transaction ledger</strong>
            <span>{filteredTransactions.length.toLocaleString("en-US")} visible rows</span>
          </div>
          <div className="ledger-table-head-meta">
            <span className="ledger-table-meta-pill">{transactionSortSummary}</span>
            <span className="ledger-table-meta-copy">Click a header to reorder</span>
          </div>
        </div>

        <DataTable
          density="compact"
          rows={rows}
          rowKey="rowId"
          stickyHeader
          sortState={sortState}
          onSortChange={setSortState}
          emptyMessage="No transactions match the current filters."
          columns={[
            {
              key: "selected",
              label: "",
              width: 42,
              cellClassName: "cell-nowrap",
              render: (_value, row) => {
                const rowId = String(row.rowId);
                const isSelected = selectedConnectedRows.includes(rowId);
                const isConnectable = Boolean(row.isConnectedSelectable);
                const treeRole = String(row.treeRole || "");

                if (treeRole === "member") {
                  return (
                    <span className="connect-tree-marker" aria-hidden="true">
                      <CornerDownRight size={14} />
                    </span>
                  );
                }

                if (!isConnectMode) {
                  return isConnectable ? (
                    <button
                      type="button"
                      className="connect-icon-button"
                      onClick={() => startConnectMode(rowId)}
                      aria-label="Start connecting transactions"
                    >
                      <Link2 size={15} />
                    </button>
                  ) : null;
                }

                return isConnectable ? (
                  <button
                    type="button"
                    className="connect-icon-button"
                    data-active={isSelected}
                    onClick={() => toggleConnectedRow(rowId)}
                    aria-label={isSelected ? "Remove transaction from connection" : "Add transaction to connection"}
                  >
                    <Link2 size={15} />
                  </button>
                ) : treeRole === "net" ? (
                  <span className="connect-tree-marker connect-tree-marker-net" aria-hidden="true">
                    <Link2 size={14} />
                  </span>
                ) : null;
              },
            },
            { key: "date", label: "Date", cellClassName: "cell-nowrap", sortable: true, sortKey: "date", sortDefaultDirection: "desc" },
            {
              key: "merchant",
              label: "Details",
              cellClassName: "cell-description",
              sortable: true,
              sortKey: "merchant",
              render: (_value, row) => (
                <div
                  className="table-transaction-cell"
                  data-tree-role={String(row.treeRole || "")}
                  style={{ ["--tree-depth" as string]: Number(row.treeDepth ?? 0) }}
                >
                  {String(row.treeRole) === "member" ? <span className="table-transaction-branch" aria-hidden="true" /> : null}
                  <strong>{String(row.merchant)}</strong>
                  <small>
                    {String(row.txType)}
                    {String(row.description) && String(row.description) !== String(row.merchant) ? ` · ${String(row.description)}` : ""}
                  </small>
                  {String(row.treeRole) === "net" ? <span className="table-transaction-note">Connected net row</span> : null}
                  {String(row.treeRole) === "member" ? <span className="table-transaction-note">Connected original row</span> : null}
                </div>
              ),
            },
            { key: "group", label: "Group", cellClassName: "cell-nowrap", sortable: true, sortKey: "group" },
            { key: "category", label: "Category", sortable: true, sortKey: "category", render: (_value, row) => <CategoryEditor row={row} /> },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              cellClassName: "cell-nowrap",
              sortable: true,
              sortKey: "amount",
              sortDefaultDirection: "desc",
              render: (value) => <SignedAmount value={Number(value)} />,
            },
          ]}
        />
      </section>

      <div className="ledger-secondary-stack">
        {isConnectMode && showConnectedComposer ? (
          <section className="manual-helper-block connected-expense-composer">
            <div className="manual-helper-head">
              <strong>Connect selected rows</strong>
              <span>Turn the selected collection and payment rows into one net expense and keep the originals nested under it.</span>
            </div>

            <div className="ledger-summary-strip" aria-label="Connected expense summary">
              <div className="ledger-summary-item"><strong>Collected {formatEuro(connectedCollectedAmount)}</strong></div>
              <div className="ledger-summary-item"><strong>Paid {formatEuro(connectedPaidAmount)}</strong></div>
              <div className="ledger-summary-item"><strong>Net {formatEuro(connectedNetAmount, { signed: true })}</strong></div>
            </div>

            <div className="manual-helper-grid">
              <div className="field">
                <label htmlFor="connectedExpenseDate">Date</label>
                <input
                  id="connectedExpenseDate"
                  type="date"
                  value={connectedExpenseDraft.date}
                  min={dates[0]}
                  max={today}
                  onChange={(event) => setConnectedExpenseDraft((current) => ({ ...current, date: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="connectedExpenseCategory">Net category</label>
                <select
                  id="connectedExpenseCategory"
                  value={connectedExpenseDraft.category}
                  onChange={(event) => setConnectedExpenseDraft((current) => ({ ...current, category: event.target.value }))}
                >
                  {connectedExpenseCategoryGroups.map((group) => (
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
                <label htmlFor="connectedExpenseMerchant">Label</label>
                <input
                  id="connectedExpenseMerchant"
                  value={connectedExpenseDraft.merchant}
                  placeholder="Connected expense"
                  onChange={(event) => setConnectedExpenseDraft((current) => ({ ...current, merchant: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="connectedExpenseDescription">Note</label>
                <input
                  id="connectedExpenseDescription"
                  value={connectedExpenseDraft.description}
                  placeholder="Connected expense adjustment"
                  onChange={(event) => setConnectedExpenseDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </div>
            </div>

            <div className="button-row">
              <button
                type="button"
                className="quick-button"
                onClick={() => void submitSharedExpenseAdjustment()}
                disabled={isSavingConnected || isRefreshingData || selectedConnectedRows.length === 0}
              >
                Save connected expense
              </button>
              <button
                type="button"
                className="quick-button quick-button-ghost"
                onClick={cancelConnectMode}
                disabled={isSavingConnected || isRefreshingData}
              >
                <X size={14} aria-hidden="true" />
                Cancel
              </button>
              <span className="helper-copy">
                Original rows will be recategorized to <strong>{categoryLabel("peer_transfer")}</strong>. The new connected row keeps only the net impact.
              </span>
            </div>

            {connectedExpenseError ? <div className="table-action-error">{connectedExpenseError}</div> : null}
          </section>
        ) : null}

        {reviewRows.length > 0 ? (
          <details className="details ledger-local-details ledger-details">
            <summary>
              <span className="filterbar-summary-title">Review</span>
              <span className="filterbar-summary-badge">{reviewRows.length.toLocaleString("en-US")}</span>
              {selectedReviewRows.length > 0 ? (
                <span className="filterbar-summary-meta">{selectedReviewRows.length} selected</span>
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
                  Clear check
                </button>
                <button
                  type="button"
                  className="quick-button quick-button-ghost"
                  onClick={() => void deleteSelectedOverrides()}
                  disabled={selectedOverrideIds.length === 0 || isSavingReview || isRefreshingData}
                >
                  Delete override
                </button>
                {selectedRows.length > 0 ? (
                  <span className="helper-copy">
                    {selectedRows.length} selected{selectedOverrideIds.length > 0 ? ` · ${selectedOverrideIds.length} override` : ""}
                  </span>
                ) : null}
              </div>

              <DataTable
                density="compact"
                rows={reviewTableRows}
                rowKey="rowId"
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
                ]}
              />
            </div>
          </details>
        ) : null}

        <details className="details ledger-local-details ledger-details">
          <summary>
            <span className="filterbar-summary-title">Add manual</span>
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
                Save
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
                Clear
              </button>
            </div>
            {manualError ? <div className="table-action-error">{manualError}</div> : null}

            <DataTable
              density="compact"
              rows={manualRows}
              rowKey="rowId"
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
      </div>
    </DashboardShell>
  );
}
