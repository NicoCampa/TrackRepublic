"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ChevronDown, FileUp } from "lucide-react";
import { useRouter } from "next/navigation";
import type { OperationsData } from "@/lib/operations-data";
import { formatAsOfDate, formatDisplayDate } from "@/lib/dashboard-utils";
import { CategoryEditor, DashboardShell, DataTable, Panel, SignedAmount, type TableColumn } from "./dashboard-ui";

type ImportedTransactionRow = {
  rowId: string;
  date: string;
  txType: string;
  description: string;
  displayDescription: string;
  signedAmount: number;
  categoryKey: string;
  categoryLabel: string;
  classificationSourceLabel: string;
};

const LOAD_DATA_USER_NAME_STORAGE_KEY = "track-republic-account-holder-name";
const LOAD_DATA_MODEL_STORAGE_KEY = "track-republic-classifier-model";
const LOAD_DATA_PROMPT_STORAGE_KEY = "track-republic-classifier-prompt-addendum";
const DEFAULT_CLASSIFIER_MODEL = "qwen3.5:9b";

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

function formatCount(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined) {
    return "0";
  }
  return value.toLocaleString("en-US");
}

function buildFailureStatusMeta(summary: OperationsData["pipelineSummary"], activeJob: OperationsData["latestJob"]) {
  const logs = [...(activeJob?.logs ?? []), ...(summary?.logs ?? [])]
    .slice(-16)
    .join("\n")
    .toLowerCase();

  if (
    logs.includes("remotedisconnected") ||
    logs.includes("closed connection without response") ||
    logs.includes("ollama")
  ) {
    return "Classifier connection failed. Try the import again.";
  }

  return "The last import did not complete.";
}

