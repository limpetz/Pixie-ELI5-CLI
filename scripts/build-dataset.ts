#!/usr/bin/env node
/**
 * Pixie Phase 3, step 1 — turn session logs into a fine-tuning dataset.
 *
 * Reads <workspace>/.pixie/sessions/*.jsonl, extracts (user request → final
 * Pixie answer) pairs, applies quality filters, dedupes, and writes
 * training/dataset.jsonl in OpenAI chat-messages format:
 *
 *   {"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}
 *
 * Usage:
 *   npm run build-dataset                       (uses current dir as workspace)
 *   npm run build-dataset -- --workspace C:/path/to/project
 *   npm run build-dataset -- --with-tools       (append tool activity to prompts)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";

interface Args {
  workspace: string;
  out: string;
  withTools: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workspace = process.cwd();
  let out = "";
  let withTools = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") workspace = argv[++i] ?? workspace;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
    else if (argv[i] === "--with-tools") withTools = true;
  }
  return { workspace: resolve(workspace), out: resolve(out || join(process.cwd(), "training")), withTools };
}

interface Pair {
  messages: { role: string; content: string }[];
}

export function extractPairs(file: string, withTools: boolean): Pair[] {
  const pairs: Pair[] = [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  let pendingUser: string | null = null;
  let activity: string[] = [];

  for (const line of lines) {
    let e: { type?: string; content?: string; toolCalls?: { name?: string; args?: unknown }[]; name?: string; output?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }

    if (e.type === "user_message") {
      pendingUser = typeof e.content === "string" ? e.content : null;
      activity = [];
    } else if (e.type === "assistant_tool_calls") {
      for (const tc of e.toolCalls ?? []) {
        const argStr = JSON.stringify(tc.args ?? {}).slice(0, 160);
        activity.push(`${tc.name ?? "?"}(${argStr})`);
      }
    } else if (e.type === "tool_result") {
      const out = String(e.output ?? "").replace(/\s+/g, " ").slice(0, 100);
      activity.push(`→ ${e.name}: ${out}`);
    } else if (e.type === "assistant_message") {
      const response = typeof e.content === "string" ? e.content.trim() : "";
      // Quality filters: need a question, a real answer, and no declined/broken turns.
      const bad =
        pendingUser === null ||
        response.length < 30 ||
        response.startsWith("Error:") ||
        response.includes("User declined to run") ||
        response.includes("NEEDS_APPROVAL");
      if (!bad) {
        const prompt = withTools && activity.length > 0 ? `${pendingUser}\n\n[Tool activity: ${activity.join("; ")}]` : (pendingUser as string);
        pairs.push({
          messages: [
            { role: "system", content: BEGINNER_SYSTEM_PROMPT },
            { role: "user", content: prompt },
            { role: "assistant", content: response },
          ],
        });
      }
      pendingUser = null;
      activity = [];
    }
  }
  return pairs;
}

function main(): void {
  const { workspace, out, withTools } = parseArgs();
  const sessionsDir = join(workspace, ".pixie", "sessions");
  if (!existsSync(sessionsDir)) {
    console.error(`No sessions found at ${sessionsDir}`);
    console.error("Use Pixie for a while first (sessions build up automatically), then rerun this.");
    process.exit(1);
  }

  const seen = new Set<string>();
  const all: Pair[] = [];
  let sessionCount = 0;

  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    sessionCount++;
    for (const pair of extractPairs(join(sessionsDir, f), withTools)) {
      const key = createHash("sha256").update(JSON.stringify(pair.messages.map((m) => m.content))).digest("hex");
      if (!seen.has(key)) {
        seen.add(key);
        all.push(pair);
      }
    }
  }

  mkdirSync(out, { recursive: true });
  const file = join(out, "dataset.jsonl");
  writeFileSync(file, all.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");

  console.log(`Sessions scanned : ${sessionCount}`);
  console.log(`Training pairs   : ${all.length} (deduped)`);
  console.log(`Dataset written  : ${file}`);
  if (all.length < 50) {
    console.log("\nTip: 50+ good pairs is a useful minimum; several hundred is better.");
    console.log("Keep chatting with Pixie — every session improves the dataset.");
  }
  console.log("\nNext: npm run prepare-training   (generates the QLoRA training kit)");
}

// Only run main when invoked directly (not when imported by the self-test).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) main();
