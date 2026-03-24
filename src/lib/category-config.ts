export const CATEGORY_LABELS: Record<string, string> = {
  salary: "Salary",
  bonus_cashback: "Cashback & bonuses",
  interest_dividend: "Interest & dividends",
  refund: "Refunds",
  groceries: "Groceries",
  dining: "Restaurants & takeaway",
  bars_cafes: "Bars & cafes",
  transport: "Transport",
  travel: "Travel",
  shopping: "Shopping",
  subscriptions: "Subscriptions",
  software_ai: "AI & software",
  education: "Education",
  health: "Health",
  housing: "Housing",
  utilities: "Utilities",
  telecom: "Phone & internet",
  entertainment: "Entertainment",
  gifts: "Gifts",
  fees: "Fees",
  internal_transfer: "Own-account transfers",
  peer_transfer: "Transfers with other people",
  investing: "Investing",
  crypto: "Crypto",
  taxes: "Taxes",
  other: "Other",
};

export const GROUP_LABELS: Record<string, string> = {
  income: "In",
  expense: "Out",
  transfer: "Transfer",
  investment: "Money invested",
  tax: "Tax",
  other: "Other",
};

export const BUCKET_LABELS: Record<string, string> = {
  income: "In",
  fixed_cost: "Recurring bills",
  variable_cost: "Flexible spending",
  investing: "Investing",
  transfer: "Transfers",
  tax: "Taxes",
  other: "Other",
};

export const SOURCE_LABELS: Record<string, string> = {
  row_override: "Row override",
  manual_rule: "Manual rule",
  rule: "Built-in rule",
  llm: "Local AI model",
  fallback: "Fallback",
};

export const FIXED_COST_CATEGORIES = new Set([
  "education",
  "health",
  "housing",
  "subscriptions",
  "telecom",
  "utilities",
]);

export const CATEGORY_GROUP_MAP: Record<string, string> = {
  salary: "income",
  bonus_cashback: "income",
  interest_dividend: "income",
  refund: "income",
  groceries: "expense",
  dining: "expense",
  bars_cafes: "expense",
  transport: "expense",
  travel: "expense",
  shopping: "expense",
  subscriptions: "expense",
  software_ai: "expense",
  education: "expense",
  health: "expense",
  housing: "expense",
  utilities: "expense",
  telecom: "expense",
  entertainment: "expense",
  gifts: "expense",
  fees: "expense",
  internal_transfer: "transfer",
  peer_transfer: "transfer",
  investing: "investment",
  crypto: "investment",
  taxes: "tax",
  other: "other",
};

export const CATEGORY_THEME: Record<string, { solid: string; soft: string; text: string }> = {
  salary: { solid: "#22c55e", soft: "rgba(34, 197, 94, 0.14)", text: "#8ef0b1" },
  bonus_cashback: { solid: "#14b8a6", soft: "rgba(20, 184, 166, 0.14)", text: "#7de9de" },
  interest_dividend: { solid: "#eab308", soft: "rgba(234, 179, 8, 0.14)", text: "#f6da74" },
  refund: { solid: "#38bdf8", soft: "rgba(56, 189, 248, 0.14)", text: "#8bdcff" },
  groceries: { solid: "#84cc16", soft: "rgba(132, 204, 22, 0.14)", text: "#b8ef62" },
  dining: { solid: "#f97316", soft: "rgba(249, 115, 22, 0.14)", text: "#ffb07d" },
  bars_cafes: { solid: "#fb7185", soft: "rgba(251, 113, 133, 0.14)", text: "#ffacb7" },
  transport: { solid: "#3b82f6", soft: "rgba(59, 130, 246, 0.14)", text: "#8fbaff" },
  travel: { solid: "#06b6d4", soft: "rgba(6, 182, 212, 0.14)", text: "#86f3ff" },
  shopping: { solid: "#a855f7", soft: "rgba(168, 85, 247, 0.14)", text: "#d6a8ff" },
  subscriptions: { solid: "#f43f5e", soft: "rgba(244, 63, 94, 0.14)", text: "#ffa1b1" },
  software_ai: { solid: "#8b5cf6", soft: "rgba(139, 92, 246, 0.14)", text: "#c8b2ff" },
  education: { solid: "#f59e0b", soft: "rgba(245, 158, 11, 0.14)", text: "#ffd17a" },
  health: { solid: "#10b981", soft: "rgba(16, 185, 129, 0.14)", text: "#86f0c7" },
  housing: { solid: "#60a5fa", soft: "rgba(96, 165, 250, 0.14)", text: "#b5d4ff" },
  utilities: { solid: "#0ea5e9", soft: "rgba(14, 165, 233, 0.14)", text: "#8fdcff" },
  telecom: { solid: "#6366f1", soft: "rgba(99, 102, 241, 0.14)", text: "#afb1ff" },
  entertainment: { solid: "#ec4899", soft: "rgba(236, 72, 153, 0.14)", text: "#ff9acd" },
  gifts: { solid: "#ef4444", soft: "rgba(239, 68, 68, 0.14)", text: "#ffaca9" },
  fees: { solid: "#f97316", soft: "rgba(249, 115, 22, 0.14)", text: "#ffb07d" },
  internal_transfer: { solid: "#64748b", soft: "rgba(100, 116, 139, 0.14)", text: "#c7d1de" },
  peer_transfer: { solid: "#94a3b8", soft: "rgba(148, 163, 184, 0.14)", text: "#d6dfea" },
  investing: { solid: "#14b8a6", soft: "rgba(20, 184, 166, 0.14)", text: "#7de9de" },
  crypto: { solid: "#f97316", soft: "rgba(249, 115, 22, 0.14)", text: "#ffb07d" },
  taxes: { solid: "#ef4444", soft: "rgba(239, 68, 68, 0.14)", text: "#ffaca9" },
  other: { solid: "#94a3b8", soft: "rgba(148, 163, 184, 0.14)", text: "#d6dfea" },
};

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? humanize(category);
}

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? humanize(group);
}

