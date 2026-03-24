import { NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

const ROOT = process.cwd();
const OVERRIDES_PATH = path.join(ROOT, "config", "position_unit_overrides.csv");
const CSV_HEADER = [
  "instrument_key",
  "isin",
  "instrument",
  "units",
  "effective_date",
  "updated_at",
] as const;

type OverrideRow = Record<(typeof CSV_HEADER)[number], string>;

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

async function readOverrides(): Promise<OverrideRow[]> {
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
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
    CSV_HEADER.join(","),
    ...rows.map((row) => CSV_HEADER.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ];
  await writeFile(OVERRIDES_PATH, `${lines.join("\n")}\n`, "utf8");
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    instrumentKey?: string;
    isin?: string;
    instrument?: string;
    units?: number;
    effectiveDate?: string;
  };

  const instrumentKey = (body.instrumentKey ?? "").trim();
  const isin = (body.isin ?? "").trim();
  const instrument = (body.instrument ?? "").trim();
  const units = Number(body.units ?? NaN);
  const effectiveDate = (body.effectiveDate ?? "").trim();

  if (!instrumentKey || !instrument || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !Number.isFinite(units) || units < 0) {
    return NextResponse.json({ message: "Invalid position units change request." }, { status: 400 });
  }

  const nextRow: OverrideRow = {
    instrument_key: instrumentKey,
    isin,
    instrument,
    units: units.toString(),
    effective_date: effectiveDate,
    updated_at: new Date().toISOString(),
  };

  const rows = await readOverrides();
  const existingIndex = rows.findIndex((row) => row.instrument_key === instrumentKey);

  if (existingIndex >= 0) {
    rows[existingIndex] = nextRow;
  } else {
    rows.push(nextRow);
  }

  await writeOverrides(rows);

  return NextResponse.json({
    ok: true,
    instrumentKey,
    instrument,
    units,
    effectiveDate,
  });
}
