import { NextResponse } from "next/server";
import { deriveGroupFromCategory } from "@/lib/category-config";
import { loadBaseDashboardData } from "@/lib/dashboard-data";
import { loadManualRules, saveManualRules, type ManualRuleRecord } from "@/lib/config-store";
import { matchesManualRule } from "@/lib/rule-matching";

export const runtime = "nodejs";

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeRule(input: Partial<ManualRuleRecord>): ManualRuleRecord {
  const category = String(input.category ?? "other").trim() || "other";
  const pattern = String(input.pattern ?? "").trim();
  const baseName = input.name ?? pattern ?? category;
  const name = String(baseName).trim() || category;
  return {
    id: String(input.id ?? `rule-${slug(name || pattern || category)}`),
    enabled: input.enabled ?? true,
    name,
    matchType: String(input.matchType ?? "contains").trim() || "contains",
    pattern,
    transactionType: String(input.transactionType ?? "").trim(),
    amountSign: String(input.amountSign ?? "").trim().toLowerCase(),
    merchant: String(input.merchant ?? "").trim(),
    group: String(input.group ?? deriveGroupFromCategory(category)).trim(),
    category,
    subcategory: String(input.subcategory ?? "manual_rule").trim(),
    confidence: Number(input.confidence ?? 0.99),
    needsReview: Boolean(input.needsReview),
  };
}

async function previewMatches(rule: ManualRuleRecord) {
  const data = await loadBaseDashboardData();
  return data.transactions.filter((row) => matchesManualRule(row, rule)).length;
}

export async function GET() {
  const rules = await loadManualRules();
  const data = await loadBaseDashboardData();
  return NextResponse.json({
    rules: rules.map((rule, index) => ({
      ...rule,
      order: index,
      matchCount: data.transactions.filter((row) => matchesManualRule(row, rule)).length,
    })),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    rule?: Partial<ManualRuleRecord>;
    previewOnly?: boolean;
  };
  const rule = normalizeRule(body.rule ?? {});
  if (!rule.pattern) {
    return NextResponse.json({ message: "Pattern is required." }, { status: 400 });
  }
  if (body.previewOnly) {
    return NextResponse.json({ rule, matchCount: await previewMatches(rule) });
  }

  const rules = await loadManualRules();
  const existingIndex = rules.findIndex((item) => item.id === rule.id);
  if (existingIndex >= 0) {
    rules[existingIndex] = rule;
  } else {
    rules.push(rule);
  }
  await saveManualRules(rules);
  return NextResponse.json({ ok: true, rules });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    action?: "toggle" | "move_up" | "move_down" | "duplicate";
  };
  const id = String(body.id ?? "");
  const action = body.action;
  if (!id || !action) {
    return NextResponse.json({ message: "Rule id and action are required." }, { status: 400 });
  }
  const rules = await loadManualRules();
  const index = rules.findIndex((rule) => rule.id === id);
  if (index < 0) {
    return NextResponse.json({ message: "Rule not found." }, { status: 404 });
  }

  if (action === "toggle") {
    rules[index] = { ...rules[index], enabled: !rules[index].enabled };
  } else if (action === "move_up" && index > 0) {
    [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
  } else if (action === "move_down" && index < rules.length - 1) {
    [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
  } else if (action === "duplicate") {
    const duplicate = {
      ...rules[index],
      id: `${rules[index].id}-copy-${Date.now()}`,
      name: `${rules[index].name} copy`,
    };
    rules.splice(index + 1, 0, duplicate);
  }

  await saveManualRules(rules);
  return NextResponse.json({ ok: true, rules });
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { id?: string };
  const id = String(body.id ?? "");
  if (!id) {
    return NextResponse.json({ message: "Rule id is required." }, { status: 400 });
  }
  const rules = (await loadManualRules()).filter((rule) => rule.id !== id);
  await saveManualRules(rules);
  return NextResponse.json({ ok: true, rules });
}
