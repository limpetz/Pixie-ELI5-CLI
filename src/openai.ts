import type { ChatMessage, ChatResponse, ProviderConfig, TokenCallback, ToolSchema } from "./types.js";
import { StreamFilter } from "./stream.js";
import { tryParseToolCall, stripNarratedCall } from "./toolparse.js";

/** Maps our internal messages to the OpenAI chat wire format. */
function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * OpenAI-compatible backend — works with OpenAI, Groq, OpenRouter, Together,
 * LM Studio, or any server that speaks the /chat/completions protocol.
 * This is Pixie's upgrade path when you want a stronger cloud brain.
 * Streams SSE deltas when onToken is provided.
 */
export async function openaiChat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  temperature = 0.4,
  onToken?: TokenCallback,
): Promise<ChatResponse> {
  const stream = onToken !== undefined;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: toOpenAIMessages(messages),
      temperature,
      stream,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) throw new Error("API returned no response body");

  let content = "";
  const toolAcc = new Map<number, { id?: string; name: string; args: string }>();

  if (stream) {
    const filter = new StreamFilter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneStreaming = false;
    while (!doneStreaming) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          doneStreaming = true;
          break;
        }
        type Delta = {
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        let evt: Delta;
        try {
          evt = JSON.parse(payload) as Delta;
        } catch {
          continue;
        }
        const d = evt.choices?.[0]?.delta;
        if (d?.content) {
          content += d.content;
          const shown = filter.filter(d.content);
          if (shown) onToken?.(shown);
        }
        for (const tc of d?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = toolAcc.get(i) ?? { id: tc.id, name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(i, cur);
        }
      }
    }
    const tail = filter.flush();
    if (tail) onToken?.(tail);
  } else {
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    const msg = data.choices?.[0]?.message;
    content = msg?.content ?? "";
    (msg?.tool_calls ?? []).forEach((tc, i) => {
      toolAcc.set(i, { id: tc.id, name: tc.function?.name ?? "unknown", args: tc.function?.arguments ?? "" });
    });
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc], j) => {
      let args: Record<string, unknown> = {};
      try {
        args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      return { id: tc.id ?? `call_${j}_${Date.now()}`, name: tc.name || "unknown", args };
    });

  if (toolCalls.length === 0 && content) {
    const parsed = tryParseToolCall(content);
    if (parsed) {
      toolCalls.push({ id: `call_0_${Date.now()}`, name: parsed.name, args: parsed.args });
      // Keep only prose: drop the narrated call AND any fake tool output the
      // model invented after it (```json result blocks, "# Response" trailers),
      // so a hallucinated result never enters the conversation history.
      content = stripNarratedCall(content);
    }
  }
  return { content, toolCalls };
}
