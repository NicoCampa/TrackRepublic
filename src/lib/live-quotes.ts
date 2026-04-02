import YahooFinance from "yahoo-finance2";
import type { TransactionRecord } from "./dashboard-data";
import {
  buildQuoteUniverse,
  extractInvestmentTrades,
  resolveInstrument,
  type InstrumentRegistryLookup,
  type HistoricalUnitEstimate,
  type InvestmentInstrument,
  type LiveQuote,
} from "./investment-positions";

async function quietYahooFetch(input: URL | RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status >= 400) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const error = new Error(`Yahoo Finance HTTP ${response.status} for ${url}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response;
}

const yahooFinance = new YahooFinance({
  suppressNotices: ["ripHistorical", "yahooSurvey"],
  fetch: quietYahooFetch,
});

const quoteCache = new Map<string, Promise<LiveQuote | null>>();
const searchCache = new Map<string, Promise<Partial<LiveQuote> | null>>();
const fxCache = new Map<string, Promise<number | null>>();
const historicalSeriesCache = new Map<string, Promise<Map<string, number>>>();
const metadataCache = new Map<string, Promise<{ country: string; industry: string; sector: string }>>();

function normalizePrice(rawPrice: number, currency: string) {
  if (currency === "GBp") {
    return {
      price: rawPrice / 100,
      currency: "GBP",
    };
  }
  return {
    price: rawPrice,
    currency,
  };
}

function normalizeInstrumentPrice(price: number, instrument: InvestmentInstrument) {
  if (instrument.priceScale === "percent_of_par") {
    return price / 100;
  }
  return price;
}

async function currentFxRate(currency: string): Promise<number> {
  if (!currency || currency === "EUR") {
    return 1;
  }

  const cacheKey = currency.toUpperCase();
  if (!fxCache.has(cacheKey)) {
    fxCache.set(
      cacheKey,
      (async () => {
        try {
          const pair = await yahooFinance.quote(`${cacheKey}EUR=X`);
          const rate = Number(pair.regularMarketPrice ?? 0);
          return Number.isFinite(rate) && rate > 0 ? rate : null;
        } catch {
          try {
            const inverse = await yahooFinance.quote(`EUR${cacheKey}=X`);
            const rate = Number(inverse.regularMarketPrice ?? 0);
            return Number.isFinite(rate) && rate > 0 ? 1 / rate : null;
          } catch {
            return null;
          }
        }
      })(),
    );
  }

  return (await fxCache.get(cacheKey)) ?? 1;
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function isFinitePrice(value: number) {
  return Number.isFinite(value) && value > 0;
}

async function resolveInstrumentQuote(instrument: InvestmentInstrument): Promise<LiveQuote | null> {
  const cacheKey = instrument.key;
  if (!quoteCache.has(cacheKey)) {
    quoteCache.set(
      cacheKey,
      (async () => {
        const hinted = instrument.symbolHint
          ? await quoteFromSymbol(instrument, instrument.symbolHint)
          : null;
        if (hinted) {
          return hinted;
        }

        const searched = await resolveBySearch(instrument);
        if (!searched?.symbol) {
          return null;
        }
        return quoteFromSymbol(instrument, searched.symbol, searched.quoteName, searched.exchange);
      })(),
    );
  }

  return quoteCache.get(cacheKey) ?? Promise.resolve(null);
}

async function quoteFromSymbol(
  instrument: InvestmentInstrument,
  symbol: string,
  resolvedName?: string,
  resolvedExchange?: string,
): Promise<LiveQuote | null> {
  try {
    const [quote, metadata] = await Promise.all([
      yahooFinance.quote(symbol),
      resolveInstrumentMetadata(instrument, symbol),
    ]);
    const marketPrice = Number(quote.regularMarketPrice ?? 0);
    if (!isFinitePrice(marketPrice)) {
      return null;
    }

    const normalized = normalizePrice(marketPrice, String(quote.currency ?? ""));
    const fxRate = await currentFxRate(normalized.currency);
    const price = normalizeInstrumentPrice(normalized.price, instrument);
    const priceEur = price * fxRate;

    return {
      instrumentKey: instrument.key,
      isin: instrument.isin,
      instrument: instrument.instrument,
      assetClass: instrument.assetClass,
      priceScale: instrument.priceScale,
      country: metadata.country,
      industry: metadata.industry,
      sector: metadata.sector,
      symbol,
      quoteName: resolvedName ?? String(quote.longName ?? quote.shortName ?? instrument.instrument),
      currency: normalized.currency || "EUR",
      price,
      priceEur,
      asOf: asIsoString(quote.regularMarketTime),
      exchange: resolvedExchange ?? String(quote.fullExchangeName ?? quote.exchange ?? ""),
    };
  } catch {
    return null;
  }
}

async function resolveBySearch(instrument: InvestmentInstrument): Promise<Partial<LiveQuote> | null> {
  if (instrument.quoteSearchMode === "disabled") {
    return null;
  }
  const cacheKey = `${instrument.quoteSearchMode}:${instrument.searchQuery}`;
  if (!searchCache.has(cacheKey)) {
    searchCache.set(
      cacheKey,
      (async () => {
        try {
          const result = await yahooFinance.search(instrument.searchQuery);
          const quotes = Array.isArray((result as { quotes?: unknown[] }).quotes)
            ? ((result as { quotes?: Record<string, unknown>[] }).quotes ?? [])
            : [];
          const candidate = quotes.find((quote) => Boolean(quote.symbol)) ?? null;
          if (!candidate) {
            return null;
          }
          return {
            symbol: String(candidate.symbol),
            quoteName: String(candidate.longname ?? candidate.shortname ?? instrument.instrument),
            exchange: String(candidate.exchDisp ?? candidate.exchange ?? ""),
          };
        } catch {
          return null;
        }
      })(),
    );
  }

  return searchCache.get(cacheKey) ?? Promise.resolve(null);
}

function fallbackCountry(instrument: InvestmentInstrument): string {
  const name = instrument.instrument.toUpperCase();
  if (instrument.assetClass === "crypto") {
    return "Digital assets";
  }
  if (instrument.assetClass === "gold") {
    return "Global";
  }
  if (instrument.assetClass === "private_market") {
    return /EURO|EUROP/.test(name) ? "Europe" : /US|AMERICA/.test(name) ? "United States" : "Global";
  }
  if (instrument.assetClass === "bond" || instrument.assetClass === "bond_etf") {
    return /EURO|EUROP/.test(name) ? "Europe" : /US|TREASURY/.test(name) ? "United States" : "Global";
  }
  if (/ALL-WORLD/.test(name)) {
    return "Global";
  }
  if (/EUROPE 600|STOXX EUROPE 600/.test(name)) {
    return "Europe";
  }
  if (/S&P 500/.test(name)) {
    return "United States";
  }
  return instrument.assetClass === "etf" ? "Global" : "Other";
}

function fallbackIndustry(instrument: InvestmentInstrument): string {
  const name = instrument.instrument.toUpperCase();
  if (instrument.assetClass === "crypto") {
    return "Crypto";
  }
  if (instrument.assetClass === "gold") {
    return "Gold";
  }
  if (instrument.assetClass === "private_market") {
    return "Private market";
  }
  if (instrument.assetClass === "bond") {
    return "Bond";
  }
  if (instrument.assetClass === "bond_etf") {
    return "Bond ETF";
  }
  if (/ALL-WORLD/.test(name)) {
    return "Global equity ETF";
  }
  if (/EUROPE 600|STOXX EUROPE 600/.test(name)) {
    return "Europe equity ETF";
  }
  if (/S&P 500/.test(name)) {
    return "US equity ETF";
  }
  if (instrument.assetClass === "etf") {
    return "Equity ETF";
  }
  if (instrument.assetClass === "stock") {
    return "Stocks";
  }
  return "Other";
}

function fallbackSector(instrument: InvestmentInstrument): string {
  if (instrument.assetClass === "crypto") {
    return "Crypto";
  }
  if (instrument.assetClass === "gold") {
    return "Commodities";
  }
  if (instrument.assetClass === "private_market") {
    return "Private markets";
  }
  if (instrument.assetClass === "bond" || instrument.assetClass === "bond_etf") {
    return "Fixed income";
  }
  return fallbackIndustry(instrument);
}

async function resolveInstrumentMetadata(
  instrument: InvestmentInstrument,
  symbol: string,
): Promise<{ country: string; industry: string; sector: string }> {
  const cacheKey = `${instrument.key}:${symbol}`;
  if (!metadataCache.has(cacheKey)) {
    metadataCache.set(
      cacheKey,
      (async () => {
        const fallback = {
          country: fallbackCountry(instrument),
          industry: fallbackIndustry(instrument),
          sector: fallbackSector(instrument),
        };

        try {
          const summary = await yahooFinance.quoteSummary(symbol, {
            modules: ["assetProfile", "summaryProfile", "fundProfile"],
          });
          const assetProfile = (summary as { assetProfile?: Record<string, unknown> }).assetProfile ?? {};
          const fundProfile = (summary as { fundProfile?: Record<string, unknown> }).fundProfile ?? {};
          const country = String(assetProfile.country ?? "").trim() || fallback.country;
          const sector =
            String(assetProfile.sectorDisp ?? assetProfile.sector ?? fundProfile.categoryName ?? "").trim() || fallback.sector;
          const industry =
            String(assetProfile.industryDisp ?? assetProfile.industry ?? sector).trim() ||
            fallback.industry;

          return {
            country,
            industry,
            sector,
          };
        } catch {
          return fallback;
        }
      })(),
    );
  }

  return (await metadataCache.get(cacheKey)) ?? {
    country: fallbackCountry(instrument),
    industry: fallbackIndustry(instrument),
    sector: fallbackSector(instrument),
  };
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  return "";
}

function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function latestFxRateForDate(fxRates: Map<string, number>, date: string): number | null {
  let latestRate: number | null = null;
  for (const key of [...fxRates.keys()].sort()) {
    if (key > date) {
      break;
    }
    latestRate = fxRates.get(key) ?? latestRate;
  }
  return latestRate;
}

async function loadHistoricalEurSeries(
  instrument: InvestmentInstrument,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const cacheKey = `${instrument.key}:${symbol}:${startDate}:${endDate}`;
  if (!historicalSeriesCache.has(cacheKey)) {
    historicalSeriesCache.set(
      cacheKey,
      (async () => {
        try {
          const chart = await yahooFinance.chart(symbol, {
            period1: addDays(startDate, -5),
            period2: addDays(endDate, 5),
            interval: "1d",
          });
          const currency = String(chart.meta.currency ?? "EUR");
          const fxRates = new Map<string, number>();

          if (currency && currency !== "EUR") {
            const fxChart = await yahooFinance.chart(`${currency}EUR=X`, {
              period1: addDays(startDate, -8),
              period2: addDays(endDate, 5),
              interval: "1d",
            });
            for (const quote of fxChart.quotes ?? []) {
              const close = Number(quote.close ?? quote.adjclose ?? 0);
              const date = toIsoDate(quote.date);
              if (!date || !isFinitePrice(close)) {
                continue;
              }
              fxRates.set(date, close);
            }
          }

          const series = new Map<string, number>();
          for (const quote of chart.quotes ?? []) {
            const close = Number(quote.close ?? quote.adjclose ?? 0);
            const date = toIsoDate(quote.date);
            if (!date || !isFinitePrice(close)) {
              continue;
            }
            const normalized = normalizePrice(close, currency);
            const fxRate = normalized.currency === "EUR" ? 1 : latestFxRateForDate(fxRates, date);
            if (!fxRate || !Number.isFinite(fxRate) || fxRate <= 0) {
              continue;
            }
            series.set(date, normalizeInstrumentPrice(normalized.price, instrument) * fxRate);
          }

          return series;
        } catch {
          return new Map<string, number>();
        }
      })(),
    );
  }

  return (await historicalSeriesCache.get(cacheKey)) ?? new Map<string, number>();
}

function priceOnOrBefore(series: Map<string, number>, date: string): number | null {
  let latest: number | null = null;
  for (const key of [...series.keys()].sort()) {
    if (key > date) {
      break;
    }
    latest = series.get(key) ?? latest;
  }
  return latest;
}

export async function loadLiveQuotes(
  transactions: TransactionRecord[],
  registry: InstrumentRegistryLookup = {},
): Promise<LiveQuote[]> {
  const instruments = buildQuoteUniverse(transactions, registry);
  const quotes = await Promise.all(instruments.map((instrument) => resolveInstrumentQuote(instrument)));
  return quotes.filter((quote): quote is LiveQuote => Boolean(quote));
}

export async function loadHistoricalUnitEstimates(
  transactions: TransactionRecord[],
  liveQuotes: LiveQuote[],
  registry: InstrumentRegistryLookup = {},
): Promise<Record<string, HistoricalUnitEstimate>> {
  const parsedTrades = extractInvestmentTrades(transactions, registry);
  const trades = parsedTrades.filter(
    (trade) => trade.assetClass !== "private_market" && trade.units === null,
  );
  if (trades.length === 0) {
    return {};
  }

  const liveQuoteMap = new Map(liveQuotes.map((quote) => [quote.instrumentKey, quote]));
  const instrumentMap = new Map(
    parsedTrades.map((trade) => [
      trade.instrumentKey,
      resolveInstrument(trade.isin ? `${trade.isin} ${trade.instrument}` : trade.instrument, registry),
    ]),
  );
  const byInstrument = new Map<string, { symbol: string; startDate: string; endDate: string }>();
  for (const trade of trades) {
    const resolved = instrumentMap.get(trade.instrumentKey);
    const symbol = liveQuoteMap.get(trade.instrumentKey)?.symbol || resolved?.symbolHint;
    if (!symbol) {
      continue;
    }
    const current = byInstrument.get(trade.instrumentKey);
    if (!current) {
      byInstrument.set(trade.instrumentKey, {
        symbol,
        startDate: trade.date,
        endDate: trade.date,
      });
      continue;
    }
    if (trade.date < current.startDate) {
      current.startDate = trade.date;
    }
    if (trade.date > current.endDate) {
      current.endDate = trade.date;
    }
  }

  const priceSeriesEntries = await Promise.all(
    [...byInstrument.entries()].map(async ([instrumentKey, meta]) => [
      instrumentKey,
      await loadHistoricalEurSeries(
        instrumentMap.get(instrumentKey) ?? resolveInstrument(instrumentKey, registry),
        meta.symbol,
        meta.startDate,
        meta.endDate,
      ),
    ] as const),
  );
  const priceSeries = new Map(priceSeriesEntries);

  const estimates: Record<string, HistoricalUnitEstimate> = {};
  for (const trade of trades) {
    const series = priceSeries.get(trade.instrumentKey);
    const priceEur = series ? priceOnOrBefore(series, trade.date) : null;
    if (!priceEur || !Number.isFinite(priceEur) || priceEur <= 0) {
      continue;
    }
    estimates[trade.rowId] = {
      units: Math.abs(trade.signedAmount) / priceEur,
      method: "historical_price",
    };
  }

  return estimates;
}

export async function loadHistoricalCryptoUnitEstimates(
  transactions: TransactionRecord[],
  registry: InstrumentRegistryLookup = {},
): Promise<Record<string, HistoricalUnitEstimate>> {
  const liveQuotes = await loadLiveQuotes(transactions, registry);
  return loadHistoricalUnitEstimates(transactions, liveQuotes, registry);
}

export type HistoricalPriceSeries = Record<string, Record<string, number>>;

export function historicalPriceOnOrBefore(series: Record<string, number>, date: string): number | null {
  let latest: number | null = null;
  for (const key of Object.keys(series).sort()) {
    if (key > date) {
      break;
    }
    latest = series[key] ?? latest;
  }
  return latest;
}

export async function loadHistoricalMarketSeries(
  transactions: TransactionRecord[],
  liveQuotes: LiveQuote[],
  registry: InstrumentRegistryLookup = {},
): Promise<HistoricalPriceSeries> {
  const parsedTrades = extractInvestmentTrades(transactions, registry);
  const tradeRanges = new Map<string, { symbol: string; startDate: string; endDate: string }>();
  const quoteMap = new Map(liveQuotes.map((quote) => [quote.instrumentKey, quote]));
  const instrumentMap = new Map(
    parsedTrades.map((trade) => [
      trade.instrumentKey,
      resolveInstrument(trade.isin ? `${trade.isin} ${trade.instrument}` : trade.instrument, registry),
    ]),
  );

  for (const trade of parsedTrades) {
    const resolved = instrumentMap.get(trade.instrumentKey);
    const symbol = quoteMap.get(trade.instrumentKey)?.symbol || resolved?.symbolHint;
    if (!symbol) {
      continue;
    }
    const existing = tradeRanges.get(trade.instrumentKey);
    if (!existing) {
      tradeRanges.set(trade.instrumentKey, { symbol, startDate: trade.date, endDate: trade.date });
      continue;
    }
    if (trade.date < existing.startDate) {
      existing.startDate = trade.date;
    }
    if (trade.date > existing.endDate) {
      existing.endDate = trade.date;
    }
  }

  const output: HistoricalPriceSeries = {};
  await Promise.all(
    [...tradeRanges.entries()].map(async ([instrumentKey, range]) => {
      const resolved = instrumentMap.get(instrumentKey) ?? resolveInstrument(instrumentKey, registry);
      const series = await loadHistoricalEurSeries(resolved, range.symbol, range.startDate, range.endDate);
      output[instrumentKey] = Object.fromEntries([...series.entries()]);
    }),
  );
  return output;
}
