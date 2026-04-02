import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { normalizeCategoryKey } from "./category-config";
import { normalizeInvestmentAssetClass } from "./investment-asset-class";

const ROOT = process.cwd();
export const CONFIG_DIR = path.join(ROOT, "config");
export const DATA_DIR = path.join(ROOT, "data", "processed");
export const RAW_DIR = path.join(ROOT, "data", "raw");

export const MANUAL_RULES_PATH = path.join(CONFIG_DIR, "manual_category_rules.csv");
export const ROW_OVERRIDES_PATH = path.join(CONFIG_DIR, "transaction_overrides.csv");
export const MANUAL_TRANSACTIONS_PATH = path.join(CONFIG_DIR, "manual_transactions.csv");
export const POSITION_OVERRIDES_PATH = path.join(CONFIG_DIR, "position_unit_overrides.csv");
export const POSITION_VALUATION_OVERRIDES_PATH = path.join(CONFIG_DIR, "position_valuation_overrides.csv");
export const INSTRUMENT_REGISTRY_PATH = path.join(CONFIG_DIR, "instrument_registry.csv");
export const CLASSIFIER_PROMPT_TEMPLATE_PATH = path.join(CONFIG_DIR, "classifier_prompt_template.txt");
export const INVESTMENT_ASSET_CLASS_PROMPT_TEMPLATE_PATH = path.join(CONFIG_DIR, "investment_asset_class_prompt_template.txt");
export const PIPELINE_SUMMARY_PATH = path.join(DATA_DIR, "pipeline_summary.json");
export const IMPORT_REGISTRY_PATH = path.join(DATA_DIR, "import_registry.json");
export const CATEGORY_CACHE_PATH = path.join(DATA_DIR, "statement_transactions_category_cache.json");

export const MANUAL_RULE_COLUMNS = [
  "id",
  "enabled",
  "name",
  "match_type",
  "pattern",
  "transaction_type",
  "amount_sign",
  "category",
] as const;

export const ROW_OVERRIDE_COLUMNS = [
  "row_id",
  "description",
  "transaction_type",
  "signed_amount",
  "category",
  "asset_class",
  "source",
  "link_group_id",
  "link_role",
  "updated_at",
] as const;

export const MANUAL_TRANSACTION_COLUMNS = [
  "row_id",
  "date",
  "transaction_type",
  "description",
  "signed_amount",
  "category",
  "link_group_id",
  "link_role",
  "updated_at",
] as const;

export const POSITION_UNIT_OVERRIDE_COLUMNS = [
  "instrument_key",
  "isin",
  "instrument",
  "units",
  "effective_date",
  "updated_at",
] as const;

export const POSITION_VALUATION_OVERRIDE_COLUMNS = [
  "instrument_key",
  "isin",
  "instrument",
  "price_eur",
  "effective_date",
  "updated_at",
] as const;

export const INSTRUMENT_REGISTRY_COLUMNS = [
  "key",
  "isin",
  "symbol",
  "instrument",
  "asset_class",
  "price_scale",
  "fallback_valuation",
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
  category: string;
};

export type TransactionLinkRole = "net" | "member" | "";

export type RowOverrideRecord = {
  rowId: string;
  description: string;
  transactionType: string;
  signedAmount: number;
  category: string;
  assetClass: string;
  source: string;
  linkGroupId: string;
  linkRole: TransactionLinkRole;
  updatedAt: string;
};

export type ManualTransactionRecord = {
  rowId: string;
  date: string;
  transactionType: string;
  description: string;
  signedAmount: number;
  category: string;
  linkGroupId: string;
  linkRole: TransactionLinkRole;
  updatedAt: string;
};

