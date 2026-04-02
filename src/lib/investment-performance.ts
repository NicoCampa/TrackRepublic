import type { CapitalPoint, TransactionRecord } from "./dashboard-data";
import type {
  AssetClass,
  FallbackValuation,
  HistoricalUnitEstimate,
  InstrumentRegistryLookup,
  LiveQuote,
  PositionUnitOverridesByInstrument,
  PositionRecord,
  PositionSnapshot,
  PositionUnitOverride,
  PositionValuationOverride,
  PositionValuationOverridesByInstrument,
  PriceScale,
  ValuationSource,
} from "./investment-positions";
import { extractInvestmentTrades, resolveInstrument } from "./investment-positions";

export type HistoricalPriceSeries = Record<string, Record<string, number>>;

type InstrumentState = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  assetClass: AssetClass;
  priceScale: PriceScale;
  fallbackValuation: FallbackValuation;
  units: number;
  costBasisCurrent: number;
  realizedPnlAllTime: number;
  realizedPnlInRange: number;
  grossInvestedEur: number;
  rowsWithQuantity: number;
  rowsWithEstimatedUnits: number;
  rowsWithoutQuantity: number;
  manualUnitsOverride: boolean;
  lastKnownPriceEur: number | null;
  lastKnownPriceDate: string;
};

export type PositionPerformanceRecord = PositionRecord & {
  costBasisEur: number;
  averageCostPerUnitEur: number;
  unrealizedPnlEur: number;
  realizedPnlRangeEur: number;
  realizedPnlAllTimeEur: number;
  dividendIncomeRangeEur: number;
  dividendIncomeAllTimeEur: number;
  totalReturnPct: number;
  grossInvestedEur: number;
  coverage: "Manual" | "Estimated" | "Partial" | "Complete";
  valuationSourceLabel: "Live" | "Manual" | "Statement" | "Cost";
};

export type PortfolioHistoryPoint = {
  date: string;
  marketValueEur: number;
  cashValueEur: number;
  totalValueEur: number;
  costBasisEur: number;
  realizedPnlEur: number;
  dividendIncomeEur: number;
  componentValues: Record<string, number>;
};

export type PortfolioReturnPoint = {
  date: string;
  marketValueEur: number;
  cashValueEur: number;
  totalValueEur: number;
  externalFlowEur: number;
  dailyReturnPct: number | null;
};

export type InvestmentAnalytics = {
  snapshot: PositionSnapshot;
  positions: PositionPerformanceRecord[];
  portfolioValueEur: number;
  costBasisEur: number;
  unrealizedPnlEur: number;
  realizedPnlRangeEur: number;
  dividendsRangeEur: number;
  history: PortfolioHistoryPoint[];
  returnSeries: PortfolioReturnPoint[];
};

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

function clampUnits(value: number) {
  return value <= 0.0000001 ? 0 : value;
}

function coverageLabel(row: {
  manualUnitsOverride?: boolean;
  unitsKnown?: boolean;
  rowsWithEstimatedUnits: number;
  rowsWithoutQuantity: number;
}): "Manual" | "Estimated" | "Partial" | "Complete" {
  if (row.manualUnitsOverride) {
    return "Manual";
  }
  if (row.unitsKnown === false) {
    return "Partial";
  }
  if (row.rowsWithoutQuantity > 0) {
    return "Partial";
  }
  if (row.rowsWithEstimatedUnits > 0) {
    return "Estimated";
  }
  return "Complete";
}

function valuationSourceLabel(source: ValuationSource): PositionPerformanceRecord["valuationSourceLabel"] {
  switch (source) {
    case "live_quote":
      return "Live";
    case "manual_price":
      return "Manual";
    case "statement_price":
      return "Statement";
    case "cost_basis":
    default:
      return "Cost";
  }
}

function pickApplicableOverride<T extends { effectiveDate: string; updatedAt: string }>(
  overrides: T[] | undefined,
  endDate: string,
) {
  return overrides
    ?.filter((override) => override.effectiveDate <= endDate)
    .sort((left, right) => `${left.effectiveDate}-${left.updatedAt}`.localeCompare(`${right.effectiveDate}-${right.updatedAt}`))
    .at(-1);
}

