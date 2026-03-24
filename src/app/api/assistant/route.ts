import { NextResponse } from "next/server";
import { ASSISTANT_TOOL_DEFINITIONS, runAssistantTool } from "@/lib/assistant-tools";
import { loadDashboardData } from "@/lib/dashboard-data";
import type { AssistantApiResponse, AssistantConversationMessage } from "@/lib/assistant-types";

const MODEL = process.env.CASHFLOW_ASSISTANT_MODEL ?? "qwen3.5:9b";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434/api/chat";

type OllamaToolCall = {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

type OllamaChatResponse = {
  message?: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
};

function buildSystemPrompt(dateRange: { startDate: string; endDate: string }, categories: string[]) {
  return [
    "You are the local finance assistant inside a personal cashflow dashboard.",
    "Use the provided tools for every numeric claim, list of rows, or chart request.",
    "Do not invent amounts, dates, categories, or balances.",
    "When the user asks for a chart, graph, plot, pie, line, or trend, call create_chart.",
    "When the user asks to list expenses or transactions, call find_transactions.",
    "Keep answers short, plain English, and focused on what the data shows.",
    "Important business rules:",
    "- Available cash includes the money market fund.",
    "- Historical investment charts use book-value deployed capital.",
    "- The Accounts page also shows current market value using live quotes and positions from the latest statement.",
    "- Transfers are excluded by default unless the user explicitly wants them included.",
    `Available date range: ${dateRange.startDate} to ${dateRange.endDate}.`,
    `Known categories: ${categories.join(", ")}.`,
  ].join("\n");
}

async function callOllama(messages: Array<Record<string, unknown>>) {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: {
        temperature: 0.15,
      },
      messages,
      tools: ASSISTANT_TOOL_DEFINITIONS,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as OllamaChatResponse;
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { messages?: AssistantConversationMessage[] };
    const inputMessages = (body.messages ?? [])
      .filter((message) => message && (message.role === "user" || message.role === "assistant"))
      .slice(-10)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const data = await loadDashboardData();
    const categories = [...new Set(data.transactions.map((row) => row.categoryLabel))].sort();

    const messages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: buildSystemPrompt(
          {
            startDate: data.transactions.at(0)?.date ?? "",
            endDate: data.transactions.at(-1)?.date ?? "",
          },
          categories,
        ),
      },
      ...inputMessages,
    ];

    const charts: AssistantApiResponse["charts"] = [];
    const tables: AssistantApiResponse["tables"] = [];

    for (let step = 0; step < 4; step += 1) {
      const payload = await callOllama(messages);
      const assistant = payload.message;

      if (!assistant) {
        throw new Error("Ollama returned no message.");
      }

      const toolCalls = assistant.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return NextResponse.json<AssistantApiResponse>({
          answer: assistant.content.trim() || "I could not produce a useful answer from the current data slice.",
          charts,
          tables,
          model: MODEL,
        });
      }

      messages.push({
        role: "assistant",
        content: assistant.content ?? "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result = await runAssistantTool(toolCall.function.name, toolCall.function.arguments, { data });
        if (result.chart) {
          charts.push(result.chart);
        }
        if (result.table) {
          tables.push(result.table);
        }
        messages.push({
          role: "tool",
          tool_name: toolCall.function.name,
          content: JSON.stringify(result.llmResult),
        });
      }
    }

    return NextResponse.json<AssistantApiResponse>({
      answer: "I reached the tool-call limit before producing a final answer. Please ask a narrower question.",
      charts,
      tables,
      model: MODEL,
    });
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error ? error.message : "Unknown assistant error.",
      },
      { status: 500 },
    );
  }
}