export type InstrumentRegistryEntry = {
  key: string;
  isin: string;
  symbol: string;
  instrument: string;
  assetClass: string;
  priceScale: string;
  fallbackValuation: string;
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
  sourcePdfSha256?: string;
  statementFingerprint?: string;
  mode: "parse_classify" | "reclassify" | "refresh_reclassify";
  startedAt: string;
  completedAt?: string;
  status: "idle" | "running" | "completed" | "failed";
  published?: boolean;
  message?: string;
  model?: string;
  transactionRowCount?: number;
  fundRowCount?: number;
  duplicatesDropped?: number;
  cacheEntryCount?: number;
  cacheHits?: number;
  cacheMisses?: number;
  manualRuleHits?: number;
  builtInRuleHits?: number;
  llmClassifications?: number;
  webEnrichedClassifications?: number;
  webLookupQueries?: number;
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
  const status = String(value.status ?? "completed") as PipelineSummary["status"];
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
    sourcePdfSha256:
      value.sourcePdfSha256 !== undefined || value.source_pdf_sha256 !== undefined
        ? String(value.sourcePdfSha256 ?? value.source_pdf_sha256 ?? "")
        : undefined,
    statementFingerprint:
      value.statementFingerprint !== undefined || value.statement_fingerprint !== undefined
        ? String(value.statementFingerprint ?? value.statement_fingerprint ?? "")
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
    status,
    published:
      value.published !== undefined
        ? parseBoolean(String(value.published), status === "completed")
        : status === "completed",
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
    duplicatesDropped: parseNumber(String(value.duplicatesDropped ?? value.duplicates_dropped ?? ""), 0),
    cacheEntryCount: parseNumber(String(value.cacheEntryCount ?? value.cache_entry_count ?? ""), 0),
    cacheHits: parseNumber(String(value.cacheHits ?? value.cache_hits ?? ""), 0),
    cacheMisses: parseNumber(String(value.cacheMisses ?? value.cache_misses ?? ""), 0),
    manualRuleHits: parseNumber(String(value.manualRuleHits ?? value.manual_rule_hits ?? ""), 0),
    builtInRuleHits: parseNumber(String(value.builtInRuleHits ?? value.built_in_rule_hits ?? ""), 0),
    llmClassifications: parseNumber(String(value.llmClassifications ?? value.llm_classifications ?? ""), 0),
    webEnrichedClassifications: parseNumber(
      String(value.webEnrichedClassifications ?? value.web_enriched_classifications ?? ""),
      0,
    ),
    webLookupQueries: parseNumber(String(value.webLookupQueries ?? value.web_lookup_queries ?? ""), 0),
    rowOverrideHits: parseNumber(String(value.rowOverrideHits ?? value.row_override_hits ?? ""), 0),
    outputs:
      value.outputs !== undefined
        ? asStringArray(value.outputs)
        : Object.values(outputFiles).map((item) => String(item)),
    logs: asStringArray(value.logs),
  };
}

