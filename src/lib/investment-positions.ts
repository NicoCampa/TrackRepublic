import type { CapitalPoint, TransactionRecord } from "./dashboard-data";

const ISIN_RE = /\b[A-Z0-9]{12}\b/;
const QUANTITY_RE = /quantity:\s*([0-9.]+)/i;

export type AssetClass = "crypto" | "etf" | "bond_etf" | "gold" | "stock" | "bond" | "private_market" | "other";
export type PriceScale = "absolute" | "percent_of_par";
export type ValuationSource = "live_quote" | "manual_price" | "statement_price" | "cost_basis";
export type FallbackValuation = Exclude<ValuationSource, "live_quote" | "manual_price">;
export type QuoteSearchMode = "broad" | "strict" | "disabled";

export type InstrumentRegistryLookup = Record<
  string,
  {
    key: string;
    isin?: string;
    symbol?: string;
    instrument?: string;
    assetClass?: string;
    priceScale?: string;
    fallbackValuation?: string;
    country?: string;
    sector?: string;
    industry?: string;
    lookthroughProvider?: string;
    searchQuery?: string;
  }
>;

type InstrumentAlias = {
  isin: string;
  instrument: string;
  symbolHint?: string;
  searchQuery?: string;
  assetClass?: AssetClass;
  priceScale?: PriceScale;
  fallbackValuation?: FallbackValuation;
};

const INSTRUMENT_ALIASES: Array<{ pattern: RegExp; alias: InstrumentAlias }> = [
  {
    pattern: /VANGUARD FTSE ALL-WORLD UCITS ETF/i,
    alias: {
      isin: "IE00BK5BQT80",
      instrument: "Vanguard FTSE All-World UCITS ETF",
      symbolHint: "IE00BK5BQT80.SG",
      searchQuery: "IE00BK5BQT80",
      assetClass: "etf",
    },
  },
  {
    pattern: /ISHARES PHYSICAL GOLD ETC/i,
    alias: {
      isin: "IE00B4ND3602",
      instrument: "iShares Physical Gold ETC",
      symbolHint: "SGLN.MI",
      searchQuery: "iShares Physical Gold ETC",
      assetClass: "gold",
    },
  },
  {
    pattern: /AMUNDI .* STOXX EUROPE 600/i,
    alias: {
      isin: "LU0908500753",
      instrument: "Amundi Core Stoxx Europe 600 UCITS ETF Acc",
      symbolHint: "MEUD.PA",
      searchQuery: "LU0908500753",
      assetClass: "etf",
    },
  },
  {
    pattern: /ISHARES CORE S&P 500 UCITS ETF/i,
    alias: {
      isin: "IE00B5BMR087",
      instrument: "iShares Core S&P 500 UCITS ETF USD (Acc)",
      symbolHint: "SXR8.DE",
      searchQuery: "IE00B5BMR087",
      assetClass: "etf",
    },
  },
  {
    pattern: /\bBITCOIN\b/i,
    alias: {
      isin: "XF000BTC0017",
      instrument: "Bitcoin",
      symbolHint: "BTC-USD",
      searchQuery: "Bitcoin",
      assetClass: "crypto",
    },
  },
  {
    pattern: /\bETH(?:EREUM)?\b/i,
    alias: {
      isin: "XF000ETH0019",
      instrument: "Ethereum",
      symbolHint: "ETH-USD",
      searchQuery: "Ethereum",
      assetClass: "crypto",
    },
  },
];

