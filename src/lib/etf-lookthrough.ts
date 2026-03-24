import { execFileSync } from "node:child_process";
import type { TransactionRecord } from "./dashboard-data";
import { extractInvestmentTrades, type InstrumentRegistryLookup } from "./investment-positions";
import { resolveRuntimeScript } from "./runtime-paths";

export type ExposureSlice = {
  name: string;
  share: number;
};

export type OfficialEtfExposure = {
  instrumentKey: string;
  instrument: string;
  asOf: string;
  source: string;
  countries: ExposureSlice[];
  sectors: ExposureSlice[];
  currencies: ExposureSlice[];
};

const VANGUARD_FACTSHEET_URL = "https://fund-docs.vanguard.com/FTSE_All-World_UCITS_ETF_USD_Accumulating_9679_EU_INT_EN.pdf";
const AMUNDI_FACTSHEET_URL = "https://www.amundietf.lu/pdfDocuments/monthly-factsheet/LU0908500753/ENG/LUX/INSTITUTIONNEL/ETF";

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type TimedPromise<T> = {
  loadedAt: number;
  promise: Promise<T>;
};

const pdfTextCache = new Map<string, TimedPromise<string>>();
const htmlTextCache = new Map<string, TimedPromise<string>>();
const exposureCache = new Map<string, TimedPromise<OfficialEtfExposure | null>>();

const ISHARES_PROVIDER_URLS: Record<string, { instrument: string; url: string }> = {
  ishares_core_msci_world: {
    instrument: "iShares Core MSCI World UCITS ETF USD (Acc)",
    url: "https://www.ishares.com/uk/individual/en/products/251882/ishares-msci-world-ucits-etf-acc-fund?shortLocale=en_GB&siteEntryPassthrough=true&switchLocale=y",
  },
  ishares_core_sp500: {
    instrument: "iShares Core S&P 500 UCITS ETF USD (Acc)",
    url: "https://www.ishares.com/uk/individual/en/products/253743/ishares-sp-500-b-ucits-etf-acc-fund_1_21?siteEntryPassthrough=true&switchLocale=y",
  },
  ishares_nasdaq_100: {
    instrument: "iShares Nasdaq 100 UCITS ETF USD (Acc)",
    url: "https://www.ishares.com/uk/individual/en/products/253741/ishares-nasdaq-100-ucits-etf?siteEntryPassthrough=true&switchLocale=y",
  },
  ishares_sp500_info_tech: {
    instrument: "iShares S&P 500 Information Technology Sector UCITS ETF USD (Acc)",
    url: "https://www.ishares.com/uk/individual/en/products/280510/ishares-sp-500-information-technology-sector-ucits-etf?siteEntryPassthrough=true&switchLocale=y",
  },
};

const VANGUARD_COUNTRIES = [
  "United States",
  "Japan",
  "United Kingdom",
  "China",
  "Canada",
  "Taiwan",
  "Switzerland",
  "Germany",
  "France",
  "Korea",
] as const;

const VANGUARD_SECTORS = [
  "Technology",
  "Financials",
  "Industrials",
  "Consumer Discretionary",
  "Health Care",
  "Consumer Staples",
  "Energy",
  "Basic Materials",
  "Telecommunications",
  "Utilities",
  "Real Estate",
] as const;

const AMUNDI_COUNTRIES = [
  "United Kingdom",
  "France",
  "Switzerland",
  "Germany",
  "Netherlands",
  "Spain",
  "Italy",
  "Sweden",
  "Denmark",
  "Finland",
  "Belgium",
  "Norway",
  "Poland",
  "Ireland",
  "Austria",
  "Others",
] as const;

