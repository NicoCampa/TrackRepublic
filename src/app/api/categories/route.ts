import { NextResponse } from "next/server";
import { categoryLabel, deriveGroupFromCategory, isKnownCategory, normalizeCategoryKey } from "@/lib/category-config";
import {
  loadManualRules,
  loadRowOverrides,
  saveManualRules,
  saveRowOverrides,
  type RowOverrideRecord,
} from "@/lib/config-store";

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
    signedAmount?: number;
    category?: string;
    mode?: "row" | "rule";
    matchType?: "exact" | "contains" | "regex";
  };

  const rowId = (body.rowId ?? "").trim();
  const description = (body.description ?? "").trim();
  const txType = (body.txType ?? "").trim();
  const category = normalizeCategoryKey(body.category ?? "");
  const signedAmount = Number(body.signedAmount ?? 0);
  const mode = body.mode ?? "row";

  if (!description || !isKnownCategory(category)) {
    return NextResponse.json({ message: "Invalid category change request." }, { status: 400 });
  }

  const group = deriveGroupFromCategory(category);

  if (mode === "row") {
    if (!rowId) {
      return NextResponse.json({ message: "Row id is required for row overrides." }, { status: 400 });
    }
    const overrides = await loadRowOverrides();
    const existingOverride = overrides.find((item) => item.rowId === rowId);
    const nextOverride: RowOverrideRecord = {
      rowId,
      description,
      transactionType: txType,
      signedAmount,
      category,
      assetClass: existingOverride?.assetClass ?? "",
      source: existingOverride?.source === "deleted_transaction" ? "row_override" : (existingOverride?.source ?? "row_override"),
      linkGroupId: existingOverride?.linkGroupId ?? "",
      linkRole: existingOverride?.linkRole ?? "",
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
      categoryLabel: categoryLabel(category),
      group,
    });
  }

  const rules = await loadManualRules();
  const sign = amountSign(signedAmount);
  const matchType = body.matchType ?? "exact";
  const nextRule = {
    id: `rule-${slug(`${category}-${description}`)}-${Date.now()}`,
    enabled: true,
    name: `UI ${matchType} ${description.slice(0, 24)}`.slice(0, 120),
    matchType,
    pattern: description,
    transactionType: txType,
    amountSign: sign,
    category,
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
    categoryLabel: categoryLabel(category),
    group,
  });
}
