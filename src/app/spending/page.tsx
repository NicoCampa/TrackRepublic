import { TrendDashboard } from "@/components/trend-dashboard";
import { loadAccountsData } from "@/lib/accounts-data";

export const dynamic = "force-dynamic";

export default async function SpendingPage() {
  const data = await loadAccountsData();
  return <TrendDashboard data={data} />;
}
