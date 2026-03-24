"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  buildQuickMonthRanges,
  buildQuickYearRanges,
  createInitialFilterState,
  formatEuro,
  type FilterState,
} from "@/lib/dashboard-utils";
import { buildCategoryOptionGroupsForAmount, categoryLabel, CATEGORY_THEME } from "@/lib/category-config";

export type MetricItem = {
  label: string;
  value: string;
  note: string;
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
};

export type DetailSummaryItem = {
  label: string;
  value: string;
};

export type DetailView<Row extends Record<string, unknown> = Record<string, unknown>> = {
  title: string;
  meta?: string;
  summary?: DetailSummaryItem[];
  rows: Row[];
  columns: Array<TableColumn<Row>>;
  emptyMessage?: string;
};

export const chartTooltipContentStyle = {
  backgroundColor: "var(--card-strong)",
  borderRadius: "0px",
  border: "1px solid var(--border)",
  boxShadow: "var(--shadow-md)",
} as const;

type EditableCategoryRow = {
  rowId?: string;
  txType?: string;
  description?: string;
  merchant?: string;
  signedAmount?: number;
  categoryKey?: string;
  categoryLabel?: string;
};

type EditablePositionRow = {
  instrumentKey: string;
  isin?: string;
  instrument: string;
  units: number;
  effectiveDate: string;
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
  children,
}: {
  kicker: string;
  title?: string;
  description: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <main className="shell">
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
        <button type="button" className="quick-button" data-active={!filters.activeQuickLabel} onClick={clearToAllData}>
          All data
        </button>
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
}: {
  category: string;
  label?: string;
}) {
  const theme = CATEGORY_THEME[category] ?? CATEGORY_THEME.other;
  return (
    <span
      className="category-badge"
      style={{
        borderColor: theme.solid,
        backgroundColor: theme.soft,
        color: theme.text,
      }}
    >
      <span className="category-badge-dot" style={{ backgroundColor: theme.solid }} />
      {label ?? categoryLabel(category)}
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
    typeof row.units === "number"
  );
}