function valueForUnits(priceEur: number, units: number, priceScale: PriceScale) {
  return priceScale === "percent_of_par" ? priceEur * units : priceEur * units;
}

function buildDividendMaps(
  transactions: TransactionRecord[],
  endDate: string,
  rangeStartDate: string,
  registry: InstrumentRegistryLookup,
) {
  const byInstrumentAll = new Map<string, number>();
  const byInstrumentRange = new Map<string, number>();
  let totalRange = 0;

  for (const row of transactions) {
    if (row.category !== "interest_dividend" || row.signedAmount <= 0 || row.date > endDate) {
      continue;
    }
    totalRange += row.date >= rangeStartDate ? row.signedAmount : 0;
    const instrument = resolveInstrument(row.description, registry);
    if (!instrument.key || instrument.assetClass === "other") {
      continue;
    }
    byInstrumentAll.set(instrument.key, (byInstrumentAll.get(instrument.key) ?? 0) + row.signedAmount);
    if (row.date >= rangeStartDate) {
      byInstrumentRange.set(instrument.key, (byInstrumentRange.get(instrument.key) ?? 0) + row.signedAmount);
    }
  }

  return {
    byInstrumentAll,
    byInstrumentRange,
    totalRange,
  };
}

function buildInstrumentStates(
  transactions: TransactionRecord[],
  endDate: string,
  rangeStartDate: string,
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate>,
  positionUnitOverrides: PositionUnitOverridesByInstrument,
  registry: InstrumentRegistryLookup,
) {
  const trades = extractInvestmentTrades(transactions, registry)
    .filter((trade) => trade.date <= endDate)
    .sort((left, right) => `${left.date}-${left.rowId}`.localeCompare(`${right.date}-${right.rowId}`));
  const stateByInstrument = new Map<string, InstrumentState>();

  for (const trade of trades) {
    const current = stateByInstrument.get(trade.instrumentKey) ?? {
      instrumentKey: trade.instrumentKey,
      isin: trade.isin,
      instrument: trade.instrument,
      assetClass: trade.assetClass,
      priceScale: trade.priceScale,
      fallbackValuation: trade.fallbackValuation,
      units: 0,
      costBasisCurrent: 0,
      realizedPnlAllTime: 0,
      realizedPnlInRange: 0,
      grossInvestedEur: 0,
      rowsWithQuantity: 0,
      rowsWithEstimatedUnits: 0,
      rowsWithoutQuantity: 0,
      manualUnitsOverride: false,
      lastKnownPriceEur: null,
      lastKnownPriceDate: "",
    };

    const estimated = trade.units === null ? historicalUnitEstimates[trade.rowId]?.units ?? null : null;
    const units = trade.units ?? estimated;
    if (trade.units !== null) {
      current.rowsWithQuantity += 1;
    } else if (estimated) {
      current.rowsWithEstimatedUnits += 1;
    } else {
      current.rowsWithoutQuantity += 1;
      if (trade.signedAmount < 0) {
        current.costBasisCurrent += Math.abs(trade.signedAmount);
        current.grossInvestedEur += Math.abs(trade.signedAmount);
      } else {
        current.costBasisCurrent = Math.max(0, current.costBasisCurrent - trade.signedAmount);
      }
      stateByInstrument.set(trade.instrumentKey, current);
      continue;
    }

    if (!units || units <= 0) {
      stateByInstrument.set(trade.instrumentKey, current);
      continue;
    }

    const transactionPriceEur = Math.abs(trade.signedAmount) / units;
    if (Number.isFinite(transactionPriceEur) && transactionPriceEur > 0) {
      current.lastKnownPriceEur = transactionPriceEur;
      current.lastKnownPriceDate = trade.date;
    }

    if (trade.signedAmount < 0) {
      current.units += units;
      current.costBasisCurrent += Math.abs(trade.signedAmount);
      current.grossInvestedEur += Math.abs(trade.signedAmount);
    } else {
      const sellUnits = Math.min(units, current.units || units);
      const averageCost = current.units > 0 ? current.costBasisCurrent / current.units : 0;
      const costRemoved = averageCost * sellUnits;
      const realized = trade.signedAmount - costRemoved;
      current.realizedPnlAllTime += realized;
      if (trade.date >= rangeStartDate) {
        current.realizedPnlInRange += realized;
      }
      current.units = clampUnits(current.units - sellUnits);
      current.costBasisCurrent = Math.max(0, current.costBasisCurrent - costRemoved);
    }

    stateByInstrument.set(trade.instrumentKey, current);
  }

  for (const [instrumentKey, overrides] of Object.entries(positionUnitOverrides)) {
    const override = pickApplicableOverride(overrides, endDate);
    if (!override) {
      continue;
    }
    const current = stateByInstrument.get(instrumentKey);
    if (!current) {
      continue;
    }
    const averageCost = current.units > 0 ? current.costBasisCurrent / current.units : 0;
    current.units = override.units;
    current.costBasisCurrent = averageCost > 0 ? averageCost * override.units : current.costBasisCurrent;
    current.manualUnitsOverride = true;
    current.rowsWithoutQuantity = 0;
    stateByInstrument.set(instrumentKey, current);
  }

  return stateByInstrument;
}

