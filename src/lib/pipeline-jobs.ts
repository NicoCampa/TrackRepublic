import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseCsv } from "csv-parse/sync";
import {
  CATEGORY_CACHE_PATH,
  DATA_DIR,
  IMPORT_REGISTRY_PATH,
  RAW_DIR,
  loadRowOverrides,
  loadPipelineSummarySync,
  normalizePipelineSummary,
  savePipelineSummary,
  saveRowOverrides,
  type PipelineSummary,
  type RowOverrideRecord,
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
};

export type PipelineJob = {
  id: string;
  mode: PipelineMode;
  status: "running" | "completed" | "failed";
  step: string;
  startedAt: string;
  completedAt?: string;
  sourcePdf?: string;
  statementLanguage?: string;
  archivePath?: string;
  sourcePdfSha256?: string;
  statementFingerprint?: string;
  duplicatesDropped?: number;
  overlapDuplicatesDropped?: number;
  published?: boolean;
  message?: string;
  logs: string[];
  outputs: string[];
  summary?: PipelineSummary;
  error?: string;
  progress: PipelineJobProgress;
};

type StartPipelineOptions = {
  promptTemplate?: string;
  promptAddendum?: string;
  userName?: string;
  model?: string;
  statementLanguage?: string;
};

type ParseMetadata = {
  transactionRowCount: number;
  fundRowCount: number;
  duplicatesDropped: number;
  overlapDuplicatesDropped?: number;
  statementFingerprint: string;
};

type ImportRegistryEntry = {
  jobId: string;
  mode: PipelineMode;
  sourcePdf: string;
  archivePath?: string;
  sourcePdfSha256?: string;
  statementFingerprint?: string;
  startedAt: string;
  completedAt: string;
  published: boolean;
  message?: string;
};

const ROOT = /*turbopackIgnore: true*/ process.cwd();
const CONVERT_SCRIPT = resolveRuntimeScript("convert_trade_republic_statement.py");
const CATEGORIZE_SCRIPT = resolveRuntimeScript("categorize_transactions.py");
const TRANSACTIONS_OUTPUT = "statement_transactions.csv";
const FUND_OUTPUT = "statement_money_market_fund.csv";
const ALL_ROWS_OUTPUT = "statement_all_rows.csv";
const CATEGORIZED_OUTPUT = "statement_transactions_categorized.csv";
const CATEGORY_CACHE_OUTPUT = "statement_transactions_category_cache.json";
const PARSE_META_OUTPUT = "statement_parse_meta.json";
const TRANSACTION_COLUMNS = [
  "row_id",
  "page",
  "date",
  "date_original",
  "type",
  "description",
  "signed_amount_eur",
  "payment_in_eur",
  "payment_out_eur",
  "balance_eur",
  "raw_row",
] as const;
const FUND_COLUMNS = [
  "row_id",
  "page",
  "date",
  "date_original",
  "payment_type",
  "fund",
  "isin",
  "units",
  "price_per_unit_eur",
  "amount_eur",
  "raw_row",
] as const;
const ALL_ROWS_COLUMNS = [
  "row_id",
  "section",
  "page",
  "date",
  "date_original",
  "type",
  "description",
  "signed_amount_eur",
  "payment_in_eur",
  "payment_out_eur",
  "balance_eur",
  "payment_type",
  "fund",
  "isin",
  "units",
  "price_per_unit_eur",
  "amount_eur",
  "raw_row",
] as const;
const PROCESSED_OUTPUTS = [
  TRANSACTIONS_OUTPUT,
  FUND_OUTPUT,
  ALL_ROWS_OUTPUT,
  CATEGORIZED_OUTPUT,
  "statement_transactions_monthly_overview.csv",
  "statement_transactions_yearly_overview.csv",
  "statement_transactions_monthly_categories.csv",
  "statement_transactions_yearly_categories.csv",
  CATEGORY_CACHE_OUTPUT,
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

let ollamaModelsCache: { expiresAt: number; models: string[] } | null = null;

function normalizeStatementLanguage(value: string | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "it" ? "it" : "de";
}

async function readAvailableOllamaModels() {
  if (ollamaModelsCache && ollamaModelsCache.expiresAt > Date.now()) {
    return ollamaModelsCache.models;
  }

  const models = await new Promise<string[]>((resolve) => {
    const child = spawn("ollama", ["list"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const parsed = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("NAME"))
        .map((line) => line.match(/^(\S+)/)?.[1] ?? "")
        .filter(Boolean);
      resolve(parsed);
    });
  });

  ollamaModelsCache = {
    expiresAt: Date.now() + 30_000,
    models,
  };
  return models;
}

function hashBufferSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashTextSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeFingerprintValue(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildCanonicalTransactionFingerprint(row: Record<string, string>) {
  return JSON.stringify([
    "transactions",
    normalizeFingerprintValue(row.page),
    normalizeFingerprintValue(row.date),
    normalizeFingerprintValue(row.date_original),
    normalizeFingerprintValue(row.type),
    normalizeFingerprintValue(row.description),
    normalizeFingerprintValue(row.signed_amount_eur),
    normalizeFingerprintValue(row.balance_eur),
    normalizeFingerprintValue(row.raw_row),
  ]);
}

function normalizeDedupeValue(value: unknown) {
  return normalizeFingerprintValue(value).toUpperCase();
}

function normalizeDedupeAmount(value: unknown) {
  const normalized = normalizeFingerprintValue(value);
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : normalized;
}

function buildTransactionOverlapKey(row: Record<string, string>) {
  return JSON.stringify([
    "transactions",
    normalizeFingerprintValue(row.date),
    normalizeDedupeValue(row.type),
    normalizeDedupeValue(row.description),
    normalizeDedupeAmount(row.signed_amount_eur),
  ]);
}

function buildFundOverlapKey(row: Record<string, string>) {
  return JSON.stringify([
    "money_market_fund",
    normalizeFingerprintValue(row.date),
    normalizeDedupeValue(row.payment_type),
    normalizeDedupeValue(row.fund),
    normalizeDedupeValue(row.isin),
    normalizeDedupeAmount(row.units),
    normalizeDedupeAmount(row.price_per_unit_eur),
    normalizeDedupeAmount(row.amount_eur),
  ]);
}

function sortRowsByDate<Row extends Record<string, string>>(rows: Row[]) {
  return [...rows].sort((left, right) => {
    const leftKey = `${normalizeFingerprintValue(left.date)}-${normalizeFingerprintValue(left.row_id)}`;
    const rightKey = `${normalizeFingerprintValue(right.date)}-${normalizeFingerprintValue(right.row_id)}`;
    return leftKey.localeCompare(rightKey);
  });
}

function isLegacyNumericRowId(value: string) {
  return /^\d+$/.test(value.trim());
}

function normalizeImportRegistryEntry(payload: unknown): ImportRegistryEntry | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = payload as Record<string, unknown>;
  const startedAt = String(value.startedAt ?? "");
  const completedAt = String(value.completedAt ?? "");
  if (!startedAt || !completedAt) {
    return null;
  }
  return {
    jobId: String(value.jobId ?? ""),
    mode: String(value.mode ?? "parse_classify") as PipelineMode,
    sourcePdf: String(value.sourcePdf ?? ""),
    archivePath: value.archivePath !== undefined ? String(value.archivePath ?? "") : undefined,
    sourcePdfSha256: value.sourcePdfSha256 !== undefined ? String(value.sourcePdfSha256 ?? "") : undefined,
    statementFingerprint: value.statementFingerprint !== undefined ? String(value.statementFingerprint ?? "") : undefined,
    startedAt,
    completedAt,
    published: Boolean(value.published),
    message: value.message !== undefined ? String(value.message ?? "") : undefined,
  };
}

async function loadImportRegistry() {
  if (!existsSync(IMPORT_REGISTRY_PATH)) {
    return [] as ImportRegistryEntry[];
  }
  try {
    const raw = await readFile(IMPORT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeImportRegistryEntry)
      .filter((entry): entry is ImportRegistryEntry => Boolean(entry));
  } catch {
    return [];
  }
}

