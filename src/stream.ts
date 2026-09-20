/**
 * Guards streamed output so tool-call JSON never reaches the terminal.
 *
 * Small local models often emit tool calls as JSON text ({"name": ...}),
 * <tool_call> blocks, or ```json fences instead of structured fields. The
 * verdict isn't knowable from the first chunk (a lone "{" or "<tool" could
 * still become prose), so this filter buffers the ambiguous head of the
 * stream and decides as soon as it can: prose → emit live, tool-call text →
 * swallow (the backend parses it into a tool call after the stream ends).
 *
 * Note: a reply that *displays* JSON will also be buffered and then printed
 * via the batch fallback — slightly less live, never lost.
 */
export class StreamFilter {
  private head = "";
  private mode: "undecided" | "text" | "json" = "undecided";

  /** Returns the text to show the user for this chunk ("" if swallowed/buffered). */
  filter(chunk: string): string {
    if (this.mode === "json") return "";
    if (this.mode === "text") return chunk;
    this.head += chunk;
    const t = this.head.trimStart();

    if (t.length === 0) {
      // All whitespace so far — if it stays whitespace too long, treat as prose.
      if (this.head.length > 64) {
        this.mode = "text";
        const out = this.head;
        this.head = "";
        return out;
      }
      return "";
    }

    // JSON tool call (possibly after whitespace).
    if (t.startsWith("{")) {
      this.mode = "json";
      return "";
    }

    // <tool_call> block — including partial prefixes like "<t" or "<tool_".
    if (t.startsWith("<tool_call>")) {
      this.mode = "json";
      return "";
    }
    if ("<tool_call>".startsWith(t)) return ""; // could still become the tag

    // Fenced blocks: buffer the opener + a peek at the body.
    if (t[0] === "`") {
      if (!t.startsWith("```")) return ""; // partial backticks so far
      const rest = t.replace(/^```[a-zA-Z0-9_-]*/, "");
      const body = rest.trimStart();
      if (body.length === 0) return ""; // opener only — wait for body
      if (body.startsWith("{")) {
        this.mode = "json";
        return "";
      }
      // Real code or prose inside the fence → stream it all.
      this.mode = "text";
      const out = this.head;
      this.head = "";
      return out;
    }

    // Give up waiting after a reasonable amount — treat as prose.
    if (this.head.length > 1024) {
      this.mode = "text";
      const out = this.head;
      this.head = "";
      return out;
    }

    this.mode = "text";
    const out = this.head;
    this.head = "";
    return out;
  }

  /** Call at end of stream: flushes a stream that never became prose or JSON. */
  flush(): string {
    if (this.mode === "undecided") {
      const out = this.head;
      this.head = "";
      return out;
    }
    return "";
  }
}