function monthEndDates(minDate: string, endDate: string) {
  const checkpoints: string[] = [];
  let current = new Date(`${minDate.slice(0, 7)}-01T00:00:00Z`);
  const final = new Date(`${endDate}T00:00:00Z`);

  while (current <= final) {
    const monthEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0));
    const checkpoint = monthEnd.toISOString().slice(0, 10) > endDate ? endDate : monthEnd.toISOString().slice(0, 10);
    if (!checkpoints.includes(checkpoint)) {
      checkpoints.push(checkpoint);
    }
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }

  if (!checkpoints.includes(endDate)) {
    checkpoints.push(endDate);
  }

  return checkpoints.sort();
}

type ResolvedValuation = {
  priceEur: number;
  marketValueEur: number;
  source: ValuationSource;
  asOf: string;
};

function resolveStateValuation(params: {
  state: InstrumentState;
  liveQuote?: LiveQuote;
  manualPriceOverride?: PositionValuationOverride;
  endDate: string;
}): ResolvedValuation | null {
  const { state, liveQuote, manualPriceOverride, endDate } = params;
  const unitsKnown = state.manualUnitsOverride || (state.rowsWithoutQuantity === 0 && state.units > 0.0000001);
  const positiveUnits = state.units > 0.0000001;

  if (liveQuote && positiveUnits && unitsKnown) {
    return {
      priceEur: liveQuote.priceEur,
      marketValueEur: valueForUnits(liveQuote.priceEur, state.units, state.priceScale),
      source: "live_quote",
      asOf: liveQuote.asOf || endDate,
    };
  }

  if (manualPriceOverride && positiveUnits && unitsKnown) {
    return {
      priceEur: manualPriceOverride.priceEur,
      marketValueEur: valueForUnits(manualPriceOverride.priceEur, state.units, state.priceScale),
      source: "manual_price",
      asOf: manualPriceOverride.effectiveDate,
    };
  }

  if (state.lastKnownPriceEur && positiveUnits && unitsKnown && state.fallbackValuation === "statement_price") {
    return {
      priceEur: state.lastKnownPriceEur,
      marketValueEur: valueForUnits(state.lastKnownPriceEur, state.units, state.priceScale),
      source: "statement_price",
      asOf: state.lastKnownPriceDate || endDate,
    };
  }

  if (state.costBasisCurrent > 0) {
    const impliedPriceEur = positiveUnits && unitsKnown ? state.costBasisCurrent / state.units : state.costBasisCurrent;
    return {
      priceEur: impliedPriceEur,
      marketValueEur: state.costBasisCurrent,
      source: "cost_basis",
      asOf: endDate,
    };
  }

  return null;
}