export function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? humanize(bucket);
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanize(source);
}

export function deriveGroupFromCategory(category: string): string {
  return CATEGORY_GROUP_MAP[category] ?? "other";
}

export function deriveCashflowBucket(group: string, category: string): string {
  if (group === "income") {
    return "income";
  }
  if (group === "expense") {
    return FIXED_COST_CATEGORIES.has(category) ? "fixed_cost" : "variable_cost";
  }
  if (group === "transfer") {
    return "transfer";
  }
  if (group === "investment") {
    return "investing";
  }
  if (group === "tax") {
    return "tax";
  }
  return "other";
}

export function buildCategoryOptions() {
  return Object.entries(CATEGORY_LABELS)
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export type CategoryOption = {
  value: string;
  label: string;
};

export type CategoryOptionGroup = {
  label: string;
  options: CategoryOption[];
};

function sortCategoryOptions(values: string[]): CategoryOption[] {
  return values
    .filter((value, index, array) => CATEGORY_LABELS[value] && array.indexOf(value) === index)
    .map((value) => ({ value, label: CATEGORY_LABELS[value] }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function buildCategoryOptionGroupsForAmount(amount?: number, currentCategory?: string): CategoryOptionGroup[] {
  const incomeCategories = ["salary", "bonus_cashback", "interest_dividend", "refund"];
  const expenseCategories = [
    "groceries",
    "dining",
    "bars_cafes",
    "transport",
    "travel",
    "shopping",
    "subscriptions",
    "software_ai",
    "education",
    "health",
    "housing",
    "utilities",
    "telecom",
    "entertainment",
    "gifts",
    "fees",
  ];
  const transferCategories = ["internal_transfer", "peer_transfer"];
  const investmentCategories = ["investing", "crypto"];
  const specialCategories = ["taxes", "other"];

  let groups: CategoryOptionGroup[];

  if (!Number.isFinite(amount ?? Number.NaN) || amount === 0) {
    groups = [
      { label: "In", options: sortCategoryOptions(incomeCategories) },
      { label: "Money out", options: sortCategoryOptions(expenseCategories) },
      { label: "Transfers", options: sortCategoryOptions(transferCategories) },
      { label: "Investing", options: sortCategoryOptions(investmentCategories) },
      { label: "Special", options: sortCategoryOptions(specialCategories) },
    ];
  } else if ((amount ?? 0) > 0) {
    groups = [
      { label: "Money in", options: sortCategoryOptions(incomeCategories) },
      { label: "Transfers", options: sortCategoryOptions(transferCategories) },
      { label: "Investing", options: sortCategoryOptions(investmentCategories) },
      { label: "Special", options: sortCategoryOptions(specialCategories) },
    ];
  } else {
    groups = [
      { label: "Money out", options: sortCategoryOptions(expenseCategories) },
      { label: "Transfers", options: sortCategoryOptions(transferCategories) },
      { label: "Investing", options: sortCategoryOptions(investmentCategories) },
      { label: "Special", options: sortCategoryOptions(specialCategories) },
    ];
  }

  const alreadyIncluded = new Set(groups.flatMap((group) => group.options.map((option) => option.value)));
  if (currentCategory && CATEGORY_LABELS[currentCategory] && !alreadyIncluded.has(currentCategory)) {
    groups = [
      {
        label: "Current",
        options: sortCategoryOptions([currentCategory]),
      },
      ...groups,
    ];
  }

  return groups.filter((group) => group.options.length > 0);
}
