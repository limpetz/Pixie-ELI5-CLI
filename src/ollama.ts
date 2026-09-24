import type { ChatMessage, ChatResponse, ProviderConfig, TokenCallback, ToolSchema } from "./types.js";
import { StreamFilter } from "./stream.js";
import { tryParseToolCall, stripNarratedCall } from "./toolparse.js";

/** Maps our internal messages to Ollama's expected wire format. */
function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.args },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.name ?? "" };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Ollama backend — talks to the local Ollama daemon (http://localhost:11434).
 * This is Pixie's default brain: free, private, runs on your own GPU.
 * Streams NDJSON chunks; passes prose to onToken as it arrives.
 */
export async function ollamaChat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  temperature = 0.4,
  onToken?: TokenCallback,
): Promise<ChatResponse> {
  const stream = onToken !== undefined;
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: toOllamaMessages(messages),
      // Ollama expects OpenAI-style wrapped tool definitions.
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      stream,
      options: { temperature },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) throw new Error("Ollama returned no response body");

  type WireToolCall = { id?: string; function?: { name?: string; arguments?: Record<string, unknown> } };
  let content = "";
  const wireToolCalls: WireToolCall[] = [];

  if (stream) {
    const filter = new StreamFilter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt: { message?: { content?: string; tool_calls?: WireToolCall[] }; done?: boolean };
        try {
          evt = JSON.parse(line) as typeof evt;
        } catch {
          continue;
        }
        const chunk = evt.message?.content ?? "";
        if (chunk) {
          content += chunk;
          const shown = filter.filter(chunk);
          if (shown) onToken?.(shown);
        }
        if (evt.message?.tool_calls) wireToolCalls.push(...evt.message.tool_calls);
        if (evt.done) {
          finished = true;
          break;
        }
      }
    }
    const tail = filter.flush();
    if (tail) onToken?.(tail);
  } else {
    const data = (await res.json()) as { message?: { content?: string; tool_calls?: WireToolCall[] } };
    content = data.message?.content ?? "";
    if (data.message?.tool_calls) wireToolCalls.push(...data.message.tool_calls);
  }

  const toolCalls = wireToolCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}_${Date.now()}`,
    name: tc.function?.name ?? "unknown",
    args: (tc.function?.arguments ?? {}) as Record<string, unknown>,
  }));

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
