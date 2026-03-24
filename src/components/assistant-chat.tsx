"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Bot, ChartColumnBig, Database, LoaderCircle, MessageSquareText, SendHorizonal, TableProperties } from "lucide-react";
import { clearQueuedAssistantDraft, readQueuedAssistantDraft } from "./app-frame";
import { DashboardShell, DataTable, Panel, SignedAmount, chartTooltipContentStyle } from "./dashboard-ui";
import { formatEuro, formatMaybeDisplayDate } from "@/lib/dashboard-utils";
import type { AssistantApiResponse, AssistantChart, AssistantConversationMessage, AssistantTable } from "@/lib/assistant-types";

const STARTER_PROMPTS = [
  {
    title: "Monthly cashflow",
    note: "Compare in, out, investing, and net result in one chart.",
    prompt: "Plot my monthly cashflow for the last 12 months.",
  },
  {
    title: "Category breakdown",
    note: "See what categories are driving the most money out.",
    prompt: "Plot my out by category for the last 12 months.",
  },
  {
    title: "Find transactions",
    note: "Pull a concrete list of rows to review or verify.",
    prompt: "List my housing transactions from the last 3 months.",
  },
  {
    title: "Portfolio and cash",
    note: "Track available cash and money invested over time.",
    prompt: "Plot available cash and money invested over time.",
  },
] as const;

const CAPABILITY_ITEMS = [
  {
    icon: MessageSquareText,
    title: "Answer questions",
    note: "Summaries, comparisons, and quick explanations from your local ledger.",
  },
  {
    icon: ChartColumnBig,
    title: "Build charts",
    note: "Bar, line, pie, and combined charts for trends and mixes.",
  },
  {
    icon: TableProperties,
    title: "List rows",
    note: "Transactions by merchant, category, period, or review status.",
  },
  {
    icon: Database,
    title: "Stay grounded",
    note: "Answers come from local statement data, with transfers excluded unless you ask.",
  },
] as const;

const PIE_COLORS = [
  "hsl(160 84% 45%)",
  "hsl(200 100% 60%)",
  "hsl(330 100% 70%)",
  "hsl(45 100% 60%)",
  "hsl(280 100% 70%)",
  "hsl(190 100% 50%)",
];

function renderTableValue(table: AssistantTable, row: Record<string, string | number | boolean | null>, key: string) {
  const column = table.columns.find((item) => item.key === key);
  const value = row[key];
  if (column?.format === "currency") {
    return <span>{formatEuro(Number(value ?? 0))}</span>;
  }
  if (column?.format === "signedCurrency") {
    return <SignedAmount value={Number(value ?? 0)} />;
  }
  if (column?.format === "number") {
    return <span>{Number(value ?? 0).toLocaleString("en-US")}</span>;
  }
  if (column?.key === "date" && typeof value === "string") {
    return <span>{formatMaybeDisplayDate(value)}</span>;
  }
  return <span>{String(value ?? "")}</span>;
}

