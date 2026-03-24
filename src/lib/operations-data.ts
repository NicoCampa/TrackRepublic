import { existsSync, statSync } from "node:fs";
import { CATEGORY_CACHE_PATH, PIPELINE_SUMMARY_PATH, loadPipelineSummarySync, type PipelineSummary } from "./config-store";
import { getBaseDashboardSnapshotKey, loadBaseDashboardData } from "./dashboard-data";
import { readCacheInspection } from "./pipeline-jobs";

export type OperationsData = {
  transactions: Awaited<ReturnType<typeof loadBaseDashboardData>>["transactions"];
  pipelineSummary: PipelineSummary | null;
  cache: Awaited<ReturnType<typeof readCacheInspection>>;
};

type PromiseCacheEntry<T> = {
  key: string;
  promise: Promise<T>;
};

let operationsDataCache: PromiseCacheEntry<OperationsData> | null = null;

function buildOperationsSnapshotKey() {
  const files = [CATEGORY_CACHE_PATH, PIPELINE_SUMMARY_PATH];
  return files
    .map((filePath) => {
      if (!existsSync(filePath)) {
        return `${filePath}:missing`;
      }
      const stats = statSync(filePath);
      return `${filePath}:${stats.mtimeMs}:${stats.size}`;
    })
    .join("|");
}

export async function loadOperationsData(): Promise<OperationsData> {
  const cacheKey = `${getBaseDashboardSnapshotKey()}:${buildOperationsSnapshotKey()}`;
  if (operationsDataCache?.key === cacheKey) {
    return operationsDataCache.promise;
  }

  const promise = Promise.resolve()
    .then(async () => {
      const [dashboardData, cache] = await Promise.all([
        loadBaseDashboardData(),
        readCacheInspection(),
      ]);

      return {
        transactions: dashboardData.transactions,
        pipelineSummary: loadPipelineSummarySync(),
        cache,
      };
    })
    .catch((error) => {
      if (operationsDataCache?.key === cacheKey) {
        operationsDataCache = null;
      }
      throw error;
    });

  operationsDataCache = { key: cacheKey, promise };
  return promise;
}