const MANUAL_ISIN_ALIASES: Record<string, InstrumentAlias> = {
  IE00BK5BQT80: {
    isin: "IE00BK5BQT80",
    instrument: "Vanguard FTSE All-World UCITS ETF",
    symbolHint: "IE00BK5BQT80.SG",
    searchQuery: "IE00BK5BQT80",
    assetClass: "etf",
  },
  IE00B4ND3602: {
    isin: "IE00B4ND3602",
    instrument: "iShares Physical Gold ETC",
    symbolHint: "SGLN.MI",
    searchQuery: "iShares Physical Gold ETC",
    assetClass: "gold",
  },
  LU0908500753: {
    isin: "LU0908500753",
    instrument: "Amundi Core Stoxx Europe 600 UCITS ETF Acc",
    symbolHint: "MEUD.PA",
    searchQuery: "LU0908500753",
    assetClass: "etf",
  },
  IE00B5BMR087: {
    isin: "IE00B5BMR087",
    instrument: "iShares Core S&P 500 UCITS ETF USD (Acc)",
    symbolHint: "SXR8.DE",
    searchQuery: "IE00B5BMR087",
    assetClass: "etf",
  },
  IE00B4L5Y983: {
    isin: "IE00B4L5Y983",
    instrument: "iShares Core MSCI World UCITS ETF USD (Acc)",
    symbolHint: "EUNL.DE",
    searchQuery: "IE00B4L5Y983",
    assetClass: "etf",
  },
  IE00B53SZB19: {
    isin: "IE00B53SZB19",
    instrument: "iShares Nasdaq 100 UCITS ETF USD (Acc)",
    symbolHint: "CNDX.L",
    searchQuery: "IE00B53SZB19",
    assetClass: "etf",
  },
  IE00B3WJKG14: {
    isin: "IE00B3WJKG14",
    instrument: "iShares S&P 500 Information Technology Sector UCITS ETF USD (Acc)",
    symbolHint: "IUIT.L",
    searchQuery: "IE00B3WJKG14",
    assetClass: "etf",
  },
  XF000BTC0017: {
    isin: "XF000BTC0017",
    instrument: "Bitcoin",
    symbolHint: "BTC-USD",
    searchQuery: "Bitcoin",
    assetClass: "crypto",
  },
  XF000ETH0019: {
    isin: "XF000ETH0019",
    instrument: "Ethereum",
    symbolHint: "ETH-USD",
    searchQuery: "Ethereum",
    assetClass: "crypto",
  },
  US0378331005: {
    isin: "US0378331005",
    instrument: "Apple",
    symbolHint: "AAPL",
    searchQuery: "US0378331005",
    assetClass: "stock",
  },
  US67066G1040: {
    isin: "US67066G1040",
    instrument: "NVIDIA",
    symbolHint: "NVDA",
    searchQuery: "US67066G1040",
    assetClass: "stock",
  },
  US0231351067: {
    isin: "US0231351067",
    instrument: "Amazon",
    symbolHint: "AMZN",
    searchQuery: "US0231351067",
    assetClass: "stock",
  },
  US0079031078: {
    isin: "US0079031078",
    instrument: "AMD",
    symbolHint: "AMD",
    searchQuery: "US0079031078",
    assetClass: "stock",
  },
  US30303M1027: {
    isin: "US30303M1027",
    instrument: "Meta",
    symbolHint: "META",
    searchQuery: "US30303M1027",
    assetClass: "stock",
  },
  US64110L1061: {
    isin: "US64110L1061",
    instrument: "Netflix",
    symbolHint: "NFLX",
    searchQuery: "US64110L1061",
    assetClass: "stock",
  },
  US90353T1007: {
    isin: "US90353T1007",
    instrument: "Uber",
    symbolHint: "UBER",
    searchQuery: "US90353T1007",
    assetClass: "stock",
  },
  US33813J1060: {
    isin: "US33813J1060",
    instrument: "Fisker",
    symbolHint: "FSR",
    searchQuery: "US33813J1060",
    assetClass: "stock",
  },
};

export type InvestmentInstrument = {
  key: string;
  isin: string;
  instrument: string;
  symbolHint?: string;
  searchQuery: string;
  assetClass: AssetClass;
  priceScale: PriceScale;
  fallbackValuation: FallbackValuation;
  quoteSearchMode: QuoteSearchMode;
};

export type ParsedInvestmentTrade = {
  rowId: string;
  date: string;
  signedAmount: number;
  isin: string;
  instrumentKey: string;
  instrument: string;
  assetClass: AssetClass;
  priceScale: PriceScale;
  fallbackValuation: FallbackValuation;
  symbolHint?: string;
  searchQuery: string;
  quoteSearchMode: QuoteSearchMode;
  units: number | null;
};

export type LiveQuote = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  assetClass: AssetClass;
  priceScale: PriceScale;
  country: string;
  industry: string;
  sector?: string;
  symbol: string;
  quoteName: string;
  currency: string;
  price: number;
  priceEur: number;
  asOf: string;
  exchange: string;
};