function AssistantChartPanel({ chart }: { chart: AssistantChart }) {
  const xKey = chart.xKey ?? chart.labelKey ?? "label";
  const labelKey = chart.labelKey ?? xKey;
  const valueKey = chart.valueKey ?? chart.series?.[0]?.key ?? "amount";

  return (
    <Panel title={chart.title} note={chart.note}>
      <div className="chart-box chart-assistant">
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === "pie" ? (
            <PieChart>
              <Pie data={chart.data} dataKey={valueKey} nameKey={labelKey} innerRadius={70} outerRadius={112} paddingAngle={6}>
                {chart.data.map((entry, index) => (
                  <Cell key={`${chart.title}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={chartTooltipContentStyle}
                formatter={(value) => formatEuro(Number(value ?? 0))}
              />
              <Legend iconType="circle" />
            </PieChart>
          ) : chart.kind === "line" ? (
            <LineChart data={chart.data}>
              <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
              <XAxis dataKey={xKey} stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
              <Tooltip
                contentStyle={chartTooltipContentStyle}
                formatter={(value) => formatEuro(Number(value ?? 0))}
              />
              <Legend iconType="circle" />
              {chart.series?.map((series) => (
                <Line
                  key={series.key}
                  type="monotone"
                  dataKey={series.key}
                  name={series.label}
                  stroke={series.color}
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              ))}
            </LineChart>
          ) : chart.kind === "composed" ? (
            <ComposedChart data={chart.data}>
              <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={false} />
              <XAxis dataKey={xKey} stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
              <Tooltip
                contentStyle={chartTooltipContentStyle}
                formatter={(value) => formatEuro(Number(value ?? 0))}
              />
              <Legend iconType="circle" />
              {chart.series?.map((series) =>
                series.kind === "line" ? (
                  <Line
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={series.label}
                    stroke={series.color}
                    strokeWidth={3}
                    dot={{ r: 5, strokeWidth: 0 }}
                  />
                ) : (
                  <Bar key={series.key} dataKey={series.key} name={series.label} fill={series.color} barSize={22} />
                ),
              )}
            </ComposedChart>
          ) : (
            <BarChart data={chart.data} layout={chart.layout === "vertical" ? "vertical" : "horizontal"} margin={chart.layout === "vertical" ? { left: 12, right: 12 } : undefined}>
              <CartesianGrid stroke="rgba(223,231,243,0.08)" vertical={chart.layout === "vertical" ? false : true} horizontal={chart.layout === "vertical" ? true : false} />
              {chart.layout === "vertical" ? (
                <>
                  <XAxis type="number" stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
                  <YAxis type="category" dataKey={xKey} width={168} stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} />
                </>
              ) : (
                <>
                  <XAxis dataKey={xKey} stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--text-muted))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(val) => `€${val}`} />
                </>
              )}
              <Tooltip
                contentStyle={chartTooltipContentStyle}
                formatter={(value) => formatEuro(Number(value ?? 0))}
              />
              {chart.series ? (
                chart.series.map((series) => (
                  <Bar key={series.key} dataKey={series.key} name={series.label} fill={series.color} barSize={24} />
                ))
              ) : (
                <Bar dataKey={valueKey} fill={PIE_COLORS[0]} barSize={24} />
              )}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function AssistantTablePanel({ table }: { table: AssistantTable }) {
  const typedRows = table.rows as Array<Record<string, string | number | boolean | null>>;
  return (
    <Panel title={table.title} note={table.note}>
      <DataTable
        rows={typedRows}
        columns={table.columns.map((column) => ({
          key: column.key,
          label: column.label,
          render: (_value, row) => renderTableValue(table, row as Record<string, string | number | boolean | null>, column.key),
        }))}
      />
    </Panel>
  );
}

export function AssistantChat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AssistantConversationMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [modelName, setModelName] = useState("qwen3.5:9b");
  const [error, setError] = useState("");
  const [lastAutoPrompt, setLastAutoPrompt] = useState("");
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const modelBadge = useMemo(() => `Model: ${modelName}`, [modelName]);

  const sendPrompt = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) {
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setError("");

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message ?? `Assistant request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as AssistantApiResponse;
      setModelName(payload.model);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: payload.answer,
          charts: payload.charts,
          tables: payload.tables,
        },
      ]);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unknown assistant error.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isLoading) {
      return;
    }
    const promptFromUrl =
      typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("prompt")?.trim() ?? "";
    const queued = readQueuedAssistantDraft();
    const autoPrompt = promptFromUrl || queued;
    if (!autoPrompt || autoPrompt === lastAutoPrompt) {
      return;
    }
    clearQueuedAssistantDraft();
    setLastAutoPrompt(autoPrompt);
    if (promptFromUrl && typeof window !== "undefined") {
      window.history.replaceState({}, "", "/assistant");
    }
    void sendPrompt(autoPrompt);
  }, [isLoading, lastAutoPrompt]);

  useEffect(() => {
    if (!threadEndRef.current) {
      return;
    }
    threadEndRef.current.scrollIntoView({
      behavior: messages.length > 0 ? "smooth" : "auto",
      block: "end",
    });
  }, [messages, isLoading]);

  const hasConversation = messages.length > 0 || isLoading;

  const sendCurrentInput = () => {
    void sendPrompt(input);
  };

  return (
    <DashboardShell
      kicker="Utility"
      title="Ask AI"
      description="Chat with your ledger, request charts, and inspect transactions."
      meta="Answers use your local statement data"
    >
      <section className="assistant-page">
        <div className="assistant-workspace">
          <section className="assistant-chat-shell">
            <div className="assistant-chat-head">
              <div className="assistant-chat-intro">
                <div className="assistant-chat-kicker">Ledger chatbot</div>
                <h2>Ask questions in plain English</h2>
                <p>{modelBadge} · Charts, tables, and answers are grounded in your local statement data.</p>
              </div>
              <div className="assistant-chat-status">
                <span className="assistant-status-pill">Local model</span>
                <span className="assistant-status-pill">Local data</span>
                <span className="assistant-status-pill">Charts and tables</span>
              </div>
            </div>

            {error ? <div className="assistant-error">{error}</div> : null}

            <div className="assistant-thread-scroll">
              {!hasConversation ? (
                <div className="assistant-welcome">
                  <div className="assistant-row" data-role="assistant">
                    <div className="assistant-avatar">
                      <Bot size={18} />
                    </div>
                    <div className="assistant-bubble">
                      <div className="assistant-message-meta">
                        <span>Assistant</span>
                      </div>
                      <div className="assistant-message-body">
                        <p>Ask about spending, portfolio, balances, or specific merchants.</p>
                        <p>I can answer directly, list matching rows, and generate charts from the data already in this app.</p>
                      </div>
                    </div>
                  </div>

                  <div className="assistant-starter-grid">
                    {STARTER_PROMPTS.map((item) => (
                      <button
                        key={item.prompt}
                        type="button"
                        className="assistant-starter-card"
                        onClick={() => void sendPrompt(item.prompt)}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.note}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="assistant-thread">
                  {messages.map((message, index) => {
                    const chartCount = message.charts?.length ?? 0;
                    const tableCount = message.tables?.length ?? 0;

                    return (
                      <article key={`${message.role}-${index}`} className="assistant-row" data-role={message.role}>
                        <div className="assistant-avatar">
                          {message.role === "assistant" ? <Bot size={18} /> : <span>You</span>}
                        </div>
                        <div className="assistant-bubble">
                          <div className="assistant-message-meta">
                            <span>{message.role === "user" ? "You" : "Assistant"}</span>
                            {chartCount + tableCount > 0 ? (
                              <div className="assistant-message-tags">
                                {chartCount > 0 ? <span>{chartCount} chart{chartCount > 1 ? "s" : ""}</span> : null}
                                {tableCount > 0 ? <span>{tableCount} table{tableCount > 1 ? "s" : ""}</span> : null}
                              </div>
                            ) : null}
                          </div>
                          <div className="assistant-message-body">
                            {message.content.split("\n").map((line, lineIndex) => (
                              <p key={lineIndex}>{line}</p>
                            ))}
                          </div>

                          {message.charts && message.charts.length > 0 ? (
                            <div className="assistant-visual-grid">
                              {message.charts.map((chart, chartIndex) => (
                                <AssistantChartPanel key={`${chart.title}-${chartIndex}`} chart={chart} />
                              ))}
                            </div>
                          ) : null}

                          {message.tables && message.tables.length > 0 ? (
                            <div className="assistant-table-stack">
                              {message.tables.map((table, tableIndex) => (
                                <AssistantTablePanel key={`${table.title}-${tableIndex}`} table={table} />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}

                  {isLoading ? (
                    <article className="assistant-row" data-role="assistant">
                      <div className="assistant-avatar">
                        <Bot size={18} />
                      </div>
                      <div className="assistant-bubble assistant-bubble-loading">
                        <div className="assistant-message-meta">
                          <span>Assistant</span>
                        </div>
                        <div className="assistant-loading-line">
                          <LoaderCircle size={16} className="spin" />
                          <span>Thinking through the data…</span>
                        </div>
                      </div>
                    </article>
                  ) : null}

                  <div ref={threadEndRef} />
                </div>
              )}
            </div>

            <form
              className="assistant-composer"
              onSubmit={(event) => {
                event.preventDefault();
                sendCurrentInput();
              }}
            >
              <div className="assistant-composer-box">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendCurrentInput();
                    }
                  }}
                  placeholder="Ask about spending, merchants, balances, trends, or request a chart."
                  rows={3}
                />
                <div className="assistant-composer-actions">
                  <div className="assistant-composer-hint">
                    <span>Enter to send</span>
                    <span>Shift+Enter for a new line</span>
                  </div>
                  <button type="submit" className="assistant-send-button" disabled={isLoading}>
                    {isLoading ? <LoaderCircle size={16} className="spin" /> : <SendHorizonal size={16} />}
                    {isLoading ? "Thinking..." : "Send"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>

        <aside className="assistant-rail">
          <section className="assistant-rail-section">
            <div className="assistant-rail-kicker">Try these</div>
            <h3>Starter prompts</h3>
            <div className="assistant-rail-prompts">
              {STARTER_PROMPTS.map((item) => (
                <button key={item.prompt} type="button" className="assistant-rail-prompt" onClick={() => void sendPrompt(item.prompt)}>
                  <strong>{item.title}</strong>
                  <span>{item.prompt}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="assistant-rail-section">
            <div className="assistant-rail-kicker">What it does</div>
            <h3>Grounded assistant</h3>
            <div className="assistant-capability-list">
              {CAPABILITY_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="assistant-capability-item">
                    <span className="assistant-capability-icon">
                      <Icon size={16} />
                    </span>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.note}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="assistant-rail-section">
            <div className="assistant-rail-kicker">Session</div>
            <h3>Current context</h3>
            <div className="assistant-session-grid">
              <div className="assistant-session-item">
                <span>Model</span>
                <strong>{modelName}</strong>
              </div>
              <div className="assistant-session-item">
                <span>Scope</span>
                <strong>Local statement data</strong>
              </div>
              <div className="assistant-session-item">
                <span>Outputs</span>
                <strong>Answers, charts, tables</strong>
              </div>
            </div>
          </section>
        </aside>
      </section>
    </DashboardShell>
  );
}
