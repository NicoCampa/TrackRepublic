import { TransactionsDashboard } from "@/components/transactions-dashboard";
import { loadBaseDashboardData } from "@/lib/dashboard-data";
import { loadManualTransactions, loadRowOverrides } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const [data, rowOverrides, manualTransactions] = await Promise.all([
    loadBaseDashboardData(),
    loadRowOverrides(),
    loadManualTransactions(),
  ]);
  return (
    <TransactionsDashboard
      transactions={data.transactions}
      rowOverrides={rowOverrides}
      manualTransactions={manualTransactions}
    />
  );
}
