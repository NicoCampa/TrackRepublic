import type { AssistantChart, AssistantTable } from "./assistant-types";
import type { DashboardData, TransactionRecord } from "./dashboard-data";
import {
  SPENDING_BUCKETS,
  applyCapitalFilters,
  applyTransactionFilters,
  buildSpendingMix,
  formatDisplayDate,
  monthlyReviewCounts,
  reviewSummary,
  sumIncome,
  sumInvesting,
  summarizeMonthlyStory,
  sumNetResult,
  sumSpending,
  topSpendingCategories,
  uniqueTransactionDates,
} from "./dashboard-utils";

const CHART_COLORS = {
  income: "hsl(160 84% 45%)",
  spending: "hsl(200 100% 60%)",
  investing: "hsl(330 100% 70%)",
  net: "hsl(45 100% 60%)",
  secondary: "hsl(280 100% 70%)",
};

type ToolContext = {
  data: DashboardData;
};

type ToolExecutionResult = {
  llmResult: Record<string, unknown>;
  chart?: AssistantChart;
  table?: AssistantTable;
};

type RangeArgs = {
  startDate?: string;
  endDate?: string;
  includeTransfers?: boolean;
};

type DescribeDataArgs = {
  includeTransfers?: boolean;
};

type SummarizeCashflowArgs = RangeArgs & {
  category?: string;
  merchantContains?: string;
};

type FindTransactionsArgs = RangeArgs & {
  category?: string;
  merchantContains?: string;
  group?: "income" | "expense" | "transfer" | "investment" | "tax" | "other";
  direction?: "inflow" | "outflow" | "any";
  recurringOnly?: boolean;
  reviewOnly?: boolean;
  limit?: number;
};

type CreateChartArgs = RangeArgs & {
  subject:
    | "monthly_cashflow"
    | "monthly_spending"
    | "monthly_income"
    | "monthly_investing"
    | "category_spending"
    | "merchant_spending"
    | "account_balances"
    | "review_queue"
    | "spending_mix";
  chartType?: "auto" | "bar" | "line" | "pie";
  category?: string;
  merchantContains?: string;
  limit?: number;
  reviewView?: "month" | "source";
};

