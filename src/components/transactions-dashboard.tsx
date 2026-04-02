"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CornerDownRight, Link2, Search, SquarePen, Trash2, X } from "lucide-react";
import { buildCategoryOptionGroupsForAmount, categoryLabel } from "@/lib/category-config";
import type { ManualTransactionRecord, RowOverrideRecord } from "@/lib/config-store";
import type { TransactionRecord } from "@/lib/dashboard-data";
import {
  applyTransactionFilters,
  createInitialFilterState,
  formatAsOfDate,
  formatDisplayDate,
  formatEuro,
  uniqueTransactionDates,
} from "@/lib/dashboard-utils";
import {
  CategoryEditor,
  DashboardShell,
  DataTable,
  FilterBar,
  PillRow,
  SignedAmount,
  type TableSortState,
} from "./dashboard-ui";

type ManualTransactionDraft = {
  date: string;
  signedAmount: string;
  category: string;
  description: string;
  transactionType: string;
};

type ConnectedExpenseDraft = {
  date: string;
  category: string;
  description: string;
};

type ConnectedRole = "net" | "member" | null;
type TransactionWidget = "connect" | "manual" | "resetData";

type TransactionSortKey = "date" | "details" | "group" | "category" | "amount";

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
    case "details":
      comparison = transactionSortCollator.compare(
        `${left.displayDescription} ${left.description} ${left.txType}`,
        `${right.displayDescription} ${right.description} ${right.txType}`,
      );
      break;
    case "group":
      comparison = transactionSortCollator.compare(
        `${left.groupLabel} ${left.displayDescription}`,
        `${right.groupLabel} ${right.displayDescription}`,
      );
      break;
    case "category":
      comparison = transactionSortCollator.compare(
        `${left.categoryLabel} ${left.displayDescription}`,
        `${right.categoryLabel} ${right.displayDescription}`,
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
    description: "",
    transactionType: "Manual",
  };
}

