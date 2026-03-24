import { getDashboardSnapshotKey, loadDashboardData, type DashboardData } from "./dashboard-data";
import { loadHistoricalMarketSeries, type HistoricalPriceSeries } from "./live-quotes";

export type AccountsData = DashboardData & {
  historicalMarketSeries: HistoricalPriceSeries;
};

type PromiseCacheEntry<T> = {
  key: string;
  promise: Promise<T>;
};

let accountsDataCache: PromiseCacheEntry<AccountsData> | null = null;

export async function loadAccountsData(): Promise<AccountsData> {
  const cacheKey = `${getDashboardSnapshotKey()}:historical-series`;
  if (accountsDataCache?.key === cacheKey) {
    return accountsDataCache.promise;
  }

  const promise = Promise.resolve()
    .then(async () => {
      const data = await loadDashboardData();
      const historicalMarketSeries = await loadHistoricalMarketSeries(
        data.transactions,
        data.liveQuotes,
        data.instrumentRegistry,
      );

      return {
        ...data,
        historicalMarketSeries,
      };
    })
    .catch((error) => {
      if (accountsDataCache?.key === cacheKey) {
        accountsDataCache = null;
      }
      throw error;
    });

  accountsDataCache = { key: cacheKey, promise };
  return promise;
}
