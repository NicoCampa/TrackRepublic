import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CATEGORY_CACHE_PATH,
  DATA_DIR,
  PIPELINE_SUMMARY_PATH,
  RAW_DIR,
  loadPipelineSummarySync,
  normalizePipelineSummary,
  savePipelineSummary,
  type PipelineSummary,
} from "./config-store";
import { resolveRuntimeScript } from "./runtime-paths";

export type PipelineMode = "parse_classify" | "reclassify" | "refresh_reclassify";
type PipelineStageKey = "queued" | "archiving" | "parsing" | "classifying" | "publishing" | "completed";

export type PipelineJobProgress = {
  stageKey: PipelineStageKey;
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  percent: number;
  rowsLoaded?: number;
  pendingDescriptions?: number;
  batchCurrent?: number;
  batchTotal?: number;
  batchItems?: number;
  webEnriched?: number;
  webQueries?: number;
  reviewCount?: number;
};

export type PipelineJob = {
  id: string;
  mode: PipelineMode;
  status: "running" | "completed" | "failed";
  step: string;
  startedAt: string;
  completedAt?: string;
  sourcePdf?: string;
  archivePath?: string;
  logs: string[];
  outputs: string[];
  summary?: PipelineSummary;
  error?: string;
  progress: PipelineJobProgress;
};

const ROOT = process.cwd();
const CONVERT_SCRIPT = resolveRuntimeScript("convert_trade_republic_statement.py");
const CATEGORIZE_SCRIPT = resolveRuntimeScript("categorize_transactions.py");
const PROCESSED_OUTPUTS = [
  "statement_transactions.csv",
  "statement_money_market_fund.csv",
  "statement_all_rows.csv",
  "statement_transactions_categorized.csv",
  "statement_transactions_needs_review.csv",
  "statement_transactions_monthly_overview.csv",
  "statement_transactions_yearly_overview.csv",
  "statement_transactions_monthly_categories.csv",
  "statement_transactions_yearly_categories.csv",
  "statement_transactions_category_cache.json",
  "pipeline_summary.json",
];
const PIPELINE_STAGE_WEIGHTS: Record<PipelineMode, Array<{ key: PipelineStageKey; label: string; weight: number }>> = {
  parse_classify: [
    { key: "queued", label: "Queued", weight: 0.02 },
    { key: "archiving", label: "Archive PDF", weight: 0.08 },
    { key: "parsing", label: "Parse PDF", weight: 0.18 },
    { key: "classifying", label: "Classify", weight: 0.6 },
    { key: "publishing", label: "Publish results", weight: 0.12 },
  ],
  reclassify: [
    { key: "queued", label: "Queued", weight: 0.04 },
    { key: "classifying", label: "Classify", weight: 0.78 },
    { key: "publishing", label: "Publish results", weight: 0.18 },
  ],
  refresh_reclassify: [
    { key: "queued", label: "Queued", weight: 0.04 },
    { key: "classifying", label: "Classify", weight: 0.78 },
    { key: "publishing", label: "Publish results", weight: 0.18 },
  ],
};

function getWeightedStageProgress(mode: PipelineMode, stageKey: PipelineStageKey, fraction = 0) {
  if (stageKey === "completed") {
    return 100;
  }

  const stages = PIPELINE_STAGE_WEIGHTS[mode];
  const stageIndex = stages.findIndex((stage) => stage.key === stageKey);
  if (stageIndex < 0) {
    return 0;
  }

  const cumulativeWeight = stages.slice(0, stageIndex).reduce((sum, stage) => sum + stage.weight, 0);
  const currentWeight = stages[stageIndex]?.weight ?? 0;
  return Math.max(0, Math.min(99, Math.round((cumulativeWeight + currentWeight * Math.max(0, Math.min(1, fraction))) * 100)));
}

function getProgressDisplayStage(mode: PipelineMode, stageKey: PipelineStageKey) {
  const activeStages = PIPELINE_STAGE_WEIGHTS[mode].filter((stage) => stage.key !== "queued");
  if (stageKey === "queued") {
    return { stageIndex: 0, stageCount: activeStages.length, stageLabel: "Queued" };
  }
  if (stageKey === "completed") {
    return { stageIndex: activeStages.length, stageCount: activeStages.length, stageLabel: "Completed" };
  }
  const activeIndex = activeStages.findIndex((stage) => stage.key === stageKey);
  return {
    stageIndex: activeIndex >= 0 ? activeIndex + 1 : 0,
    stageCount: activeStages.length,
    stageLabel: activeStages[activeIndex]?.label ?? stageKey,
  };
}

