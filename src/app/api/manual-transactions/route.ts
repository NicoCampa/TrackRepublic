import { NextResponse } from "next/server";
import { CATEGORY_LABELS } from "@/lib/category-config";
import { loadManualTransactions, saveManualTransactions, type ManualTransactionRecord } from "@/lib/config-store";

export const runtime = "nodejs";

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function normalizeTransaction(input: Partial<ManualTransactionRecord>): ManualTransactionRecord {
  const date = String(input.date ?? "").trim();
  const merchant = String(input.merchant ?? "").trim();
  const description = String(input.description ?? "").trim();
  const category = String(input.category ?? "other").trim() || "other";
  const signedAmount = Number(input.signedAmount ?? 0);
  const txType = String(input.transactionType ?? "Manual").trim() || "Manual";
  const rowId =
    String(input.rowId ?? "").trim() ||
    `manual-${date || new Date().toISOString().slice(0, 10)}-${slug(merchant || description || category)}-${Date.now()}`;

  return {
    rowId,
    date,
    transactionType: txType,
    merchant: merchant || "Manual entry",
    description: description || merchant || "Manual entry",
    signedAmount,
    category,
    subcategory: String(input.subcategory ?? "manual_entry").trim() || "manual_entry",
    updatedAt: String(input.updatedAt ?? new Date().toISOString()),
  };
}

export async function GET() {
  const transactions = await loadManualTransactions();
  return NextResponse.json({ transactions });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    transaction?: Partial<ManualTransactionRecord>;
    transactions?: Partial<ManualTransactionRecord>[];
  };

  const incoming = (body.transactions ?? (body.transaction ? [body.transaction] : [])).map(normalizeTransaction);
  if (
    incoming.length === 0 ||
    incoming.some(
      (item) =>
        !item.date ||
        !CATEGORY_LABELS[item.category] ||
        !Number.isFinite(item.signedAmount) ||
        item.signedAmount === 0,
    )
  ) {
    return NextResponse.json({ message: "A valid date, non-zero amount, and category are required." }, { status: 400 });
  }

  const existing = await loadManualTransactions();
  const byRowId = new Map(existing.map((item) => [item.rowId, item]));
  for (const item of incoming) {
    byRowId.set(item.rowId, item);
  }

  const transactions = [...byRowId.values()].sort((left, right) =>
    `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`),
  );
  await saveManualTransactions(transactions);
  return NextResponse.json({ ok: true, transactions });
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { rowId?: string; rowIds?: string[] };
  const rowIds = body.rowIds ?? (body.rowId ? [body.rowId] : []);
  if (rowIds.length === 0) {
    return NextResponse.json({ message: "At least one rowId is required." }, { status: 400 });
  }

  const removeSet = new Set(rowIds.map((rowId) => String(rowId)));
  const transactions = (await loadManualTransactions()).filter((item) => !removeSet.has(item.rowId));
  await saveManualTransactions(transactions);
  return NextResponse.json({ ok: true, transactions });
}
