import { loadBaseDashboardData } from "@/lib/dashboard-data";
import { OverviewDashboard } from "@/components/overview-dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const data = await loadBaseDashboardData();
  return <OverviewDashboard transactions={data.transactions} />;
}
