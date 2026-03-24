import type { CapitalPoint, TransactionRecord } from "./dashboard-data";
import type {
  AssetClass,
  HistoricalUnitEstimate,
  InstrumentRegistryLookup,
  LiveQuote,
  PositionRecord,
  PositionSnapshot,
  PositionUnitOverride,
} from "./investment-positions";
import { buildPositionSnapshot, extractInvestmentTrades, resolveInstrument } from "./investment-positions";

export type HistoricalPriceSeries = Record<string, Record<string, number>>;

type InstrumentState = {
  instrumentKey: string;
  isin: string;
  instrument: string;
  assetClass: AssetClass;
  units: number;
  costBasisCurrent: number;
  realizedPnlAllTime: number;
  realizedPnlInRange: number;
  grossInvestedEur: number;
  rowsWithQuantity: number;
  rowsWithEstimatedUnits: number;
  rowsWithoutQuantity: number;
  manualUnitsOverride: boolean;
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
};

export type PortfolioHistoryPoint = {
  date: string;
  marketValueEur: number;
  costBasisEur: number;
  realizedPnlEur: number;
  dividendIncomeEur: number;
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
};

function historicalPriceOnOrBefore(series: Record<string, number>, date: string): number | null {
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
  rowsWithEstimatedUnits: number;
  rowsWithoutQuantity: number;
}): "Manual" | "Estimated" | "Partial" | "Complete" {
  if (row.manualUnitsOverride) {
    return "Manual";
  }
  if (row.rowsWithoutQuantity > 0) {
    return "Partial";
  }
  if (row.rowsWithEstimatedUnits > 0) {
    return "Estimated";
  }
  return "Complete";
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
  positionUnitOverrides: Record<string, PositionUnitOverride>,
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
      units: 0,
      costBasisCurrent: 0,
      realizedPnlAllTime: 0,
      realizedPnlInRange: 0,
      grossInvestedEur: 0,
      rowsWithQuantity: 0,
      rowsWithEstimatedUnits: 0,
      rowsWithoutQuantity: 0,
      manualUnitsOverride: false,
    };

    const estimated = trade.units === null ? historicalUnitEstimates[trade.rowId]?.units ?? null : null;
    const units = trade.units ?? estimated;
    if (trade.units !== null) {
      current.rowsWithQuantity += 1;
    } else if (estimated) {
      current.rowsWithEstimatedUnits += 1;
    } else {
      current.rowsWithoutQuantity += 1;
      stateByInstrument.set(trade.instrumentKey, current);
      continue;
    }

    if (!units || units <= 0) {
      stateByInstrument.set(trade.instrumentKey, current);
      continue;
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

  for (const [instrumentKey, override] of Object.entries(positionUnitOverrides)) {
    if (override.effectiveDate > endDate) {
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

function marketValueForDate(
  position: PositionRecord,
  date: string,
  historicalSeries: HistoricalPriceSeries,
) {
  const historicalPrice = historicalPriceOnOrBefore(historicalSeries[position.instrumentKey] ?? {}, date);
  const price = historicalPrice ?? position.priceEur;
  return price * position.units;
}

export function buildInvestmentAnalytics(params: {
  transactions: TransactionRecord[];
  capitalSeries: CapitalPoint[];
  liveQuotes: LiveQuote[];
  historicalSeries: HistoricalPriceSeries;
  endDate: string;
  rangeStartDate: string;
  historicalUnitEstimates: Record<string, HistoricalUnitEstimate>;
  positionUnitOverrides: Record<string, PositionUnitOverride>;
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
    };
  }

  const snapshot = buildPositionSnapshot(
    transactions,
    capitalSeries,
    liveQuotes,
    endDate,
    historicalUnitEstimates,
    positionUnitOverrides,
    registry,
  );
  const dividendMaps = buildDividendMaps(transactions, endDate, rangeStartDate, registry);
  const stateByInstrument = buildInstrumentStates(
    transactions,
    endDate,
    rangeStartDate,
    historicalUnitEstimates,
    positionUnitOverrides,
    registry,
  );

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
    } satisfies PositionPerformanceRecord;
  });

  const historyDates = monthEndDates(transactions[0]?.date ?? endDate, endDate);
  const history = historyDates.map((date) => {
    const historicalSnapshot = buildPositionSnapshot(
      transactions,
      capitalSeries,
      liveQuotes,
      date,
      historicalUnitEstimates,
      positionUnitOverrides,
      registry,
    );
    const pointStates = buildInstrumentStates(
      transactions,
      date,
      transactions[0]?.date ?? date,
      historicalUnitEstimates,
      positionUnitOverrides,
      registry,
    );
    return {
      date,
      marketValueEur: historicalSnapshot.positions.reduce((sum, row) => sum + marketValueForDate(row, date, historicalSeries), 0),
      costBasisEur: [...pointStates.values()].reduce((sum, row) => sum + row.costBasisCurrent, 0),
      realizedPnlEur: [...pointStates.values()].reduce((sum, row) => sum + row.realizedPnlAllTime, 0),
      dividendIncomeEur: transactions.reduce(
        (sum, row) => sum + (row.category === "interest_dividend" && row.signedAmount > 0 && row.date <= date ? row.signedAmount : 0),
        0,
      ),
    } satisfies PortfolioHistoryPoint;
  });

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
  };
}
