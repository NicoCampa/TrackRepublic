import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

const ROOT = process.cwd();
export const CONFIG_DIR = path.join(ROOT, "config");
export const DATA_DIR = path.join(ROOT, "data", "processed");
export const RAW_DIR = path.join(ROOT, "data", "raw");

export const MANUAL_RULES_PATH = path.join(CONFIG_DIR, "manual_category_rules.csv");
export const ROW_OVERRIDES_PATH = path.join(CONFIG_DIR, "transaction_overrides.csv");
export const POSITION_OVERRIDES_PATH = path.join(CONFIG_DIR, "position_unit_overrides.csv");
export const INSTRUMENT_REGISTRY_PATH = path.join(CONFIG_DIR, "instrument_registry.csv");
export const PIPELINE_SUMMARY_PATH = path.join(DATA_DIR, "pipeline_summary.json");
export const CATEGORY_CACHE_PATH = path.join(DATA_DIR, "statement_transactions_category_cache.json");

export const MANUAL_RULE_COLUMNS = [
  "id",
  "enabled",
  "name",
  "match_type",
  "pattern",
  "transaction_type",
  "amount_sign",
  "merchant",
  "group",
  "category",
  "subcategory",
  "confidence",
  "needs_review",
] as const;

export const ROW_OVERRIDE_COLUMNS = [
  "row_id",
  "description",
  "transaction_type",
  "signed_amount",
  "merchant",
  "group",
  "category",
  "subcategory",
  "confidence",
  "needs_review",
  "source",
  "updated_at",
] as const;

export const INSTRUMENT_REGISTRY_COLUMNS = [
  "key",
  "isin",
  "symbol",
  "instrument",
  "asset_class",
  "country",
  "sector",
  "industry",
  "lookthrough_provider",
  "search_query",
] as const;

export type ManualRuleRecord = {
  id: string;
  enabled: boolean;
  name: string;
  matchType: string;
  pattern: string;
  transactionType: string;
  amountSign: string;
  merchant: string;
  group: string;
  category: string;
  subcategory: string;
  confidence: number;
  needsReview: boolean;
};

export type RowOverrideRecord = {
  rowId: string;
  description: string;
  transactionType: string;
  signedAmount: number;
  merchant: string;
  group: string;
  category: string;
  subcategory: string;
  confidence: number;
  needsReview: boolean;
  source: string;
  updatedAt: string;
};

export type InstrumentRegistryEntry = {
  key: string;
  isin: string;
  symbol: string;
  instrument: string;
  assetClass: string;
  country: string;
  sector: string;
  industry: string;
  lookthroughProvider: string;
  searchQuery: string;
};

export type PipelineSummary = {
  sourcePdf: string;
  sourceTransactionsCsv: string;
  sourceArchivePath?: string;
  mode: "parse_classify" | "reclassify" | "refresh_reclassify";
  startedAt: string;
  completedAt?: string;
  status: "idle" | "running" | "completed" | "failed";
  message?: string;
  model?: string;
  transactionRowCount?: number;
  fundRowCount?: number;
  reviewCount?: number;
  cacheEntryCount?: number;
  cacheHits?: number;
  cacheMisses?: number;
  manualRuleHits?: number;
  builtInRuleHits?: number;
  llmClassifications?: number;
  rowOverrideHits?: number;
  outputs?: string[];
  logs?: string[];
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return [];
}

