import type { ManualRuleRecord } from "./config-store";

export type RuleMatchableRow = {
  txType: string;
  description: string;
  signedAmount: number;
};

export function normalizeDescriptionForRuleMatch(value: string): string {
  const original = value.toUpperCase().replace(/\s+/g, " ").trim();
  let normalized = original;
  normalized = normalized.replace(/,\s*EXCHANGE RATE:.*$/g, "");
  normalized = normalized.replace(/,\s*ECB RATE:.*$/g, "");
  normalized = normalized.replace(/,\s*MARKUP:.*$/g, "");
  normalized = normalized.replace(/\([A-Z0-9]{10,}\)/g, "");
  normalized = normalized.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/g, "<ACCOUNT>");
  normalized = normalized.replace(/\b[A-Z0-9*:/._-]*\d[A-Z0-9*:/._-]{5,}\b/g, "");
  normalized = normalized.replace(/\s+/g, " ").trim().replace(/^[,\-\s]+|[,\-\s]+$/g, "");
  return normalized || original;
}

export function amountSign(value: number): string {
  if (value > 0) {
    return "income";
  }
  if (value < 0) {
    return "expense";
  }
  return "zero";
}

export function matchesManualRule(row: RuleMatchableRow, rule: ManualRuleRecord): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.transactionType && rule.transactionType !== row.txType) {
    return false;
  }
  if (rule.amountSign && rule.amountSign !== amountSign(row.signedAmount)) {
    return false;
  }

  if (rule.matchType === "regex") {
    try {
      return new RegExp(rule.pattern, "i").test(row.description);
    } catch {
      return false;
    }
  }

  if (rule.matchType === "exact") {
    return normalizeDescriptionForRuleMatch(rule.pattern) === normalizeDescriptionForRuleMatch(row.description);
  }

  return row.description.toUpperCase().includes(rule.pattern.toUpperCase());
}
