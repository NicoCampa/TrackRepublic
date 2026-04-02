"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  buildQuickMonthRanges,
  buildQuickYearRanges,
  createInitialFilterState,
  formatEuro,
  type FilterState,
} from "@/lib/dashboard-utils";
import { buildCategoryOptionGroupsForAmount, categoryLabel, resolveCategoryTheme, type CategoryTheme } from "@/lib/category-config";
import {
  EDITABLE_INVESTMENT_ASSET_CLASS_OPTIONS,
  investmentAssetClassLabel,
  normalizeInvestmentAssetClass,
} from "@/lib/investment-asset-class";
import type { PriceScale } from "@/lib/investment-positions";

export type MetricItem = {
  label: string;
  value: string;
  note: string;
  tone?: "neutral" | "positive" | "negative" | "accent";
};

export type TableColumn<Row> = {
  key: keyof Row;
  label: string;
  render?: (value: Row[keyof Row], row: Row) => ReactNode;
  align?: "left" | "right";
  className?: string;
  headerClassName?: string;
  cellClassName?: string;
  width?: CSSProperties["width"];
  sortable?: boolean;
  sortKey?: string;
  sortDefaultDirection?: "asc" | "desc";
};

export type TableSortState = {
  key: string;
  direction: "asc" | "desc";
};

export type DetailSummaryItem = {
  label: string;
  value: string;
};

export type DetailTrendPoint = {
  monthLabel: string;
  displayMonthLabel: string;
  value: number;
};

export type DetailTrendView = {
  title: string;
  note?: string;
  valueLabel: string;
  color?: string;
  data: DetailTrendPoint[];
};

export type DetailView<Row extends Record<string, unknown> = Record<string, unknown>> = {
  title: string;
  meta?: string;
  summary?: DetailSummaryItem[];
  trend?: DetailTrendView;
  actionHref?: string;
  actionLabel?: string;
  rows: Row[];
  columns: Array<TableColumn<Row>>;
  emptyMessage?: string;
};

export const chartTooltipContentStyle = {
  backgroundColor: "hsl(223 22% 13%)",
  borderRadius: "0px",
  border: "1px solid hsla(var(--border-strong), 0.94)",
  boxShadow: "0 18px 28px -24px rgba(0, 0, 0, 0.82)",
  color: "hsl(var(--text))",
  opacity: 1,
  padding: "10px 12px",
  backdropFilter: "none",
  WebkitBackdropFilter: "none",
} as const;

const detailTrendAxisFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

const detailTableSortCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

function compareDetailTableValues(left: unknown, right: unknown) {
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
  return detailTableSortCollator.compare(String(left), String(right));
}

type ChartTooltipValueFormatter = (
  value: unknown,
  name: string,
  item: any,
  index: number,
) => ReactNode | [ReactNode, ReactNode];

type ChartTooltipLabelFormatter = (label: unknown, payload: any[]) => ReactNode;

