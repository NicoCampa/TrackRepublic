import { OperationsDashboard } from "@/components/operations-dashboard";
import { loadOperationsData } from "@/lib/operations-data";

export const dynamic = "force-dynamic";

export default async function LoadDataPage() {
  const data = await loadOperationsData();
  return <OperationsDashboard data={data} />;
}
