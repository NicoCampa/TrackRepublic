"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OperationsData } from "@/lib/operations-data";
import { formatAsOfDate } from "@/lib/dashboard-utils";
import { DashboardShell, PageToolbar, Panel, PillRow, Section } from "./dashboard-ui";

export function OperationsDashboard({ data }: { data: OperationsData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pipelineSummary, setPipelineSummary] = useState(data.pipelineSummary);
  const [cache, setCache] = useState(data.cache);
  const [job, setJob] = useState<{ id: string; status: string; step: string; logs: string[]; outputs?: string[] } | null>(null);
  const [file, setFile] = useState<File | null>(null);

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

  const toolbarItems = [
    pipelineSummary ? `Last run: ${pipelineSummary.mode}` : "No pipeline run yet",
    `Rows: ${pipelineSummary?.transactionRowCount?.toLocaleString("en-US") ?? "0"}`,
    `Needs review: ${pipelineSummary?.reviewCount?.toLocaleString("en-US") ?? "0"}`,
    cache.entryCount > 0 ? `Cache entries: ${cache.entryCount.toLocaleString("en-US")}` : "",
  ];

  return (
    <DashboardShell
      kicker="Utility"
      title="Load data"
      description="Import statements, rerun parsing, and inspect the latest dataset build."
      meta={`Updated as of ${formatAsOfDate(data.transactions.at(-1)?.date ?? new Date().toISOString().slice(0, 10))}`}
    >
      <PageToolbar items={toolbarItems} />

      <Section title="Data pipeline" note="Run the parser and categorizer from inside the app.">
        <div className="operations-grid">
          <Panel title="Runner" note="Uploads archive the PDF and regenerate the active dataset on success.">
            <div className="form-grid">
              <label className="field">
                <span>Statement PDF</span>
                <input type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="quick-button" onClick={() => void startPipeline("parse_classify")} disabled={isPending}>
                Parse + classify
              </button>
              <button type="button" className="quick-button" onClick={() => void startPipeline("reclassify")} disabled={isPending}>
                Reclassify only
              </button>
              <button type="button" className="quick-button" onClick={() => void startPipeline("refresh_reclassify")} disabled={isPending}>
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
    </DashboardShell>
  );
}