export function OperationsDashboard({ data }: { data: OperationsData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pipelineSummary, setPipelineSummary] = useState(data.pipelineSummary);
  const [job, setJob] = useState(data.latestJob);
  const [file, setFile] = useState<File | null>(null);
  const [availableModels, setAvailableModels] = useState(data.availableModels);
  const [accountHolderName, setAccountHolderName] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(LOAD_DATA_USER_NAME_STORAGE_KEY) ?? "";
  });
  const [classifierModel, setClassifierModel] = useState(() => {
    const fallbackModel =
      data.pipelineSummary?.model?.trim() ||
      data.cache.model?.trim() ||
      data.availableModels[0] ||
      DEFAULT_CLASSIFIER_MODEL;
    if (typeof window === "undefined") {
      return fallbackModel;
    }
    return window.localStorage.getItem(LOAD_DATA_MODEL_STORAGE_KEY) ?? fallbackModel;
  });
  const [classifierPrompt, setClassifierPrompt] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(LOAD_DATA_PROMPT_STORAGE_KEY) ?? "";
  });
  const [showClassifierSettings, setShowClassifierSettings] = useState(false);
  const [runError, setRunError] = useState("");
  const [importedRowsSearch, setImportedRowsSearch] = useState("");
  const isJobRunning = job?.status === "running";

  const refreshSnapshot = async () => {
    const snapshotResponse = await fetch("/api/pipeline");
    if (!snapshotResponse.ok) {
      return;
    }
    const snapshot = (await snapshotResponse.json()) as {
      summary: typeof pipelineSummary;
      latestJob: typeof job;
      availableModels: string[];
    };
    setPipelineSummary(snapshot.summary);
    setJob((current) => (current?.status === "running" ? current : snapshot.latestJob));
    setAvailableModels(snapshot.availableModels ?? []);
  };

  useEffect(() => {
    void refreshSnapshot();
  }, []);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const nextValue = accountHolderName.trim();
    if (nextValue) {
      window.localStorage.setItem(LOAD_DATA_USER_NAME_STORAGE_KEY, nextValue);
      return;
    }
    window.localStorage.removeItem(LOAD_DATA_USER_NAME_STORAGE_KEY);
  }, [accountHolderName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const nextValue = classifierModel.trim();
    if (nextValue) {
      window.localStorage.setItem(LOAD_DATA_MODEL_STORAGE_KEY, nextValue);
      return;
    }
    window.localStorage.removeItem(LOAD_DATA_MODEL_STORAGE_KEY);
  }, [classifierModel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (classifierPrompt) {
      window.localStorage.setItem(LOAD_DATA_PROMPT_STORAGE_KEY, classifierPrompt);
      return;
    }
    window.localStorage.removeItem(LOAD_DATA_PROMPT_STORAGE_KEY);
  }, [classifierPrompt]);

  const startPipeline = async () => {
    if (!file) {
      return;
    }

    setRunError("");

    const formData = new FormData();
    formData.set("mode", "parse_classify");
    formData.set("file", file);
    if (accountHolderName.trim()) {
      formData.set("userName", accountHolderName.trim());
    }
    if (classifierPrompt.trim()) {
      formData.set("promptAddendum", classifierPrompt.trim());
    }
    if (classifierModel.trim()) {
      formData.set("model", classifierModel.trim());
    }

    const response = await fetch("/api/pipeline", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string; job?: typeof job } | null;
      if (response.status === 409 && payload?.job) {
        setJob(payload.job);
      }
      setRunError(payload?.message ?? "Could not start the import.");
      return;
    }

    const payload = (await response.json()) as { job: typeof job };
    setJob(payload.job);
    setFile(null);
  };

  const activeSummary = job?.summary ?? pipelineSummary;
  const isFailed = job?.status === "failed" || (!job && activeSummary?.status === "failed");
  const isDuplicateSkip = activeSummary?.status === "completed" && activeSummary.published === false;
  const statusTone = isFailed ? "error" : isDuplicateSkip ? "default" : job?.status === "completed" ? "success" : "default";
  const statusLabel =
    job?.status === "running"
      ? "Loading data"
      : isDuplicateSkip
        ? "Duplicate skipped"
        : isFailed
          ? "Last import failed"
          : activeSummary
            ? "Latest import"
            : "";
  const statusMeta = job?.status === "running"
    ? job.step
    : isFailed
      ? buildFailureStatusMeta(activeSummary, job)
      : isDuplicateSkip
        ? "This statement was already imported."
        : activeSummary?.completedAt
          ? `${formatPipelineMode(activeSummary.mode)} on ${formatAsOfDate(activeSummary.completedAt.slice(0, 10))}`
          : "Choose a statement PDF to build the dataset.";
  const progressPercent =
    job?.progress?.percent ??
    (activeSummary
      ? activeSummary.status === "completed" || activeSummary.status === "failed"
        ? 100
        : 0
      : 0);
  const progressStageLabel =
    job?.progress?.stageLabel ??
    (activeSummary?.status === "failed"
      ? "Failed"
      : activeSummary?.status === "completed"
        ? "Completed"
        : "Waiting");
  const progressFacts = [
    isJobRunning && job?.progress.pendingDescriptions !== undefined
      ? {
          label: "Descriptions",
          value: formatCount(job.progress.pendingDescriptions),
        }
      : null,
    isJobRunning && job?.progress.batchTotal
      ? {
          label: "Batches",
          value: `${job.progress.batchCurrent ?? 0}/${job.progress.batchTotal}`,
        }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const commandbarMeta = activeSummary?.completedAt ? `Updated ${formatAsOfDate(activeSummary.completedAt.slice(0, 10))}` : "";

  const importedTransactions = useMemo<ImportedTransactionRow[]>(
    () =>
      data.transactions
        .filter((row) => row.classificationSource !== "manual_entry")
        .map((row) => ({
          rowId: row.rowId,
          date: row.date,
          txType: row.txType,
          description: row.description,
          displayDescription: row.displayDescription,
          signedAmount: row.signedAmount,
          categoryKey: row.category,
          categoryLabel: row.categoryLabel,
          classificationSourceLabel: row.classificationSourceLabel,
        }))
        .sort((left, right) => `${right.date}-${right.rowId}`.localeCompare(`${left.date}-${left.rowId}`)),
    [data.transactions],
  );

  const filteredImportedTransactions = useMemo(() => {
    const query = importedRowsSearch.trim().toLowerCase();
    return importedTransactions.filter((row) => {
      if (!query) {
        return true;
      }
      const haystack = `${row.date} ${formatDisplayDate(row.date)} ${row.displayDescription} ${row.description} ${row.txType} ${row.categoryLabel}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [importedTransactions, importedRowsSearch]);

  const importedTransactionColumns = useMemo<Array<TableColumn<ImportedTransactionRow>>>(
    () => [
      {
        key: "date",
        label: "Date",
        cellClassName: "cell-nowrap",
        render: (value) => formatDisplayDate(String(value ?? "")),
      },
      {
        key: "displayDescription",
        label: "Details",
        cellClassName: "cell-description",
        render: (_, row) => (
          <div className="table-transaction-cell">
            <strong>{row.displayDescription}</strong>
            <small>
              {row.txType}
              {row.description && row.description !== row.displayDescription ? ` · ${row.description}` : ""}
            </small>
          </div>
        ),
      },
      {
        key: "categoryKey",
        label: "Category",
        render: (_, row) => <CategoryEditor row={row} />,
      },
      {
        key: "signedAmount",
        label: "Amount",
        align: "right",
        cellClassName: "cell-nowrap",
        render: (value) => <SignedAmount value={Number(value ?? 0)} />,
      },
    ],
    [],
  );

  const classifierModelSuggestions = useMemo(
    () =>
      [...new Set([
        classifierModel.trim(),
        activeSummary?.model?.trim() ?? "",
        data.cache.model?.trim() ?? "",
        ...availableModels,
        DEFAULT_CLASSIFIER_MODEL,
      ])].filter(Boolean),
    [activeSummary?.model, availableModels, classifierModel, data.cache.model],
  );
  const loadingFacts = [
    job?.sourcePdf || activeSummary?.sourcePdf
      ? {
          label: "Statement",
          value: job?.sourcePdf || activeSummary?.sourcePdf || "",
        }
      : null,
    classifierModel.trim()
      ? {
          label: "Model",
          value: classifierModel.trim(),
        }
      : null,
    ...progressFacts,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <DashboardShell kicker="Utility" description="Import a statement PDF." hideHero viewportLocked>
      <section className="home-commandbar">
        <div className="home-commandbar-row">
          <div className="home-commandbar-title"><strong>Load data</strong></div>
          <div />
          <div className="home-commandbar-meta">
            {statusLabel ? <span className="home-status-pill">{statusLabel}</span> : null}
            {commandbarMeta ? <span className="home-updated">{commandbarMeta}</span> : null}
          </div>
        </div>
      </section>

      <section className="load-data-simple" data-state={isJobRunning ? "running" : "idle"}>
        <Panel title={isJobRunning ? "Loading" : "Import"} className="workspace-panel load-data-simple-panel">
          <div className={`workspace-panel-body load-data-simple-body${isJobRunning ? " load-data-simple-body-running" : ""}`}>
            {isJobRunning ? (
              <div className="load-data-run-state" data-tone={statusTone}>
                <div className="load-data-run-stage">
                  <span className="load-data-run-orb" aria-hidden="true" />
                  <span className="load-data-run-kicker">{statusLabel}</span>
                </div>
                <div className="load-data-run-copy">
                  <strong>{progressStageLabel}</strong>
                  <p>{statusMeta}</p>
                </div>
                <div className="load-data-run-meter">
                  <div className="load-data-run-value">{progressPercent}%</div>
                  <div className="load-data-progress-bar" aria-hidden="true">
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
                {loadingFacts.length > 0 ? (
                  <div className="load-data-run-facts">
                    {loadingFacts.map((item) => (
                      <div key={item.label} className="load-data-status">
                        <strong>{item.label}</strong>
                        <span>{item.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="load-data-intake-grid">
                  <div className="load-data-intake-main">
                    <div className="load-data-upload-control">
                      <input
                        ref={fileInputRef}
                        className="load-data-file-input"
                        type="file"
                        accept="application/pdf"
                        disabled={isJobRunning}
                        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      />
                      <button
                        type="button"
                        className="upload-picker load-data-upload-picker"
                        data-has-file={file ? "true" : "false"}
                        disabled={isJobRunning}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <span className="load-data-upload-icon" aria-hidden="true">
                          <FileUp size={20} strokeWidth={2.1} />
                        </span>
                        <div className="load-data-upload-copy">
                          <span className="load-data-upload-label">{file ? "Change PDF" : "Choose PDF"}</span>
                          <strong>{file ? file.name : "No PDF selected"}</strong>
                          {file ? <span>{formatFileSize(file.size)}</span> : <span>Statement PDF</span>}
                        </div>
                        <span className="load-data-upload-action" aria-hidden="true">
                          {file ? "Replace" : "Browse"}
                        </span>
                      </button>
                    </div>

                    <div className="field">
                      <label htmlFor="loadDataUserName">Your name</label>
                      <input
                        id="loadDataUserName"
                        type="text"
                        value={accountHolderName}
                        disabled={isJobRunning}
                        placeholder="Optional"
                        onChange={(event) => setAccountHolderName(event.target.value)}
                      />
                      <span className="field-help">Used only to detect transfers between your own accounts.</span>
                    </div>

                    <div className="button-row load-data-simple-actions">
                      <button
                        type="button"
                        className="quick-button load-data-action-button"
                        onClick={() => void startPipeline()}
                        disabled={isPending || isJobRunning || !file}
                      >
                        {isJobRunning ? "Loading..." : "Run import"}
                      </button>
                      {file ? (
                        <button
                          type="button"
                          className="quick-button quick-button-ghost load-data-action-button load-data-action-button-secondary"
                          onClick={() => setFile(null)}
                          disabled={isPending || isJobRunning}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>

                    {runError ? <span className="table-action-error">{runError}</span> : null}
                  </div>

                  <div className="load-data-prompt-module">
                    <button
                      type="button"
                      className="load-data-disclosure-button"
                      data-open={showClassifierSettings ? "true" : "false"}
                      onClick={() => setShowClassifierSettings((current) => !current)}
                    >
                      <span className="load-data-disclosure-copy">
                        <strong>Classifier settings</strong>
                        <span>{classifierPrompt ? "Extra instructions" : "Default prompt"}</span>
                      </span>
                      <span className="load-data-disclosure-trailing">
                        <span className="load-data-disclosure-state">{showClassifierSettings ? "Hide" : "Open"}</span>
                        <span className="load-data-disclosure-icon" aria-hidden="true">
                          <ChevronDown size={16} />
                        </span>
                      </span>
                    </button>

                    {showClassifierSettings ? (
                      <div className="load-data-prompt-details-body">
                        <div className="field load-data-prompt-field">
                          <label htmlFor="loadDataClassifierModel">Ollama model</label>
                          <input
                            id="loadDataClassifierModel"
                            type="text"
                            list={classifierModelSuggestions.length > 0 ? "loadDataClassifierModelSuggestions" : undefined}
                            value={classifierModel}
                            disabled={isJobRunning}
                            placeholder={DEFAULT_CLASSIFIER_MODEL}
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            onChange={(event) => setClassifierModel(event.target.value)}
                          />
                          {classifierModelSuggestions.length > 0 ? (
                            <datalist id="loadDataClassifierModelSuggestions">
                              {classifierModelSuggestions.map((modelName) => (
                                <option key={modelName} value={modelName} />
                              ))}
                            </datalist>
                          ) : null}
                          <span className="field-help">
                            Type any Ollama model tag. Installed models are suggested here. Current cache: <code>{data.cache.model || "none"}</code>.
                          </span>
                          {classifierModelSuggestions.length > 0 ? (
                            <div className="load-data-model-presets">
                              {classifierModelSuggestions.map((modelName) => (
                                <button
                                  key={modelName}
                                  type="button"
                                  className="load-data-model-preset"
                                  data-active={classifierModel.trim() === modelName ? "true" : "false"}
                                  onClick={() => setClassifierModel(modelName)}
                                  disabled={isJobRunning}
                                >
                                  {modelName}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="field load-data-prompt-field">
                          <label htmlFor="loadDataPromptTemplate">Category prompt</label>
                          <textarea
                            id="loadDataPromptTemplate"
                            rows={10}
                            value={data.classifierPromptTemplate}
                            disabled
                            readOnly
                          />
                          <span className="field-help">
                            This is the exact backend prompt for the first pass. Manual-correction examples, your extra instructions, and the transaction batch are appended later at runtime.
                          </span>
                        </div>

                        <div className="field load-data-prompt-field">
                          <label htmlFor="loadDataInvestmentAssetPromptTemplate">Investment asset prompt</label>
                          <textarea
                            id="loadDataInvestmentAssetPromptTemplate"
                            rows={10}
                            value={data.investmentAssetClassPromptTemplate}
                            disabled
                            readOnly
                          />
                          <span className="field-help">
                            This is the exact backend prompt for the second pass, used only after a row was classified as investing or crypto.
                          </span>
                        </div>

                        <div className="field load-data-prompt-field">
                          <label htmlFor="loadDataPrompt">Extra instructions</label>
                          <textarea
                            id="loadDataPrompt"
                            rows={4}
                            value={classifierPrompt}
                            disabled={isJobRunning}
                            placeholder="Optional. Example: classify cafes and takeaway as restaurants_takeaway."
                            onChange={(event) => setClassifierPrompt(event.target.value)}
                          />
                          <span className="field-help">
                            Extra instructions are appended to both backend prompts for this run only. They affect uncached LLM classifications for the next run. Exact row overrides still apply afterward.
                          </span>
                          {classifierPrompt ? (
                            <div className="load-data-prompt-meta">
                              <button
                                type="button"
                                className="quick-button quick-button-ghost"
                                onClick={() => setClassifierPrompt("")}
                                disabled={isPending || isJobRunning}
                              >
                                Reset
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {statusLabel ? (
                  <div className="load-data-progress" data-tone={statusTone}>
                    <div className="load-data-progress-head">
                      <div className="load-data-progress-copy">
                        <span className="load-data-progress-kicker">{statusLabel}</span>
                        <strong>{progressStageLabel}</strong>
                        <span>{statusMeta}</span>
                      </div>
                      <div className="load-data-progress-value">{progressPercent}%</div>
                    </div>
                    <div className="load-data-progress-bar" aria-hidden="true">
                      <span style={{ width: `${progressPercent}%` }} />
                    </div>
                    {progressFacts.length > 0 ? (
                      <div className="load-data-progress-grid">
                        {progressFacts.map((item) => (
                          <div key={item.label} className="load-data-status">
                            <strong>{item.label}</strong>
                            <span>{item.value}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </Panel>

        {!isJobRunning ? (
          <Panel title="Imported rows" className="workspace-panel load-data-imported-panel">
            {importedTransactions.length > 0 ? (
              <div className="workspace-panel-body load-data-imported-body">
                <div className="load-data-imported-toolbar">
                  <div className="field load-data-imported-search">
                    <label htmlFor="loadDataImportedSearch">Search</label>
                    <input
                      id="loadDataImportedSearch"
                      type="search"
                      value={importedRowsSearch}
                      placeholder="Search details or category"
                      onChange={(event) => setImportedRowsSearch(event.target.value)}
                    />
                  </div>
                </div>
                <div className="load-data-imported-table">
                  <DataTable
                    density="compact"
                    rows={filteredImportedTransactions}
                    columns={importedTransactionColumns}
                    rowKey="rowId"
                    stickyHeader
                    emptyMessage="No imported transactions match the current filters."
                  />
                </div>
              </div>
            ) : (
              <div className="empty">Imported transactions will appear here after a successful load.</div>
            )}
          </Panel>
        ) : null}
      </section>
    </DashboardShell>
  );
}