async function saveImportRegistry(entries: ImportRegistryEntry[]) {
  await mkdir(path.dirname(IMPORT_REGISTRY_PATH), { recursive: true });
  await writeFile(IMPORT_REGISTRY_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function appendImportRegistryEntry(job: PipelineJob) {
  if (job.mode !== "parse_classify" || !job.completedAt || (!job.sourcePdfSha256 && !job.statementFingerprint)) {
    return;
  }
  const entries = await loadImportRegistry();
  entries.push({
    jobId: job.id,
    mode: job.mode,
    sourcePdf: job.sourcePdf ?? "",
    archivePath: job.archivePath,
    sourcePdfSha256: job.sourcePdfSha256,
    statementFingerprint: job.statementFingerprint,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    published: Boolean(job.published),
    message: job.message,
  });
  await saveImportRegistry(entries);
}

async function readCsvRecords(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

async function readRequiredCsvRecords(filePath: string, label: string) {
  try {
    return await readCsvRecords(filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} CSV at ${filePath}: ${detail}`);
  }
}

async function readOptionalCsvRecords(filePath: string, label: string) {
  if (!existsSync(filePath)) {
    return [];
  }
  return readRequiredCsvRecords(filePath, label);
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function writeCsvRecords(filePath: string, columns: readonly string[], rows: Record<string, string>[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n");
  await writeFile(filePath, `${body}\n`, "utf8");
}

function mergeRowsByOverlapKey(
  existingRows: Record<string, string>[],
  incomingRows: Record<string, string>[],
  keyForRow: (row: Record<string, string>) => string,
) {
  const existingCounts = new Map<string, number>();
  const existingRowIds = new Set<string>();
  for (const row of existingRows) {
    existingCounts.set(keyForRow(row), (existingCounts.get(keyForRow(row)) ?? 0) + 1);
    const rowId = normalizeFingerprintValue(row.row_id);
    if (rowId) {
      existingRowIds.add(rowId);
    }
  }

  const incomingSeen = new Map<string, number>();
  const keptIncomingRows: Record<string, string>[] = [];
  let duplicatesDropped = 0;
  for (const row of incomingRows) {
    const key = keyForRow(row);
    const nextSeen = (incomingSeen.get(key) ?? 0) + 1;
    incomingSeen.set(key, nextSeen);
    const rowId = normalizeFingerprintValue(row.row_id);
    if (nextSeen <= (existingCounts.get(key) ?? 0) || (rowId && existingRowIds.has(rowId))) {
      duplicatesDropped += 1;
      continue;
    }
    if (rowId) {
      existingRowIds.add(rowId);
    }
    keptIncomingRows.push(row);
  }

  return {
    rows: sortRowsByDate([...existingRows, ...keptIncomingRows]),
    duplicatesDropped,
  };
}

function transactionToAllRowsRecord(row: Record<string, string>) {
  return {
    row_id: row.row_id ?? "",
    section: "transactions",
    page: row.page ?? "",
    date: row.date ?? "",
    date_original: row.date_original ?? "",
    type: row.type ?? "",
    description: row.description ?? "",
    signed_amount_eur: row.signed_amount_eur ?? "",
    payment_in_eur: row.payment_in_eur ?? "",
    payment_out_eur: row.payment_out_eur ?? "",
    balance_eur: row.balance_eur ?? "",
    payment_type: "",
    fund: "",
    isin: "",
    units: "",
    price_per_unit_eur: "",
    amount_eur: "",
    raw_row: row.raw_row ?? "",
  };
}

function fundToAllRowsRecord(row: Record<string, string>) {
  return {
    row_id: row.row_id ?? "",
    section: "money_market_fund",
    page: row.page ?? "",
    date: row.date ?? "",
    date_original: row.date_original ?? "",
    type: "",
    description: "",
    signed_amount_eur: "",
    payment_in_eur: "",
    payment_out_eur: "",
    balance_eur: "",
    payment_type: row.payment_type ?? "",
    fund: row.fund ?? "",
    isin: row.isin ?? "",
    units: row.units ?? "",
    price_per_unit_eur: row.price_per_unit_eur ?? "",
    amount_eur: row.amount_eur ?? "",
    raw_row: row.raw_row ?? "",
  };
}

async function mergeParsedStatementWithExistingData(tempDir: string) {
  const currentTransactionsPath = path.join(DATA_DIR, TRANSACTIONS_OUTPUT);
  const currentFundPath = path.join(DATA_DIR, FUND_OUTPUT);
  const nextTransactionsPath = path.join(tempDir, TRANSACTIONS_OUTPUT);
  const nextFundPath = path.join(tempDir, FUND_OUTPUT);
  const existingTransactions = await readOptionalCsvRecords(currentTransactionsPath, "existing transactions");
  const existingFundRows = await readOptionalCsvRecords(currentFundPath, "existing money market fund");
  const incomingTransactions = await readRequiredCsvRecords(nextTransactionsPath, "incoming transactions");
  const incomingFundRows = await readRequiredCsvRecords(nextFundPath, "incoming money market fund");

  if (existingTransactions.length === 0 && existingFundRows.length === 0) {
    return {
      transactionRowCount: incomingTransactions.length,
      fundRowCount: incomingFundRows.length,
      overlapDuplicatesDropped: 0,
    };
  }

  const mergedTransactions = mergeRowsByOverlapKey(
    existingTransactions,
    incomingTransactions,
    buildTransactionOverlapKey,
  );
  const mergedFundRows = mergeRowsByOverlapKey(
    existingFundRows,
    incomingFundRows,
    buildFundOverlapKey,
  );
  const mergedAllRows = sortRowsByDate([
    ...mergedTransactions.rows.map(transactionToAllRowsRecord),
    ...mergedFundRows.rows.map(fundToAllRowsRecord),
  ]);

  await writeCsvRecords(nextTransactionsPath, TRANSACTION_COLUMNS, mergedTransactions.rows);
  await writeCsvRecords(nextFundPath, FUND_COLUMNS, mergedFundRows.rows);
  await writeCsvRecords(path.join(tempDir, ALL_ROWS_OUTPUT), ALL_ROWS_COLUMNS, mergedAllRows);

  return {
    transactionRowCount: mergedTransactions.rows.length,
    fundRowCount: mergedFundRows.rows.length,
    overlapDuplicatesDropped: mergedTransactions.duplicatesDropped + mergedFundRows.duplicatesDropped,
  };
}

async function loadParseMetadata(tempDir: string): Promise<ParseMetadata> {
  const parseMetaPath = path.join(tempDir, PARSE_META_OUTPUT);
  try {
    const raw = await readFile(parseMetaPath, "utf8");
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const transactionRowCount = Number(payload.transaction_row_count ?? payload.transactionRowCount ?? 0);
    const fundRowCount = Number(payload.fund_row_count ?? payload.fundRowCount ?? 0);
    const duplicatesDropped = Number(payload.duplicates_dropped ?? payload.duplicatesDropped ?? 0);
    const statementFingerprint = String(payload.statement_fingerprint ?? payload.statementFingerprint ?? "");
    return {
      transactionRowCount: Number.isFinite(transactionRowCount) ? transactionRowCount : 0,
      fundRowCount: Number.isFinite(fundRowCount) ? fundRowCount : 0,
      duplicatesDropped: Number.isFinite(duplicatesDropped) ? duplicatesDropped : 0,
      statementFingerprint,
    };
  } catch {
    const [transactionRows, fundRows] = await Promise.all([
      readRequiredCsvRecords(path.join(tempDir, TRANSACTIONS_OUTPUT), "parsed transactions"),
      readRequiredCsvRecords(path.join(tempDir, FUND_OUTPUT), "parsed money market fund"),
    ]);
    const statementFingerprint = hashTextSha256(
      [...transactionRows.map((row) => String(row.row_id ?? "")), ...fundRows.map((row) => String(row.row_id ?? ""))]
        .filter(Boolean)
        .sort()
        .join("\n"),
    );
    return {
      transactionRowCount: transactionRows.length,
      fundRowCount: fundRows.length,
      duplicatesDropped: 0,
      statementFingerprint,
    };
  }
}

async function maybeMigrateLegacyRowOverrides(tempDir: string) {
  const overrides = await loadRowOverrides();
  if (overrides.length === 0 || !overrides.some((item) => isLegacyNumericRowId(item.rowId))) {
    return [] as string[];
  }

  const currentCategorizedPath = path.join(DATA_DIR, CATEGORIZED_OUTPUT);
  if (!existsSync(currentCategorizedPath)) {
    return ["Skipped override migration: current categorized CSV is missing."];
  }

  const [currentRows, nextRows] = await Promise.all([
    readCsvRecords(currentCategorizedPath),
    readCsvRecords(path.join(tempDir, TRANSACTIONS_OUTPUT)),
  ]);

  if (!currentRows.some((row) => isLegacyNumericRowId(String(row.row_id ?? "")))) {
    return [];
  }

  const currentFingerprintByRowId = new Map<string, string>();
  for (const row of currentRows) {
    const rowId = String(row.row_id ?? "");
    if (!isLegacyNumericRowId(rowId)) {
      continue;
    }
    currentFingerprintByRowId.set(rowId, buildCanonicalTransactionFingerprint(row));
  }

  const nextRowIdsByFingerprint = new Map<string, string[]>();
  for (const row of nextRows) {
    const fingerprint = buildCanonicalTransactionFingerprint(row);
    nextRowIdsByFingerprint.set(fingerprint, [...(nextRowIdsByFingerprint.get(fingerprint) ?? []), String(row.row_id ?? "")]);
  }

  let migratedCount = 0;
  const unresolved: string[] = [];
  const migratedOverrides: RowOverrideRecord[] = overrides.map((override) => {
    if (!isLegacyNumericRowId(override.rowId)) {
      return override;
    }

    const fingerprint = currentFingerprintByRowId.get(override.rowId);
    if (!fingerprint) {
      unresolved.push(override.rowId);
      return override;
    }

    const nextRowIds = nextRowIdsByFingerprint.get(fingerprint) ?? [];
    if (nextRowIds.length !== 1 || !nextRowIds[0]) {
      unresolved.push(override.rowId);
      return override;
    }

    migratedCount += 1;
    return {
      ...override,
      rowId: nextRowIds[0],
    };
  });

  if (migratedCount > 0) {
    await saveRowOverrides(migratedOverrides);
  }

  const logs: string[] = [];
  if (migratedCount > 0) {
    logs.push(`Migrated ${migratedCount} row overrides from legacy numeric row IDs to stable IDs.`);
  }
  if (unresolved.length > 0) {
    logs.push(`Could not migrate ${unresolved.length} row overrides: ${unresolved.slice(0, 10).join(", ")}${unresolved.length > 10 ? "..." : ""}`);
  }
  return logs;
}

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

  const classifyMatch = trimmed.match(
    /^Classifying (?:categories for |asset classes for )?([\d,]+) (?:unique |investment )?descriptions with .* in batches of ([\d,]+)\.\.\.$/,
  );
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

  const batchMatch = trimmed.match(/^(?:Category |Asset class )?batch (\d+)\/(\d+): (\d+) items$/i);
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
      env: {
        ...process.env,
        TRACK_REPUBLIC_NODE: process.execPath,
      },
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

async function buildFallbackSummary(
  job: PipelineJob,
  tempDir: string,
  sourceTransactionsCsv: string,
  parseMetadata?: ParseMetadata,
): Promise<PipelineSummary> {
  return {
    sourcePdf: job.sourcePdf ?? "",
    sourceTransactionsCsv,
    sourceArchivePath: job.archivePath,
    sourcePdfSha256: job.sourcePdfSha256,
    statementFingerprint: job.statementFingerprint ?? parseMetadata?.statementFingerprint,
    statementLanguage: job.statementLanguage,
    mode: job.mode,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    published: job.published ?? job.status === "completed",
    message: job.message ?? job.error,
    transactionRowCount: parseMetadata?.transactionRowCount ?? await countCsvRows(path.join(tempDir, TRANSACTIONS_OUTPUT)),
    fundRowCount: parseMetadata?.fundRowCount ?? await countCsvRows(path.join(tempDir, FUND_OUTPUT)),
    duplicatesDropped: job.duplicatesDropped ?? parseMetadata?.duplicatesDropped ?? 0,
    overlapDuplicatesDropped: job.overlapDuplicatesDropped ?? parseMetadata?.overlapDuplicatesDropped ?? 0,
    outputs: [...job.outputs],
    logs: job.logs.slice(-60),
  };
}

function buildSkippedSummary(
  job: PipelineJob,
  sourceTransactionsCsv: string,
  message: string,
  parseMetadata?: ParseMetadata,
): PipelineSummary {
  return {
    sourcePdf: job.sourcePdf ?? "",
    sourceTransactionsCsv,
    sourceArchivePath: job.archivePath,
    sourcePdfSha256: job.sourcePdfSha256,
    statementFingerprint: job.statementFingerprint ?? parseMetadata?.statementFingerprint,
    statementLanguage: job.statementLanguage,
    mode: job.mode,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: "completed",
    published: false,
    message,
    transactionRowCount: parseMetadata?.transactionRowCount,
    fundRowCount: parseMetadata?.fundRowCount,
    duplicatesDropped: parseMetadata?.duplicatesDropped ?? 0,
    overlapDuplicatesDropped: parseMetadata?.overlapDuplicatesDropped ?? 0,
    outputs: [],
    logs: job.logs.slice(-60),
  };
}

async function finalizeOutputs(job: PipelineJob, tempDir: string, sourceTransactionsCsv: string, parseMetadata?: ParseMetadata) {
  const copiedOutputs: string[] = [];
  for (const fileName of PROCESSED_OUTPUTS) {
    const copied = await copyOutputIfExists(tempDir, DATA_DIR, fileName);
    if (copied) {
      copiedOutputs.push(fileName);
    }
  }
  job.outputs = copiedOutputs;
  const fallbackSummary = await buildFallbackSummary(job, tempDir, sourceTransactionsCsv, parseMetadata);
  const summary = await loadGeneratedSummary(tempDir, fallbackSummary);
  summary.outputs = copiedOutputs;
  summary.logs = job.logs.slice(-60);
  summary.sourceArchivePath = job.archivePath;
  summary.sourcePdf = job.sourcePdf ?? summary.sourcePdf;
  summary.sourcePdfSha256 = job.sourcePdfSha256 ?? summary.sourcePdfSha256;
  summary.statementFingerprint = job.statementFingerprint ?? parseMetadata?.statementFingerprint ?? summary.statementFingerprint;
  summary.statementLanguage = job.statementLanguage ?? summary.statementLanguage;
  summary.mode = job.mode;
  summary.startedAt = job.startedAt;
  summary.completedAt = job.completedAt;
  summary.status = job.status;
  summary.published = job.published ?? summary.published ?? true;
  summary.message = job.message ?? job.error;
  summary.duplicatesDropped = job.duplicatesDropped ?? parseMetadata?.duplicatesDropped ?? summary.duplicatesDropped ?? 0;
  summary.overlapDuplicatesDropped = job.overlapDuplicatesDropped ?? parseMetadata?.overlapDuplicatesDropped ?? summary.overlapDuplicatesDropped ?? 0;
  await savePipelineSummary(summary);
  job.summary = summary;
}

async function archivePdf(fileName: string, buffer: Buffer) {
  await mkdir(RAW_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${timestamp}-${fileName}`;
  const archivePath = path.join(RAW_DIR, archiveName);
  await writeFile(archivePath, buffer);
  return archivePath;
}

async function executePipeline(job: PipelineJob, file?: File, fileBuffer?: Buffer, options?: StartPipelineOptions) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cashflow-pipeline-"));
  let sourceTransactionsCsv = path.join(DATA_DIR, "statement_transactions.csv");
  let parseMetadata: ParseMetadata | undefined;
  const statementLanguage = normalizeStatementLanguage(options?.statementLanguage ?? job.statementLanguage);
  job.statementLanguage = statementLanguage;
  try {
    if (job.mode === "parse_classify") {
      if (!file) {
        throw new Error("A PDF file is required for Parse + classify.");
      }
      job.step = "Archiving PDF";
      setJobStage(job, "archiving");
      job.archivePath = await archivePdf(file.name, fileBuffer ?? Buffer.from(await file.arrayBuffer()));
      job.sourcePdf = file.name;

      job.step = "Parsing PDF";
      setJobStage(job, "parsing");
      await runCommand(job, "python3", [CONVERT_SCRIPT, job.archivePath, "--output-dir", tempDir, "--prefix", "statement"]);
      sourceTransactionsCsv = path.join(tempDir, TRANSACTIONS_OUTPUT);
      parseMetadata = await loadParseMetadata(tempDir);
      job.statementFingerprint = parseMetadata.statementFingerprint;
      job.duplicatesDropped = parseMetadata.duplicatesDropped;

      const importRegistry = await loadImportRegistry();
      const matchingStatement = importRegistry.find(
        (entry) => entry.statementFingerprint && entry.statementFingerprint === job.statementFingerprint,
      );
      if (matchingStatement) {
        job.status = "completed";
        job.published = false;
        job.completedAt = new Date().toISOString();
        job.step = "Duplicate statement skipped";
        job.message = "Statement content already imported. Archived PDF and skipped publishing.";
        appendLog(job, job.message ?? "Statement content already imported. Archived PDF and skipped publishing.");
        setJobStage(job, "completed", 1);
        job.summary = buildSkippedSummary(job, sourceTransactionsCsv, job.message, parseMetadata);
        await savePipelineSummary(job.summary);
        await appendImportRegistryEntry(job);
        return;
      }

      job.step = "Merging statement";
      const mergeMetadata = await mergeParsedStatementWithExistingData(tempDir);
      parseMetadata = {
        ...parseMetadata,
        transactionRowCount: mergeMetadata.transactionRowCount,
        fundRowCount: mergeMetadata.fundRowCount,
        duplicatesDropped: parseMetadata.duplicatesDropped + mergeMetadata.overlapDuplicatesDropped,
        overlapDuplicatesDropped: mergeMetadata.overlapDuplicatesDropped,
      };
      job.duplicatesDropped = parseMetadata.duplicatesDropped;
      job.overlapDuplicatesDropped = mergeMetadata.overlapDuplicatesDropped;
      sourceTransactionsCsv = path.join(tempDir, TRANSACTIONS_OUTPUT);
      appendLog(
        job,
        (
          `Merged statement into existing dataset: ${mergeMetadata.transactionRowCount} transactions, `
          + `${mergeMetadata.fundRowCount} fund rows, `
          + `${mergeMetadata.overlapDuplicatesDropped} overlapping rows skipped.`
        ),
      );
    } else {
      job.step = "Preparing reclassification";
      setJobStage(job, "classifying", 0.02);
    }

    job.step = "Classifying transactions";
    setJobStage(job, "classifying");
    if (job.mode !== "refresh_reclassify" && existsSync(CATEGORY_CACHE_PATH)) {
      await copyFile(CATEGORY_CACHE_PATH, path.join(tempDir, CATEGORY_CACHE_OUTPUT)).catch(() => undefined);
    }
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
      "--statement-language",
      statementLanguage,
    ];
    const promptTemplate = options?.promptTemplate?.trim();
    if (promptTemplate) {
      const promptTemplatePath = path.join(tempDir, "classifier_prompt_template.txt");
      await writeFile(promptTemplatePath, `${promptTemplate}\n`, "utf8");
      classifyArgs.push("--prompt-template-file", promptTemplatePath);
    }
    const promptAddendum = options?.promptAddendum?.trim();
    if (promptAddendum) {
      const promptAddendumPath = path.join(tempDir, "classifier_prompt_addendum.txt");
      await writeFile(promptAddendumPath, `${promptAddendum}\n`, "utf8");
      classifyArgs.push("--prompt-addendum-file", promptAddendumPath);
    }
    const userName = options?.userName?.trim();
    if (userName) {
      classifyArgs.push("--user-name", userName);
    }
    const model = options?.model?.trim();
    if (model) {
      classifyArgs.push("--model", model);
    }
    if (job.mode === "refresh_reclassify") {
      classifyArgs.push("--refresh-cache");
    }
    await runCommand(job, "python3", classifyArgs);

    if (job.mode === "parse_classify") {
      for (const logLine of await maybeMigrateLegacyRowOverrides(tempDir)) {
        appendLog(job, logLine);
      }
    }

    job.step = "Publishing outputs";
    setJobStage(job, "publishing");
    job.published = true;
    await finalizeOutputs(job, tempDir, sourceTransactionsCsv, parseMetadata);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    setJobStage(job, "completed", 1);
    if (job.summary) {
      job.summary.status = job.status;
      job.summary.completedAt = job.completedAt;
      job.summary.published = true;
      job.summary.message = job.message;
      job.summary.sourcePdfSha256 = job.sourcePdfSha256 ?? job.summary.sourcePdfSha256;
      job.summary.statementFingerprint = job.statementFingerprint ?? job.summary.statementFingerprint;
      job.summary.duplicatesDropped = job.duplicatesDropped ?? job.summary.duplicatesDropped;
      job.summary.overlapDuplicatesDropped = job.overlapDuplicatesDropped ?? job.summary.overlapDuplicatesDropped;
      await savePipelineSummary(job.summary);
    }
    await appendImportRegistryEntry(job);
  } catch (error) {
    job.status = "failed";
    job.published = false;
    job.error = error instanceof Error ? error.message : "Pipeline run failed.";
    job.completedAt = new Date().toISOString();
    const existingSummary = await loadGeneratedSummary(
      tempDir,
      await buildFallbackSummary(job, tempDir, sourceTransactionsCsv, parseMetadata),
    );
    existingSummary.status = "failed";
    existingSummary.published = false;
    existingSummary.message = job.error;
    existingSummary.completedAt = job.completedAt;
    existingSummary.sourcePdfSha256 = job.sourcePdfSha256 ?? existingSummary.sourcePdfSha256;
    existingSummary.statementFingerprint = job.statementFingerprint ?? existingSummary.statementFingerprint;
    existingSummary.statementLanguage = job.statementLanguage ?? existingSummary.statementLanguage;
    existingSummary.duplicatesDropped = job.duplicatesDropped ?? existingSummary.duplicatesDropped;
    existingSummary.overlapDuplicatesDropped = job.overlapDuplicatesDropped ?? existingSummary.overlapDuplicatesDropped;
    existingSummary.logs = job.logs.slice(-60);
    await savePipelineSummary(existingSummary);
    job.summary = existingSummary;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function startPipelineJob(mode: PipelineMode, file?: File, options?: StartPipelineOptions) {
  let fileBuffer: Buffer | undefined;
  let sourcePdfSha256 = "";
  const statementLanguage = normalizeStatementLanguage(options?.statementLanguage);
  if (mode === "parse_classify") {
    if (!file) {
      throw new Error("A PDF file is required for Parse + classify.");
    }
    fileBuffer = Buffer.from(await file.arrayBuffer());
    sourcePdfSha256 = hashBufferSha256(fileBuffer);
    const existingEntry = (await loadImportRegistry()).find(
      (entry) => entry.sourcePdfSha256 && entry.sourcePdfSha256 === sourcePdfSha256,
    );
    if (existingEntry) {
      const currentSummary = loadPipelineSummarySync();
      const completedAt = new Date().toISOString();
      const job: PipelineJob = {
        id: randomUUID(),
        mode,
        status: "completed",
        step: "Duplicate PDF skipped",
        startedAt: completedAt,
        completedAt,
        sourcePdf: file.name,
        statementLanguage,
        sourcePdfSha256,
        statementFingerprint: existingEntry.statementFingerprint,
        duplicatesDropped: 0,
        published: false,
        message: "This PDF was already imported. Skipped before parsing.",
        logs: [],
        outputs: [],
        progress: {
          stageKey: "completed",
          stageLabel: "Completed",
          stageIndex: PIPELINE_STAGE_WEIGHTS[mode].filter((stage) => stage.key !== "queued").length,
          stageCount: PIPELINE_STAGE_WEIGHTS[mode].filter((stage) => stage.key !== "queued").length,
          percent: 100,
        },
      };
      appendLog(job, job.message ?? "This PDF was already imported. Skipped before parsing.");
      job.summary = {
        ...(currentSummary ?? {
          sourcePdf: file.name,
          sourceTransactionsCsv: path.join(DATA_DIR, TRANSACTIONS_OUTPUT),
          mode,
          startedAt: job.startedAt,
          completedAt,
          status: "completed",
        }),
        sourcePdf: file.name,
        sourceTransactionsCsv: currentSummary?.sourceTransactionsCsv ?? path.join(DATA_DIR, TRANSACTIONS_OUTPUT),
        sourceArchivePath: existingEntry.archivePath ?? currentSummary?.sourceArchivePath,
        sourcePdfSha256,
        statementFingerprint: existingEntry.statementFingerprint,
        statementLanguage,
        mode,
        startedAt: job.startedAt,
        completedAt,
        status: "completed",
        published: false,
        message: job.message,
        duplicatesDropped: 0,
        logs: job.logs.slice(-60),
      };
      await savePipelineSummary(job.summary);
      jobsStore().set(job.id, job);
      await appendImportRegistryEntry(job);
      return job;
    }
  }

  const job: PipelineJob = {
    id: randomUUID(),
    mode,
    status: "running",
    step: "Queued",
    startedAt: new Date().toISOString(),
    sourcePdf: file?.name,
    statementLanguage,
    sourcePdfSha256: sourcePdfSha256 || undefined,
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
  void executePipeline(job, file, fileBuffer, options);
  return job;
}

export function getPipelineJob(jobId: string) {
  return jobsStore().get(jobId) ?? null;
}

export function getRunningPipelineJob() {
  return [...jobsStore().values()]
    .filter((job) => job.status === "running")
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
}

export function resetPipelineState() {
  jobsStore().clear();
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
  const [cache, availableModels] = await Promise.all([readCacheInspection(), readAvailableOllamaModels()]);

  return {
    summary,
    latestJob,
    cache,
    availableModels,
  };
}