function setJobStage(job: PipelineJob, stageKey: PipelineStageKey, fraction = stageKey === "classifying" ? 0.04 : 0.18) {
  const displayStage = getProgressDisplayStage(job.mode, stageKey);
  job.progress = {
    ...job.progress,
    stageKey,
    stageLabel: displayStage.stageLabel,
    stageIndex: displayStage.stageIndex,
    stageCount: displayStage.stageCount,
    percent: getWeightedStageProgress(job.mode, stageKey, fraction),
    batchCurrent: stageKey === "classifying" ? job.progress.batchCurrent : undefined,
    batchTotal: stageKey === "classifying" ? job.progress.batchTotal : undefined,
    batchItems: stageKey === "classifying" ? job.progress.batchItems : undefined,
  };
}

function updateJobProgressFromLine(job: PipelineJob, line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const loadedRowsMatch = trimmed.match(/^Loaded ([\d,]+) rows\./);
  if (loadedRowsMatch) {
    job.progress.rowsLoaded = Number(loadedRowsMatch[1].replaceAll(",", ""));
    return;
  }

  const webEnrichmentMatch = trimmed.match(
    /^Web enrichment added context to ([\d,]+) of ([\d,]+) uncached descriptions across ([\d,]+) queries\./,
  );
  if (webEnrichmentMatch) {
    job.progress.webEnriched = Number(webEnrichmentMatch[1].replaceAll(",", ""));
    job.progress.pendingDescriptions = Number(webEnrichmentMatch[2].replaceAll(",", ""));
    job.progress.webQueries = Number(webEnrichmentMatch[3].replaceAll(",", ""));
    return;
  }

  const classifyMatch = trimmed.match(/^Classifying ([\d,]+) unique descriptions with .* in batches of ([\d,]+)\.\.\.$/);
  if (classifyMatch) {
    const totalDescriptions = Number(classifyMatch[1].replaceAll(",", ""));
    const batchSize = Number(classifyMatch[2].replaceAll(",", ""));
    job.progress.pendingDescriptions = totalDescriptions;
    job.progress.batchTotal = batchSize > 0 ? Math.max(1, Math.ceil(totalDescriptions / batchSize)) : 0;
    job.progress.batchCurrent = 0;
    job.progress.batchItems = undefined;
    job.progress.percent = getWeightedStageProgress(job.mode, "classifying", 0.05);
    return;
  }

  const noUncachedMatch = trimmed.match(/^No uncached descriptions required LLM classification\./);
  if (noUncachedMatch) {
    job.progress.pendingDescriptions = 0;
    job.progress.batchCurrent = 0;
    job.progress.batchTotal = 0;
    job.progress.batchItems = 0;
    job.progress.percent = getWeightedStageProgress(job.mode, "classifying", 1);
    return;
  }

  const batchMatch = trimmed.match(/^Batch (\d+)\/(\d+): (\d+) items$/);
  if (batchMatch) {
    const currentBatch = Number(batchMatch[1]);
    const totalBatches = Number(batchMatch[2]);
    job.progress.batchCurrent = currentBatch;
    job.progress.batchTotal = totalBatches;
    job.progress.batchItems = Number(batchMatch[3]);
    job.progress.percent = getWeightedStageProgress(
      job.mode,
      "classifying",
      totalBatches > 0 ? Math.max(0.08, (currentBatch - 1) / totalBatches) : 0.08,
    );
    return;
  }

  const reviewMatch = trimmed.match(/^Rows marked for review: ([\d,]+)\/([\d,]+)$/);
  if (reviewMatch) {
    job.progress.reviewCount = Number(reviewMatch[1].replaceAll(",", ""));
    job.progress.rowsLoaded = Number(reviewMatch[2].replaceAll(",", ""));
  }
}