function resolveChartTooltipLabel(
  label: unknown,
  payload: any[],
  formatLabel?: ChartTooltipLabelFormatter,
) {
  const formatted = formatLabel ? formatLabel(label, payload) : label;
  if (formatted !== undefined && formatted !== null && String(formatted).trim()) {
    return formatted;
  }

  const first = payload[0];
  return (
    first?.payload?.categoryLabel ??
    first?.payload?.label ??
    first?.payload?.displayMonthLabel ??
    first?.payload?.monthLabel ??
    first?.name ??
    first?.dataKey ??
    ""
  );
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  formatLabel,
  formatValue,
  sortPayload,
}: {
  active?: boolean;
  payload?: any[];
  label?: unknown;
  formatLabel?: ChartTooltipLabelFormatter;
  formatValue?: ChartTooltipValueFormatter;
  sortPayload?: ((left: any, right: any) => number) | undefined;
}) {
  const visiblePayload = (payload ?? []).filter((item) => item && item.value !== undefined && item.value !== null);
  if (!active || visiblePayload.length === 0) {
    return null;
  }

  const sortedPayload = sortPayload ? visiblePayload.slice().sort(sortPayload) : visiblePayload;
  const tooltipLabel = resolveChartTooltipLabel(label, sortedPayload, formatLabel);

  return (
    <div className="chart-tooltip-surface" style={chartTooltipContentStyle}>
      {tooltipLabel ? <div className="chart-tooltip-title">{tooltipLabel}</div> : null}
      <div className="chart-tooltip-list">
        {sortedPayload.map((item, index) => {
          const resolvedName = String(item.name ?? item.dataKey ?? "");
          const formatted = formatValue ? formatValue(item.value, resolvedName, item, index) : item.value;
          const valueNode = Array.isArray(formatted) ? formatted[0] : formatted;
          const nameNode = Array.isArray(formatted) ? formatted[1] : resolvedName;
          const color = item.color ?? item.fill ?? item.stroke ?? item.payload?.color ?? "hsl(var(--text-muted))";

          return (
            <div key={`${item.dataKey ?? resolvedName}-${index}`} className="chart-tooltip-row">
              <span className="chart-tooltip-series">
                <span className="chart-tooltip-dot" style={{ backgroundColor: color }} />
                <span>{nameNode}</span>
              </span>
              <span className="chart-tooltip-value">{valueNode}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type EditableCategoryRow = {
  rowId?: string;
  txType?: string;
  description?: string;
  displayDescription?: string;
  date?: string;
  signedAmount?: number;
  groupKey?: string;
  categoryKey?: string;
  categoryLabel?: string;
  categoryOverride?: string;
  investmentAssetClass?: string;
  classifiedInvestmentAssetClass?: string;
  investmentAssetClassOverride?: string;
};

type EditablePositionRow = {
  instrumentKey: string;
  isin?: string;
  instrument: string;
  units: number;
  unitsKnown?: boolean;
  effectiveDate: string;
  priceEur: number;
  priceScale?: PriceScale;
  valuationSource?: string;
  valuationSourceLabel?: string;
};

export function defaultFilterState(dates: string[]): FilterState {
  const latestMonthRange = buildQuickMonthRanges(dates, 1)[0];
  if (!latestMonthRange) {
    return createInitialFilterState(dates, "allTime");
  }

  return {
    preset: "custom",
    startDate: latestMonthRange.startDate,
    endDate: latestMonthRange.endDate,
    includeTransfers: true,
    excludeIncompleteMonths: false,
    activeQuickLabel: latestMonthRange.label,
    activeQuickKind: latestMonthRange.kind,
  };
}

export function DashboardShell({
  kicker,
  title,
  description,
  meta,
  className,
  hideHero = false,
  viewportLocked = false,
  children,
}: {
  kicker: string;
  title?: string;
  description: string;
  meta?: string;
  className?: string;
  hideHero?: boolean;
  viewportLocked?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={`shell${viewportLocked ? " shell-viewport-locked" : ""}${className ? ` ${className}` : ""}`}>
      {hideHero ? null : (
        <section className="hero">
          <div className="hero-main">
            <div className="hero-kicker">{kicker}</div>
            <div className="hero-copy">
              {title ? <h1>{title}</h1> : null}
              <p>{description}</p>
            </div>
          </div>
          {meta ? <div className="hero-meta">{meta}</div> : null}
        </section>
      )}

      {children}
    </main>
  );
}

export function FilterBar({
  dates,
  filters,
  onChange,
  compact = false,
  summaryLabel = "Time range",
}: {
  dates: string[];
  filters: FilterState;
  onChange: (next: FilterState) => void;
  compact?: boolean;
  summaryLabel?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const quickMonths = buildQuickMonthRanges(dates);
  const quickYears = buildQuickYearRanges(dates);
  const activeWindowLabel = filters.activeQuickLabel
    ? `${filters.activeQuickKind === "month" ? "Month" : "Year"}: ${filters.activeQuickLabel}`
    : "All data";

  const applyFilters = (next: FilterState) => {
    startTransition(() => onChange(next));
  };

  const clearToAllData = () => {
    applyFilters(createInitialFilterState(dates, "allTime"));
  };

  const applyQuickRange = (range: { startDate: string; endDate: string; kind: "month" | "year"; label: string }) => {
    const isActive = filters.activeQuickKind === range.kind && filters.activeQuickLabel === range.label;
    if (isActive) {
      clearToAllData();
      return;
    }

    applyFilters({
      ...filters,
      preset: "custom",
      startDate: range.startDate,
      endDate: range.endDate,
      activeQuickKind: range.kind,
      activeQuickLabel: range.label,
    });
  };

  const content = (
    <section className="toolbar" aria-busy={isPending}>
      <div className="quick-line">
        <h3>Months</h3>
        <div className="button-grid">
          {quickMonths.map((range) => (
            <button
              key={`${range.kind}-${range.startDate}`}
              type="button"
              className="quick-button"
              data-active={filters.activeQuickKind === range.kind && filters.activeQuickLabel === range.label}
              onClick={() => applyQuickRange(range)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="quick-line">
        <h3>Years</h3>
        <div className="button-grid">
          {quickYears.map((range) => (
            <button
              key={`${range.kind}-${range.label}`}
              type="button"
              className="quick-button"
              data-active={filters.activeQuickKind === range.kind && filters.activeQuickLabel === range.label}
              onClick={() => applyQuickRange(range)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar-clear">
        <button
          type="button"
          className="quick-button"
          data-active={filters.excludeIncompleteMonths}
          onClick={() =>
            applyFilters({
              ...filters,
              excludeIncompleteMonths: !filters.excludeIncompleteMonths,
            })
          }
        >
          Hide incomplete last month
        </button>
      </div>
    </section>
  );

  if (!compact) {
    return content;
  }

  return (
    <details className="details filterbar-compact" aria-busy={isPending}>
      <summary>
        <span className="filterbar-summary-title">{summaryLabel}</span>
        <span className="filterbar-summary-meta">{activeWindowLabel}</span>
        {filters.excludeIncompleteMonths ? (
          <span className="filterbar-summary-badge">Incomplete last month hidden</span>
        ) : null}
      </summary>
      <div className="filterbar-compact-body">{content}</div>
    </details>
  );
}

export function PageToolbar({
  children,
  items = [],
}: {
  children?: ReactNode;
  items?: string[];
}) {
  const visible = items.filter(Boolean);

  return (
    <section className="page-toolbar">
      {children ? <div className="page-toolbar-body">{children}</div> : null}
      {visible.length > 0 ? (
        <div className="page-toolbar-pills" aria-label="Current filters">
          {visible.map((item) => (
            <span key={item} className="page-toolbar-pill">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function PillRow({ items }: { items: string[] }) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="pill-row">
      {visible.map((item) => (
        <span key={item} className="pill">
          {item}
        </span>
      ))}
    </div>
  );
}

export function CategoryBadge({
  category,
  label,
  theme,
}: {
  category: string;
  label?: string;
  theme?: CategoryTheme;
}) {
  const resolvedTheme = theme ?? resolveCategoryTheme(category);
  return (
    <span
      className="category-badge"
      style={{
        borderColor: resolvedTheme.solid,
        backgroundColor: resolvedTheme.soft,
        color: resolvedTheme.text,
      }}
    >
      <span className="category-badge-dot" style={{ backgroundColor: resolvedTheme.solid }} />
      {label ?? categoryLabel(category)}
    </span>
  );
}

function InvestmentAssetClassBadge({
  value,
  label,
  automatic = false,
}: {
  value?: string;
  label?: string;
  automatic?: boolean;
}) {
  const normalized = normalizeInvestmentAssetClass(value);
  return (
    <span className="investment-asset-class-badge" data-value={normalized || "automatic"} data-automatic={automatic}>
      {label ?? investmentAssetClassLabel(normalized, "Automatic")}
    </span>
  );
}

function isEditableCategoryRow(row: Record<string, unknown>): row is Record<string, unknown> & EditableCategoryRow {
  return typeof row.rowId === "string" && typeof row.description === "string" && typeof row.categoryKey === "string";
}

function isEditablePositionRow(row: Record<string, unknown>): row is Record<string, unknown> & EditablePositionRow {
  return (
    typeof row.instrumentKey === "string" &&
    typeof row.instrument === "string" &&
    typeof row.effectiveDate === "string" &&
    typeof row.units === "number" &&
    typeof row.priceEur === "number"
  );
}

function displayPriceForScale(priceEur: number, priceScale: PriceScale | undefined) {
  if (priceScale === "percent_of_par") {
    return priceEur * 100;
  }
  return priceEur;
}

function normalizePriceInput(price: number, priceScale: PriceScale | undefined) {
  if (priceScale === "percent_of_par") {
    return price / 100;
  }
  return price;
}

export function CategoryEditor({ row }: { row: Record<string, unknown> }) {
  const editableRow = isEditableCategoryRow(row) ? row : null;
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const dialogTitleId = useId();
  const searchFieldId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(editableRow?.categoryKey ?? "other");
  const [selectedAssetClass, setSelectedAssetClass] = useState(
    normalizeInvestmentAssetClass(editableRow?.investmentAssetClassOverride ?? ""),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  if (!editableRow) {
    return null;
  }

  const currentCategory = editableRow.categoryKey ?? "other";
  const currentCategoryOverride = String(editableRow.categoryOverride ?? "").trim();
  const currentCategoryLabel = editableRow.categoryLabel ?? categoryLabel(currentCategory);
  const selectedCategoryLabel = categoryLabel(selectedCategory);
  const isInvestmentRow = editableRow.groupKey === "investment";
  const currentAssetClass = normalizeInvestmentAssetClass(editableRow.investmentAssetClass ?? "");
  const currentAssetClassOverride = normalizeInvestmentAssetClass(editableRow.investmentAssetClassOverride ?? "");
  const classifiedAssetClass = normalizeInvestmentAssetClass(editableRow.classifiedInvestmentAssetClass ?? "");
  const currentAssetClassLabel = investmentAssetClassLabel(currentAssetClass, "Unclassified");
  const selectedAssetClassLabel = investmentAssetClassLabel(selectedAssetClass, "Automatic");
  const classifierAssetClassLabel = investmentAssetClassLabel(classifiedAssetClass, "Unclassified");
  const rowTitle = String(editableRow.displayDescription ?? editableRow.description ?? "Transaction").trim() || "Transaction";
  const secondaryDescription =
    editableRow.displayDescription && editableRow.description && editableRow.displayDescription !== editableRow.description
      ? editableRow.description
      : "";
  const rowMeta = [editableRow.date, editableRow.txType].filter(Boolean).join(" · ");
  const categoryGroups = useMemo(
    () => buildCategoryOptionGroupsForAmount(editableRow.signedAmount, currentCategory),
    [currentCategory, editableRow.signedAmount],
  );
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleCategoryGroups = useMemo(() => {
    if (!normalizedSearch) {
      return categoryGroups;
    }

    return categoryGroups
      .map((group) => {
        const matchesGroup = group.label.toLowerCase().includes(normalizedSearch);
        return {
          ...group,
          options: matchesGroup
            ? group.options
            : group.options.filter((option) => option.label.toLowerCase().includes(normalizedSearch)),
        };
      })
      .filter((group) => group.options.length > 0);
  }, [categoryGroups, normalizedSearch]);
  const visibleOptionCount = visibleCategoryGroups.reduce((sum, group) => sum + group.options.length, 0);
  const categoryChanged = selectedCategory !== currentCategory;
  const assetClassChanged = isInvestmentRow && selectedAssetClass !== currentAssetClassOverride;
  const canSave = categoryChanged || assetClassChanged;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        setIsOpen(false);
        setError("");
        setSearchQuery("");
      }
    };

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    window.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [isOpen, isSaving]);

  const closeEditor = (force = false) => {
    if (isSaving && !force) {
      return;
    }
    setIsOpen(false);
    setError("");
    setSearchQuery("");
  };

  const submit = async () => {
    if (!selectedCategory || isSaving || !canSave) {
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const response = await fetch("/api/row-overrides", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          override: {
            rowId: editableRow.rowId,
            description: editableRow.description,
            transactionType: editableRow.txType,
            signedAmount: editableRow.signedAmount,
            category: categoryChanged ? selectedCategory : currentCategoryOverride,
            assetClass: isInvestmentRow
              ? assetClassChanged
                ? selectedAssetClass
                : currentAssetClassOverride
              : currentAssetClassOverride,
            source: "row_override",
          },
        }),
      });

      if (!response.ok) {
        throw new Error("Could not save the classification change.");
      }

      closeEditor(true);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the classification change.");
    } finally {
      setIsSaving(false);
    }
  };

  const openEditor = () => {
    setError("");
    setSearchQuery("");
    setSelectedCategory(currentCategory);
    setSelectedAssetClass(currentAssetClassOverride);
    setIsOpen(true);
  };

  const dialog =
    isOpen && typeof document !== "undefined" ? (
      createPortal(
        <div
          className="detail-sheet-backdrop category-editor-backdrop"
          role="presentation"
          onClick={() => {
            closeEditor();
          }}
        >
          <aside
            className="detail-sheet category-editor-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-sheet-head category-editor-sheet-head">
              <div>
                <div className="detail-sheet-kicker">Transactions</div>
                <h2 id={dialogTitleId}>Edit classification</h2>
                <p>Update this transaction only. Similar rows, rules, and future imports stay unchanged.</p>
              </div>
              <div className="detail-sheet-head-actions">
                <button
                  type="button"
                  className="detail-sheet-close"
                  onClick={() => closeEditor()}
                  aria-label="Close classification editor"
                  disabled={isSaving}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="detail-sheet-body category-editor-sheet-body">
              <section className="transactions-widget-section category-editor-context">
                <div className="category-editor-context-copy">
                  <strong>{rowTitle}</strong>
                  {secondaryDescription ? <span>{secondaryDescription}</span> : null}
                  {rowMeta ? <small>{rowMeta}</small> : null}
                </div>
                <div className="category-editor-context-amount">
                  {formatEuro(editableRow.signedAmount ?? 0, { signed: true })}
                </div>
              </section>

              <div className="category-editor-summary-grid" aria-label="Category selection summary">
                <article className="category-editor-summary-card">
                  <span className="category-editor-summary-card-label">Current</span>
                  <CategoryBadge category={currentCategory} label={currentCategoryLabel} />
                  <small>{categoryChanged ? "Current category on this row" : "No pending category change"}</small>
                </article>
                <article className="category-editor-summary-card" data-state={categoryChanged ? "pending" : "current"}>
                  <span className="category-editor-summary-card-label">{categoryChanged ? "New category" : "Selected"}</span>
                  <CategoryBadge category={selectedCategory} label={selectedCategoryLabel} />
                  <small>{categoryChanged ? "Will be saved for this row only" : "Choose a different category to update it"}</small>
                </article>
              </div>

              <section className="transactions-widget-section category-editor-selector">
                <div className="category-editor-selector-head">
                  <strong>Categories</strong>
                  <span>{normalizedSearch ? `${visibleOptionCount} matches` : `${visibleOptionCount} available`}</span>
                </div>
                <div className="field category-editor-search-field">
                  <label htmlFor={searchFieldId}>Search categories</label>
                  <input
                    ref={searchInputRef}
                    id={searchFieldId}
                    type="search"
                    placeholder="Search categories"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                <div className="category-editor-sheet-groups">
                  {visibleCategoryGroups.length > 0 ? (
                    visibleCategoryGroups.map((group) => (
                      <section key={group.label} className="category-editor-sheet-group">
                        <div className="category-editor-sheet-group-head">
                          <strong>{group.label}</strong>
                          <span>{group.options.length}</span>
                        </div>
                        <div className="category-editor-sheet-options">
                          {group.options.map((option) => {
                            const isCurrent = currentCategory === option.value;
                            const isSelected = selectedCategory === option.value;

                            return (
                              <button
                                key={option.value}
                                type="button"
                                className="category-editor-sheet-option"
                                data-active={isSelected}
                                data-current={isCurrent}
                                onClick={() => setSelectedCategory(option.value)}
                                disabled={isSaving}
                                aria-pressed={isSelected}
                                aria-label={`${option.label}${isCurrent ? ", current" : isSelected ? ", selected" : ""}`}
                              >
                                <CategoryBadge
                                  category={option.value}
                                  label={option.label}
                                  theme={resolveCategoryTheme(option.value)}
                                />
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  ) : (
                    <div className="category-editor-sheet-empty">No categories match that search.</div>
                  )}
                </div>
              </section>

              {isInvestmentRow ? (
                <section className="transactions-widget-section category-editor-selector">
                  <div className="category-editor-selector-head">
                    <strong>Investment subcategory</strong>
                    <span>{currentAssetClassOverride ? "Manual override" : "Automatic"}</span>
                  </div>

                  <div className="category-editor-summary-grid" aria-label="Investment subcategory selection summary">
                    <article className="category-editor-summary-card">
                      <span className="category-editor-summary-card-label">Current</span>
                      <InvestmentAssetClassBadge value={currentAssetClass} label={currentAssetClassLabel} />
                      <small>
                        {currentAssetClassOverride
                          ? "Current row-level investment subtype"
                          : `Automatic result${currentAssetClass ? `: ${currentAssetClassLabel}` : ""}`}
                      </small>
                    </article>
                    <article className="category-editor-summary-card" data-state={assetClassChanged ? "pending" : "current"}>
                      <span className="category-editor-summary-card-label">
                        {assetClassChanged ? "New subtype" : "Selected"}
                      </span>
                      <InvestmentAssetClassBadge
                        value={selectedAssetClass}
                        label={selectedAssetClassLabel}
                        automatic={!selectedAssetClass}
                      />
                      <small>
                        {selectedAssetClass
                          ? "Will be saved for this row only"
                          : currentAssetClassOverride
                            ? `Revert to automatic: ${classifierAssetClassLabel}`
                            : "Use the current automatic result"}
                      </small>
                    </article>
                  </div>

                  <div className="investment-asset-class-grid">
                    <button
                      type="button"
                      className="investment-asset-class-option"
                      data-active={selectedAssetClass === ""}
                      data-current={currentAssetClassOverride === ""}
                      onClick={() => setSelectedAssetClass("")}
                      disabled={isSaving}
                      aria-pressed={selectedAssetClass === ""}
                    >
                      <span className="investment-asset-class-option-copy">
                        <InvestmentAssetClassBadge automatic />
                        <small>{currentAssetClass ? `Follow ${currentAssetClassLabel}` : "Remove the manual subtype override."}</small>
                      </span>
                      <span className="investment-asset-class-option-meta">
                        {isSaving && selectedAssetClass === ""
                          ? "Saving..."
                          : currentAssetClassOverride === ""
                            ? "Saved"
                            : selectedAssetClass === ""
                              ? "Selected"
                              : "Choose"}
                      </span>
                    </button>

                    {EDITABLE_INVESTMENT_ASSET_CLASS_OPTIONS.map((option) => {
                      const isCurrent = currentAssetClass === option.value;
                      const isSelected = selectedAssetClass === option.value;
                      const isSaved = currentAssetClassOverride === option.value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          className="investment-asset-class-option"
                          data-active={isSelected}
                          data-current={isSaved}
                          onClick={() => setSelectedAssetClass(option.value)}
                          disabled={isSaving}
                          aria-pressed={isSelected}
                        >
                          <span className="investment-asset-class-option-copy">
                            <InvestmentAssetClassBadge value={option.value} label={option.label} />
                            <small>{option.note}</small>
                          </span>
                          <span className="investment-asset-class-option-meta">
                            {isSaving && isSelected
                              ? "Saving..."
                              : isSaved
                                ? "Saved"
                                : isCurrent
                                  ? "Current"
                                  : isSelected
                                    ? "Selected"
                                    : "Choose"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {error ? <div className="table-action-error category-editor-error">{error}</div> : null}

              <div className="category-editor-sheet-footer">
                <span className="category-editor-helper">Only this transaction will be updated.</span>
                <div className="category-editor-actions category-editor-sheet-actions">
                  <button type="button" className="quick-button quick-button-ghost" onClick={() => closeEditor()} disabled={isSaving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="quick-button category-editor-save-button"
                    data-active={canSave}
                    onClick={() => void submit()}
                    disabled={!canSave || isSaving}
                  >
                    {isSaving ? "Saving..." : "Save change"}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>,
        document.body,
      )
    ) : null;

  return (
    <div className="category-editor-inline">
      <button
        type="button"
        className="category-editor-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={openEditor}
      >
        <CategoryBadge
          category={currentCategory}
          label={currentCategoryLabel}
        />
        <span className="category-editor-caret">▾</span>
      </button>
      {dialog}
    </div>
  );
}

export function PositionHoldingEditor({ row }: { row: Record<string, unknown> }) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draftUnits, setDraftUnits] = useState(
    isEditablePositionRow(row)
      ? row.unitsKnown === false && row.units <= 0.0000001
        ? ""
        : row.units.toFixed(6)
      : "",
  );
  const [draftPrice, setDraftPrice] = useState(
    isEditablePositionRow(row) ? displayPriceForScale(row.priceEur, row.priceScale).toFixed(row.priceScale === "percent_of_par" ? 4 : 6) : "",
  );
  const [draftEffectiveDate, setDraftEffectiveDate] = useState(isEditablePositionRow(row) ? row.effectiveDate : "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: "top" | "bottom";
  } | null>(null);

  if (!isEditablePositionRow(row)) {
    return null;
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const margin = 12;
      const gap = 8;
      const preferredHeight = 360;
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.max(320, Math.ceil(rect.width) + 160);
      const spaceBelow = viewportHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const placement = spaceBelow >= 240 || spaceBelow >= spaceAbove ? "bottom" : "top";
      const maxHeight = Math.max(220, Math.min(preferredHeight, placement === "bottom" ? spaceBelow : spaceAbove));
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)) + window.scrollX;
      const top = (placement === "bottom" ? rect.bottom + gap : rect.top - gap) + window.scrollY;

      setMenuPosition({
        top,
        left,
        width,
        maxHeight,
        placement,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        setError("");
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
      setError("");
    };

    const handleResize = () => updatePosition();

    updatePosition();
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [isOpen]);

  const submit = async () => {
    if (isSaving) {
      return;
    }

    const nextDate = draftEffectiveDate.trim();
    const unitsChanged = draftUnits.trim() !== (row.unitsKnown === false && row.units <= 0.0000001 ? "" : row.units.toFixed(6));
    const priceChanged =
      draftPrice.trim() !==
      displayPriceForScale(row.priceEur, row.priceScale).toFixed(row.priceScale === "percent_of_par" ? 4 : 6);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      setError("Enter a valid effective date.");
      return;
    }

    const units = draftUnits.trim() ? Number(draftUnits) : Number.NaN;
    if (unitsChanged && (!Number.isFinite(units) || units < 0)) {
      setError("Enter a valid non-negative unit count.");
      return;
    }

    const displayPrice = Number(draftPrice);
    if (!Number.isFinite(displayPrice) || displayPrice <= 0) {
      setError("Enter a valid positive price.");
      return;
    }

    const priceEur = normalizePriceInput(displayPrice, row.priceScale);
    if (!Number.isFinite(priceEur) || priceEur <= 0) {
      setError("Enter a valid positive price.");
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const requests: Promise<Response>[] = [];

      if (unitsChanged) {
        requests.push(
          fetch("/api/position-units", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              instrumentKey: row.instrumentKey,
              isin: row.isin,
              instrument: row.instrument,
              units,
              effectiveDate: nextDate,
            }),
          }),
        );
      }

      if (priceChanged) {
        requests.push(
          fetch("/api/position-valuations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              instrumentKey: row.instrumentKey,
              isin: row.isin,
              instrument: row.instrument,
              priceEur,
              effectiveDate: nextDate,
            }),
          }),
        );
      }

      if (requests.length === 0) {
        setIsOpen(false);
        return;
      }

      const responses = await Promise.all(requests);
      if (responses.some((response) => !response.ok)) {
        throw new Error("Could not save the holding adjustment.");
      }

      setIsOpen(false);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the holding adjustment.");
    } finally {
      setIsSaving(false);
    }
  };

  const openEditor = () => {
    setDraftUnits(row.unitsKnown === false && row.units <= 0.0000001 ? "" : row.units.toFixed(6));
    setDraftPrice(
      displayPriceForScale(row.priceEur, row.priceScale).toFixed(row.priceScale === "percent_of_par" ? 4 : 6),
    );
    setDraftEffectiveDate(row.effectiveDate);
    setError("");
    setIsOpen(true);
  };

  const priceLabel = row.priceScale === "percent_of_par" ? "Price (% of par)" : "Price (EUR / unit)";
  const sourceLabel = row.valuationSourceLabel ?? row.valuationSource ?? "Current";
  const popover =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popoverRef}
            className="position-holding-popover"
            data-placement={menuPosition?.placement ?? "bottom"}
            role="dialog"
            aria-modal="false"
            aria-label="Adjust holding"
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
              width: menuPosition?.width ?? 320,
              maxHeight: menuPosition?.maxHeight ?? 360,
            }}
          >
            <div className="category-editor-dialog-head">
              <div className="category-editor-popover-head">Adjust holding</div>
              <div className="category-editor-dialog-title">
                <strong>{row.instrument}</strong>
                <span>{sourceLabel}</span>
              </div>
            </div>
            <div className="position-holding-form">
              <label className="position-holding-field">
                <span>Effective date</span>
                <input
                  className="position-units-input"
                  type="date"
                  value={draftEffectiveDate}
                  onChange={(event) => setDraftEffectiveDate(event.target.value)}
                />
              </label>
              <label className="position-holding-field">
                <span>Units</span>
                <input
                  className="position-units-input"
                  type="number"
                  step="0.000001"
                  min="0"
                  value={draftUnits}
                  onChange={(event) => {
                    setDraftUnits(event.target.value);
                    if (error) {
                      setError("");
                    }
                  }}
                  placeholder="0.000000"
                />
              </label>
              <label className="position-holding-field">
                <span>{priceLabel}</span>
                <input
                  className="position-units-input"
                  type="number"
                  step={row.priceScale === "percent_of_par" ? "0.0001" : "0.000001"}
                  min="0"
                  value={draftPrice}
                  onChange={(event) => {
                    setDraftPrice(event.target.value);
                    if (error) {
                      setError("");
                    }
                  }}
                />
              </label>
            </div>
            <div className="position-holding-helper">
              Live quotes still take priority. Manual price is used when no valid live quote is available.
            </div>
            {error ? <span className="table-action-error">{error}</span> : null}
            <div className="position-units-actions">
              <button type="button" className="table-action-button table-action-button-secondary" onClick={() => setIsOpen(false)} disabled={isSaving}>
                Close
              </button>
              <button type="button" className="table-action-button" onClick={() => void submit()} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="position-units-inline">
      <button
        ref={triggerRef}
        type="button"
        className="position-holding-trigger"
        onClick={openEditor}
      >
        <span>Adjust</span>
        <span className="category-editor-caret">▾</span>
      </button>
      {popover}
    </div>
  );
}

export function PositionUnitsEditor({ row }: { row: Record<string, unknown> }) {
  return <PositionHoldingEditor row={row} />;
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <section className="metrics">
      {items.map((item, idx) => (
        <article className="metric-card" data-tone={item.tone ?? "neutral"} key={item.label} style={{ animationDelay: `${idx * 0.1}s` }}>
          <div className="metric-label">{item.label}</div>
          <div className="metric-value">
            <MetricValueDisplay value={item.value} />
          </div>
          <div className="metric-note">{item.note}</div>
        </article>
      ))}
    </section>
  );
}

export function ClickableMetricGrid({
  items,
  onSelect,
}: {
  items: MetricItem[];
  onSelect: (item: MetricItem) => void;
}) {
  return (
    <section className="metrics">
      {items.map((item, idx) => (
        <button
          type="button"
          className="metric-card metric-card-button"
          data-tone={item.tone ?? "neutral"}
          key={item.label}
          style={{ animationDelay: `${idx * 0.1}s` }}
          onClick={() => onSelect(item)}
        >
          <div className="metric-label">{item.label}</div>
          <div className="metric-value">
            <MetricValueDisplay value={item.value} />
          </div>
          <div className="metric-note">{item.note}</div>
        </button>
      ))}
    </section>
  );
}

export function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {note ? (
          <span className="info-dot" title={note} aria-label={note}>
            i
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  title,
  note,
  actions,
  className,
  children,
}: {
  title: string;
  note?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={["panel", className ?? ""].filter(Boolean).join(" ")}>
      <div className="panel-head">
        <div className="panel-head-main">
          <h3>{title}</h3>
          {note ? (
            <span className="info-dot" title={note} aria-label={note}>
              i
            </span>
          ) : null}
        </div>
        {actions ? <div className="panel-head-actions">{actions}</div> : null}
      </div>
      {children}
    </article>
  );
}

function MetricValueDisplay({ value }: { value: string }) {
  const hasLeadingPositiveSign = value.startsWith("+");
  const normalizedValue = hasLeadingPositiveSign ? value.slice(1) : value;
  const match = normalizedValue.match(/^([A-Z]{3})\s(.+)$/);

  if (!match) {
    return <span className="metric-number">{value}</span>;
  }

  return (
    <span className="metric-value-shell">
      <span className="metric-currency">{match[1]}</span>
      <span className="metric-number">{`${hasLeadingPositiveSign ? "+" : ""}${match[2]}`}</span>
    </span>
  );
}

export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  emptyMessage,
  density = "default",
  onRowClick,
  rowKey,
  stickyHeader = false,
  sortState,
  onSortChange,
}: {
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  emptyMessage?: string;
  density?: "default" | "compact";
  onRowClick?: (row: Row) => void;
  rowKey?: keyof Row | ((row: Row, index: number) => string);
  stickyHeader?: boolean;
  sortState?: TableSortState | null;
  onSortChange?: (next: TableSortState) => void;
}) {
  if (rows.length === 0) {
    return <div className="empty">{emptyMessage ?? "No rows match the current view."}</div>;
  }

  return (
    <div className="table-wrap" data-sticky-header={stickyHeader ? "true" : undefined}>
      <table className="data-table" data-density={density} data-sticky-header={stickyHeader ? "true" : undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={String(column.key)}
                aria-sort={
                  column.sortable && sortState?.key === (column.sortKey ?? String(column.key))
                    ? sortState.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : column.sortable
                      ? "none"
                      : undefined
                }
                className={[
                  column.align === "right" ? "is-right" : "",
                  column.className ?? "",
                  column.headerClassName ?? "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.sortable && onSortChange ? (
                  <button
                    type="button"
                    className="table-sort-button"
                    data-active={sortState?.key === (column.sortKey ?? String(column.key))}
                    onClick={() =>
                      onSortChange({
                        key: column.sortKey ?? String(column.key),
                        direction:
                          sortState?.key === (column.sortKey ?? String(column.key))
                            ? sortState.direction === "asc"
                              ? "desc"
                              : "asc"
                            : (column.sortDefaultDirection ?? "asc"),
                      })
                    }
                  >
                    <span>{column.label}</span>
                    <span className="table-sort-icon" aria-hidden="true">
                      {sortState?.key === (column.sortKey ?? String(column.key)) ? (
                        sortState.direction === "asc" ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        )
                      ) : (
                        <ArrowUpDown size={12} />
                      )}
                    </span>
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={typeof rowKey === "function" ? rowKey(row, index) : rowKey ? String(row[rowKey] ?? index) : index}
              className={onRowClick ? "is-clickable" : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowClick(row);
                }
              } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => {
                const value = row[column.key];
                return (
                  <td
                    key={String(column.key)}
                    className={[
                      column.align === "right" ? "is-right" : "",
                      column.className ?? "",
                      column.cellClassName ?? "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {column.render ? column.render(value, row) : String(value ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SignedAmount({ value }: { value: number }) {
  const isPositive = value >= 0;
  return (
    <span style={{ color: isPositive ? "hsl(var(--accent-primary))" : "hsl(var(--accent-tertiary))", fontWeight: "600" }}>
      {formatEuro(value, { signed: true })}
    </span>
  );
}

export function DetailSheet({
  open,
  detail,
  onClose,
}: {
  open: boolean;
  detail: DetailView | null;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [sortState, setSortState] = useState<TableSortState | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
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
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    bodyRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [open, detail]);

  useEffect(() => {
    setSortState(null);
  }, [detail]);

  const sortedRows = useMemo(() => {
    if (!detail || !sortState) {
      return detail?.rows ?? [];
    }

    return detail.rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const comparison = compareDetailTableValues(
          left.row[sortState.key as keyof typeof left.row],
          right.row[sortState.key as keyof typeof right.row],
        );

        if (comparison !== 0) {
          return sortState.direction === "asc" ? comparison : -comparison;
        }

        return left.index - right.index;
      })
      .map(({ row }) => row);
  }, [detail, sortState]);

  if (!open) {
    return null;
  }

  if (typeof document === "undefined") {
    return null;
  }

  if (!detail) {
    return null;
  }

  return createPortal(
    <div className="detail-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={detail.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-sheet-head">
          <div>
            <div className="detail-sheet-kicker">Details</div>
            <h2>{detail.title}</h2>
            {detail.meta ? <p>{detail.meta}</p> : null}
          </div>
          <div className="detail-sheet-head-actions">
            {detail.actionHref ? (
              <a href={detail.actionHref} className="detail-sheet-link">
                {detail.actionLabel ?? "Open"}
              </a>
            ) : null}
            <button type="button" className="detail-sheet-close" onClick={onClose} aria-label="Close details">
              <X size={18} />
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="detail-sheet-body">
          {detail.trend || (detail.summary && detail.summary.length > 0) ? (
            <div className="detail-overview-grid" data-has-trend={detail.trend ? "true" : undefined}>
              {detail.trend ? (
                <section className="detail-trend-card">
                  <div className="detail-trend-head">
                    <div className="detail-trend-copy">
                      <strong>{detail.trend.title}</strong>
                      {detail.trend.note ? <span>{detail.trend.note}</span> : null}
                    </div>
                  </div>
                  <div className="detail-trend-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={detail.trend.data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                        <CartesianGrid stroke="rgba(223,231,243,0.06)" vertical={false} />
                        <XAxis
                          dataKey="displayMonthLabel"
                          stroke="hsl(var(--text-muted))"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          interval={0}
                          minTickGap={0}
                        />
                        <YAxis
                          stroke="hsl(var(--text-muted))"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          width={48}
                          tickFormatter={(value) => detailTrendAxisFormatter.format(Number(value ?? 0))}
                        />
                        <Tooltip
                          cursor={{ fill: "hsla(var(--text), 0.03)" }}
                          content={
                            <ChartTooltipContent
                              formatLabel={(label) => String(label ?? "")}
                              formatValue={(value) => [formatEuro(Number(value ?? 0)), detail.trend?.valueLabel ?? "Amount"]}
                            />
                          }
                        />
                        <Bar
                          dataKey="value"
                          name={detail.trend.valueLabel}
                          fill={detail.trend.color ?? "hsl(var(--accent-primary))"}
                          radius={[0, 0, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              ) : null}
              {detail.summary && detail.summary.length > 0 ? (
                <div className="detail-summary-grid">
                  {detail.summary.map((item) => (
                    <div key={item.label} className="detail-summary-card">
                      <div className="detail-summary-label">{item.label}</div>
                      <div className="detail-summary-value">{item.value}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <DataTable
            columns={detail.columns}
            rows={sortedRows}
            emptyMessage={detail.emptyMessage}
            stickyHeader
            sortState={sortState}
            onSortChange={setSortState}
          />
        </div>
      </aside>
    </div>,
    document.body,
  );
}
