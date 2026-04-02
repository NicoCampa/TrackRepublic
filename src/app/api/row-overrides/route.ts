import { NextResponse } from "next/server";
import { normalizeCategoryKey } from "@/lib/category-config";
import { normalizeInvestmentAssetClass } from "@/lib/investment-asset-class";
import { loadRowOverrides, saveRowOverrides, type RowOverrideRecord } from "@/lib/config-store";

export const runtime = "nodejs";

function hasMeaningfulOverride(override: RowOverrideRecord) {
  return (
    override.source === "deleted_transaction" ||
    Boolean(override.category || override.assetClass || override.linkGroupId || override.linkRole)
  );
}

function mergeOverride(
  input: Partial<RowOverrideRecord>,
  existing?: RowOverrideRecord,
): RowOverrideRecord | null {
  const rowId = String(input.rowId ?? existing?.rowId ?? "").trim();
  if (!rowId) {
    return null;
  }

  const category =
    input.category !== undefined ? normalizeCategoryKey(input.category ?? "") : (existing?.category ?? "");
  const assetClass =
    input.assetClass !== undefined
      ? normalizeInvestmentAssetClass(input.assetClass ?? "")
      : (existing?.assetClass ?? "");
  const source =
    input.source !== undefined
      ? (String(input.source ?? "").trim() || "row_override")
      : (existing?.source ?? "row_override");

  const merged: RowOverrideRecord = {
    rowId,
    description:
      input.description !== undefined
        ? String(input.description ?? "").trim()
        : (existing?.description ?? ""),
    transactionType:
      input.transactionType !== undefined
        ? String(input.transactionType ?? "").trim()
        : (existing?.transactionType ?? ""),
    signedAmount:
      input.signedAmount !== undefined
        ? Number(input.signedAmount ?? 0)
        : (existing?.signedAmount ?? 0),
    category,
    assetClass,
    source,
    linkGroupId:
      input.linkGroupId !== undefined
        ? String(input.linkGroupId ?? "").trim()
        : (existing?.linkGroupId ?? ""),
    linkRole:
      input.linkRole === "net" || input.linkRole === "member"
        ? input.linkRole
        : input.linkRole !== undefined
          ? ""
          : (existing?.linkRole ?? ""),
    updatedAt:
      input.updatedAt !== undefined
        ? String(input.updatedAt ?? "").trim() || new Date().toISOString()
        : new Date().toISOString(),
  };

  if (!hasMeaningfulOverride(merged)) {
    return null;
  }

  return merged;
}

function normalizeIncomingOverride(input: Partial<RowOverrideRecord>) {
  return {
    rowId: input.rowId !== undefined ? String(input.rowId ?? "").trim() : undefined,
    description: input.description !== undefined ? String(input.description ?? "").trim() : undefined,
    transactionType: input.transactionType !== undefined ? String(input.transactionType ?? "").trim() : undefined,
    signedAmount: input.signedAmount !== undefined ? Number(input.signedAmount ?? 0) : undefined,
    category: input.category !== undefined ? normalizeCategoryKey(input.category ?? "") : undefined,
    assetClass:
      input.assetClass !== undefined ? normalizeInvestmentAssetClass(input.assetClass ?? "") : undefined,
    source: input.source !== undefined ? String(input.source ?? "").trim() : undefined,
    linkGroupId: input.linkGroupId !== undefined ? String(input.linkGroupId ?? "").trim() : undefined,
    linkRole:
      input.linkRole === "net" || input.linkRole === "member"
        ? input.linkRole
        : input.linkRole !== undefined
          ? ""
          : undefined,
    updatedAt: input.updatedAt,
  } satisfies Partial<RowOverrideRecord>;
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

  const incoming = (body.overrides ?? (body.override ? [body.override] : [])).map(normalizeIncomingOverride);
  if (incoming.length === 0 || incoming.some((item) => !item.rowId)) {
    return NextResponse.json({ message: "At least one row override with a rowId is required." }, { status: 400 });
  }

  const existing = await loadRowOverrides();
  const byRowId = new Map(existing.map((item) => [item.rowId, item]));
  for (const item of incoming) {
    const merged = mergeOverride(item, byRowId.get(item.rowId ?? ""));
    if (merged) {
      byRowId.set(merged.rowId, merged);
    } else if (item.rowId) {
      byRowId.delete(item.rowId);
    }
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