export function CategoryEditor({ row }: { row: Record<string, unknown> }) {
  const editableRow = isEditableCategoryRow(row) ? row : null;
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(editableRow?.categoryKey ?? "other");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: "top" | "bottom";
  } | null>(null);

  if (!editableRow) {
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
      const preferredHeight = 320;
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.max(260, Math.ceil(rect.width) + 18);
      const spaceBelow = viewportHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const placement = spaceBelow >= 220 || spaceBelow >= spaceAbove ? "bottom" : "top";
      const maxHeight = Math.max(160, Math.min(preferredHeight, placement === "bottom" ? spaceBelow : spaceAbove));
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)) + window.scrollX;
      const top =
        (placement === "bottom" ? rect.bottom + gap : rect.top - gap) + window.scrollY;

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

    const handleResize = () => {
      setIsOpen(false);
      setError("");
    };

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
    if (!selectedCategory || isSaving) {
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const response = await fetch("/api/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rowId: editableRow.rowId,
          description: editableRow.description,
          txType: editableRow.txType,
          merchant: editableRow.merchant,
          signedAmount: editableRow.signedAmount,
          category: selectedCategory,
          mode: "row",
        }),
      });

      if (!response.ok) {
        throw new Error("Could not save the category change.");
      }

      setIsOpen(false);
      router.refresh();
    } catch (saveError) {
      setSelectedCategory(editableRow.categoryKey ?? "other");
      setError(saveError instanceof Error ? saveError.message : "Could not save the category change.");
    } finally {
      setIsSaving(false);
    }
  };

  const openMenu = () => {
    setError("");
    setSelectedCategory(editableRow.categoryKey ?? "other");
    setIsOpen((current) => !current);
  };

  const canSave = selectedCategory !== (editableRow.categoryKey ?? "other");

  const menu =
    isOpen && typeof document !== "undefined" ? (
      createPortal(
        <div
          ref={popoverRef}
          className="category-editor-popover"
          data-placement={menuPosition?.placement ?? "bottom"}
          role="dialog"
          aria-modal="false"
          aria-label="Choose category"
          style={{
            top: menuPosition?.top ?? 0,
            left: menuPosition?.left ?? 0,
            width: menuPosition?.width ?? 260,
            maxHeight: menuPosition?.maxHeight ?? 320,
          }}
        >
          <div className="category-editor-dialog-head">
            <div className="category-editor-popover-head">Choose category</div>
            <div className="category-editor-dialog-title">
              <strong>{editableRow.merchant || editableRow.description}</strong>
              <span>{formatEuro(editableRow.signedAmount ?? 0, { signed: true })}</span>
            </div>
          </div>
          <div className="category-editor-list">
            {buildCategoryOptionGroupsForAmount(editableRow.signedAmount, editableRow.categoryKey).map((group) => (
              <div key={group.label} className="category-editor-group">
                <div className="category-editor-group-label">{group.label}</div>
                {group.options.map((option) => {
                  const isCurrent = editableRow.categoryKey === option.value;
                  const isSelected = selectedCategory === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      className="category-editor-option"
                      data-active={isSelected}
                      data-current={isCurrent}
                      onClick={() => setSelectedCategory(option.value)}
                      disabled={isSaving}
                    >
                      <span className="category-editor-option-main">
                        <span
                          className="category-editor-option-dot"
                          style={{ backgroundColor: (CATEGORY_THEME[option.value] ?? CATEGORY_THEME.other).solid }}
                        />
                        <span>{option.label}</span>
                      </span>
                      <span className="category-editor-option-meta">
                        {isSaving && isSelected ? "Saving..." : isCurrent ? "Current" : isSelected ? "Selected" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="category-editor-helper">This changes only the selected transaction.</div>
          {error ? <span className="table-action-error">{error}</span> : null}
          <div className="category-editor-actions">
            <button type="button" className="table-action-button table-action-button-secondary" onClick={() => setIsOpen(false)}>
              Close
            </button>
            <button type="button" className="table-action-button" onClick={() => void submit()} disabled={!canSave || isSaving}>
              {isSaving ? "Saving..." : "Save change"}
            </button>
          </div>
        </div>,
        document.body,
      )
    ) : null;

  return (
    <div className="category-editor-inline">
      <button
        ref={triggerRef}
        type="button"
        className="category-editor-trigger"
        aria-expanded={isOpen}
        onClick={openMenu}
      >
        <CategoryBadge
          category={editableRow.categoryKey ?? "other"}
          label={editableRow.categoryLabel ?? editableRow.categoryKey ?? "Other"}
        />
        <span className="category-editor-caret">▾</span>
      </button>
      {menu}
    </div>
  );
}

export function PositionUnitsEditor({ row }: { row: Record<string, unknown> }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [draftUnits, setDraftUnits] = useState(isEditablePositionRow(row) ? row.units.toFixed(6) : "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isEditablePositionRow(row)) {
    return null;
  }

  const submit = async () => {
    const units = Number(draftUnits);
    if (!Number.isFinite(units) || units < 0 || isSaving) {
      setError("Enter a valid non-negative unit count.");
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      const response = await fetch("/api/position-units", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instrumentKey: row.instrumentKey,
          isin: row.isin,
          instrument: row.instrument,
          units,
          effectiveDate: row.effectiveDate,
        }),
      });

      if (!response.ok) {
        throw new Error("Could not save the units change.");
      }

      setIsOpen(false);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the units change.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="position-units-inline">
        <button
          type="button"
          className="position-units-trigger"
          onClick={() => {
            setDraftUnits(row.units.toFixed(6));
            setError("");
            setIsOpen(true);
          }}
        >
          <span>{row.units.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 })}</span>
          <span className="category-editor-caret">▾</span>
        </button>
      </div>
    );
  }

  return (
    <div className="position-units-editor">
      <input
        className="position-units-input"
        type="number"
        step="0.000001"
        min="0"
        value={draftUnits}
        autoFocus
        onChange={(event) => {
          setDraftUnits(event.target.value);
          if (error) {
            setError("");
          }
        }}
      />
      <div className="position-units-actions">
        <button type="button" className="table-action-button" onClick={() => void submit()} disabled={isSaving}>
          Save
        </button>
        <button type="button" className="table-action-button table-action-button-secondary" onClick={() => setIsOpen(false)} disabled={isSaving}>
          Close
        </button>
      </div>
      {error ? <span className="table-action-error">{error}</span> : null}
    </div>
  );
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  return (
    <section className="metrics">
      {items.map((item, idx) => (
        <article className="metric-card" key={item.label} style={{ animationDelay: `${idx * 0.1}s` }}>
          <div className="metric-label">{item.label}</div>
          <div className="metric-value">{item.value}</div>
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
          key={item.label}
          style={{ animationDelay: `${idx * 0.1}s` }}
          onClick={() => onSelect(item)}
        >
          <div className="metric-label">{item.label}</div>
          <div className="metric-value">{item.value}</div>
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
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        <span className="info-dot" title={note} aria-label={note}>
          i
        </span>
      </div>
      {children}
    </section>
  );
}

export function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <article className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="info-dot" title={note} aria-label={note}>
          i
        </span>
      </div>
      {children}
    </article>
  );
}

export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  emptyMessage,
  density = "default",
}: {
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  emptyMessage?: string;
  density?: "default" | "compact";
}) {
  if (rows.length === 0) {
    return <div className="empty">{emptyMessage ?? "No rows match the current view."}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table" data-density={density}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={String(column.key)}
                className={[
                  column.align === "right" ? "is-right" : "",
                  column.className ?? "",
                  column.headerClassName ?? "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
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
          <button type="button" className="detail-sheet-close" onClick={onClose} aria-label="Close details">
            <X size={18} />
          </button>
        </div>
        <div ref={bodyRef} className="detail-sheet-body">
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
          <DataTable columns={detail.columns} rows={detail.rows} emptyMessage={detail.emptyMessage} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}