export type PositionRecord = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  assetClass: AssetClass;
  priceScale: PriceScale;
  country: string;
  industry: string;
  sector?: string;
  symbol: string;
  units: number;
  unitsKnown: boolean;
  price: number;
  priceEur: number;
  quoteCurrency: string;
  marketValueEur: number;
  asOf: string;
  valuationSource: ValuationSource;
  valuationAsOf: string;
  rowsWithQuantity: number;
  rowsWithEstimatedUnits: number;
  rowsWithoutQuantity: number;
  manualUnitsOverride: boolean;
};

export type PositionSnapshot = {
  positionsAsOf: string;
  pricesAsOf: string;
  availableCash: number;
  investmentsMarketValue: number;
  totalMarketValue: number;
  positions: PositionRecord[];
  unresolvedRows: number;
};

export type HistoricalUnitEstimate = {
  units: number;
  method: "historical_price";
};

export type PositionUnitOverride = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  units: number;
  effectiveDate: string;
  updatedAt: string;
};

export type PositionValuationOverride = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  priceEur: number;
  effectiveDate: string;
  updatedAt: string;
};

export type PositionUnitOverridesByInstrument = Record<string, PositionUnitOverride[]>;
export type PositionValuationOverridesByInstrument = Record<string, PositionValuationOverride[]>;

function normalizeAssetClass(value?: string): AssetClass {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "commodity" || normalized === "gold") {
    return "gold";
  }
  if (normalized === "bond_etf") {
    return "bond_etf";
  }
  if (
    normalized === "crypto" ||
    normalized === "etf" ||
    normalized === "stock" ||
    normalized === "bond" ||
    normalized === "private_market"
  ) {
    return normalized;
  }
  return "other";
}

function applyPreferredAssetClass(
  instrument: InvestmentInstrument,
  preferredAssetClass: AssetClass,
): InvestmentInstrument {
  if (preferredAssetClass === "other" || preferredAssetClass === instrument.assetClass) {
    return instrument;
  }

  let quoteSearchMode: QuoteSearchMode = "broad";
  if (preferredAssetClass === "private_market") {
    quoteSearchMode = instrument.searchQuery || instrument.isin ? "strict" : "disabled";
  } else if (preferredAssetClass === "bond") {
    quoteSearchMode = instrument.searchQuery || instrument.isin ? "strict" : "disabled";
  }

  return {
    ...instrument,
    assetClass: preferredAssetClass,
    priceScale: defaultPriceScale(preferredAssetClass),
    fallbackValuation: defaultFallbackValuation(preferredAssetClass),
    quoteSearchMode,
  };
}

function normalizePriceScale(value?: string): PriceScale | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "absolute" || normalized === "percent_of_par") {
    return normalized;
  }
  return undefined;
}

function normalizeFallbackValuation(value?: string): FallbackValuation | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "statement_price" || normalized === "cost_basis") {
    return normalized;
  }
  return undefined;
}

function defaultPriceScale(assetClass: AssetClass): PriceScale {
  return assetClass === "bond" ? "percent_of_par" : "absolute";
}

function defaultFallbackValuation(assetClass: AssetClass): FallbackValuation {
  return assetClass === "private_market" ? "cost_basis" : "statement_price";
}