function buildSnapshotFromStates(params: {
  capitalSeries: CapitalPoint[];
  endDate: string;
  liveQuotes: LiveQuote[];
  states: Map<string, InstrumentState>;
  positionValuationOverrides: PositionValuationOverridesByInstrument;
  registry: InstrumentRegistryLookup;
}): PositionSnapshot {
  const { capitalSeries, endDate, liveQuotes, states, positionValuationOverrides, registry } = params;
  const quoteMap = new Map(liveQuotes.map((quote) => [quote.instrumentKey, quote]));
  const positions: PositionRecord[] = [];

  for (const [instrumentKey, state] of states.entries()) {
    const liveQuote = quoteMap.get(instrumentKey);
    const manualPriceOverride = pickApplicableOverride(positionValuationOverrides[instrumentKey], endDate);
    const valuation = resolveStateValuation({
      state,
      liveQuote,
      manualPriceOverride,
      endDate,
    });
    const unitsKnown = state.manualUnitsOverride || (state.rowsWithoutQuantity === 0 && state.units > 0.0000001);
    const shouldInclude = state.units > 0.0000001 || state.costBasisCurrent > 0.0000001 || manualPriceOverride || valuation;

    if (!shouldInclude || !valuation || valuation.marketValueEur <= 0.0000001) {
      continue;
    }

    positions.push({
      instrumentKey,
      isin: state.isin,
      instrument: state.instrument,
      assetClass: state.assetClass,
      priceScale: state.priceScale,
      country: liveQuote?.country ?? registry[instrumentKey]?.country ?? registry[state.isin]?.country ?? "Other",
      industry: liveQuote?.industry ?? registry[instrumentKey]?.industry ?? registry[state.isin]?.industry ?? "",
      sector: liveQuote?.sector ?? registry[instrumentKey]?.sector ?? registry[state.isin]?.sector,
      symbol: liveQuote?.symbol ?? state.isin ?? instrumentKey,
      units: state.units,
      unitsKnown,
      price: valuation.priceEur,
      priceEur: valuation.priceEur,
      quoteCurrency: liveQuote?.currency ?? "EUR",
      marketValueEur: valuation.marketValueEur,
      asOf: liveQuote?.asOf ?? valuation.asOf,
      valuationSource: valuation.source,
      valuationAsOf: valuation.asOf,
      rowsWithQuantity: state.rowsWithQuantity,
      rowsWithEstimatedUnits: state.rowsWithEstimatedUnits,
      rowsWithoutQuantity: state.rowsWithoutQuantity,
      manualUnitsOverride: state.manualUnitsOverride,
    });
  }

  positions.sort((left, right) => right.marketValueEur - left.marketValueEur);

  let latestCapital: CapitalPoint | null = null;
  for (const point of capitalSeries) {
    if (point.date > endDate) {
      break;
    }
    latestCapital = point;
  }

  const availableCash = latestCapital?.availableCash ?? 0;
  const investmentsMarketValue = positions.reduce((sum, row) => sum + row.marketValueEur, 0);
  const pricesAsOf = positions.map((row) => row.valuationAsOf).sort().at(-1) ?? endDate;

  return {
    positionsAsOf: endDate,
    pricesAsOf,
    availableCash,
    investmentsMarketValue,
    totalMarketValue: availableCash + investmentsMarketValue,
    positions,
    unresolvedRows: [...states.values()].reduce((sum, row) => sum + (row.manualUnitsOverride ? 0 : row.rowsWithoutQuantity), 0),
  };
}

function marketValueForDate(
  position: PositionRecord,
  date: string,
  historicalSeries: HistoricalPriceSeries,
) {
  const historicalPrice = historicalPriceOnOrBefore(historicalSeries[position.instrumentKey] ?? {}, date);
  if (historicalPrice && position.valuationSource === "live_quote" && position.unitsKnown && position.units > 0.0000001) {
    return valueForUnits(historicalPrice, position.units, position.priceScale);
  }
  return position.marketValueEur;
}

function previousDate(date: string) {
  const current = new Date(`${date}T00:00:00Z`);
  current.setUTCDate(current.getUTCDate() - 1);
  return current.toISOString().slice(0, 10);
}

function isExternalPortfolioFlow(row: TransactionRecord) {
  if (row.group === "investment") {
    return false;
  }
  if (row.category === "interest_dividend" || row.category === "fees" || row.category === "taxes") {
    return false;
  }
  return true;
}

function buildExternalFlowByDate(transactions: TransactionRecord[], endDate: string) {
  const byDate = new Map<string, number>();
  for (const row of transactions) {
    if (row.date > endDate || !isExternalPortfolioFlow(row)) {
      continue;
    }
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.signedAmount);
  }
  return byDate;
}

