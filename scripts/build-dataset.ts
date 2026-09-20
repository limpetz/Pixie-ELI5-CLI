#!/usr/bin/env node
/**
 * Pixie Phase 3, step 1 — turn session logs into a fine-tuning dataset.
 *
 * Reads <workspace>/.pixie/sessions/*.jsonl and rebuilds the FULL conversation
 * each session contains — including the assistant's tool-call rounds and the
 * tool results — because a coding agent must learn to CALL TOOLS, not to
 * narrate having done things. (The prose-only format taught exactly that
 * failure mode: fine-tuned models that claim "What I did: ..." without ever
 * emitting a tool call.)
 *
 * Output rows use OpenAI/Qwen chat format with native tool calls, which the
 * Qwen2.5 chat template renders into <tool_call> JSON — the same format Ollama
 * parses back into structured tool calls at runtime:
 *
 *   {"messages":[
 *     {"role":"system",...},
 *     {"role":"user",...},
 *     {"role":"assistant","content":"","tool_calls":[{"type":"function",
 *        "function":{"name":"write_file","arguments":{...}}}]},
 *     {"role":"tool","name":"write_file","content":"Wrote greeting.txt"},
 *     {"role":"assistant","content":"What I did: ..."}
 *   ]}
 *
 * Also writes tool-schemas.json (the exact tool definitions Pixie uses at
 * runtime) so train.py can render the same <tools> block the model will see
 * in production prompts.
 *
 * Usage:
 *   npm run build-dataset                       (uses current dir as workspace)
 *   npm run build-dataset -- --workspace C:/path/to/project
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";
import { TOOL_SCHEMAS } from "../src/tools.js";

interface Args {
  workspace: string;
  out: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workspace = process.cwd();
  let out = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") workspace = argv[++i] ?? workspace;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  return { workspace: resolve(workspace), out: resolve(out || join(process.cwd(), "training")) };
}

export interface ToolCallMsg {
  type: "function";
  function: { name: string; arguments: Record<string, unknown> };
}
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCallMsg[];
  name?: string;
}
export interface Pair {
  messages: Msg[];
  source?: string;
}

/**
 * Rebuild one session log into tool-call-faithful training exchanges.
 * Each user_message starts a new exchange; an exchange is kept when it ends
 * with a healthy final assistant reply. Tool rounds are preserved verbatim.
 */
export function extractPairs(file: string, source = ""): Pair[] {
  const pairs: Pair[] = [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");

  let turns: Msg[] = []; // turns of the current exchange (user ... assistant)
  let haveUser = false;
  let sawFailedTool = false;

  const flush = () => {
    if (!haveUser) return;
    const last = turns[turns.length - 1];
    const healthy =
      last &&
      last.role === "assistant" &&
      !last.tool_calls?.length &&
      last.content.trim().length >= 30 &&
      !last.content.startsWith("Error:") &&
      !last.content.includes("User declined to run") &&
      !last.content.includes("NEEDS_APPROVAL") &&
      // Narration-only exchanges (no tool call at all) taught the model to
      // claim actions instead of taking them — drop them.
      turns.some((t) => t.role === "assistant" && t.tool_calls?.length) &&
      // All tools in the exchange should have succeeded; small datasets
      // should teach success patterns first.
      !sawFailedTool;
    if (healthy) {
      pairs.push({ messages: [{ role: "system", content: BEGINNER_SYSTEM_PROMPT }, ...turns], source });
    }
    turns = [];
    haveUser = false;
    sawFailedTool = false;
  };

  for (const line of lines) {
    let e: {
      type?: string;
      content?: string;
      toolCalls?: { name?: string; args?: unknown }[];
      name?: string;
      ok?: boolean;
      output?: unknown;
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }

    if (e.type === "user_message") {
      flush();
      haveUser = true;
      turns.push({ role: "user", content: typeof e.content === "string" ? e.content : "" });
    } else if (e.type === "assistant_tool_calls") {
      const toolCalls: ToolCallMsg[] = (e.toolCalls ?? [])
        .filter((tc) => typeof tc?.name === "string")
        .map((tc) => ({
          type: "function" as const,
          function: { name: tc.name as string, arguments: (tc.args ?? {}) as Record<string, unknown> },
        }));
      if (!toolCalls.length) continue;
      turns.push({ role: "assistant", content: (e.content ?? "").trim(), tool_calls: toolCalls });
    } else if (e.type === "tool_result") {
      if (e.ok === false) sawFailedTool = true;
      turns.push({ role: "tool", name: e.name ?? "tool", content: String(e.output ?? "").trim() });
    } else if (e.type === "assistant_message") {
      turns.push({ role: "assistant", content: typeof e.content === "string" ? e.content.trim() : "" });
    }
  }
  flush();
  return pairs;
}

/** Dedupe pairs by their message content. */
export function dedupe(all: Pair[]): Pair[] {
  const seen = new Set<string>();
  const out: Pair[] = [];
  for (const p of all) {
    const key = createHash("sha256").update(JSON.stringify(p.messages)).digest("hex");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** Build pairs from every session log in a workspace's sessions dir. */
export function buildFromWorkspace(workspace: string, source = ""): Pair[] {
  const sessionsDir = join(workspace, ".pixie", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const all: Pair[] = [];
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    all.push(...extractPairs(join(sessionsDir, f), source));
  }
  return dedupe(all);
}

function main(): void {
  const { workspace, out } = parseArgs();
  const sessionsDir = join(workspace, ".pixie", "sessions");
  if (!existsSync(sessionsDir)) {
    console.error(`No sessions found at ${sessionsDir}`);
    console.error("Use Pixie for a while first (sessions build up automatically), then rerun this.");
    process.exit(1);
  }

  const all = buildFromWorkspace(workspace, "sessions");
  mkdirSync(out, { recursive: true });

  // Export the runtime tool schemas so train.py can render the same
  // <tools> block the model sees in production prompts.
  writeFileSync(join(out, "tool-schemas.json"), JSON.stringify(TOOL_SCHEMAS, null, 2), "utf8");

  const file = join(out, "dataset.jsonl");
  writeFileSync(file, all.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");

  const withTools = all.filter((p) => p.messages.some((m) => m.tool_calls?.length)).length;
  console.log(`Sessions scanned : ${readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).length}`);
  console.log(`Training pairs   : ${all.length} (deduped, tool-faithful)`);
  console.log(`  with tool calls : ${withTools}`);
  console.log(`  prose-only      : ${all.length - withTools} (kept: real multi-turn answers)`);
  console.log(`Dataset written  : ${file}`);
  console.log(`Tool schemas     : ${join(out, "tool-schemas.json")}`);
  if (all.length < 50) {
    console.log("\nTip: 50+ good pairs is a useful minimum; several hundred is better.");
  }
  console.log("\nNext: npm run prepare-training   (generates the QLoRA training kit)");
}

// Only run main when invoked directly (not when imported by the self-test).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) main();
