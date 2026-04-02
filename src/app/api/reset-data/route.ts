import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  CATEGORY_CACHE_PATH,
  CLASSIFIER_PROMPT_TEMPLATE_PATH,
  DATA_DIR,
  IMPORT_REGISTRY_PATH,
  INVESTMENT_ASSET_CLASS_PROMPT_TEMPLATE_PATH,
  INSTRUMENT_REGISTRY_PATH,
  MANUAL_RULE_COLUMNS,
  MANUAL_RULES_PATH,
  MANUAL_TRANSACTION_COLUMNS,
  MANUAL_TRANSACTIONS_PATH,
  PIPELINE_SUMMARY_PATH,
  POSITION_OVERRIDES_PATH,
  POSITION_UNIT_OVERRIDE_COLUMNS,
  POSITION_VALUATION_OVERRIDE_COLUMNS,
  POSITION_VALUATION_OVERRIDES_PATH,
  RAW_DIR,
  ROW_OVERRIDE_COLUMNS,
  ROW_OVERRIDES_PATH,
} from "@/lib/config-store";
import { getRunningPipelineJob, resetPipelineState } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

const PROCESSED_OUTPUT_FILES = [
  "statement_transactions.csv",
  "statement_money_market_fund.csv",
  "statement_all_rows.csv",
  "statement_transactions_categorized.csv",
  "statement_transactions_monthly_overview.csv",
  "statement_transactions_yearly_overview.csv",
  "statement_transactions_monthly_categories.csv",
  "statement_transactions_yearly_categories.csv",
];

function csvHeader(columns: readonly string[]) {
  return `${columns.join(",")}\n`;
}

async function resetCsvFile(filePath: string, columns: readonly string[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, csvHeader(columns), "utf8");
}

async function removeIfExists(filePath: string) {
  await rm(filePath, { recursive: true, force: true });
}

async function emptyDirectory(targetPath: string) {
  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => removeIfExists(path.join(targetPath, entry.name))),
  );
}

export async function POST() {
  if (getRunningPipelineJob()) {
    return NextResponse.json({ message: "Cannot delete data while an import is running." }, { status: 409 });
  }

  const preservedFiles = [
    INSTRUMENT_REGISTRY_PATH,
    CLASSIFIER_PROMPT_TEMPLATE_PATH,
    INVESTMENT_ASSET_CLASS_PROMPT_TEMPLATE_PATH,
  ];

  await Promise.all([
    emptyDirectory(RAW_DIR),
    Promise.all(PROCESSED_OUTPUT_FILES.map((fileName) => removeIfExists(path.join(DATA_DIR, fileName)))),
    removeIfExists(CATEGORY_CACHE_PATH),
    removeIfExists(PIPELINE_SUMMARY_PATH),
    removeIfExists(IMPORT_REGISTRY_PATH),
    resetCsvFile(MANUAL_RULES_PATH, MANUAL_RULE_COLUMNS),
    resetCsvFile(ROW_OVERRIDES_PATH, ROW_OVERRIDE_COLUMNS),
    resetCsvFile(MANUAL_TRANSACTIONS_PATH, MANUAL_TRANSACTION_COLUMNS),
    resetCsvFile(POSITION_OVERRIDES_PATH, POSITION_UNIT_OVERRIDE_COLUMNS),
    resetCsvFile(POSITION_VALUATION_OVERRIDES_PATH, POSITION_VALUATION_OVERRIDE_COLUMNS),
  ]);

  resetPipelineState();

  return NextResponse.json({
    ok: true,
    preservedFiles,
    message: "All imported data and mutable app data were deleted.",
  });
}