function buildHistoricalPortfolioPoint(params: {
  transactions: TransactionRecord[];
  capitalSeries: CapitalPoint[];
  liveQuotes: LiveQuote[];
  historicalSeries: HistoricalPriceSeries;
  date: string;
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate>;
  positionUnitOverrides: PositionUnitOverridesByInstrument;
  positionValuationOverrides: PositionValuationOverridesByInstrument;
  registry: InstrumentRegistryLookup;
}): PortfolioHistoryPoint {
  const {
    transactions,
    capitalSeries,
    liveQuotes,
    historicalSeries,
    date,
    historicalUnitEstimates,
    positionUnitOverrides,
    positionValuationOverrides,
    registry,
  } = params;

  const pointStates = buildInstrumentStates(
    transactions,
    date,
    transactions[0]?.date ?? date,
    historicalUnitEstimates,
    positionUnitOverrides,
    registry,
  );
  const historicalSnapshot = buildSnapshotFromStates({
    capitalSeries,
    endDate: date,
    liveQuotes,
    states: pointStates,
    positionValuationOverrides,
    registry,
  });
  const historicalInvestmentsMarketValue = historicalSnapshot.positions.reduce(
    (sum, row) => sum + marketValueForDate(row, date, historicalSeries),
    0,
  );
  const componentValues = historicalSnapshot.positions.reduce<Record<string, number>>((accumulator, row) => {
    const marketValue = marketValueForDate(row, date, historicalSeries);
    if (marketValue <= 0) {
      return accumulator;
    }

    accumulator[row.assetClass] = (accumulator[row.assetClass] ?? 0) + marketValue;
    return accumulator;
  }, {});
  if (historicalSnapshot.availableCash > 0.0000001) {
    componentValues.cash = (componentValues.cash ?? 0) + historicalSnapshot.availableCash;
  }

  return {
    date,
    marketValueEur: historicalInvestmentsMarketValue,
    cashValueEur: historicalSnapshot.availableCash,
    totalValueEur: historicalSnapshot.availableCash + historicalInvestmentsMarketValue,
    costBasisEur: [...pointStates.values()].reduce((sum, row) => sum + row.costBasisCurrent, 0),
    realizedPnlEur: [...pointStates.values()].reduce((sum, row) => sum + row.realizedPnlAllTime, 0),
    dividendIncomeEur: transactions.reduce(
      (sum, row) => sum + (row.category === "interest_dividend" && row.signedAmount > 0 && row.date <= date ? row.signedAmount : 0),
      0,
    ),
    componentValues,
  } satisfies PortfolioHistoryPoint;
}

