import { CATEGORY_THEME, categoryLabel } from "./category-config";
import type { TransactionRecord } from "./dashboard-data";

export type IncomeCategoryScopeProfile = {
  key: string;
  label: string;
  sourceLabel: string;
  index: number;
};

const SALARY_SCOPE_PREFIX = "salary_source:";
const SALARY_SCOPE_THEMES = [
  { solid: "#22c55e", soft: "rgba(34, 197, 94, 0.14)", text: "#8ef0b1" },
  { solid: "#16a34a", soft: "rgba(22, 163, 74, 0.14)", text: "#79e7a0" },
  { solid: "#4ade80", soft: "rgba(74, 222, 128, 0.14)", text: "#b5f6cb" },
  { solid: "#15803d", soft: "rgba(21, 128, 61, 0.14)", text: "#7ed9a2" },
];

function normalizeSalarySourceId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function resolveSalarySourceLabel(row: TransactionRecord) {
  return row.displayDescription || row.description || "Salary source";
}

export function isSyntheticIncomeCategoryScopeKey(scopeKey: string) {
  return scopeKey.startsWith(SALARY_SCOPE_PREFIX);
}

export function buildIncomeCategoryScopeProfiles(transactions: TransactionRecord[]) {
  const salaryTotals = new Map<string, { amount: number; sourceLabel: string }>();

  for (const row of transactions) {
    if (row.category !== "salary" || row.signedAmount <= 0) {
      continue;
    }

    const sourceLabel = resolveSalarySourceLabel(row);
    const sourceId = normalizeSalarySourceId(sourceLabel);
    const current = salaryTotals.get(sourceId) ?? { amount: 0, sourceLabel };
    current.amount += row.signedAmount;
    salaryTotals.set(sourceId, current);
  }

  return [...salaryTotals.entries()]
    .sort((left, right) => right[1].amount - left[1].amount || left[1].sourceLabel.localeCompare(right[1].sourceLabel))
    .map(([sourceId, value], index) => ({
      key: `${SALARY_SCOPE_PREFIX}${sourceId}`,
      label: index === 0 ? "Salary" : `Salary ${index + 1}`,
      sourceLabel: value.sourceLabel,
      index,
    })) satisfies IncomeCategoryScopeProfile[];
}

export function resolveIncomeCategoryScopeKeyForRow(
  row: TransactionRecord,
  profileMap: Map<string, IncomeCategoryScopeProfile>,
) {
  if (row.category === "salary" && row.signedAmount > 0) {
    const sourceKey = `${SALARY_SCOPE_PREFIX}${normalizeSalarySourceId(resolveSalarySourceLabel(row))}`;
    return profileMap.has(sourceKey) ? sourceKey : row.category;
  }

  return row.category;
}

export function resolveIncomeCategoryScopeBaseKey(scopeKey: string) {
  return isSyntheticIncomeCategoryScopeKey(scopeKey) ? "salary" : scopeKey;
}

export function resolveIncomeCategoryScopeLabel(
  scopeKey: string,
  profileMap: Map<string, IncomeCategoryScopeProfile>,
) {
  return profileMap.get(scopeKey)?.label ?? categoryLabel(resolveIncomeCategoryScopeBaseKey(scopeKey));
}

export function resolveIncomeCategoryScopeMeta(
  scopeKey: string,
  profileMap: Map<string, IncomeCategoryScopeProfile>,
) {
  return profileMap.get(scopeKey)?.sourceLabel ?? categoryLabel(resolveIncomeCategoryScopeBaseKey(scopeKey));
}

export function resolveIncomeCategoryScopeTheme(
  scopeKey: string,
  profileMap: Map<string, IncomeCategoryScopeProfile>,
) {
  const profile = profileMap.get(scopeKey);
  if (profile) {
    return SALARY_SCOPE_THEMES[profile.index % SALARY_SCOPE_THEMES.length];
  }
  return CATEGORY_THEME[resolveIncomeCategoryScopeBaseKey(scopeKey)] ?? CATEGORY_THEME.other;
}

export function matchesIncomeCategoryScope(
  row: TransactionRecord,
  scopeKey: string,
  profileMap: Map<string, IncomeCategoryScopeProfile>,
) {
  return resolveIncomeCategoryScopeKeyForRow(row, profileMap) === scopeKey;
}
