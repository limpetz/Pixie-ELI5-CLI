import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Appends every message and tool use to a JSONL file inside the workspace.
 * These logs are the raw material for Phase 3 (fine-tuning Pixie's own model).
 */
export class SessionLogger {
  private file: string;

  constructor(workspace: string, meta: Record<string, unknown>) {
    const dir = join(workspace, ".pixie", "sessions");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
    this.write({ type: "session_start", ...meta });
  }

  get path(): string {
    return this.file;
  }

  /** Continue writing into a previous session file (used by /resume). */
  resume(filePath: string): void {
    this.file = filePath;
    this.write({ type: "session_resumed" });
  }

  write(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
    } catch {
      // Logging must never break the app.
    }
  }
}