export const ASSISTANT_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "describe_data",
      description: "Describe the available date range, row counts, and supported categories in the personal finance dataset.",
      parameters: {
        type: "object",
        properties: {
          includeTransfers: {
            type: "boolean",
            description: "Whether transfer rows should be counted in the transaction totals.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_cashflow",
      description: "Summarize income, spending, investing, and net result for a date range. Use this for numeric answers.",
      parameters: {
        type: "object",
        properties: {
          startDate: { type: "string", description: "Start date in YYYY-MM-DD format." },
          endDate: { type: "string", description: "End date in YYYY-MM-DD format." },
          includeTransfers: { type: "boolean", description: "Include transfer rows in the net result." },
          category: { type: "string", description: "Optional category label filter, for example Housing." },
          merchantContains: { type: "string", description: "Optional merchant text filter." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_transactions",
      description: "Return matching transaction rows. Use this when the user asks to list expenses, show rows, or inspect merchants.",
      parameters: {
        type: "object",
        properties: {
          startDate: { type: "string", description: "Start date in YYYY-MM-DD format." },
          endDate: { type: "string", description: "End date in YYYY-MM-DD format." },
          includeTransfers: { type: "boolean", description: "Include transfer rows." },
          category: { type: "string", description: "Optional category label filter." },
          merchantContains: { type: "string", description: "Optional merchant text filter." },
          group: {
            type: "string",
            enum: ["income", "expense", "transfer", "investment", "tax", "other"],
            description: "Optional raw group filter.",
          },
          direction: {
            type: "string",
            enum: ["inflow", "outflow", "any"],
            description: "Filter to inflows, outflows, or both.",
          },
          recurringOnly: { type: "boolean", description: "Only recurring transactions." },
          reviewOnly: { type: "boolean", description: "Only rows marked for manual checking." },
          limit: { type: "integer", description: "Maximum number of rows to return, capped at 80." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_chart",
      description:
        "Create a chart from the personal finance dataset. Use this whenever the user asks to plot, graph, visualize, compare trends, or show a pie chart.",
      parameters: {
        type: "object",
        required: ["subject"],
        properties: {
          subject: {
            type: "string",
            enum: [
              "monthly_cashflow",
              "monthly_spending",
              "monthly_income",
              "monthly_investing",
              "category_spending",
              "merchant_spending",
              "account_balances",
              "review_queue",
              "spending_mix",
            ],
            description: "The chart subject to visualize.",
          },
          chartType: {
            type: "string",
            enum: ["auto", "bar", "line", "pie"],
            description: "Preferred chart type. Auto lets the server choose a good default.",
          },
          startDate: { type: "string", description: "Start date in YYYY-MM-DD format." },
          endDate: { type: "string", description: "End date in YYYY-MM-DD format." },
          includeTransfers: { type: "boolean", description: "Include transfer rows when relevant." },
          category: { type: "string", description: "Optional category label filter." },
          merchantContains: { type: "string", description: "Optional merchant text filter." },
          limit: { type: "integer", description: "Limit the number of categories or merchants in ranking charts." },
          reviewView: {
            type: "string",
            enum: ["month", "source"],
            description: "For review_queue charts, group by month or source.",
          },
        },
      },
    },
  },
] as const;

function clampRange(dates: string[], args: RangeArgs) {
  const minDate = dates[0] ?? "";
  const maxDate = dates.at(-1) ?? "";
  const startDate = args.startDate && args.startDate >= minDate ? args.startDate : minDate;
  const endDate = args.endDate && args.endDate <= maxDate ? args.endDate : maxDate;
  if (!startDate || !endDate) {
    return { startDate: "", endDate: "" };
  }
  if (startDate > endDate) {
    return { startDate: endDate, endDate };
  }
  return { startDate, endDate };
}

function asFilterState(data: DashboardData, args: RangeArgs) {
  const dates = uniqueTransactionDates(data.transactions);
  const range = clampRange(dates, args);
  return {
    preset: "custom" as const,
    startDate: range.startDate,
    endDate: range.endDate,
    includeTransfers: Boolean(args.includeTransfers),
    excludeIncompleteMonths: false,
    activeQuickLabel: "",
    activeQuickKind: "" as const,
  };
}

function normalizeText(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function filterTransactionsWithArgs(data: DashboardData, args: FindTransactionsArgs | SummarizeCashflowArgs | CreateChartArgs) {
  const base = applyTransactionFilters(data.transactions, asFilterState(data, args));
  return base.filter((row) => {
    if ("category" in args && args.category && row.categoryLabel !== args.category) {
      return false;
    }
    if ("merchantContains" in args && args.merchantContains) {
      const needle = normalizeText(args.merchantContains);
      const haystack = `${row.merchant} ${row.description}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    if ("group" in args && args.group && row.group !== args.group) {
      return false;
    }
    if ("direction" in args && args.direction === "inflow" && row.signedAmount <= 0) {
      return false;
    }
    if ("direction" in args && args.direction === "outflow" && row.signedAmount >= 0) {
      return false;
    }
    if ("recurringOnly" in args && args.recurringOnly && !row.isRecurring) {
      return false;
    }
    if ("reviewOnly" in args && args.reviewOnly && !row.needsReview) {
      return false;
    }
    return true;
  });
}

function topMerchantSpending(rows: TransactionRecord[], limit = 8) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!SPENDING_BUCKETS.has(row.cashflowBucket) || row.signedAmount >= 0) {
      continue;
    }
    totals.set(row.merchant, (totals.get(row.merchant) ?? 0) + Math.abs(row.signedAmount));
  }
  return [...totals.entries()]
    .map(([merchant, amount]) => ({ merchant, amount }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

function summarizeIncomeByMonth(rows: TransactionRecord[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.group === "income" && row.signedAmount > 0) {
      totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + row.signedAmount);
    }
  }
  return [...totals.entries()]
    .map(([monthLabel, amount]) => ({ monthLabel, amount }))
    .sort((left, right) => left.monthLabel.localeCompare(right.monthLabel));
}

function summarizeSpendingByMonth(rows: TransactionRecord[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (SPENDING_BUCKETS.has(row.cashflowBucket) && row.signedAmount < 0) {
      totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + Math.abs(row.signedAmount));
    }
  }
  return [...totals.entries()]
    .map(([monthLabel, amount]) => ({ monthLabel, amount }))
    .sort((left, right) => left.monthLabel.localeCompare(right.monthLabel));
}

function summarizeInvestingByMonth(rows: TransactionRecord[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.group === "investment") {
      totals.set(row.monthLabel, (totals.get(row.monthLabel) ?? 0) + -row.signedAmount);
    }
  }
  return [...totals.entries()]
    .map(([monthLabel, amount]) => ({ monthLabel, amount }))
    .sort((left, right) => left.monthLabel.localeCompare(right.monthLabel));
}

function buildTransactionsTable(title: string, note: string, rows: TransactionRecord[]): AssistantTable {
  return {
    title,
    note,
    columns: [
      { key: "date", label: "Date" },
      { key: "merchant", label: "Merchant" },
      { key: "category", label: "Category" },
      { key: "amount", label: "Amount", format: "signedCurrency" },
      { key: "description", label: "Description" },
    ],
    rows: rows.map((row) => ({
      date: formatDisplayDate(row.date),
      merchant: row.merchant,
      category: row.categoryLabel,
      amount: row.signedAmount,
      description: row.description,
    })),
  };
}

function chartFromSubject(data: DashboardData, args: CreateChartArgs): ToolExecutionResult {
  const filteredTransactions = filterTransactionsWithArgs(data, args);
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 16);

  if (args.subject === "monthly_cashflow") {
    const rows = summarizeMonthlyStory(filteredTransactions).map((row) => ({
      monthLabel: row.monthLabel,
      income: row.income,
      spending: row.spending,
      investing: row.investing,
      netResult: row.netResult,
    }));
    return {
      chart: {
        title: "Monthly cashflow",
        note: "In, out, investing, and the final net result by month.",
        kind: args.chartType === "line" ? "line" : "composed",
        data: rows,
        xKey: "monthLabel",
        series: [
          { key: "income", label: "In", color: CHART_COLORS.income, kind: "bar" },
          { key: "spending", label: "Out", color: CHART_COLORS.spending, kind: "bar" },
          { key: "investing", label: "Investing", color: CHART_COLORS.investing, kind: "bar" },
          { key: "netResult", label: "Net result", color: CHART_COLORS.net, kind: "line" },
        ],
      },
      llmResult: {
        subject: "monthly_cashflow",
        rows,
      },
    };
  }

  if (args.subject === "monthly_spending") {
    const rows = summarizeSpendingByMonth(filteredTransactions);
    return {
      chart: {
        title: args.category ? `${args.category} out by month` : "Out by month",
        note: args.category ? `Monthly outflows for ${args.category}.` : "Monthly spending totals across the selected range.",
        kind: args.chartType === "line" ? "line" : "bar",
        data: rows,
        xKey: "monthLabel",
        series: [{ key: "amount", label: "Out", color: CHART_COLORS.spending, kind: args.chartType === "line" ? "line" : "bar" }],
      },
      llmResult: {
        subject: "monthly_spending",
        rows,
      },
    };
  }

  if (args.subject === "monthly_income") {
    const rows = summarizeIncomeByMonth(filteredTransactions);
    return {
      chart: {
        title: "In by month",
        note: "Positive income flows by month.",
        kind: args.chartType === "bar" ? "bar" : "line",
        data: rows,
        xKey: "monthLabel",
        series: [{ key: "amount", label: "In", color: CHART_COLORS.income, kind: args.chartType === "bar" ? "bar" : "line" }],
      },
      llmResult: {
        subject: "monthly_income",
        rows,
      },
    };
  }

  if (args.subject === "monthly_investing") {
    const rows = summarizeInvestingByMonth(filteredTransactions);
    return {
      chart: {
        title: "Money invested by month",
        note: "Book-value money moved into investments each month.",
        kind: args.chartType === "line" ? "line" : "bar",
        data: rows,
        xKey: "monthLabel",
        series: [{ key: "amount", label: "Money invested", color: CHART_COLORS.investing, kind: args.chartType === "line" ? "line" : "bar" }],
      },
      llmResult: {
        subject: "monthly_investing",
        rows,
      },
    };
  }

  if (args.subject === "category_spending") {
    const rows = topSpendingCategories(filteredTransactions, limit).map((row) => ({
      label: row.categoryLabel,
      amount: row.amount,
    }));
    return {
      chart: {
        title: "Out by category",
        note: "Largest spending categories in the selected slice.",
        kind: args.chartType === "pie" ? "pie" : "bar",
        layout: args.chartType === "pie" ? "horizontal" : "vertical",
        data: rows,
        xKey: "label",
        labelKey: "label",
        valueKey: "amount",
        series: [{ key: "amount", label: "Out", color: CHART_COLORS.secondary, kind: "bar" }],
      },
      llmResult: {
        subject: "category_spending",
        rows,
      },
    };
  }

  if (args.subject === "merchant_spending") {
    const rows = topMerchantSpending(filteredTransactions, limit).map((row) => ({
      label: row.merchant,
      amount: row.amount,
    }));
    return {
      chart: {
        title: "Out by merchant",
        note: "Highest-cost merchants in the selected slice.",
        kind: args.chartType === "pie" ? "pie" : "bar",
        layout: args.chartType === "pie" ? "horizontal" : "vertical",
        data: rows,
        xKey: "label",
        labelKey: "label",
        valueKey: "amount",
        series: [{ key: "amount", label: "Out", color: CHART_COLORS.secondary, kind: "bar" }],
      },
      llmResult: {
        subject: "merchant_spending",
        rows,
      },
    };
  }

  if (args.subject === "account_balances") {
    const points = applyCapitalFilters(data.capitalSeries, asFilterState(data, args)).map((row) => ({
      date: formatDisplayDate(row.date),
      availableCash: row.availableCash,
      investedCapital: row.investedCapital,
      trackedCapital: row.trackedCapital,
    }));
    return {
      chart: {
        title: "Account balances",
        note: "Available cash plus historical investment cost basis over time.",
        kind: "line",
        data: points,
        xKey: "date",
        series: [
          { key: "availableCash", label: "Available cash", color: CHART_COLORS.income, kind: "line" },
          { key: "investedCapital", label: "Money invested", color: CHART_COLORS.investing, kind: "line" },
          { key: "trackedCapital", label: "Cash + invested money", color: CHART_COLORS.net, kind: "line" },
        ],
      },
      llmResult: {
        subject: "account_balances",
      rows: points.slice(-12),
      },
    };
  }

  if (args.subject === "review_queue") {
    if (args.reviewView === "source") {
      const rows = reviewSummary(filteredTransactions);
      return {
        chart: {
          title: "Transactions to check by source",
          note: "Where the current review queue is coming from.",
          kind: args.chartType === "bar" ? "bar" : "pie",
          layout: args.chartType === "bar" ? "vertical" : "horizontal",
          data: rows.map((row) => ({ label: row.name, amount: row.value })),
          xKey: "label",
          labelKey: "label",
          valueKey: "amount",
          series: [{ key: "amount", label: "Rows", color: CHART_COLORS.secondary, kind: "bar" }],
        },
        llmResult: {
          subject: "review_queue",
          rows,
        },
      };
    }

    const rows = monthlyReviewCounts(filteredTransactions).map((row) => ({
      monthLabel: row.monthLabel,
      rows: row.rows,
    }));
    return {
      chart: {
        title: "Transactions to check by month",
        note: "Review queue volume across the selected period.",
        kind: "bar",
        data: rows,
        xKey: "monthLabel",
        series: [{ key: "rows", label: "Rows", color: CHART_COLORS.net, kind: "bar" }],
      },
      llmResult: {
        subject: "review_queue",
        rows,
      },
    };
  }

  const rows = buildSpendingMix(filteredTransactions).map((row) => ({
    label: row.name,
    amount: row.value,
  }));
  return {
    chart: {
      title: "Out mix",
      note: "Recurring bills, flexible spending, and taxes.",
      kind: "pie",
      data: rows,
      labelKey: "label",
      valueKey: "amount",
    },
    llmResult: {
      subject: "spending_mix",
      rows,
    },
  };
}

function describeData(context: ToolContext, args: DescribeDataArgs): ToolExecutionResult {
  const data = context.data;
  const filtered = applyTransactionFilters(data.transactions, asFilterState(data, { includeTransfers: args.includeTransfers }));
  const categories = [...new Set(data.transactions.map((row) => row.categoryLabel))].sort();
  const groups = [...new Set(data.transactions.map((row) => row.groupLabel))].sort();
  return {
    llmResult: {
      dateRange: {
        startDate: data.transactions.at(0)?.date ?? "",
        endDate: data.transactions.at(-1)?.date ?? "",
      },
      counts: {
        transactions: filtered.length,
        rowsToCheck: filtered.filter((row) => row.needsReview).length,
        recurringRows: filtered.filter((row) => row.isRecurring).length,
        reserveFundRows: data.fundRows.length,
      },
      groups,
      categories,
      notes: [
        "Available cash includes the money market fund.",
        "Historical investment charts use book value.",
        "The Accounts page uses live quotes for the current portfolio total.",
      ],
    },
  };
}

function summarizeCashflow(context: ToolContext, args: SummarizeCashflowArgs): ToolExecutionResult {
  const rows = filterTransactionsWithArgs(context.data, args);
  return {
    llmResult: {
      range: clampRange(uniqueTransactionDates(context.data.transactions), args),
      totals: {
        income: sumIncome(rows),
        spending: sumSpending(rows),
        investing: sumInvesting(rows),
        netResult: sumNetResult(rows),
      },
      counts: {
        transactions: rows.length,
        rowsToCheck: rows.filter((row) => row.needsReview).length,
      },
      topSpendingCategories: topSpendingCategories(rows, 5),
    },
  };
}

function findTransactions(context: ToolContext, args: FindTransactionsArgs): ToolExecutionResult {
  const rows = filterTransactionsWithArgs(context.data, args)
    .slice()
    .sort((left, right) => (right.date === left.date ? Math.abs(right.signedAmount) - Math.abs(left.signedAmount) : right.date.localeCompare(left.date)))
    .slice(0, Math.min(Math.max(args.limit ?? 20, 1), 80));

  return {
    table: buildTransactionsTable("Matching transactions", "Rows that match the current assistant request.", rows),
    llmResult: {
      count: rows.length,
      rows: rows.map((row) => ({
        date: formatDisplayDate(row.date),
        merchant: row.merchant,
        category: row.categoryLabel,
        amount: row.signedAmount,
        description: row.description,
      })),
    },
  };
}

export async function runAssistantTool(name: string, rawArguments: unknown, context: ToolContext): Promise<ToolExecutionResult> {
  const args = (rawArguments ?? {}) as Record<string, unknown>;

  if (name === "describe_data") {
    return describeData(context, args as DescribeDataArgs);
  }
  if (name === "summarize_cashflow") {
    return summarizeCashflow(context, args as SummarizeCashflowArgs);
  }
  if (name === "find_transactions") {
    return findTransactions(context, args as FindTransactionsArgs);
  }
  if (name === "create_chart") {
    return chartFromSubject(context.data, args as CreateChartArgs);
  }

  return {
    llmResult: {
      error: `Unknown tool: ${name}`,
    },
  };
}
