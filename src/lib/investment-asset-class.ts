import type { AssetClass } from "./investment-positions";

export type EditableInvestmentAssetClass = Exclude<AssetClass, "bond_etf">;

export const EDITABLE_INVESTMENT_ASSET_CLASS_OPTIONS: Array<{
  value: EditableInvestmentAssetClass;
  label: string;
  note: string;
}> = [
  {
    value: "stock",
    label: "Stock",
    note: "Single-company shares and ADRs.",
  },
  {
    value: "bond",
    label: "Bond",
    note: "Government or corporate debt instruments.",
  },
  {
    value: "etf",
    label: "ETF",
    note: "Exchange-traded funds and similar listed baskets.",
  },
  {
    value: "crypto",
    label: "Crypto",
    note: "Direct cryptocurrency exposure.",
  },
  {
    value: "gold",
    label: "Gold",
    note: "Gold ETCs and other gold-linked holdings.",
  },
  {
    value: "private_market",
    label: "Private market",
    note: "Private equity, private credit, venture, and similar assets.",
  },
  {
    value: "other",
    label: "Other",
    note: "Use when none of the core investment types fits reliably.",
  },
];

const EDITABLE_INVESTMENT_ASSET_CLASS_SET = new Set<EditableInvestmentAssetClass>(
  EDITABLE_INVESTMENT_ASSET_CLASS_OPTIONS.map((option) => option.value),
);

const INVESTMENT_ASSET_CLASS_ALIASES: Record<string, EditableInvestmentAssetClass> = {
  commodity: "gold",
  commodities: "gold",
  gold: "gold",
  etf: "etf",
  etfs: "etf",
  bond_etf: "etf",
  bond_etfs: "etf",
  stock: "stock",
  stocks: "stock",
  equity: "stock",
  equities: "stock",
  bond: "bond",
  bonds: "bond",
  crypto: "crypto",
  cryptocurrency: "crypto",
  cryptocurrencies: "crypto",
  private_market: "private_market",
  private_markets: "private_market",
};

function normalizeInvestmentAssetClassToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeInvestmentAssetClass(value?: string): EditableInvestmentAssetClass | "" {
  const normalized = normalizeInvestmentAssetClassToken(value ?? "");
  if (!normalized) {
    return "";
  }
  const resolved = INVESTMENT_ASSET_CLASS_ALIASES[normalized] ?? normalized;
  if (EDITABLE_INVESTMENT_ASSET_CLASS_SET.has(resolved as EditableInvestmentAssetClass)) {
    return resolved as EditableInvestmentAssetClass;
  }
  return "other";
}

export function investmentAssetClassLabel(value?: string, emptyLabel = "Automatic") {
  const normalized = normalizeInvestmentAssetClass(value);
  switch (normalized) {
    case "stock":
      return "Stock";
    case "bond":
      return "Bond";
    case "etf":
      return "ETF";
    case "crypto":
      return "Crypto";
    case "gold":
      return "Gold";
    case "private_market":
      return "Private market";
    case "other":
      return "Other";
    default:
      return emptyLabel;
  }
}