const AMUNDI_SECTORS = [
  "Financials",
  "Industrials",
  "Health Care",
  "Consumer Staples",
  "Information Technology",
  "Consumer Discretionary",
  "Materials",
  "Utilities",
  "Energy",
  "Communication Services",
  "Real Estate",
] as const;

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  Austria: "EUR",
  Belgium: "EUR",
  Canada: "CAD",
  China: "CNY",
  Denmark: "DKK",
  Finland: "EUR",
  France: "EUR",
  Germany: "EUR",
  Ireland: "EUR",
  Italy: "EUR",
  Japan: "JPY",
  Korea: "KRW",
  Netherlands: "EUR",
  Norway: "NOK",
  Poland: "PLN",
  Spain: "EUR",
  Sweden: "SEK",
  Switzerland: "CHF",
  Taiwan: "TWD",
  "United Kingdom": "GBP",
  "United States": "USD",
  Others: "Other currencies",
  "Other countries": "Other currencies",
};

function normalizeWhitespace(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toIsoDate(value: string): string {
  const normalized = normalizeWhitespace(value);
  const shortMonthSlashMatch = normalized.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4})$/);
  if (shortMonthSlashMatch) {
    const monthMap: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };
    const month = monthMap[shortMonthSlashMatch[2]];
    if (month) {
      return `${shortMonthSlashMatch[3]}-${month}-${shortMonthSlashMatch[1]}`;
    }
  }
  const longMatch = normalized.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (longMatch) {
    const monthMap: Record<string, string> = {
      January: "01",
      February: "02",
      March: "03",
      April: "04",
      May: "05",
      June: "06",
      July: "07",
      August: "08",
      September: "09",
      October: "10",
      November: "11",
      December: "12",
    };
    const month = monthMap[longMatch[2]];
    if (month) {
      return `${longMatch[3]}-${month}-${longMatch[1].padStart(2, "0")}`;
    }
  }

  const slashMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2]}-${slashMatch[1]}`;
  }

  return normalized;
}

function roundShare(value: number) {
  return Math.round(value * 100) / 100;
}

function sumShares(slices: ExposureSlice[]) {
  return slices.reduce((sum, slice) => sum + slice.share, 0);
}

function addRemainderSlice(slices: ExposureSlice[], label: string) {
  const remainder = roundShare(100 - sumShares(slices));
  if (remainder > 0.1) {
    slices.push({ name: label, share: remainder });
  }
  return slices;
}

function parseLabelThenNumber(section: string, labels: readonly string[]): ExposureSlice[] {
  return labels
    .map((label) => {
      const match = section.match(new RegExp(`${escapeRegExp(label)}\\s+([0-9]+(?:\\.[0-9]+)?)%?`, "i"));
      if (!match) {
        return null;
      }
      return {
        name: label,
        share: roundShare(Number(match[1])),
      } satisfies ExposureSlice;
    })
    .filter((slice): slice is ExposureSlice => Boolean(slice));
}

function parseNumbersBeforeLabels(
  section: string,
  firstLabel: string,
  labels: readonly string[],
): ExposureSlice[] {
  const labelIndex = section.indexOf(firstLabel);
  if (labelIndex === -1) {
    return [];
  }

  const numberBlock = section.slice(0, labelIndex);
  const matches = [...numberBlock.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*%/g)].map((match) => Number(match[1]));
  return labels
    .map((label, index) => {
      const share = matches[index];
      if (!Number.isFinite(share)) {
        return null;
      }
      return {
        name: label,
        share: roundShare(share),
      } satisfies ExposureSlice;
    })
    .filter((slice): slice is ExposureSlice => Boolean(slice));
}

function deriveCurrenciesFromCountries(countries: ExposureSlice[]): ExposureSlice[] {
  const grouped = new Map<string, number>();
  for (const slice of countries) {
    const currency = COUNTRY_TO_CURRENCY[slice.name] ?? "Other currencies";
    grouped.set(currency, (grouped.get(currency) ?? 0) + slice.share);
  }

  return [...grouped.entries()]
    .map(([name, share]) => ({
      name,
      share: roundShare(share),
    }))
    .sort((left, right) => right.share - left.share);
}

async function fetchPdfText(url: string): Promise<string> {
  const cached = pdfTextCache.get(url);
  if (!cached || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    pdfTextCache.set(
      url,
      {
        loadedAt: Date.now(),
        promise: (async () => {
          const scriptPath = resolveRuntimeScript("extract_pdf_text.mjs");
          return execFileSync(process.execPath, [scriptPath, url], {
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
          });
        })(),
      },
    );
  }
  return (await pdfTextCache.get(url)?.promise) ?? "";
}

async function fetchHtmlText(url: string): Promise<string> {
  const cached = htmlTextCache.get(url);
  if (!cached || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    htmlTextCache.set(
      url,
      {
        loadedAt: Date.now(),
        promise: (async () => {
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0",
            },
            cache: "no-store",
          });
          return response.ok ? response.text() : "";
        })(),
      },
    );
  }
  return (await htmlTextCache.get(url)?.promise) ?? "";
}

async function loadVanguardAllWorldExposure(): Promise<OfficialEtfExposure | null> {
  const text = await fetchPdfText(VANGUARD_FACTSHEET_URL);
  if (!text) {
    return null;
  }

  const asOfMatch = text.match(/Factsheet\s*\|\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/);
  const sectorSection = text.split("Weighted exposure").at(1)?.split("Source: Vanguard").at(0) ?? "";
  const marketSection = text.split("Market allocation").at(1)?.split("Glossary for ETF attributes").at(0) ?? "";
  const sectors = parseLabelThenNumber(sectorSection, VANGUARD_SECTORS);
  const countries = addRemainderSlice(parseLabelThenNumber(marketSection, VANGUARD_COUNTRIES), "Other countries");

  if (sectors.length === 0 || countries.length === 0) {
    return null;
  }

  return {
    instrumentKey: "IE00BK5BQT80",
    instrument: "Vanguard FTSE All-World UCITS ETF",
    asOf: toIsoDate(asOfMatch?.[1] ?? ""),
    source: "Official Vanguard factsheet",
    countries,
    sectors,
    currencies: deriveCurrenciesFromCountries(countries),
  };
}

async function loadAmundiEuropeExposure(): Promise<OfficialEtfExposure | null> {
  const text = await fetchPdfText(AMUNDI_FACTSHEET_URL);
  if (!text) {
    return null;
  }

  const asOfMatch = text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
  const geographicSection = text
    .split("Geographical breakdown (for illustrative purposes only - Source: Amundi)")
    .at(1)
    ?.split("Benchmark Sector breakdown (for illustrative purposes only - Source : Amundi)")
    .at(0) ?? "";
  const sectorSection = text
    .split("Benchmark Sector breakdown (for illustrative purposes only - Source : Amundi)")
    .at(1)
    ?.split("Amundi Asset Management")
    .at(0) ?? "";

  const countries = parseNumbersBeforeLabels(geographicSection, "United Kingdom", AMUNDI_COUNTRIES);
  const sectors = parseNumbersBeforeLabels(sectorSection, "Financials", AMUNDI_SECTORS);

  if (sectors.length === 0 || countries.length === 0) {
    return null;
  }

  return {
    instrumentKey: "LU0908500753",
    instrument: "Amundi Core Stoxx Europe 600 UCITS ETF Acc",
    asOf: toIsoDate(asOfMatch?.[1] ?? ""),
    source: "Official Amundi factsheet",
    countries,
    sectors,
    currencies: deriveCurrenciesFromCountries(countries),
  };
}

function parseIsharesTable(section: string, variableName: string): ExposureSlice[] {
  const match = section.match(new RegExp(`var\\s+${variableName}\\s*=\\s*(\\[.*?\\]);`, "s"));
  if (!match) {
    return [];
  }
  try {
    const normalized = match[1]
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    const rows = JSON.parse(normalized) as Array<{ name?: string; value?: string }>;
    return rows
      .map((row) => ({
        name: normalizeWhitespace(String(row.name ?? "")),
        share: roundShare(Number(row.value ?? 0)),
      }))
      .filter((row) => row.name && Number.isFinite(row.share) && row.share > 0);
  } catch {
    return [];
  }
}

async function loadIsharesExposure(
  instrumentKey: string,
  instrument: string,
  url: string,
): Promise<OfficialEtfExposure | null> {
  const text = await fetchHtmlText(url);
  if (!text) {
    return null;
  }

  const countries = parseIsharesTable(text, "subTabsCountriesDataTable");
  const sectors = parseIsharesTable(text, "tabsSectorDataTable");
  const asOfMatch = text.match(/as of (\d{2}\/[A-Za-z]{3}\/\d{4}|\d{2}\/\d{2}\/\d{4})/i);

  if (countries.length === 0 || sectors.length === 0) {
    return null;
  }

  return {
    instrumentKey,
    instrument,
    asOf: toIsoDate(asOfMatch?.[1] ?? ""),
    source: "Official iShares product page",
    countries,
    sectors,
    currencies: deriveCurrenciesFromCountries(countries),
  };
}

function fallbackLookthroughProvider(instrumentKey: string) {
  if (instrumentKey === "IE00BK5BQT80") {
    return "vanguard_all_world";
  }
  if (instrumentKey === "LU0908500753") {
    return "amundi_stoxx_europe_600";
  }
  if (instrumentKey === "IE00B4L5Y983") {
    return "ishares_core_msci_world";
  }
  if (instrumentKey === "IE00B5BMR087") {
    return "ishares_core_sp500";
  }
  if (instrumentKey === "IE00B53SZB19") {
    return "ishares_nasdaq_100";
  }
  if (instrumentKey === "IE00B3WJKG14") {
    return "ishares_sp500_info_tech";
  }
  return "";
}

async function loadExposureForInstrument(
  instrumentKey: string,
  instrument: string,
  providerKey: string,
): Promise<OfficialEtfExposure | null> {
  const cached = exposureCache.get(instrumentKey);
  if (!cached || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    exposureCache.set(
      instrumentKey,
      {
        loadedAt: Date.now(),
        promise: (async () => {
          if (providerKey === "vanguard_all_world") {
            return loadVanguardAllWorldExposure();
          }
          if (providerKey === "amundi_stoxx_europe_600") {
            return loadAmundiEuropeExposure();
          }
          if (ISHARES_PROVIDER_URLS[providerKey]) {
            const config = ISHARES_PROVIDER_URLS[providerKey];
            return loadIsharesExposure(instrumentKey, instrument || config.instrument, config.url);
          }
          return null;
        })(),
      },
    );
  }

  return (await exposureCache.get(instrumentKey)?.promise) ?? null;
}

export async function loadOfficialEtfExposures(
  transactions: TransactionRecord[],
  registry: InstrumentRegistryLookup = {},
): Promise<Record<string, OfficialEtfExposure>> {
  const instruments = [
    ...new Map(
      extractInvestmentTrades(transactions, registry)
        .filter((trade) => trade.assetClass === "etf" || trade.assetClass === "bond_etf")
        .map((trade) => [trade.instrumentKey, { instrumentKey: trade.instrumentKey, instrument: trade.instrument }]),
    ).values(),
  ];

  const exposures = await Promise.all(
    instruments.map(async ({ instrumentKey, instrument }) => {
      const providerKey = registry[instrumentKey]?.lookthroughProvider || fallbackLookthroughProvider(instrumentKey);
      return [instrumentKey, await loadExposureForInstrument(instrumentKey, instrument, providerKey)] as const;
    }),
  );

  return exposures.reduce<Record<string, OfficialEtfExposure>>((acc, [instrumentKey, exposure]) => {
    if (exposure) {
      acc[instrumentKey] = exposure;
    }
    return acc;
  }, {});
}
