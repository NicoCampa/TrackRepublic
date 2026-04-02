import { PortfolioDashboard } from "@/components/portfolio-dashboard";
import { loadAccountsData } from "@/lib/accounts-data";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const data = await loadAccountsData();
  return <PortfolioDashboard data={data} />;
}
