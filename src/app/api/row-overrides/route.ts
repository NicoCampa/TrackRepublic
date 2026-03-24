import { NextResponse } from "next/server";
import { deriveGroupFromCategory } from "@/lib/category-config";
import { loadRowOverrides, saveRowOverrides, type RowOverrideRecord } from "@/lib/config-store";

export const runtime = "nodejs";

function normalizeOverride(input: Partial<RowOverrideRecord>): RowOverrideRecord {
  const category = String(input.category ?? "other").trim() || "other";
  return {
    rowId: String(input.rowId ?? "").trim(),
    description: String(input.description ?? "").trim(),
    transactionType: String(input.transactionType ?? "").trim(),
    signedAmount: Number(input.signedAmount ?? 0),
    merchant: String(input.merchant ?? "").trim(),
    group: String(input.group ?? deriveGroupFromCategory(category)).trim(),
    category,
    subcategory: String(input.subcategory ?? "row_override").trim(),
    confidence: Number(input.confidence ?? 0.99),
    needsReview: Boolean(input.needsReview),
    source: String(input.source ?? "row_override").trim() || "row_override",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export async function GET() {
  const overrides = await loadRowOverrides();
  return NextResponse.json({ overrides });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    overrides?: Partial<RowOverrideRecord>[];
    override?: Partial<RowOverrideRecord>;
  };

  const incoming = (body.overrides ?? (body.override ? [body.override] : [])).map(normalizeOverride);
  if (incoming.length === 0 || incoming.some((item) => !item.rowId)) {
    return NextResponse.json({ message: "At least one row override with a rowId is required." }, { status: 400 });
  }

  const existing = await loadRowOverrides();
  const byRowId = new Map(existing.map((item) => [item.rowId, item]));
  for (const item of incoming) {
    byRowId.set(item.rowId, item);
  }
  const overrides = [...byRowId.values()].sort((left, right) => left.rowId.localeCompare(right.rowId));
  await saveRowOverrides(overrides);
  return NextResponse.json({ ok: true, overrides });
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { rowIds?: string[]; rowId?: string };
  const rowIds = body.rowIds ?? (body.rowId ? [body.rowId] : []);
  if (rowIds.length === 0) {
    return NextResponse.json({ message: "At least one rowId is required." }, { status: 400 });
  }
  const removeSet = new Set(rowIds.map((rowId) => String(rowId)));
  const overrides = (await loadRowOverrides()).filter((item) => !removeSet.has(item.rowId));
  await saveRowOverrides(overrides);
  return NextResponse.json({ ok: true, overrides });
}
