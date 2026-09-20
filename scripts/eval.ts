#!/usr/bin/env node
/**
 * Pixie evals — score a fine-tuned model (e.g. pixie-7b) against the base
 * model on beginner tasks with automatic, objective checks.
 *
 * Check syntax (all checked after the model finishes the task):
 *   file:<name>            a file with that name exists in the task workspace
 *   contains:<text>        some file in the workspace contains <text>
 *   regex:<pattern>        some file in the workspace matches the regex
 *   reply-contains:<text>  the model's final answer contains <text>
 *   reply-regex:<pattern>  the model's final answer matches the regex
 *
 * Usage:
 *   npm run eval                       (pixie-7b vs qwen2.5-coder:7b, built-in suite)
 *   npm run eval -- --a ollama://pixie-7b --b ollama://llama3.1:8b
 *   npm run eval -- --tasks-file training/my-evals.jsonl
 *
 * Tasks file format (JSONL): {"prompt": "...", "checks": ["file:x.txt", "regex:144"]}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTurn } from "../src/agent.js";
import { SessionLogger } from "../src/session.js";
import type { ChatMessage, PixieConfig, ProviderConfig } from "../src/types.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveModel(spec: string): ProviderConfig {
  if (spec.startsWith("ollama://")) {
    return { kind: "ollama", baseUrl: "http://localhost:11434", model: spec.slice("ollama://".length) };
  }
  const parts = spec.split("|");
  if (parts.length === 3) return { kind: "openai", baseUrl: parts[0], apiKey: parts[1], model: parts[2] };
  console.error(`Unrecognized model spec: ${spec}`);
  process.exit(1);
}

interface Task {
  prompt: string;
  checks: string[];
}

const BUILT_IN: Task[] = [
  {
    prompt: "create a file named greeting.txt containing a friendly hello message",
    checks: ["file:greeting.txt", "regex:hello|hi|hey"],
  },
  {
    prompt: "create math.txt with the answer to 12 multiplied by 12 written as a sentence",
    checks: ["file:math.txt", "regex:144"],
  },
  {
    prompt: "make colors.txt listing the colors of the rainbow, one per line",
    checks: ["file:colors.txt", "regex:blue", "regex:violet|purple"],
  },
  {
    prompt: "create index.html with a simple page titled About Me and one paragraph about your favorite season",
    checks: ["file:index.html", "contains:About Me"],
  },
  {
    prompt: "write a haiku about the sea into sea.txt",
    checks: ["file:sea.txt"],
  },
  {
    prompt: "how many continents are there on Earth? answer in one short sentence",
    checks: ["reply-regex:\\b7\\b|seven"],
  },
  {
    prompt: "what is 15 percent of 200? answer with just the number",
    checks: ["reply-regex:\\b30\\b"],
  },
];

function loadTasks(): Task[] {
  const file = arg("tasks-file", "");
  if (!file) return BUILT_IN;
  const tasks: Task[] = [];
  for (const line of readFileSync(resolve(file), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parsed = JSON.parse(t) as { prompt?: string; checks?: string[] };
    if (!parsed.prompt || !parsed.checks?.length) {
      console.error(`Skipping malformed task line in ${file}`);
      continue;
    }
    tasks.push({ prompt: parsed.prompt, checks: parsed.checks });
  }
  return tasks;
}

/* ── checks ── */
function allTextIn(dir: string, acc: { path: string; text: string }[] = [], depth = 0): { path: string; text: string }[] {
  if (depth > 4) return acc;
  for (const e of readdirSync(dir)) {
    if (e === ".pixie" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let isDir = false;
    try {
      isDir = readdirSync(full).length >= 0;
    } catch {
      isDir = false;
    }
    if (isDir) {
      allTextIn(full, acc, depth + 1);
    } else {
      try {
        acc.push({ path: e, text: readFileSync(full, "utf8") });
      } catch {
        /* unreadable */
      }
    }
  }
  return acc;
}

function runChecks(task: Task, workspace: string, reply: string): { pass: boolean; failed: string[] } {
  const files = allTextIn(workspace);
  const failed: string[] = [];
  for (const raw of task.checks) {
    const i = raw.indexOf(":");
    const kind = i >= 0 ? raw.slice(0, i) : raw;
    const value = i >= 0 ? raw.slice(i + 1) : "";
    let ok = false;
    try {
      if (kind === "file") ok = files.some((f) => f.path.toLowerCase() === value.toLowerCase());
      else if (kind === "contains") ok = files.some((f) => f.text.toLowerCase().includes(value.toLowerCase()));
      else if (kind === "regex") ok = files.some((f) => new RegExp(value, "i").test(f.text));
      else if (kind === "reply-contains") ok = reply.toLowerCase().includes(value.toLowerCase());
      else if (kind === "reply-regex") ok = new RegExp(value, "i").test(reply);
      else failed.push(`(unknown check ${kind})`);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(raw);
  }
  return { pass: failed.length === 0, failed };
}

/* ── runner ── */
async function evalModel(
  spec: string,
  tasks: Task[],
  root: string,
): Promise<{ passes: number; total: number; seconds: number; perTask: (boolean | null)[] }> {
  const provider = resolveModel(spec);
  const key = provider.model.replace(/[^a-zA-Z0-9_-]/g, "-");
  const wsRoot = join(root, key);
  if (existsSync(wsRoot)) rmSync(wsRoot, { recursive: true, force: true });

  const cfg: PixieConfig = {
    provider,
    fallback: null,
    workspace: wsRoot,
    beginnerMode: true,
    temperature: 0.2,
    maxToolRounds: 8,
  };

  const perTask: (boolean | null)[] = [];
  const t0 = Date.now();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const ws = join(wsRoot, `task-${i}`);
    mkdirSync(ws, { recursive: true });
    const taskCfg = { ...cfg, workspace: ws };
    try {
      const logger = new SessionLogger(ws, { note: "eval", model: provider.model });
      const history: ChatMessage[] = [];
      const result = await runTurn(taskCfg, history, task.prompt, logger, { autoRun: true });
      const { pass, failed } = runChecks(task, ws, result.reply);
      perTask.push(pass);
      const mark = pass ? "✔" : "✘";
      const detail = pass ? "" : `  failed: ${failed.join(", ")}`;
      console.log(`    ${mark} task ${i + 1}${detail}`);
    } catch (err) {
      perTask.push(false);
      console.log(`    ✘ task ${i + 1}  errored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    passes: perTask.filter((p) => p === true).length,
    total: tasks.length,
    seconds: (Date.now() - t0) / 1000,
    perTask,
  };
}

async function main(): Promise<void> {
  const specA = arg("a", "ollama://pixie-7b");
  const specB = arg("b", "ollama://qwen2.5-coder:7b");
  const tasks = loadTasks();
  const root = resolve("training/eval-workspace");
  mkdirSync(root, { recursive: true });

  console.log(`Eval suite : ${tasks.length} task(s)`);
  console.log(`Model A    : ${specA}`);
  console.log(`Model B    : ${specB}\n`);

  console.log("Model A:");
  const a = await evalModel(specA, tasks, root);
  console.log(`  → ${a.passes}/${a.total} checks passed, ${a.seconds.toFixed(0)}s total\n`);

  console.log("Model B:");
  const b = await evalModel(specB, tasks, root);
  console.log(`  → ${b.passes}/${b.total} checks passed, ${b.seconds.toFixed(0)}s total\n`);

  console.log("─".repeat(46));
  console.log(`  A (${resolveModel(specA).model}): ${a.passes}/${a.total}`);
  console.log(`  B (${resolveModel(specB).model}): ${b.passes}/${b.total}`);
  if (a.passes > b.passes) console.log("  🏆 A wins on task checks.");
  else if (b.passes > a.passes) console.log("  🏆 B wins on task checks.");
  else console.log("  🤝 Tie on task checks — try more/harder tasks.");
  console.log("─".repeat(46));
  console.log(`Workspaces kept in ${root} for inspection.`);
}

main().catch((err) => {
  console.error("Eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