export function loadClassifierPromptTemplateSync() {
  try {
    return readFileSync(CLASSIFIER_PROMPT_TEMPLATE_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

export function loadInvestmentAssetClassPromptTemplateSync() {
  try {
    return readFileSync(INVESTMENT_ASSET_CLASS_PROMPT_TEMPLATE_PATH, "utf8").trim();
  } catch {
    return "";
  }
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

function normalizeLinkRole(value: string | undefined): TransactionLinkRole {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "net" || normalized === "member") {
    return normalized;
  }
  return "";
}

function extractLegacyLinkMetadata(subcategory: string | undefined) {
  const value = (subcategory ?? "").trim();
  if (value.startsWith("connected_expense_net:")) {
    return {
      linkGroupId: value.slice("connected_expense_net:".length).trim(),
      linkRole: "net" as const,
    };
  }
  if (value.startsWith("connected_expense_member:")) {
    return {
      linkGroupId: value.slice("connected_expense_member:".length).trim(),
      linkRole: "member" as const,
    };
  }
  return {
    linkGroupId: "",
    linkRole: "" as const,
  };
}

function readLinkMetadata(row: Record<string, string>) {
  const directGroupId = (row.link_group_id ?? "").trim();
  const directRole = normalizeLinkRole(row.link_role);
  if (directGroupId || directRole) {
    return {
      linkGroupId: directGroupId,
      linkRole: directRole,
    };
  }
  return extractLegacyLinkMetadata(row.subcategory);
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
  const category = normalizeCategoryKey((row.category ?? "").trim()) || "other";
  return {
    id: (row.id ?? "").trim() || ensureId("rule", row.name || pattern || String(index + 1)),
    enabled: parseBoolean(row.enabled, true),
    name: (row.name ?? "").trim() || pattern,
    matchType: ((row.match_type ?? "contains").trim().toLowerCase() || "contains"),
    pattern,
    transactionType: (row.transaction_type ?? "").trim(),
    amountSign: (row.amount_sign ?? "").trim().toLowerCase(),
    category,
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
    category: rule.category,
  };
}

function normalizeRowOverride(row: Record<string, string>): RowOverrideRecord | null {
  const rowId = (row.row_id ?? "").trim();
  if (!rowId) {
    return null;
  }
  const link = readLinkMetadata(row);
  const category = normalizeCategoryKey((row.category ?? "").trim());
  const override = {
    rowId,
    description: (row.description ?? "").trim(),
    transactionType: (row.transaction_type ?? "").trim(),
    signedAmount: parseNumber(row.signed_amount, 0),
    category,
    assetClass: normalizeInvestmentAssetClass(row.asset_class ?? ""),
    source: (row.source ?? "").trim() || "row_override",
    linkGroupId: link.linkGroupId,
    linkRole: link.linkRole,
    updatedAt: (row.updated_at ?? "").trim(),
  };
  if (
    override.source !== "deleted_transaction" &&
    !override.category &&
    !override.assetClass &&
    !override.linkGroupId &&
    !override.linkRole
  ) {
    return null;
  }
  return override;
}

function toRowOverrideRow(override: RowOverrideRecord): Record<string, string> {
  return {
    row_id: override.rowId,
    description: override.description,
    transaction_type: override.transactionType,
    signed_amount: String(override.signedAmount),
    category: override.category,
    asset_class: override.assetClass,
    source: override.source || "row_override",
    link_group_id: override.linkGroupId,
    link_role: override.linkRole,
    updated_at: override.updatedAt,
  };
}

function normalizeManualTransaction(row: Record<string, string>): ManualTransactionRecord | null {
  const rowId = (row.row_id ?? "").trim();
  const date = (row.date ?? "").trim();
  if (!rowId || !date) {
    return null;
  }
  const link = readLinkMetadata(row);
  const legacyDescription = (row.description ?? "").trim();
  const legacyMerchant = (row.merchant ?? "").trim();
  const category = normalizeCategoryKey((row.category ?? "").trim()) || "other";
  return {
    rowId,
    date,
    transactionType: (row.transaction_type ?? "").trim(),
    description: legacyDescription || legacyMerchant || "Manual entry",
    signedAmount: parseNumber(row.signed_amount, 0),
    category,
    linkGroupId: link.linkGroupId,
    linkRole: link.linkRole,
    updatedAt: (row.updated_at ?? "").trim(),
  };
}

function toManualTransactionRow(transaction: ManualTransactionRecord): Record<string, string> {
  return {
    row_id: transaction.rowId,
    date: transaction.date,
    transaction_type: transaction.transactionType,
    description: transaction.description,
    signed_amount: String(transaction.signedAmount),
    category: transaction.category,
    link_group_id: transaction.linkGroupId,
    link_role: transaction.linkRole,
    updated_at: transaction.updatedAt,
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
    priceScale: (row.price_scale ?? "").trim(),
    fallbackValuation: (row.fallback_valuation ?? "").trim(),
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

export function loadManualTransactionsSync(): ManualTransactionRecord[] {
  if (!existsSync(MANUAL_TRANSACTIONS_PATH)) {
    return [];
  }
  return readCsvSync(MANUAL_TRANSACTIONS_PATH)
    .map(normalizeManualTransaction)
    .filter((row): row is ManualTransactionRecord => Boolean(row));
}

export async function loadManualTransactions(): Promise<ManualTransactionRecord[]> {
  if (!existsSync(MANUAL_TRANSACTIONS_PATH)) {
    return [];
  }
  return (await readCsv(MANUAL_TRANSACTIONS_PATH))
    .map(normalizeManualTransaction)
    .filter((row): row is ManualTransactionRecord => Boolean(row));
}

export async function saveManualTransactions(transactions: ManualTransactionRecord[]) {
  await ensureCsvFile(MANUAL_TRANSACTIONS_PATH, MANUAL_TRANSACTION_COLUMNS);
  await writeCsv(
    MANUAL_TRANSACTIONS_PATH,
    MANUAL_TRANSACTION_COLUMNS,
    transactions.map(toManualTransactionRow),
  );
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
    ensureCsvFile(POSITION_OVERRIDES_PATH, POSITION_UNIT_OVERRIDE_COLUMNS),
    ensureCsvFile(POSITION_VALUATION_OVERRIDES_PATH, POSITION_VALUATION_OVERRIDE_COLUMNS),
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