function createConnectedExpenseDraft(defaultDate: string): ConnectedExpenseDraft {
  return {
    date: defaultDate,
    category: "gifts",
    description: "Connected expense adjustment",
  };
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseConnectedMeta(linkGroupId: string, linkRole: string): { connectedGroupId: string | null; connectedRole: ConnectedRole } {
  return {
    connectedGroupId: linkGroupId || null,
    connectedRole: linkRole === "net" || linkRole === "member" ? linkRole : null,
  };
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
  const [openWidget, setOpenWidget] = useState<TransactionWidget | null>(null);
  const [selectedConnectedRows, setSelectedConnectedRows] = useState<string[]>([]);
  const [manualDraft, setManualDraft] = useState<ManualTransactionDraft>(() => createManualDraft(latestKnownDate));
  const [connectedExpenseDraft, setConnectedExpenseDraft] = useState<ConnectedExpenseDraft>(() => createConnectedExpenseDraft(latestKnownDate));
  const [isSavingManual, setIsSavingManual] = useState(false);
  const [isSavingConnected, setIsSavingConnected] = useState(false);
  const [isDeletingTransaction, setIsDeletingTransaction] = useState(false);
  const [isResettingData, setIsResettingData] = useState(false);
  const [manualError, setManualError] = useState("");
  const [connectedExpenseError, setConnectedExpenseError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [resetDataError, setResetDataError] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery.trim().toLowerCase());

  const baseTransactions = applyTransactionFilters(transactions, filters);
  const matchingTransactions = useMemo(() => {
    return baseTransactions.filter((row) => {
      if (deferredSearchQuery) {
        const haystack = `${row.date} ${formatDisplayDate(row.date)} ${row.displayDescription} ${row.description} ${row.txType} ${row.categoryLabel} ${row.groupLabel}`.toLowerCase();
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
      return true;
    });
  }, [
    baseTransactions,
    deferredSearchQuery,
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
  const selectedConnectedTransactions = useMemo(
    () => filteredTransactions.filter((row) => selectedConnectedRows.includes(row.rowId)),
    [filteredTransactions, selectedConnectedRows],
  );
  const transactionById = useMemo(() => new Map(transactions.map((row) => [row.rowId, row])), [transactions]);

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

  useEffect(() => {
    if (!openWidget) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenWidget(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [openWidget]);

  useEffect(() => {
    if (openWidget === "connect" && selectedConnectedRows.length < 2) {
      setOpenWidget(null);
    }
  }, [openWidget, selectedConnectedRows.length]);

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
  const activeLocalFilterCount =
    Number(Boolean(selectedGroup)) +
    selectedCategories.length +
    Number(Boolean(selectedSource)) +
    Number(Boolean(selectedType)) +
    Number(Boolean(selectedDirection));
  const localFilterSummary = activeLocalFilterCount === 0 ? "" : `${activeLocalFilterCount}`;
  const activeFilterPills = [
    searchQuery.trim() ? `Search: ${searchQuery.trim()}` : "",
    selectedDirection === "in" ? "Money in" : selectedDirection === "out" ? "Money out" : "",
    selectedGroup ? `Group: ${groupOptions.find((option) => option.value === selectedGroup)?.label ?? selectedGroup}` : "",
    ...selectedCategories.map((category) => `Category: ${categoryOptions.find((option) => option.value === category)?.label ?? categoryLabel(category)}`),
    selectedSource ? `Source: ${sourceOptions.find((option) => option.value === selectedSource)?.label ?? selectedSource}` : "",
    selectedType ? `Type: ${selectedType}` : "",
  ].filter(Boolean);
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
  const hasSelectedRowsForLink = selectedConnectedRows.length > 0;
  const canOpenLinkWidget = selectedConnectedRows.length >= 2;
  const hasActiveSearch = Boolean(searchQuery.trim());
  const hasActiveLedgerFilters = hasActiveSearch || activeLocalFilterCount > 0;

  const transactionRows = filteredTransactions.map((row) => {
    const connection = parseConnectedMeta(row.linkGroupId, row.linkRole);
    return {
      selected: selectedConnectedRows.includes(row.rowId),
      rowId: row.rowId,
      date: formatDisplayDate(row.date),
      txType: row.txType,
      displayDescription: row.displayDescription,
      description: row.description,
      group: row.groupLabel,
      groupKey: row.group,
      category: row.categoryLabel,
      categoryKey: row.category,
      categoryLabel: row.categoryLabel,
      categoryOverride: row.categoryOverride,
      investmentAssetClass: row.investmentAssetClass,
      classifiedInvestmentAssetClass: row.classifiedInvestmentAssetClass,
      investmentAssetClassOverride: row.investmentAssetClassOverride,
      signedAmount: row.signedAmount,
      amount: row.signedAmount,
      balance: row.balance,
      sourceKey: row.classificationSource,
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
  const manualRows = manualTransactionsState
    .slice()
    .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
    .slice(0, 12)
    .map((row) => ({
      rowId: row.rowId,
      date: formatDisplayDate(row.date),
      description: row.description,
      category: categoryLabel(row.category),
      categoryKey: row.category,
      categoryLabel: categoryLabel(row.category),
      categoryOverride: "",
      amount: row.signedAmount,
      txType: row.transactionType || "Manual",
      action: row.rowId,
    }));
  const linkedExpenseRows = selectedConnectedTransactions
    .slice()
    .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`))
    .map((row) => ({
      rowId: row.rowId,
      date: formatDisplayDate(row.date),
      displayDescription: row.displayDescription,
      description: row.description,
      txType: row.txType,
      amount: row.signedAmount,
    }));

  const syncOverrides = async (response: Response) => {
    const payload = (await response.json()) as { overrides: RowOverrideRecord[] };
    setRowOverridesState(payload.overrides);
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
    setSelectedConnectedRows([]);
    setOpenWidget(null);
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category],
    );
  };

  const toggleLinkedRow = (rowId: string) => {
    setConnectedExpenseError("");
    setSelectedConnectedRows((current) => (current.includes(rowId) ? current.filter((value) => value !== rowId) : [...current, rowId]));
  };

  const clearLinkedRows = () => {
    setSelectedConnectedRows([]);
    setConnectedExpenseDraft(createConnectedExpenseDraft(latestKnownDate));
    setConnectedExpenseError("");
    setOpenWidget((current) => (current === "connect" ? null : current));
  };

  const resetAllData = async () => {
    if (isResettingData || isRefreshingData || isSavingManual || isSavingConnected || isDeletingTransaction) {
      return;
    }

    setResetDataError("");
    setDeleteError("");
    setManualError("");
    setConnectedExpenseError("");
    setIsResettingData(true);

    try {
      const response = await fetch("/api/reset-data", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;

      if (!response.ok) {
        setResetDataError(payload?.message ?? "Could not delete the local data.");
        return;
      }

      setSelectedConnectedRows([]);
      setConnectedExpenseDraft(createConnectedExpenseDraft(latestKnownDate));
      setManualDraft(createManualDraft(latestKnownDate));
      setRowOverridesState([]);
      setManualTransactionsState([]);
      setOpenWidget(null);
      clearLocalFilters();
      startRefreshTransition(() => router.refresh());
    } catch (error) {
      setResetDataError(error instanceof Error ? error.message : "Could not delete the local data.");
    } finally {
      setIsResettingData(false);
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
            description: manualDraft.description,
            signedAmount,
            category: manualDraft.category,
            linkGroupId: "",
            linkRole: "",
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
      setOpenWidget(null);
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

  const deleteTransactionRow = async (rowId: string) => {
    const target = transactionById.get(rowId);
    if (!target || isDeletingTransaction || isRefreshingData) {
      return;
    }

    const groupedRows = target.linkGroupId
      ? transactions.filter((row) => row.linkGroupId === target.linkGroupId)
      : [target];
    const manualRowsToDelete = groupedRows.filter((row) => row.classificationSource === "manual_entry");
    const importedRowsToDelete = groupedRows.filter((row) => row.classificationSource !== "manual_entry");
    const deleteCount = groupedRows.length;
    const confirmMessage =
      deleteCount > 1
        ? `Delete this connected group of ${deleteCount} rows?`
        : `Delete "${target.displayDescription}"?`;

    if (typeof window !== "undefined" && !window.confirm(confirmMessage)) {
      return;
    }

    setDeleteError("");
    setIsDeletingTransaction(true);

    const importedRowIds = importedRowsToDelete.map((row) => row.rowId);
    const manualRowIds = manualRowsToDelete.map((row) => row.rowId);

    try {
      if (importedRowsToDelete.length > 0) {
        const overrides = importedRowsToDelete.map((row) => ({
          rowId: row.rowId,
          description: row.description,
          transactionType: row.txType,
          signedAmount: row.signedAmount,
          category: row.category,
          source: "deleted_transaction",
          linkGroupId: "",
          linkRole: "",
          updatedAt: new Date().toISOString(),
        }));

        const overrideResponse = await fetch("/api/row-overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides }),
        });

        if (!overrideResponse.ok) {
          const payload = (await overrideResponse.json().catch(() => null)) as { message?: string } | null;
          setDeleteError(payload?.message ?? "Could not delete the selected transaction.");
          return;
        }

        await syncOverrides(overrideResponse);
      }

      if (manualRowsToDelete.length > 0) {
        const manualResponse = await fetch("/api/manual-transactions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rowIds: manualRowIds }),
        });

        if (!manualResponse.ok) {
          if (importedRowIds.length > 0) {
            await fetch("/api/row-overrides", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rowIds: importedRowIds }),
            }).catch(() => null);
          }
          const payload = (await manualResponse.json().catch(() => null)) as { message?: string } | null;
          setDeleteError(payload?.message ?? "Could not delete the selected transaction.");
          return;
        }

        await syncManualTransactions(manualResponse);
      }

      const affectedIds = new Set(groupedRows.map((row) => row.rowId));
      setSelectedConnectedRows((current) => current.filter((candidate) => !affectedIds.has(candidate)));
      setOpenWidget((current) => (current === "connect" ? null : current));
    } finally {
      setIsDeletingTransaction(false);
    }
  };

  const submitLinkedExpense = async () => {
    const signedAmount = connectedNetAmount;

    if (selectedConnectedTransactions.length < 2) {
      setConnectedExpenseError("Select at least two imported rows to create a link.");
      return;
    }

    if (connectedManualRows.length > 0) {
      setConnectedExpenseError("Linked expenses can only be created from imported rows, not existing manual rows.");
      return;
    }

    if (!connectedExpenseDraft.date || signedAmount === 0 || !connectedExpenseDraft.category) {
      setConnectedExpenseError("A date, category, and non-zero net amount are required.");
      return;
    }

    const rowId = `manual-${connectedExpenseDraft.date}-linked-expense-${Date.now()}`;
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
            transactionType: "Linked expense",
            description: connectedExpenseDraft.description.trim() || "Linked expense adjustment",
            signedAmount,
            category: connectedExpenseDraft.category,
            linkGroupId: connectedGroupId,
            linkRole: "net",
          },
        }),
      });
      if (!manualResponse.ok) {
        const payload = (await manualResponse.json().catch(() => null)) as { message?: string } | null;
        setConnectedExpenseError(payload?.message ?? "Could not save the linked expense.");
        return;
      }

      const overrides = connectedEligibleRows.map((row) => ({
        rowId: row.rowId,
        description: row.description,
        transactionType: row.txType,
        signedAmount: row.signedAmount,
        category: "peer_transfer",
        source: "row_override",
        linkGroupId: connectedGroupId,
        linkRole: "member",
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
        setConnectedExpenseError(payload?.message ?? "Could not link the selected rows.");
        return;
      }

      await syncManualTransactions(manualResponse);
      await syncOverrides(overrideResponse);
      setSelectedConnectedRows([]);
      setConnectedExpenseDraft(createConnectedExpenseDraft(connectedExpenseDraft.date));
      setOpenWidget(null);
    } finally {
      setIsSavingConnected(false);
    }
  };

  return (
    <DashboardShell
      kicker="Transactions"
      description="Search and edit imported transactions."
      className="transactions-shell"
      hideHero
      viewportLocked
    >
      <section className="home-commandbar transactions-commandbar">
        <div className="home-commandbar-row">
          <div className="home-commandbar-title"><strong>Transactions</strong></div>
          <div />
          <div className="home-commandbar-meta">
            <span className="home-updated">Updated {formatAsOfDate(transactions.at(-1)?.date ?? filters.endDate)}</span>
          </div>
        </div>
      </section>

      <section className="transactions-stage">
        <section className="transactions-surface">
          <div className="transactions-surface-top">
            <div className="transactions-surface-meta">
              <strong>Imported rows</strong>
              <span>
                {hasActiveLedgerFilters
                  ? `${filteredTransactions.length.toLocaleString("en-US")} matching rows`
                  : `${filteredTransactions.length.toLocaleString("en-US")} rows in view`}
              </span>
            </div>
            <div className="transactions-surface-controls">
              <div className="transactions-surface-search">
                <Search size={15} aria-hidden="true" />
                <label htmlFor="transactionSearch" className="sr-only">Search</label>
                <input
                  id="transactionSearch"
                  value={searchQuery}
                  placeholder="Search transactions"
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>

              <div className="transactions-surface-actions-frame">
                <div className="transactions-surface-actions">
                  <button
                    type="button"
                    className="quick-button transactions-action-button transactions-action-button-link"
                    data-active={openWidget === "connect"}
                    onClick={() => {
                      if (canOpenLinkWidget) {
                        setConnectedExpenseError("");
                        setOpenWidget("connect");
                      }
                    }}
                    disabled={!canOpenLinkWidget}
                  >
                    <Link2 size={14} aria-hidden="true" />
                    {hasSelectedRowsForLink ? `Link (${selectedConnectedRows.length})` : "Link"}
                  </button>
                  <button
                    type="button"
                    className="quick-button transactions-action-button"
                    data-active={openWidget === "manual"}
                    onClick={() => {
                      setManualError("");
                      setOpenWidget("manual");
                    }}
                  >
                    <SquarePen size={14} aria-hidden="true" />
                    Add manual
                  </button>
                  <button
                    type="button"
                    className="quick-button transactions-action-button transactions-action-button-danger"
                    data-active={openWidget === "resetData"}
                    onClick={() => {
                      setResetDataError("");
                      setOpenWidget("resetData");
                    }}
                    disabled={isRefreshingData || isSavingManual || isSavingConnected || isDeletingTransaction || isResettingData}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete all data
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="transactions-surface-toolbar">
            <div className="transactions-commandbar-period">
              <FilterBar dates={dates} filters={filters} onChange={setFilters} compact summaryLabel="Range" />
            </div>
            <div className="transactions-surface-toolbar-actions">
              {hasSelectedRowsForLink ? (
                <span className="ledger-table-meta-pill ledger-table-meta-pill-accent">
                  {selectedConnectedRows.length.toLocaleString("en-US")} selected for link
                </span>
              ) : null}
              {hasSelectedRowsForLink ? (
                <button type="button" className="quick-button quick-button-ghost transactions-commandbar-reset" onClick={clearLinkedRows}>
                  Clear selection
                </button>
              ) : null}
              {hasActiveLedgerFilters ? (
                <button
                  type="button"
                  className="quick-button quick-button-ghost transactions-commandbar-reset"
                  onClick={clearLocalFilters}
                >
                  Reset filters
                </button>
              ) : null}
            </div>
          </div>

          <details className="details ledger-local-details ledger-inline-details ledger-filter-tray">
            <summary>
              <span className="filterbar-summary-title">Filters</span>
              {localFilterSummary ? <span className="filterbar-summary-meta">{localFilterSummary} active</span> : null}
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

          {activeFilterPills.length > 0 ? (
            <div className="transactions-filter-pills">
              <PillRow items={activeFilterPills} />
            </div>
          ) : null}
          {deleteError ? <div className="table-action-error">{deleteError}</div> : null}

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
                label: "Link",
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

                  return isConnectable ? (
                    <button
                      type="button"
                      className="connect-icon-button"
                      data-active={isSelected}
                      onClick={() => toggleLinkedRow(rowId)}
                      aria-label={isSelected ? "Remove transaction from linked expenses" : "Add transaction to linked expenses"}
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
                key: "displayDescription",
                label: "Details",
                cellClassName: "cell-description",
                sortable: true,
                sortKey: "details",
                render: (_value, row) => (
                  <div
                    className="table-transaction-cell"
                    data-tree-role={String(row.treeRole || "")}
                    style={{ ["--tree-depth" as string]: Number(row.treeDepth ?? 0) }}
                  >
                    {String(row.treeRole) === "member" ? <span className="table-transaction-branch" aria-hidden="true" /> : null}
                    <strong>{String(row.displayDescription)}</strong>
                    <small>
                      {String(row.txType)}
                      {String(row.description) && String(row.description) !== String(row.displayDescription) ? ` · ${String(row.description)}` : ""}
                    </small>
                    {String(row.treeRole) === "net" ? <span className="table-transaction-note">Connected net row</span> : null}
                    {String(row.treeRole) === "member" ? <span className="table-transaction-note">Connected original row</span> : null}
                  </div>
                ),
              },
              { key: "category", label: "Category", width: 184, sortable: true, sortKey: "category", render: (_value, row) => <CategoryEditor row={row} /> },
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
              {
                key: "rowId",
                label: "",
                width: 88,
                align: "right",
                cellClassName: "cell-nowrap",
                render: (_value, row) => (
                  <button
                    type="button"
                    className="table-action-button table-action-button-secondary"
                    onClick={() => void deleteTransactionRow(String(row.rowId))}
                    disabled={isDeletingTransaction || isRefreshingData}
                    aria-label={`Delete ${String(row.displayDescription)}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                ),
              },
            ]}
          />
        </section>
      </section>

      {openWidget && typeof document !== "undefined"
        ? createPortal(
            <div
              className="detail-sheet-backdrop"
              role="presentation"
              onClick={() => {
                if (!isResettingData) {
                  setOpenWidget(null);
                }
              }}
            >
              <aside
                className="detail-sheet transactions-widget-sheet"
                role="dialog"
                aria-modal="true"
                aria-label={
                  openWidget === "connect"
                    ? "Link expenses"
                    : openWidget === "manual"
                      ? "Add manual row"
                      : "Delete all data"
                }
                onClick={(event) => event.stopPropagation()}
              >
                <div className="detail-sheet-head transactions-widget-head">
                  <div>
                    <div className="detail-sheet-kicker">Transactions</div>
                    <h2>
                      {openWidget === "connect"
                        ? "Link expenses"
                        : openWidget === "manual"
                          ? "Add manual row"
                          : "Delete all data"}
                    </h2>
                    <p>
                      {openWidget === "connect"
                        ? "Create one net row from the selected transactions."
                        : openWidget === "manual"
                          ? "Add a missing transaction without leaving the page."
                          : "Clean the local app database and start again from an empty workspace."}
                    </p>
                  </div>
                  <div className="detail-sheet-head-actions">
                    <button
                      type="button"
                      className="detail-sheet-close"
                      onClick={() => setOpenWidget(null)}
                      aria-label="Close widget"
                      disabled={isResettingData}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>

                <div className="detail-sheet-body transactions-widget-body">
                  {openWidget === "connect" ? (
                    <>
                      <div className="transactions-widget-metrics" aria-label="Link summary">
                        <div className="transactions-widget-metric">
                          <span>Selected</span>
                          <strong>{selectedConnectedRows.length.toLocaleString("en-US")} rows</strong>
                        </div>
                        <div className="transactions-widget-metric">
                          <span>Net</span>
                          <strong>{formatEuro(connectedNetAmount, { signed: true })}</strong>
                        </div>
                        {connectedCollectedAmount > 0 ? (
                          <div className="transactions-widget-metric">
                            <span>Collected</span>
                            <strong>{formatEuro(connectedCollectedAmount)}</strong>
                          </div>
                        ) : null}
                        {connectedPaidAmount > 0 ? (
                          <div className="transactions-widget-metric">
                            <span>Paid</span>
                            <strong>{formatEuro(connectedPaidAmount)}</strong>
                          </div>
                        ) : null}
                      </div>

                      <section className="transactions-widget-section">
                        <div className="transactions-widget-section-head">
                          <strong>Selected rows</strong>
                          <span>{selectedConnectedRows.length.toLocaleString("en-US")} ready</span>
                        </div>
                        <div className="transactions-widget-row-list">
                          {linkedExpenseRows.map((row) => (
                            <article key={row.rowId} className="transactions-widget-row">
                              <div className="transactions-widget-row-main">
                                <div className="transactions-widget-row-date">{String(row.date)}</div>
                                <div className="transactions-widget-row-title">{String(row.displayDescription)}</div>
                              </div>
                              <div className="transactions-widget-row-amount">
                                <SignedAmount value={Number(row.amount)} />
                              </div>
                              <button
                                type="button"
                                className="transactions-widget-row-remove"
                                onClick={() => toggleLinkedRow(String(row.rowId))}
                                disabled={isSavingConnected || isRefreshingData}
                                aria-label={`Remove ${String(row.displayDescription)}`}
                              >
                                <X size={14} aria-hidden="true" />
                              </button>
                            </article>
                          ))}
                        </div>
                      </section>

                      <section className="transactions-widget-section">
                        <div className="transactions-widget-section-head">
                          <strong>Net row</strong>
                          <span>The selected rows will become peer transfers.</span>
                        </div>
                        <div className="transactions-widget-form-grid">
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
                        </div>
                      </section>

                      <div className="transactions-widget-actions">
                        <button
                          type="button"
                          className="quick-button transactions-link-confirm-button"
                          onClick={() => void submitLinkedExpense()}
                          disabled={isSavingConnected || isRefreshingData || selectedConnectedRows.length < 2}
                        >
                          {isSavingConnected ? "Linking..." : "Link selected"}
                        </button>
                        <button
                          type="button"
                          className="quick-button quick-button-ghost transactions-widget-secondary"
                          onClick={() => setOpenWidget(null)}
                          disabled={isSavingConnected || isRefreshingData}
                        >
                          Cancel
                        </button>
                      </div>
                      {connectedExpenseError ? <div className="table-action-error">{connectedExpenseError}</div> : null}
                    </>
                  ) : openWidget === "manual" ? (
                    <>
                      <section className="transactions-widget-section transactions-manual-composer">
                        <div className="transactions-manual-head">
                          <strong>Add adjustment</strong>
                          <span>One extra row for anything missing from the statement.</span>
                        </div>

                        <div className="manual-transaction-grid transactions-manual-grid transactions-widget-form-grid">
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
                          <div className="field transactions-manual-amount">
                            <label htmlFor="manualAmount">Amount</label>
                            <input
                              id="manualAmount"
                              type="number"
                              step="0.01"
                              placeholder="-18.40 or +2500"
                              value={manualDraft.signedAmount}
                              onChange={(event) => setManualDraft((current) => ({ ...current, signedAmount: event.target.value }))}
                            />
                          </div>
                          <div className="field transactions-utility-field-span">
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
                          <div className="field transactions-utility-field-span">
                            <label htmlFor="manualDescription">Description</label>
                            <input
                              id="manualDescription"
                              value={manualDraft.description}
                              placeholder="Rent split, correction, reimbursement..."
                              onChange={(event) => setManualDraft((current) => ({ ...current, description: event.target.value }))}
                            />
                          </div>
                        </div>

                        <div className="button-row transactions-manual-actions">
                          <button
                            type="button"
                            className="quick-button"
                            onClick={() => void submitManualTransaction()}
                            disabled={isSavingManual || isRefreshingData}
                          >
                            {isSavingManual ? "Adding..." : "Add row"}
                          </button>
                          <button
                            type="button"
                            className="quick-button quick-button-ghost transactions-widget-secondary"
                            onClick={() => setOpenWidget(null)}
                            disabled={isSavingManual || isRefreshingData}
                          >
                            Cancel
                          </button>
                        </div>
                        {manualError ? <div className="table-action-error">{manualError}</div> : null}
                      </section>

                      {manualRows.length > 0 ? (
                        <section className="transactions-widget-section">
                          <div className="transactions-manual-saved-head">
                            <strong>Recent manual rows</strong>
                            <span>{manualTransactionsState.length.toLocaleString("en-US")} total</span>
                          </div>

                          <div className="transactions-manual-list">
                            {manualRows.map((row) => (
                              <article key={String(row.rowId)} className="transactions-manual-item">
                                <div className="transactions-manual-item-main">
                                  <div className="transactions-manual-item-head">
                                    <strong>{String(row.description || "Manual adjustment")}</strong>
                                    <SignedAmount value={Number(row.amount)} />
                                  </div>
                                  <div className="transactions-manual-item-meta">
                                    <span>{String(row.date)}</span>
                                  </div>
                                </div>
                                <div className="transactions-manual-item-actions">
                                  <CategoryEditor row={row} />
                                  <button
                                    type="button"
                                    className="table-action-button table-action-button-secondary"
                                    onClick={() => void deleteManualTransaction(String(row.rowId))}
                                    disabled={isSavingManual || isRefreshingData}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <section className="transactions-widget-section transactions-reset-section">
                        <div className="transactions-reset-copy">
                          <strong>This deletes the local app database.</strong>
                          <p>
                            Imported transactions, raw statements, manual rows, overrides, caches, and portfolio
                            adjustments will be removed from this app instance.
                          </p>
                        </div>

                        <div className="transactions-widget-metrics" aria-label="Delete all data summary">
                          <div className="transactions-widget-metric">
                            <span>Imported rows</span>
                            <strong>{transactions.length.toLocaleString("en-US")}</strong>
                          </div>
                          <div className="transactions-widget-metric">
                            <span>Manual rows</span>
                            <strong>{manualTransactionsState.length.toLocaleString("en-US")}</strong>
                          </div>
                          <div className="transactions-widget-metric">
                            <span>Overrides</span>
                            <strong>{rowOverridesState.length.toLocaleString("en-US")}</strong>
                          </div>
                        </div>

                        <ul className="transactions-reset-list">
                          <li>Deletes imported cashflow and portfolio data</li>
                          <li>Deletes raw PDF statements and classifier cache</li>
                          <li>Keeps the instrument registry and base classifier prompt</li>
                        </ul>
                      </section>

                      <div className="transactions-widget-actions transactions-reset-actions">
                        <button
                          type="button"
                          className="quick-button transactions-reset-confirm-button"
                          onClick={() => void resetAllData()}
                          disabled={isResettingData || isRefreshingData}
                        >
                          {isResettingData ? "Deleting..." : "Delete all data"}
                        </button>
                        <button
                          type="button"
                          className="quick-button quick-button-ghost transactions-widget-secondary"
                          onClick={() => setOpenWidget(null)}
                          disabled={isResettingData || isRefreshingData}
                        >
                          Cancel
                        </button>
                      </div>
                      {resetDataError ? <div className="table-action-error">{resetDataError}</div> : null}
                    </>
                  )}
                </div>
              </aside>
            </div>,
            document.body,
          )
        : null}
    </DashboardShell>
  );
}