function inferAssetClass(description: string, instrument: string): AssetClass {
  const text = `${description} ${instrument}`.toUpperCase();
  const sovereignBondStyle =
    /\b(FRANKREICH|FRANCE|DEUTSCHLAND|GERMANY|BUND|ITALIEN|ITALY|SPANIEN|SPAIN|PORTUGAL|BELGIEN|BELGIUM|NIEDERLANDE|NETHERLANDS|ÖSTERREICH|AUSTRIA|TREASURY)\b/.test(
      text,
    ) && /\b\d{2}\/\d{2}\b/.test(text);
  if (/\bBITCOIN\b|\bETH(?:EREUM)?\b|XF000BTC0017|XF000ETH0019/.test(text)) {
    return "crypto";
  }
  if (/GOLD ETC|PHYSICAL GOLD/.test(text)) {
    return "gold";
  }
  if (
    /PRIVATE\s+MARKET|PRIVATE\s+EQUITY|PRIVATE\s+CREDIT|PRIVATE\s+DEBT|VENTURE\s+CAPITAL|VENTURE\b|SECONDAR(?:Y|IES)|INFRASTRUCTURE\s+FUND|ELTIF|GROWTH\s+EQUITY|BUYOUT|PRIVATE\s+ASSETS/.test(
      text,
    )
  ) {
    return "private_market";
  }
  if (
    sovereignBondStyle ||
    /BOND|BONDS|TREASURY|ANLEIHE|ANLEIHEN|CORP(?:ORATE)?\.?\s*BOND|GOVT|GOVERNMENT|FIXED INCOME|NOTE\b|NOTES\b|DEBENTURE|SCHULDVERSCHREIBUNG|RENTE\b|OBLIGATION|OBLIGATIONS/.test(
      text,
    )
  ) {
    return /ETF|UCITS|ISHARES|VANGUARD|AMUNDI/.test(text) ? "bond_etf" : "bond";
  }
  if (/ETF|UCITS|ISHARES|VANGUARD|AMUNDI|MULTI UNITS|MSCI|NASDAQ/.test(text)) {
    return "etf";
  }
  if (/[A-Z]/.test(instrument)) {
    return "stock";
  }
  return "other";
}

function cleanInstrumentName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[-,\s]+|[-,\s]+$/g, "")
    .trim();
}

function extractInstrumentName(description: string, isin: string): string {
  let text = description;
  text = text.replace(/,\s*quantity:.*$/i, "");
  text = text.replace(
    /^(Buy trade|Sell trade|Savings plan execution|Ausführung Handel Direktkauf Kauf|Ausführung Handel Direktverkauf Verkauf|Ausführung Direktkauf|Ausführung Direktverkauf|Ertrag|Dividend)\s+/i,
    "",
  );
  if (isin) {
    text = text.replace(isin, "");
  }
  text = text.replace(/\bC\d{8,}\b/g, "");
  text = text.replace(/\b\d{10,}\b/g, "");
  text = text.replace(/\bKW\b/g, "");
  text = text.replace(/\bDL[ -]?,?0*\.?\d+\b/g, "");
  return cleanInstrumentName(text);
}

function aliasFromDescription(description: string): InstrumentAlias | null {
  for (const entry of INSTRUMENT_ALIASES) {
    if (entry.pattern.test(description)) {
      return entry.alias;
    }
  }
  return null;
}

function registryAlias(
  description: string,
  detectedIsin: string,
  registry: InstrumentRegistryLookup,
): InstrumentAlias | null {
  if (detectedIsin && registry[detectedIsin]) {
    const hit = registry[detectedIsin];
    return {
      isin: hit.isin || detectedIsin,
      instrument: hit.instrument || extractInstrumentName(description, detectedIsin),
      symbolHint: hit.symbol || undefined,
      searchQuery: hit.searchQuery || hit.isin || hit.symbol || hit.instrument || detectedIsin,
      assetClass: normalizeAssetClass(hit.assetClass),
      priceScale: normalizePriceScale(hit.priceScale),
      fallbackValuation: normalizeFallbackValuation(hit.fallbackValuation),
    };
  }

  const extracted = extractInstrumentName(description, detectedIsin);
  const candidates = [extracted, extracted.toUpperCase()].filter(Boolean);
  for (const candidate of candidates) {
    const hit = registry[candidate];
    if (!hit) {
      continue;
    }
    return {
      isin: hit.isin || detectedIsin,
      instrument: hit.instrument || extracted,
      symbolHint: hit.symbol || undefined,
      searchQuery: hit.searchQuery || hit.isin || hit.symbol || hit.instrument || candidate,
      assetClass: normalizeAssetClass(hit.assetClass),
      priceScale: normalizePriceScale(hit.priceScale),
      fallbackValuation: normalizeFallbackValuation(hit.fallbackValuation),
    };
  }

  return null;
}