export function normalizePipelineSummary(payload: unknown): PipelineSummary | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const timestamps =
    value.timestamps && typeof value.timestamps === "object"
      ? (value.timestamps as Record<string, unknown>)
      : {};
  const outputFiles =
    value.output_files && typeof value.output_files === "object"
      ? (value.output_files as Record<string, unknown>)
      : {};

  return {
    sourcePdf: String(value.sourcePdf ?? value.source_pdf ?? ""),
    sourceTransactionsCsv: String(value.sourceTransactionsCsv ?? value.source_transactions_csv ?? ""),
    sourceArchivePath:
      value.sourceArchivePath !== undefined || value.source_archive_path !== undefined
        ? String(value.sourceArchivePath ?? value.source_archive_path ?? "")
        : undefined,
    mode: String(value.mode ?? "reclassify") as PipelineSummary["mode"],
    startedAt: String(value.startedAt ?? value.started_at ?? timestamps.startedAt ?? timestamps.started_at ?? ""),
    completedAt:
      value.completedAt !== undefined ||
      value.completed_at !== undefined ||
      timestamps.completedAt !== undefined ||
      timestamps.completed_at !== undefined
        ? String(value.completedAt ?? value.completed_at ?? timestamps.completedAt ?? timestamps.completed_at ?? "")
        : undefined,
    status: String(value.status ?? "completed") as PipelineSummary["status"],
    message:
      value.message !== undefined || value.error !== undefined
        ? String(value.message ?? value.error ?? "")
        : undefined,
    model: value.model !== undefined ? String(value.model) : undefined,
    transactionRowCount: parseNumber(
      String(value.transactionRowCount ?? value.transaction_row_count ?? ""),
      0,
    ),
    fundRowCount: parseNumber(String(value.fundRowCount ?? value.fund_row_count ?? ""), 0),
    reviewCount: parseNumber(String(value.reviewCount ?? value.review_count ?? ""), 0),
    cacheEntryCount: parseNumber(String(value.cacheEntryCount ?? value.cache_entry_count ?? ""), 0),
    cacheHits: parseNumber(String(value.cacheHits ?? value.cache_hits ?? ""), 0),
    cacheMisses: parseNumber(String(value.cacheMisses ?? value.cache_misses ?? ""), 0),
    manualRuleHits: parseNumber(String(value.manualRuleHits ?? value.manual_rule_hits ?? ""), 0),
    builtInRuleHits: parseNumber(String(value.builtInRuleHits ?? value.built_in_rule_hits ?? ""), 0),
    llmClassifications: parseNumber(String(value.llmClassifications ?? value.llm_classifications ?? ""), 0),
    rowOverrideHits: parseNumber(String(value.rowOverrideHits ?? value.row_override_hits ?? ""), 0),
    outputs:
      value.outputs !== undefined
        ? asStringArray(value.outputs)
        : Object.values(outputFiles).map((item) => String(item)),
    logs: asStringArray(value.logs),
  };
}

function parseBoolean(value: string | undefined, defaultValue = false) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ["1", "true", "yes", "y"].includes(normalized);
}

function parseNumber(value: string | undefined, defaultValue = 0) {
  const numeric = Number(value ?? defaultValue);
  return Number.isFinite(numeric) ? numeric : defaultValue;
}

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function ensureId(prefix: string, value: string) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}-${cleaned || "item"}`;
}

function readCsvSync(filePath: string): Record<string, string>[] {
  const raw = readFileSync(filePath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  const raw = await readFile(filePath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

async function ensureCsvFile(filePath: string, columns: readonly string[]) {
  if (existsSync(filePath)) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${columns.join(",")}\n`, "utf8");
}

