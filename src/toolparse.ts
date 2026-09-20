/**
 * Some local models (and older Ollama versions) emit tool calls as JSON text
 * in the message content — e.g. {"name": "write_file", "arguments": {...}} —
 * instead of a parsed tool_calls field. This parses that text back into a
 * structured call so Pixie works with many small local models.
 */
export function tryParseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const tag = t.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (tag) t = tag[1].trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t) as { name?: unknown; arguments?: unknown };
    if (typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
      return { name: obj.name, args: obj.arguments as Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}
