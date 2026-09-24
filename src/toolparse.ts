/**
 * Some local models (and older Ollama versions) emit tool calls as JSON text
 * in the message content instead of a parsed tool_calls field — sometimes as
 * plain JSON, sometimes fenced (```json), sometimes wrapped in <tool_call>
 * tags, and sometimes *embedded after prose* like:
 *
 *   "Sure, let's create the file!
 *
 *    {"name": "write_file", "arguments": {"path": "x", "content": "hi"}}"
 *
 * This parses all of those shapes back into a structured call so Pixie works
 * with many small local models.
 */
export function tryParseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  let t = text.trim();

  // A ```json fence may hold the real call — but a reply can ALSO start with a
  // bare call and then trail a *fake tool result* inside its own ```json fence
  // (#23: call JSON, then "# Response", then ```json {"lines_added": 3}).
  // Strip fences only when they wrap a plausible call; otherwise ignore them.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && /\{\s*"name"/.test(fence[1])) {
    const fenced = parseCallObject(fence[1].trim());
    if (fenced) return fenced;
  }
  const tag = t.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (tag) t = tag[1].trim();

  if (t.startsWith("{")) {
    return parseCallObject(t);
  }
  // Embedded after prose (or trailing junk after a bare call): locate the
  // first {"name" … } with balanced braces.
  const start = t.indexOf('{"name"');
  if (start < 0) return null;
  return parseCallObject(t.slice(start));
}

/**
 * Removes a narrated tool call from reply text, keeping only prose that came
 * BEFORE it. Everything after the call is the model's invented tool output
 * (```json result fences, "# Response" trailers) and is dropped wholesale.
 * Used by the backends after a narrated call has been parsed back into a real
 * tool call, so the hallucinated result never enters the conversation history.
 */
export function stripNarratedCall(text: string): string {
  let t = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  const start = t.indexOf('{"name"');
  if (start < 0) return t.trim();
  const head = t.slice(0, start);
  // Drop the call object, then any fake-result fences / trailers after it.
  const rest = t
    .slice(start)
    .replace(/\{\s*"name"\s*:[\s\S]*?\}\s*\}/, "")
    .replace(/```(?:json)?[\s\S]*?```/g, "");
  const cut = rest.search(/#+\s*Response/i);
  return (head + (cut >= 0 ? rest.slice(0, cut) : rest)).trim();
}

/** Parses a {"name": …, "arguments": {…}} object, scanning to its balanced end. */
function parseCallObject(t: string): { name: string; args: Record<string, unknown> } | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(t.slice(0, i + 1)) as { name?: unknown; arguments?: unknown };
          if (typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
            return { name: obj.name, args: obj.arguments as Record<string, unknown> };
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
