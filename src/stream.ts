/**
 * Guards streamed output so tool-call JSON never reaches the terminal.
 *
 * Small local models emit tool calls in messy ways: bare JSON, <tool_call>
 * tags, ```json fences, or JSON *embedded after prose*. The verdict isn't
 * knowable from the first chunk, so this filter:
 *   1. buffers the ambiguous head of the stream until it can classify it
 *   2. in text mode, holds back a small guard window and scans it — if a
 *      tool-call opener appears ({"name"…, <tool_call>, ```json{…), it cuts
 *      there and suppresses the rest (the backend parses it into a tool call)
 *   3. flushes any held prose at end of stream, so nothing is ever lost
 */
export class StreamFilter {
  /** Openers that mean "this is a tool call, stop showing text". */
  private static readonly OPENERS = [/\{\s*"name"/, /<tool_call>/, /```(?:json)?\s*\{\s*"name"/];

  private buf = ""; // pending text (undecided head or guarded tail)
  private mode: "undecided" | "text" | "json" = "undecided";

  /** Returns the text to show the user for this chunk ("" if swallowed/buffered). */
  filter(chunk: string): string {
    if (this.mode === "json") return "";
    this.buf += chunk;

    if (this.mode === "undecided") {
      const t = this.buf.trimStart();
      if (t.length === 0) {
        if (this.buf.length > 64) {
          this.mode = "text";
        }
        return "";
      }
      if (t.startsWith("{") || t.startsWith("<tool_call>") || /^```(?:json)?\s*\{/.test(t)) {
        this.mode = "json";
        return "";
      }
      if (t[0] === "`") {
        // Could be a fence opener we can't classify yet; wait for more.
        if (!/^```(?:[a-zA-Z0-9_-]*)?/.test(t) || t.length < 10) return "";
        if (!t.includes("\n")) return "";
      }
      // Anything else is prose.
      this.mode = "text";
    }

    // Text mode: scan the guarded tail for a tool-call opener appearing mid-prose.
    for (const op of StreamFilter.OPENERS) {
      const m = this.buf.match(op);
      if (m && m.index !== undefined) {
        const out = this.buf.slice(0, m.index);
        this.buf = "";
        this.mode = "json";
        return out;
      }
    }

    // Hold back the last few chars so an opener split across chunks is caught.
    const GUARD = 24;
    if (this.buf.length > GUARD) {
      const out = this.buf.slice(0, this.buf.length - GUARD);
      this.buf = this.buf.slice(-GUARD);
      return out;
    }
    return "";
  }

  /** Call at end of stream: flushes any prose that was still being guarded. */
  flush(): string {
    if (this.mode === "json") return "";
    const out = this.buf;
    this.buf = "";
    return out;
  }
}
