import { loadAccountsData } from "@/lib/accounts-data";
import { OverviewDashboard } from "@/components/overview-dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const data = await loadAccountsData();
  return <OverviewDashboard data={data} />;
}
