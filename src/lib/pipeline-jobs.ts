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

export type PipelineMode = "parse_classify" | "reclassify" | "refresh_reclassify";

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
};

const ROOT = process.cwd();
const CONVERT_SCRIPT = path.join(ROOT, "scripts", "convert_trade_republic_statement.py");
const CATEGORIZE_SCRIPT = path.join(ROOT, "scripts", "categorize_transactions.py");
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

    child.stdout.on("data", (chunk) => {
      appendLog(job, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      appendLog(job, String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
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
      job.archivePath = await archivePdf(file);
      job.sourcePdf = file.name;

      job.step = "Parsing PDF";
      await runCommand(job, "python3", [CONVERT_SCRIPT, job.archivePath, "--output-dir", tempDir, "--prefix", "statement"]);
      sourceTransactionsCsv = path.join(tempDir, "statement_transactions.csv");
    } else {
      job.step = "Preparing reclassification";
    }

    job.step = "Classifying transactions";
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
    await finalizeOutputs(job, tempDir, sourceTransactionsCsv);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
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