async function writeCsv(filePath: string, columns: readonly string[], rows: Record<string, string>[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n");
  await writeFile(filePath, `${body}\n`, "utf8");
}

function normalizeManualRule(row: Record<string, string>, index: number): ManualRuleRecord | null {
  const pattern = (row.pattern ?? "").trim();
  if (!pattern) {
    return null;
  }
  return {
    id: (row.id ?? "").trim() || ensureId("rule", row.name || pattern || String(index + 1)),
    enabled: parseBoolean(row.enabled, true),
    name: (row.name ?? "").trim() || pattern,
    matchType: ((row.match_type ?? "contains").trim().toLowerCase() || "contains"),
    pattern,
    transactionType: (row.transaction_type ?? "").trim(),
    amountSign: (row.amount_sign ?? "").trim().toLowerCase(),
    merchant: (row.merchant ?? "").trim(),
    group: (row.group ?? "").trim(),
    category: (row.category ?? "").trim(),
    subcategory: (row.subcategory ?? "").trim(),
    confidence: parseNumber(row.confidence, 0.99),
    needsReview: parseBoolean(row.needs_review, false),
  };
}

function toManualRuleRow(rule: ManualRuleRecord): Record<string, string> {
  return {
    id: rule.id,
    enabled: String(rule.enabled),
    name: rule.name,
    match_type: rule.matchType,
    pattern: rule.pattern,
    transaction_type: rule.transactionType,
    amount_sign: rule.amountSign,
    merchant: rule.merchant,
    group: rule.group,
    category: rule.category,
    subcategory: rule.subcategory,
    confidence: rule.confidence.toFixed(2),
    needs_review: String(rule.needsReview),
  };
}

function normalizeRowOverride(row: Record<string, string>): RowOverrideRecord | null {
  const rowId = (row.row_id ?? "").trim();
  if (!rowId) {
    return null;
  }
  return {
    rowId,
    description: (row.description ?? "").trim(),
    transactionType: (row.transaction_type ?? "").trim(),
    signedAmount: parseNumber(row.signed_amount, 0),
    merchant: (row.merchant ?? "").trim(),
    group: (row.group ?? "").trim(),
    category: (row.category ?? "").trim(),
    subcategory: (row.subcategory ?? "").trim(),
    confidence: parseNumber(row.confidence, 0.99),
    needsReview: parseBoolean(row.needs_review, false),
    source: (row.source ?? "").trim() || "row_override",
    updatedAt: (row.updated_at ?? "").trim(),
  };
}

function toRowOverrideRow(override: RowOverrideRecord): Record<string, string> {
  return {
    row_id: override.rowId,
    description: override.description,
    transaction_type: override.transactionType,
    signed_amount: String(override.signedAmount),
    merchant: override.merchant,
    group: override.group,
    category: override.category,
    subcategory: override.subcategory,
    confidence: override.confidence.toFixed(2),
    needs_review: String(override.needsReview),
    source: override.source || "row_override",
    updated_at: override.updatedAt,
  };
}

function normalizeInstrumentRegistryEntry(row: Record<string, string>): InstrumentRegistryEntry | null {
  const key = (row.key ?? row.isin ?? row.symbol ?? "").trim();
  if (!key) {
    return null;
  }
  return {
    key,
    isin: (row.isin ?? "").trim(),
    symbol: (row.symbol ?? "").trim(),
    instrument: (row.instrument ?? "").trim(),
    assetClass: (row.asset_class ?? "").trim(),
    country: (row.country ?? "").trim(),
    sector: (row.sector ?? "").trim(),
    industry: (row.industry ?? "").trim(),
    lookthroughProvider: (row.lookthrough_provider ?? "").trim(),
    searchQuery: (row.search_query ?? "").trim(),
  };
}

export function loadManualRulesSync(): ManualRuleRecord[] {
  if (!existsSync(MANUAL_RULES_PATH)) {
    return [];
  }
  return readCsvSync(MANUAL_RULES_PATH)
    .map(normalizeManualRule)
    .filter((row): row is ManualRuleRecord => Boolean(row));
}

export async function loadManualRules(): Promise<ManualRuleRecord[]> {
  if (!existsSync(MANUAL_RULES_PATH)) {
    return [];
  }
  return (await readCsv(MANUAL_RULES_PATH))
    .map(normalizeManualRule)
    .filter((row): row is ManualRuleRecord => Boolean(row));
}

export async function saveManualRules(rules: ManualRuleRecord[]) {
  await ensureCsvFile(MANUAL_RULES_PATH, MANUAL_RULE_COLUMNS);
  await writeCsv(MANUAL_RULES_PATH, MANUAL_RULE_COLUMNS, rules.map(toManualRuleRow));
}

export function loadRowOverridesSync(): RowOverrideRecord[] {
  if (!existsSync(ROW_OVERRIDES_PATH)) {
    return [];
  }
  return readCsvSync(ROW_OVERRIDES_PATH)
    .map(normalizeRowOverride)
    .filter((row): row is RowOverrideRecord => Boolean(row));
}

export async function loadRowOverrides(): Promise<RowOverrideRecord[]> {
  if (!existsSync(ROW_OVERRIDES_PATH)) {
    return [];
  }
  return (await readCsv(ROW_OVERRIDES_PATH))
    .map(normalizeRowOverride)
    .filter((row): row is RowOverrideRecord => Boolean(row));
}

export async function saveRowOverrides(overrides: RowOverrideRecord[]) {
  await ensureCsvFile(ROW_OVERRIDES_PATH, ROW_OVERRIDE_COLUMNS);
  await writeCsv(ROW_OVERRIDES_PATH, ROW_OVERRIDE_COLUMNS, overrides.map(toRowOverrideRow));
}

export function loadInstrumentRegistrySync(): Record<string, InstrumentRegistryEntry> {
  if (!existsSync(INSTRUMENT_REGISTRY_PATH)) {
    return {};
  }
  return readCsvSync(INSTRUMENT_REGISTRY_PATH)
    .map(normalizeInstrumentRegistryEntry)
    .filter((row): row is InstrumentRegistryEntry => Boolean(row))
    .reduce<Record<string, InstrumentRegistryEntry>>((acc, row) => {
      acc[row.key] = row;
      if (row.isin) {
        acc[row.isin] = row;
      }
      if (row.symbol) {
        acc[row.symbol] = row;
      }
      return acc;
    }, {});
}

export async function ensureConfigScaffolding() {
  await Promise.all([
    ensureCsvFile(MANUAL_RULES_PATH, MANUAL_RULE_COLUMNS),
    ensureCsvFile(ROW_OVERRIDES_PATH, ROW_OVERRIDE_COLUMNS),
    ensureCsvFile(INSTRUMENT_REGISTRY_PATH, INSTRUMENT_REGISTRY_COLUMNS),
  ]);
}

export function loadPipelineSummarySync(): PipelineSummary | null {
  if (!existsSync(PIPELINE_SUMMARY_PATH)) {
    return null;
  }
  try {
    return normalizePipelineSummary(JSON.parse(readFileSync(PIPELINE_SUMMARY_PATH, "utf8")));
  } catch {
    return null;
  }
}

export async function savePipelineSummary(summary: PipelineSummary) {
  await mkdir(path.dirname(PIPELINE_SUMMARY_PATH), { recursive: true });
  await writeFile(PIPELINE_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