export function buildInvestmentAnalytics(params: {
  transactions: TransactionRecord[];
  capitalSeries: CapitalPoint[];
  liveQuotes: LiveQuote[];
  historicalSeries: HistoricalPriceSeries;
  endDate: string;
  rangeStartDate: string;
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate>;
  positionUnitOverrides: PositionUnitOverridesByInstrument;
  positionValuationOverrides: PositionValuationOverridesByInstrument;
  registry: InstrumentRegistryLookup;
}): InvestmentAnalytics {
  const {
    transactions,
    capitalSeries,
    liveQuotes,
    historicalSeries,
    endDate,
    rangeStartDate,
    historicalUnitEstimates,
    positionUnitOverrides,
    positionValuationOverrides,
    registry,
  } = params;

  if (!endDate) {
    return {
      snapshot: {
        positionsAsOf: "",
        pricesAsOf: "",
        availableCash: 0,
        investmentsMarketValue: 0,
        totalMarketValue: 0,
        positions: [],
        unresolvedRows: 0,
      },
      positions: [],
      portfolioValueEur: 0,
      costBasisEur: 0,
      unrealizedPnlEur: 0,
      realizedPnlRangeEur: 0,
      dividendsRangeEur: 0,
      history: [],
      returnSeries: [],
    };
  }

  const dividendMaps = buildDividendMaps(transactions, endDate, rangeStartDate, registry);
  const stateByInstrument = buildInstrumentStates(
    transactions,
    endDate,
    rangeStartDate,
    historicalUnitEstimates,
    positionUnitOverrides,
    registry,
  );
  const snapshot = buildSnapshotFromStates({
    capitalSeries,
    endDate,
    liveQuotes,
    states: stateByInstrument,
    positionValuationOverrides,
    registry,
  });

  const positions = snapshot.positions.map((position) => {
    const state = stateByInstrument.get(position.instrumentKey);
    const costBasisEur = state?.costBasisCurrent ?? 0;
    const averageCostPerUnitEur = position.units > 0 ? costBasisEur / position.units : 0;
    const unrealizedPnlEur = position.marketValueEur - costBasisEur;
    const realizedPnlRangeEur = state?.realizedPnlInRange ?? 0;
    const realizedPnlAllTimeEur = state?.realizedPnlAllTime ?? 0;
    const dividendIncomeAllTimeEur = dividendMaps.byInstrumentAll.get(position.instrumentKey) ?? 0;
    const dividendIncomeRangeEur = dividendMaps.byInstrumentRange.get(position.instrumentKey) ?? 0;
    const grossInvestedEur = state?.grossInvestedEur ?? 0;
    const totalReturnPct =
      grossInvestedEur > 0
        ? ((unrealizedPnlEur + realizedPnlAllTimeEur + dividendIncomeAllTimeEur) / grossInvestedEur) * 100
        : 0;

    return {
      ...position,
      costBasisEur,
      averageCostPerUnitEur,
      unrealizedPnlEur,
      realizedPnlRangeEur,
      realizedPnlAllTimeEur,
      dividendIncomeRangeEur,
      dividendIncomeAllTimeEur,
      totalReturnPct,
      grossInvestedEur,
      coverage: coverageLabel(position),
      valuationSourceLabel: valuationSourceLabel(position.valuationSource),
    } satisfies PositionPerformanceRecord;
  });

  const historyDates = monthEndDates(transactions[0]?.date ?? endDate, endDate);
  const returnStartDate = rangeStartDate ? previousDate(rangeStartDate) : transactions[0]?.date ?? endDate;
  const returnDates = capitalSeries
    .map((point) => point.date)
    .filter((date) => date >= returnStartDate && date <= endDate);
  if (!returnDates.includes(endDate)) {
    returnDates.push(endDate);
    returnDates.sort();
  }
  const timelineDates = [...new Set([...historyDates, ...returnDates])].sort();
  const timelineByDate = new Map(
    timelineDates.map((date) => [
      date,
      buildHistoricalPortfolioPoint({
        transactions,
        capitalSeries,
        liveQuotes,
        historicalSeries,
        date,
        historicalUnitEstimates,
        positionUnitOverrides,
        positionValuationOverrides,
        registry,
      }),
    ]),
  );
  const history = historyDates
    .map((date) => timelineByDate.get(date))
    .filter((point): point is PortfolioHistoryPoint => Boolean(point));
  const externalFlowByDate = buildExternalFlowByDate(transactions, endDate);
  const returnSeries = returnDates
    .map((date, index) => {
      const point = timelineByDate.get(date);
      if (!point) {
        return null;
      }
      const previousPoint = index > 0 ? timelineByDate.get(returnDates[index - 1]) ?? null : null;
      const externalFlowEur = externalFlowByDate.get(date) ?? 0;
      const dailyReturnPct =
        previousPoint && Math.abs(previousPoint.totalValueEur) > 0.0000001
          ? ((point.totalValueEur - previousPoint.totalValueEur - externalFlowEur) / previousPoint.totalValueEur) * 100
          : null;

      return {
        date,
        marketValueEur: point.marketValueEur,
        cashValueEur: point.cashValueEur,
        totalValueEur: point.totalValueEur,
        externalFlowEur,
        dailyReturnPct,
      } satisfies PortfolioReturnPoint;
    })
    .filter((point): point is PortfolioReturnPoint => Boolean(point));

  const costBasisEur = positions.reduce((sum, row) => sum + row.costBasisEur, 0);
  const unrealizedPnlEur = positions.reduce((sum, row) => sum + row.unrealizedPnlEur, 0);
  const realizedPnlRangeEur = positions.reduce((sum, row) => sum + row.realizedPnlRangeEur, 0);

  return {
    snapshot,
    positions,
    portfolioValueEur: snapshot.investmentsMarketValue,
    costBasisEur,
    unrealizedPnlEur,
    realizedPnlRangeEur,
    dividendsRangeEur: dividendMaps.totalRange,
    history,
    returnSeries,
  };
}
