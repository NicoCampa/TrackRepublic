"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OperationsData } from "@/lib/operations-data";
import { formatAsOfDate } from "@/lib/dashboard-utils";
import { DashboardShell, PageToolbar, Panel, PillRow, Section } from "./dashboard-ui";

function formatPipelineMode(mode: string) {
  switch (mode) {
    case "parse_classify":
      return "Imported PDF";
    case "reclassify":
      return "Reclassified data";
    case "refresh_reclassify":
      return "Refreshed cache";
    default:
      return mode;
  }
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getPipelineStages(mode: string) {
  switch (mode) {
    case "parse_classify":
      return ["Archive PDF", "Parse PDF", "Classify", "Publish results"];
    case "reclassify":
    case "refresh_reclassify":
      return ["Classify", "Publish results"];
    default:
      return ["Classify", "Publish results"];
  }
}

export function OperationsDashboard({ data }: { data: OperationsData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pipelineSummary, setPipelineSummary] = useState(data.pipelineSummary);
  const [cache, setCache] = useState(data.cache);
  const [job, setJob] = useState(data.latestJob);
  const [file, setFile] = useState<File | null>(null);
  const [runError, setRunError] = useState("");
  const isJobRunning = job?.status === "running";

  const refreshSnapshot = async () => {
    const snapshotResponse = await fetch("/api/pipeline");
    if (!snapshotResponse.ok) {
      return;
    }
    const snapshot = (await snapshotResponse.json()) as { summary: typeof pipelineSummary; cache: typeof cache; latestJob: typeof job };
    setPipelineSummary(snapshot.summary);
    setCache(snapshot.cache);
    setJob((current) => (current?.status === "running" ? current : snapshot.latestJob));
  };

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
        await refreshSnapshot();
        startTransition(() => router.refresh());
      }
    }, 2000);

    return () => window.clearInterval(handle);
  }, [job, router, startTransition]);

  const startPipeline = async (mode: "parse_classify" | "reclassify" | "refresh_reclassify") => {
    setRunError("");

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
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      setRunError(payload?.message ?? "Could not start the import.");
      return;
    }

    const payload = (await response.json()) as { job: typeof job };
    setJob(payload.job);

    if (mode === "parse_classify") {
      setFile(null);
    }
  };

  const activeSummary = job?.summary ?? pipelineSummary;
  const toolbarItems = [
    job ? formatPipelineMode(job.mode) : activeSummary ? formatPipelineMode(activeSummary.mode) : "No imports yet",
    `Rows: ${(job?.progress.rowsLoaded ?? activeSummary?.transactionRowCount ?? 0).toLocaleString("en-US")}`,
    `Needs review: ${(job?.progress.reviewCount ?? activeSummary?.reviewCount ?? 0).toLocaleString("en-US")}`,
  ];

  const statusTone = job?.status === "failed" ? "error" : job?.status === "completed" ? "success" : "default";
  const statusLabel =
    job?.status === "running"
      ? "Import in progress"
      : job?.status === "completed"
        ? "Import finished"
        : job?.status === "failed"
          ? "Import failed"
          : activeSummary
            ? "Latest dataset"
            : "";
  const statusMeta =
    job?.step ??
    (activeSummary?.completedAt
      ? `${formatPipelineMode(activeSummary.mode)} on ${formatAsOfDate(activeSummary.completedAt.slice(0, 10))}`
      : "Choose a statement PDF to build the dataset.");
  const stageLabels = getPipelineStages(job?.mode ?? activeSummary?.mode ?? "parse_classify");
  const progressPercent = job?.progress?.percent ?? 0;
  const progressFacts = [
    job?.progress?.stageCount
      ? {
          label: "Stage",
          value: `${Math.min(job.progress.stageIndex, job.progress.stageCount)}/${job.progress.stageCount}`,
        }
      : null,
    job?.progress?.rowsLoaded
      ? {
          label: "Rows",
          value: job.progress.rowsLoaded.toLocaleString("en-US"),
        }
      : null,
    job?.progress?.pendingDescriptions !== undefined
      ? {
          label: "Unknowns",
          value: job.progress.pendingDescriptions.toLocaleString("en-US"),
        }
      : null,
    job?.progress?.batchTotal
      ? {
          label: "AI batch",
          value: `${Math.min(job.progress.batchCurrent ?? 0, job.progress.batchTotal)}/${job.progress.batchTotal}`,
        }
      : null,
    job?.progress?.webEnriched
      ? {
          label: "Web hits",
          value: job.progress.webEnriched.toLocaleString("en-US"),
        }
      : null,
    job?.progress?.reviewCount !== undefined && job.status !== "running"
      ? {
          label: "Needs review",
          value: job.progress.reviewCount.toLocaleString("en-US"),
        }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  const summaryItems = [
    {
      label: "Rows",
      value: activeSummary?.transactionRowCount?.toLocaleString("en-US") ?? "0",
    },
    {
      label: "Needs review",
      value: activeSummary?.reviewCount?.toLocaleString("en-US") ?? "0",
    },
    {
      label: "Cache hits",
      value: activeSummary?.cacheHits?.toLocaleString("en-US") ?? "0",
    },
    {
      label: "AI rows",
      value: activeSummary?.llmClassifications?.toLocaleString("en-US") ?? "0",
    },
    {
      label: "Web-enriched",
      value: activeSummary?.webEnrichedClassifications?.toLocaleString("en-US") ?? "0",
    },
  ];

  return (
    <DashboardShell
      kicker="Utility"
      title="Load data"
      description="Import one statement PDF and refresh the local dataset."
      meta={`Updated as of ${formatAsOfDate(data.transactions.at(-1)?.date ?? new Date().toISOString().slice(0, 10))}`}
    >
      <PageToolbar items={toolbarItems} />

      <Section title="Import statement" note="Add a PDF when you have a new statement. Everything else is optional maintenance.">
        <div className="load-data-stack">
          <Panel title="New PDF" note="The app archives the file locally, parses it, and refreshes the dataset on success.">
            <div className="load-data-primary">
              <label className="upload-picker" data-has-file={file ? "true" : "false"}>
                <input
                  className="upload-picker-input"
                  type="file"
                  accept="application/pdf"
                  disabled={isJobRunning}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <span className="upload-picker-kicker">{file ? "PDF ready" : "Statement PDF"}</span>
                <strong>{file ? file.name : "Choose a statement PDF"}</strong>
                <span>{file ? `${formatFileSize(file.size)} selected` : "Use this when you have a new monthly export."}</span>
              </label>

              <div className="button-row">
                <button
                  type="button"
                  className="quick-button"
                  onClick={() => void startPipeline("parse_classify")}
                  disabled={isPending || isJobRunning || !file}
                >
                  {isJobRunning && job?.step !== "Preparing reclassification" ? "Importing..." : "Import PDF"}
                </button>
                {file ? (
                  <button type="button" className="quick-button quick-button-ghost" onClick={() => setFile(null)} disabled={isPending || isJobRunning}>
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="helper-copy">
                This is the normal path. The app parses, categorizes, and updates the active dataset automatically.
              </div>

              {runError ? <span className="table-action-error">{runError}</span> : null}

              {job ? (
                <div className="load-data-progress" data-tone={statusTone}>
                  <div className="load-data-progress-head">
                    <div className="load-data-progress-copy">
                      <span className="load-data-progress-kicker">Pipeline progress</span>
                      <strong>{statusLabel}</strong>
                      <span>{statusMeta}</span>
                    </div>
                    <div className="load-data-progress-value">{progressPercent}%</div>
                  </div>
                  <div className="load-data-progress-bar" aria-hidden="true">
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="load-data-stage-strip" aria-label="Pipeline stages">
                    {stageLabels.map((label, index) => {
                      const stageNumber = index + 1;
                      const state =
                        job.status === "completed" || (job.progress?.stageIndex ?? 0) > stageNumber
                          ? "done"
                          : (job.progress?.stageIndex ?? 0) === stageNumber
                            ? "active"
                            : "idle";
                      return (
                        <div key={label} className="load-data-stage-pill" data-state={state}>
                          <span>{stageNumber}</span>
                          <strong>{label}</strong>
                        </div>
                      );
                    })}
                  </div>
                  {progressFacts.length > 0 ? (
                    <div className="load-data-progress-grid">
                      {progressFacts.map((item) => (
                        <div key={item.label} className="summary-item summary-item-compact">
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : statusLabel ? (
                <div className="load-data-status" data-tone={statusTone}>
                  <strong>{statusLabel}</strong>
                  <span>{statusMeta}</span>
                </div>
              ) : null}

              <div className="load-data-summary-grid">
                {summaryItems.map((item) => (
                  <div key={item.label} className="summary-item">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          <details className="details load-data-details">
            <summary>Maintenance and logs</summary>
            <div className="load-data-details-body">
              <div className="button-row">
                <button type="button" className="quick-button quick-button-ghost" onClick={() => void startPipeline("reclassify")} disabled={isPending || isJobRunning}>
                  Reclassify current data
                </button>
                <button
                  type="button"
                  className="quick-button quick-button-ghost"
                  onClick={() => void startPipeline("refresh_reclassify")}
                  disabled={isPending || isJobRunning}
                >
                  Refresh cache + reclassify
                </button>
              </div>

              <div className="helper-copy">
                Use these only when categories changed or the classification cache needs a clean rerun.
              </div>

              <PillRow
                items={[
                  activeSummary?.model ? `Model: ${activeSummary.model}` : "",
                  cache.model ? `Cache model: ${cache.model}` : "",
                  cache.entryCount ? `Cache entries: ${cache.entryCount.toLocaleString("en-US")}` : "",
                  cache.updatedAt ? `Cache updated ${formatAsOfDate(cache.updatedAt.slice(0, 10))}` : "",
                ]}
              />

              <pre className="log-box">{(job?.logs ?? activeSummary?.logs ?? ["No logs yet."]).join("\n")}</pre>
            </div>
          </details>
        </div>
      </Section>
    </DashboardShell>
  );
}
