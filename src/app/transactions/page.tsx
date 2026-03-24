import { TransactionsDashboard } from "@/components/transactions-dashboard";
import { loadBaseDashboardData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const data = await loadBaseDashboardData();
  return <TransactionsDashboard transactions={data.transactions} />;
}