export function resolveInstrument(description: string, registry: InstrumentRegistryLookup = {}): InvestmentInstrument {
  const isinMatch = description.match(ISIN_RE);
  const detectedIsin = isinMatch?.[0] ?? "";
  const registryMatch = registryAlias(description, detectedIsin, registry);
  const directAlias = detectedIsin ? MANUAL_ISIN_ALIASES[detectedIsin] : undefined;
  const descriptionAlias = aliasFromDescription(description);
  const alias = registryMatch ?? directAlias ?? descriptionAlias;
  const isin = alias?.isin ?? detectedIsin;
  const instrument = alias?.instrument ?? extractInstrumentName(description, detectedIsin);
  const key = registryMatch?.isin || registryMatch?.instrument || isin || instrument.toUpperCase();
  const assetClass = alias?.assetClass ?? inferAssetClass(description, instrument);
  const priceScale = alias?.priceScale ?? defaultPriceScale(assetClass);
  const fallbackValuation = alias?.fallbackValuation ?? defaultFallbackValuation(assetClass);

  let quoteSearchMode: QuoteSearchMode = "broad";
  if (assetClass === "private_market") {
    quoteSearchMode = registryMatch?.searchQuery || detectedIsin ? "strict" : "disabled";
  } else if (assetClass === "bond") {
    quoteSearchMode = alias?.searchQuery || detectedIsin ? "strict" : "disabled";
  }

  return {
    key,
    isin,
    instrument,
    symbolHint: alias?.symbolHint,
    searchQuery: alias?.searchQuery ?? isin ?? instrument,
    assetClass,
    priceScale,
    fallbackValuation,
    quoteSearchMode,
  };
}

export function resolveInstrumentFromParts(
  instrument: string,
  isin = "",
  registry: InstrumentRegistryLookup = {},
): InvestmentInstrument {
  return resolveInstrument(isin ? `${isin} ${instrument}` : instrument, registry);
}

export function extractInvestmentTrades(
  transactions: TransactionRecord[],
  registry: InstrumentRegistryLookup = {},
): ParsedInvestmentTrade[] {
  return transactions
    .filter((row) => row.group === "investment")
    .map((row) => {
      const preferredAssetClass = normalizeAssetClass(row.investmentAssetClass);
      const instrument = applyPreferredAssetClass(
        resolveInstrument(row.description, registry),
        preferredAssetClass,
      );
      const quantityMatch = row.description.match(QUANTITY_RE);
      return {
        rowId: row.rowId,
        date: row.date,
        signedAmount: row.signedAmount,
        isin: instrument.isin,
        instrumentKey: instrument.key,
        instrument: instrument.instrument,
        assetClass: instrument.assetClass,
        priceScale: instrument.priceScale,
        fallbackValuation: instrument.fallbackValuation,
        symbolHint: instrument.symbolHint,
        searchQuery: instrument.searchQuery,
        quoteSearchMode: instrument.quoteSearchMode,
        units: quantityMatch ? Number(quantityMatch[1]) : null,
      };
    });
}

export function buildQuoteUniverse(
  transactions: TransactionRecord[],
  registry: InstrumentRegistryLookup = {},
): InvestmentInstrument[] {
  const trades = extractInvestmentTrades(transactions, registry);
  const unique = new Map<string, InvestmentInstrument>();

  for (const trade of trades) {
    if (unique.has(trade.instrumentKey)) {
      continue;
    }
    const resolved = resolveInstrumentFromParts(trade.instrument, trade.isin, registry);
    unique.set(trade.instrumentKey, {
      key: trade.instrumentKey,
      isin: trade.isin,
      instrument: trade.instrument,
      symbolHint: trade.symbolHint ?? resolved.symbolHint,
      searchQuery: trade.searchQuery || resolved.searchQuery || trade.instrument || trade.isin,
      assetClass: trade.assetClass,
      priceScale: trade.priceScale,
      fallbackValuation: trade.fallbackValuation,
      quoteSearchMode: trade.quoteSearchMode,
    });
  }

  return [...unique.values()];
}

function findCapitalPoint(capitalSeries: CapitalPoint[], endDate: string): CapitalPoint | null {
  let latest: CapitalPoint | null = null;
  for (const point of capitalSeries) {
    if (point.date > endDate) {
      break;
    }
    latest = point;
  }
  return latest;
}

