import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { NextResponse } from "next/server";
import {
  POSITION_VALUATION_OVERRIDE_COLUMNS,
  POSITION_VALUATION_OVERRIDES_PATH,
} from "@/lib/config-store";

type OverrideColumn = (typeof POSITION_VALUATION_OVERRIDE_COLUMNS)[number];
type OverrideRow = Record<OverrideColumn, string>;

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

async function readOverrides(): Promise<OverrideRow[]> {
  try {
    const raw = await readFile(POSITION_VALUATION_OVERRIDES_PATH, "utf8");
    return parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as OverrideRow[];
  } catch {
    return [];
  }
}

async function writeOverrides(rows: OverrideRow[]) {
  const lines = [
    POSITION_VALUATION_OVERRIDE_COLUMNS.join(","),
    ...rows.map((row) => POSITION_VALUATION_OVERRIDE_COLUMNS.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ];
  await mkdir(path.dirname(POSITION_VALUATION_OVERRIDES_PATH), { recursive: true });
  await writeFile(POSITION_VALUATION_OVERRIDES_PATH, `${lines.join("\n")}\n`, "utf8");
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    instrumentKey?: string;
    isin?: string;
    instrument?: string;
    priceEur?: number;
    effectiveDate?: string;
  };

  const instrumentKey = (body.instrumentKey ?? "").trim();
  const isin = (body.isin ?? "").trim();
  const instrument = (body.instrument ?? "").trim();
  const priceEur = Number(body.priceEur ?? Number.NaN);
  const effectiveDate = (body.effectiveDate ?? "").trim();

  if (!instrumentKey || !instrument || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !Number.isFinite(priceEur) || priceEur <= 0) {
    return NextResponse.json({ message: "Invalid position valuation change request." }, { status: 400 });
  }

  const nextRow: OverrideRow = {
    instrument_key: instrumentKey,
    isin,
    instrument,
    price_eur: priceEur.toString(),
    effective_date: effectiveDate,
    updated_at: new Date().toISOString(),
  };

  const rows = await readOverrides();
  const existingIndex = rows.findIndex(
    (row) => row.instrument_key === instrumentKey && row.effective_date === effectiveDate,
  );

  if (existingIndex >= 0) {
    rows[existingIndex] = nextRow;
  } else {
    rows.push(nextRow);
  }

  rows.sort((left, right) =>
    `${left.instrument_key}-${left.effective_date}-${left.updated_at}`.localeCompare(
      `${right.instrument_key}-${right.effective_date}-${right.updated_at}`,
    ),
  );
  await writeOverrides(rows);

  return NextResponse.json({
    ok: true,
    instrumentKey,
    instrument,
    priceEur,
    effectiveDate,
  });
}
