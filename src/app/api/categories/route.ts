import { NextResponse } from "next/server";
import { CATEGORY_LABELS, deriveGroupFromCategory } from "@/lib/category-config";
import { loadManualRules, loadRowOverrides, saveManualRules, saveRowOverrides } from "@/lib/config-store";

export const runtime = "nodejs";

function amountSign(value: number): string {
  if (value > 0) {
    return "income";
  }
  if (value < 0) {
    return "expense";
  }
  return "zero";
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    rowId?: string;
    description?: string;
    txType?: string;
    merchant?: string;
    signedAmount?: number;
    category?: string;
    mode?: "row" | "rule";
    matchType?: "exact" | "contains" | "regex";
    needsReview?: boolean;
  };

  const rowId = (body.rowId ?? "").trim();
  const description = (body.description ?? "").trim();
  const txType = (body.txType ?? "").trim();
  const merchant = (body.merchant ?? "").trim();
  const category = (body.category ?? "").trim();
  const signedAmount = Number(body.signedAmount ?? 0);
  const mode = body.mode ?? "row";

  if (!description || !category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ message: "Invalid category change request." }, { status: 400 });
  }

  const group = deriveGroupFromCategory(category);

  if (mode === "row") {
    if (!rowId) {
      return NextResponse.json({ message: "Row id is required for row overrides." }, { status: 400 });
    }
    const overrides = await loadRowOverrides();
    const nextOverride = {
      rowId,
      description,
      transactionType: txType,
      signedAmount,
      merchant: merchant || "Manual override",
      group,
      category,
      subcategory: "row_override",
      confidence: 0.99,
      needsReview: Boolean(body.needsReview),
      source: "row_override",
      updatedAt: new Date().toISOString(),
    };
    const existingIndex = overrides.findIndex((item) => item.rowId === rowId);
    if (existingIndex >= 0) {
      overrides[existingIndex] = nextOverride;
    } else {
      overrides.push(nextOverride);
    }
    await saveRowOverrides(overrides);
    return NextResponse.json({
      ok: true,
      mode,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      group,
    });
  }

  const rules = await loadManualRules();
  const sign = amountSign(signedAmount);
  const matchType = body.matchType ?? "exact";
  const nextRule = {
    id: `rule-${slug(`${category}-${merchant || description}`)}-${Date.now()}`,
    enabled: true,
    name: `UI ${matchType} ${merchant || description.slice(0, 24)}`.slice(0, 120),
    matchType,
    pattern: description,
    transactionType: txType,
    amountSign: sign,
    merchant: merchant || "Manual override",
    group,
    category,
    subcategory: "manual_override",
    confidence: 0.99,
    needsReview: Boolean(body.needsReview),
  };

  const existingIndex = rules.findIndex(
    (row) =>
      row.matchType === nextRule.matchType &&
      row.pattern === nextRule.pattern &&
      row.transactionType === nextRule.transactionType &&
      row.amountSign === nextRule.amountSign,
  );

  if (existingIndex >= 0) {
    rules[existingIndex] = { ...rules[existingIndex], ...nextRule, id: rules[existingIndex].id };
  } else {
    rules.push(nextRule);
  }

  await saveManualRules(rules);

  return NextResponse.json({
    ok: true,
    mode,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    group,
  });
}