export function buildPositionSnapshot(
  transactions: TransactionRecord[],
  capitalSeries: CapitalPoint[],
  liveQuotes: LiveQuote[],
  endDate: string,
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate> = {},
  positionUnitOverrides: PositionUnitOverridesByInstrument = {},
  registry: InstrumentRegistryLookup = {},
): PositionSnapshot {
  const trades = extractInvestmentTrades(transactions, registry).filter((trade) => trade.date <= endDate);
  const quoteMap = new Map(liveQuotes.map((quote) => [quote.instrumentKey, quote]));
  const grouped = new Map<
    string,
    {
      isin: string;
      instrument: string;
      assetClass: AssetClass;
      units: number;
      rowsWithQuantity: number;
      rowsWithEstimatedUnits: number;
      rowsWithoutQuantity: number;
      manualUnitsOverride: boolean;
    }
  >();

  for (const trade of trades) {
    const bucket = grouped.get(trade.instrumentKey) ?? {
      isin: trade.isin,
      instrument: trade.instrument,
      assetClass: trade.assetClass,
      units: 0,
      rowsWithQuantity: 0,
      rowsWithEstimatedUnits: 0,
      rowsWithoutQuantity: 0,
      manualUnitsOverride: false,
    };

    if (trade.units === null) {
      const estimated = historicalUnitEstimates[trade.rowId];
      if (estimated && estimated.units > 0) {
        bucket.rowsWithEstimatedUnits += 1;
        bucket.units += trade.signedAmount < 0 ? estimated.units : -estimated.units;
      } else {
        bucket.rowsWithoutQuantity += 1;
      }
    } else {
      bucket.rowsWithQuantity += 1;
      bucket.units += trade.signedAmount < 0 ? trade.units : -trade.units;
    }

    grouped.set(trade.instrumentKey, bucket);
  }

  for (const [instrumentKey, bucket] of grouped.entries()) {
    const override = positionUnitOverrides[instrumentKey]
      ?.filter((item) => item.effectiveDate <= endDate)
      .sort((left, right) => `${left.effectiveDate}-${left.updatedAt}`.localeCompare(`${right.effectiveDate}-${right.updatedAt}`))
      .at(-1);
    if (!override) {
      continue;
    }
    bucket.units = override.units;
    bucket.manualUnitsOverride = true;
    bucket.rowsWithoutQuantity = 0;
    grouped.set(instrumentKey, bucket);
  }

  const positions: PositionRecord[] = [];
  for (const [instrumentKey, bucket] of grouped.entries()) {
    const quote = quoteMap.get(instrumentKey);
    if (!quote || bucket.units <= 0.0000001) {
      continue;
    }

    positions.push({
      instrumentKey,
      isin: bucket.isin,
      instrument: bucket.instrument,
      assetClass: quote.assetClass,
      priceScale: quote.priceScale,
      country: quote.country,
      industry: quote.industry,
      sector: quote.sector,
      symbol: quote.symbol,
      units: bucket.units,
      unitsKnown: true,
      price: quote.price,
      priceEur: quote.priceEur,
      quoteCurrency: quote.currency,
      marketValueEur: bucket.units * quote.priceEur,
      asOf: quote.asOf,
      valuationSource: "live_quote",
      valuationAsOf: quote.asOf,
      rowsWithQuantity: bucket.rowsWithQuantity,
      rowsWithEstimatedUnits: bucket.rowsWithEstimatedUnits,
      rowsWithoutQuantity: bucket.rowsWithoutQuantity,
      manualUnitsOverride: bucket.manualUnitsOverride,
    });
  }
  positions.sort((left, right) => right.marketValueEur - left.marketValueEur);

  const capitalPoint = findCapitalPoint(capitalSeries, endDate);
  const availableCash = capitalPoint?.availableCash ?? 0;
  const investmentsMarketValue = positions.reduce((sum, row) => sum + row.marketValueEur, 0);
  const pricesAsOf = positions.map((row) => row.asOf).sort().at(-1) ?? endDate;

  return {
    positionsAsOf: endDate,
    pricesAsOf,
    availableCash,
    investmentsMarketValue,
    totalMarketValue: availableCash + investmentsMarketValue,
    positions,
    unresolvedRows: [...grouped.values()].reduce((sum, row) => sum + (row.manualUnitsOverride ? 0 : row.rowsWithoutQuantity), 0),
  };
}
