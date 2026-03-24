export type AssistantChartKind = "bar" | "line" | "pie" | "composed";

export type AssistantChartSeries = {
  key: string;
  label: string;
  color: string;
  kind?: "bar" | "line";
  stackId?: string;
};

export type AssistantChart = {
  title: string;
  note: string;
  kind: AssistantChartKind;
  layout?: "horizontal" | "vertical";
  data: Array<Record<string, string | number>>;
  xKey?: string;
  labelKey?: string;
  valueKey?: string;
  series?: AssistantChartSeries[];
};

export type AssistantTableColumn = {
  key: string;
  label: string;
  format?: "text" | "currency" | "signedCurrency" | "number";
};

export type AssistantTable = {
  title: string;
  note: string;
  columns: AssistantTableColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
};

export type AssistantConversationMessage = {
  role: "user" | "assistant";
  content: string;
  charts?: AssistantChart[];
  tables?: AssistantTable[];
};

export type AssistantApiResponse = {
  answer: string;
  charts: AssistantChart[];
  tables: AssistantTable[];
  model: string;
};