function jobsStore() {
  const target = globalThis as typeof globalThis & {
    __cashflowPipelineJobs?: Map<string, PipelineJob>;
  };
  if (!target.__cashflowPipelineJobs) {
    target.__cashflowPipelineJobs = new Map<string, PipelineJob>();
  }
  return target.__cashflowPipelineJobs;
}

function appendLog(job: PipelineJob, line: string) {
  const normalized = line.trimEnd();
  if (!normalized) {
    return;
  }
  job.logs.push(normalized);
  if (job.logs.length > 400) {
    job.logs.splice(0, job.logs.length - 400);
  }
}

async function runCommand(job: PipelineJob, command: string, args: string[]) {
  appendLog(job, `$ ${[command, ...args].join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const handleChunk = (chunk: unknown, source: "stdout" | "stderr") => {
      const nextChunk = String(chunk).replaceAll("\r\n", "\n");
      const previousBuffer = source === "stdout" ? stdoutBuffer : stderrBuffer;
      const combined = previousBuffer + nextChunk;
      const lines = combined.split("\n");
      const remainder = lines.pop() ?? "";
      for (const line of lines) {
        appendLog(job, line);
        updateJobProgressFromLine(job, line);
      }
      if (source === "stdout") {
        stdoutBuffer = remainder;
      } else {
        stderrBuffer = remainder;
      }
    };
    const flushBuffer = (source: "stdout" | "stderr") => {
      const remainder = source === "stdout" ? stdoutBuffer : stderrBuffer;
      if (!remainder.trim()) {
        return;
      }
      appendLog(job, remainder);
      updateJobProgressFromLine(job, remainder);
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk) => handleChunk(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      flushBuffer("stdout");
      flushBuffer("stderr");
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function countCsvRows(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    return Math.max(0, raw.trim().split("\n").length - 1);
  } catch {
    return 0;
  }
}

async function copyOutputIfExists(fromDir: string, toDir: string, fileName: string) {
  const source = path.join(fromDir, fileName);
  try {
    await stat(source);
  } catch {
    return false;
  }
  await mkdir(toDir, { recursive: true });
  await copyFile(source, path.join(toDir, fileName));
  return true;
}

async function loadGeneratedSummary(tempDir: string, fallback: PipelineSummary): Promise<PipelineSummary> {
  try {
    const raw = await readFile(path.join(tempDir, "pipeline_summary.json"), "utf8");
    const normalized = normalizePipelineSummary(JSON.parse(raw));
    return normalized ? { ...fallback, ...normalized } : fallback;
  } catch {
    return fallback;
  }
}

async function buildFallbackSummary(job: PipelineJob, tempDir: string, sourceTransactionsCsv: string): Promise<PipelineSummary> {
  return {
    sourcePdf: job.sourcePdf ?? "",
    sourceTransactionsCsv,
    sourceArchivePath: job.archivePath,
    mode: job.mode,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    message: job.error,
    transactionRowCount: await countCsvRows(path.join(tempDir, "statement_transactions.csv")),
    fundRowCount: await countCsvRows(path.join(tempDir, "statement_money_market_fund.csv")),
    outputs: [...job.outputs],
    logs: job.logs.slice(-60),
  };
}

async function finalizeOutputs(job: PipelineJob, tempDir: string, sourceTransactionsCsv: string) {
  const copiedOutputs: string[] = [];
  for (const fileName of PROCESSED_OUTPUTS) {
    const copied = await copyOutputIfExists(tempDir, DATA_DIR, fileName);
    if (copied) {
      copiedOutputs.push(fileName);
    }
  }
  job.outputs = copiedOutputs;
  const fallbackSummary = await buildFallbackSummary(job, tempDir, sourceTransactionsCsv);
  const summary = await loadGeneratedSummary(tempDir, fallbackSummary);
  summary.outputs = copiedOutputs;
  summary.logs = job.logs.slice(-60);
  summary.sourceArchivePath = job.archivePath;
  summary.sourcePdf = job.sourcePdf ?? summary.sourcePdf;
  summary.mode = job.mode;
  summary.startedAt = job.startedAt;
  summary.completedAt = job.completedAt;
  summary.status = job.status;
  summary.message = job.error;
  await savePipelineSummary(summary);
  job.summary = summary;
}

async function archivePdf(file: File) {
  await mkdir(RAW_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${timestamp}-${file.name}`;
  const archivePath = path.join(RAW_DIR, archiveName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(archivePath, buffer);
  return archivePath;
}

async function executePipeline(job: PipelineJob, file?: File) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cashflow-pipeline-"));
  let sourceTransactionsCsv = path.join(DATA_DIR, "statement_transactions.csv");
  try {
    if (job.mode === "parse_classify") {
      if (!file) {
        throw new Error("A PDF file is required for Parse + classify.");
      }
      job.step = "Archiving PDF";
      setJobStage(job, "archiving");
      job.archivePath = await archivePdf(file);
      job.sourcePdf = file.name;

      job.step = "Parsing PDF";
      setJobStage(job, "parsing");
      await runCommand(job, "python3", [CONVERT_SCRIPT, job.archivePath, "--output-dir", tempDir, "--prefix", "statement"]);
      sourceTransactionsCsv = path.join(tempDir, "statement_transactions.csv");
    } else {
      job.step = "Preparing reclassification";
      setJobStage(job, "classifying", 0.02);
    }

    job.step = "Classifying transactions";
    setJobStage(job, "classifying");
    const classifyArgs = [
      CATEGORIZE_SCRIPT,
      sourceTransactionsCsv,
      "--output-dir",
      tempDir,
      "--rules-file",
      path.join(ROOT, "config", "manual_category_rules.csv"),
      "--row-overrides-file",
      path.join(ROOT, "config", "transaction_overrides.csv"),
      "--summary-json",
      path.join(tempDir, "pipeline_summary.json"),
    ];
    if (job.mode === "refresh_reclassify") {
      classifyArgs.push("--refresh-cache");
    }
    await runCommand(job, "python3", classifyArgs);

    job.step = "Publishing outputs";
    setJobStage(job, "publishing");
    await finalizeOutputs(job, tempDir, sourceTransactionsCsv);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    setJobStage(job, "completed", 1);
    if (job.summary) {
      job.summary.status = job.status;
      job.summary.completedAt = job.completedAt;
      await savePipelineSummary(job.summary);
    }
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Pipeline run failed.";
    job.completedAt = new Date().toISOString();
    const existingSummary = await loadGeneratedSummary(tempDir, await buildFallbackSummary(job, tempDir, sourceTransactionsCsv));
    existingSummary.status = "failed";
    existingSummary.message = job.error;
    existingSummary.completedAt = job.completedAt;
    existingSummary.logs = job.logs.slice(-60);
    await savePipelineSummary(existingSummary);
    job.summary = existingSummary;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function startPipelineJob(mode: PipelineMode, file?: File) {
  const job: PipelineJob = {
    id: randomUUID(),
    mode,
    status: "running",
    step: "Queued",
    startedAt: new Date().toISOString(),
    sourcePdf: file?.name,
    logs: [],
    outputs: [],
    progress: {
      stageKey: "queued",
      stageLabel: "Queued",
      stageIndex: 0,
      stageCount: PIPELINE_STAGE_WEIGHTS[mode].filter((stage) => stage.key !== "queued").length,
      percent: getWeightedStageProgress(mode, "queued", 1),
    },
  };
  jobsStore().set(job.id, job);
  void executePipeline(job, file);
  return job;
}

export function getPipelineJob(jobId: string) {
  return jobsStore().get(jobId) ?? null;
}

export async function readCacheInspection() {
  try {
    const raw = await readFile(CATEGORY_CACHE_PATH, "utf8");
    const payload = JSON.parse(raw) as { model?: string; updated_at_epoch?: number; entries?: Record<string, unknown> };
    return {
      model: payload.model ?? "",
      updatedAt: payload.updated_at_epoch ? new Date(payload.updated_at_epoch * 1000).toISOString() : "",
      entryCount: Object.keys(payload.entries ?? {}).length,
    };
  } catch {
    return {
      model: "",
      updatedAt: "",
      entryCount: 0,
    };
  }
}

export async function readPipelineSnapshot() {
  const summary = loadPipelineSummarySync();

  const latestJob = [...jobsStore().values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
  const cache = await readCacheInspection();

  return {
    summary,
    latestJob,
    cache,
  };
}
