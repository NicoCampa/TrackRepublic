"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildCategoryOptions, deriveGroupFromCategory } from "@/lib/category-config";
import type { OperationsData } from "@/lib/operations-data";
import { formatAsOfDate, formatDisplayDate, formatEuro } from "@/lib/dashboard-utils";
import { CategoryBadge, DashboardShell, DataTable, PageToolbar, Panel, PillRow, Section, SignedAmount } from "./dashboard-ui";

type OperationsDashboardMode = "operations" | "pipeline";

export function OperationsDashboard({
  data,
  mode = "operations",
}: {
  data: OperationsData;
  mode?: OperationsDashboardMode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rowOverrides, setRowOverrides] = useState(data.rowOverrides);
  const [pipelineSummary, setPipelineSummary] = useState(data.pipelineSummary);
  const [cache, setCache] = useState(data.cache);
  const [job, setJob] = useState<{ id: string; status: string; step: string; logs: string[]; outputs?: string[] } | null>(null);
  const [selectedReviewRows, setSelectedReviewRows] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState("other");
  const [file, setFile] = useState<File | null>(null);

  const reviewRows = useMemo(
    () =>
      data.transactions
        .filter((row) => row.needsReview)
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`)),
    [data.transactions],
  );

  useEffect(() => {
    if (!job || job.status !== "running") {
      return;
    }

    const handle = window.setInterval(async () => {
      const response = await fetch(`/api/pipeline?jobId=${job.id}`);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { job: typeof job };
      setJob(payload.job);
      if (payload.job.status !== "running") {
        const snapshotResponse = await fetch("/api/pipeline");
        if (snapshotResponse.ok) {
          const snapshot = (await snapshotResponse.json()) as { summary: typeof pipelineSummary; cache: typeof cache };
          setPipelineSummary(snapshot.summary);
          setCache(snapshot.cache);
        }
        startTransition(() => router.refresh());
      }
    }, 2000);

    return () => window.clearInterval(handle);
  }, [cache, job, pipelineSummary, router, startTransition]);

  const refreshOverrides = async () => {
    const response = await fetch("/api/row-overrides");
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { overrides: typeof rowOverrides };
    setRowOverrides(payload.overrides);
  };

  const selectedRows = reviewRows.filter((row) => selectedReviewRows.includes(row.rowId));

  const upsertOverrides = async (mode: "categorize" | "clear_review") => {
    if (selectedRows.length === 0) {
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
      needsReview: mode === "categorize" ? false : false,
      source: "row_override",
      updatedAt: new Date().toISOString(),
    }));
    const response = await fetch("/api/row-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides }),
    });
    if (!response.ok) {
      return;
    }
    await refreshOverrides();
    setSelectedReviewRows([]);
    startTransition(() => router.refresh());
  };

  const deleteSelectedOverrides = async () => {
    if (selectedReviewRows.length === 0) {
      return;
    }
    const response = await fetch("/api/row-overrides", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rowIds: selectedReviewRows }),
    });
    if (!response.ok) {
      return;
    }
    await refreshOverrides();
    setSelectedReviewRows([]);
    startTransition(() => router.refresh());
  };

  const startPipeline = async (mode: "parse_classify" | "reclassify" | "refresh_reclassify") => {
    const formData = new FormData();
    formData.set("mode", mode);
    if (file) {
      formData.set("file", file);
    }
    const response = await fetch("/api/pipeline", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { job: typeof job };
    setJob(payload.job);
  };

  const isPipelineMode = mode === "pipeline";
  const toolbarItems = isPipelineMode
    ? [
        pipelineSummary ? `Last run: ${pipelineSummary.mode}` : "No pipeline run yet",
        `Rows: ${pipelineSummary?.transactionRowCount?.toLocaleString("en-US") ?? "0"}`,
        `Needs review: ${pipelineSummary?.reviewCount?.toLocaleString("en-US") ?? "0"}`,
        cache.entryCount > 0 ? `Cache entries: ${cache.entryCount.toLocaleString("en-US")}` : "",
      ]
    : [
        `Row overrides: ${rowOverrides.length.toLocaleString("en-US")}`,
        `Review rows: ${reviewRows.length.toLocaleString("en-US")}`,
        cache.entryCount > 0 ? `Cache entries: ${cache.entryCount.toLocaleString("en-US")}` : "",
      ];

  return (
    <DashboardShell
      kicker="Utility"
      title={isPipelineMode ? "Load data" : "Review"}
      description={
        isPipelineMode
          ? "Import statements, rerun parsing, and inspect the latest dataset build."
          : "Fix uncertain categorizations and clear the review queue."
      }
      meta={`Updated as of ${formatAsOfDate(data.transactions.at(-1)?.date ?? new Date().toISOString().slice(0, 10))}`}
    >
      <PageToolbar items={toolbarItems}>
        <div className="button-row">
          <Link href="/load-data" className="quick-button" data-active={isPipelineMode}>
            Load data
          </Link>
          <Link href="/operations" className="quick-button" data-active={!isPipelineMode}>
            Review
          </Link>
        </div>
      </PageToolbar>

      {!isPipelineMode ? (
        <Section title="Review queue" note="Row overrides affect only the selected transactions.">
          <Panel title="Rows that need checking" note="Bulk-fix uncertain rows without leaving the dashboard.">
            <div className="button-row">
              <select value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}>
                {buildCategoryOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button type="button" className="quick-button" onClick={() => void upsertOverrides("categorize")} disabled={selectedRows.length === 0}>
                Change category
              </button>
              <button type="button" className="quick-button" onClick={() => void upsertOverrides("clear_review")} disabled={selectedRows.length === 0}>
                Clear needs review
              </button>
              <button type="button" className="quick-button quick-button-ghost" onClick={() => void deleteSelectedOverrides()} disabled={selectedRows.length === 0}>
                Delete row override
              </button>
            </div>
            <DataTable
              rows={reviewRows.slice(0, 120).map((row) => ({
                selected: selectedReviewRows.includes(row.rowId),
                rowId: row.rowId,
                date: formatDisplayDate(row.date),
                merchant: row.merchant,
                category: row.categoryLabel,
                amount: row.signedAmount,
                source: row.classificationSourceLabel,
              }))}
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
                          event.target.checked ? [...current, String(row.rowId)] : current.filter((value) => value !== String(row.rowId)),
                        )
                      }
                    />
                  ),
                },
                { key: "date", label: "Date" },
                { key: "merchant", label: "Merchant" },
                {
                  key: "category",
                  label: "Category",
                  render: (_value, row) => <CategoryBadge category={String((reviewRows.find((item) => item.rowId === row.rowId)?.category) ?? "other")} label={String(row.category)} />,
                },
                { key: "amount", label: "Amount", render: (value) => <SignedAmount value={Number(value)} /> },
                { key: "source", label: "Source" },
              ]}
              emptyMessage="No rows currently need checking."
            />
          </Panel>
        </Section>
      ) : (
        <Section title="Data pipeline" note="Run the existing parser and categorizer from inside the app.">
          <div className="operations-grid">
            <Panel title="Runner" note="Uploads archive the PDF and regenerate the active dataset on success.">
              <div className="form-grid">
                <label className="field">
                  <span>Statement PDF</span>
                  <input type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="quick-button" onClick={() => void startPipeline("parse_classify")}>
                  Parse + classify
                </button>
                <button type="button" className="quick-button" onClick={() => void startPipeline("reclassify")}>
                  Reclassify only
                </button>
                <button type="button" className="quick-button" onClick={() => void startPipeline("refresh_reclassify")}>
                  Refresh cache + reclassify
                </button>
              </div>
              {job ? (
                <div className="pipeline-status">
                  <strong>{job.status === "running" ? "Running" : job.status === "completed" ? "Completed" : "Failed"}</strong>
                  <span>{job.step}</span>
                </div>
              ) : null}
            </Panel>

            <Panel title="Last run" note="Summary of the canonical dataset generation.">
              {pipelineSummary ? (
                <div className="summary-grid">
                  <div className="summary-item">
                    <span>Mode</span>
                    <strong>{pipelineSummary.mode}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Model</span>
                    <strong>{pipelineSummary.model || "n/a"}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Rows</span>
                    <strong>{pipelineSummary.transactionRowCount?.toLocaleString("en-US") ?? "0"}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Needs review</span>
                    <strong>{pipelineSummary.reviewCount?.toLocaleString("en-US") ?? "0"}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Cache hits</span>
                    <strong>{pipelineSummary.cacheHits?.toLocaleString("en-US") ?? "0"}</strong>
                  </div>
                  <div className="summary-item">
                    <span>LLM rows</span>
                    <strong>{pipelineSummary.llmClassifications?.toLocaleString("en-US") ?? "0"}</strong>
                  </div>
                </div>
              ) : (
                <div className="empty">No pipeline run summary exists yet.</div>
              )}
            </Panel>
          </div>

          <Panel title="Cache and logs" note="Inspect the current classification cache and the latest run output.">
            <PillRow
              items={[
                cache.model ? `Cache model: ${cache.model}` : "",
                cache.entryCount ? `Cache entries: ${cache.entryCount.toLocaleString("en-US")}` : "",
                cache.updatedAt ? `Cache updated ${formatAsOfDate(cache.updatedAt.slice(0, 10))}` : "",
              ]}
            />
            <pre className="log-box">{(job?.logs ?? pipelineSummary?.logs ?? ["No logs yet."]).join("\n")}</pre>
          </Panel>
        </Section>
      )}
    </DashboardShell>
  );
}
