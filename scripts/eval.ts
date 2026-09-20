#!/usr/bin/env node
/**
 * Pixie evals — score a fine-tuned model (e.g. pixie-7b) against the base
 * model on a suite of beginner tasks, from single-step to hard multi-step.
 *
 * Each task runs in its own fresh workspace, optionally seeded with files,
 * optionally followed by extra user turns (true multi-step conversations).
 *
 * Check syntax (checked after the task's final turn):
 *   file:<name>            a file with that (base)name exists
 *   missing:<name>         no file with that (base)name exists
 *   contains:<text>        some file contains <text> (case-insensitive)
 *   not-contains:<text>    no file contains <text>
 *   regex:<pattern>        some file matches the regex
 *   file-count:<n>         exactly <n> non-hidden files exist in the workspace
 *   lines:<name>:<min>-<max>  file has between min and max non-empty lines
 *   reply-contains:<text>  the final answer contains <text>
 *   reply-regex:<pattern>  the final answer matches the regex
 *
 * Task fields: prompt, checks, tier ("core"|"multi"|"hard"),
 *              seed: [{path, content}], followUps: [strings]
 *
 * Usage:
 *   npm run eval                       (pixie-7b vs qwen2.5-coder:7b, built-in suite)
 *   npm run eval -- --a ollama://pixie-7b --b ollama://llama3.1:8b
 *   npm run eval -- --tasks-file training/my-evals.jsonl
 *
 * Results are appended to training/eval-results.json so progress across
 * fine-tuning runs can be tracked over time.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

type Tier = "core" | "multi" | "hard";

interface Task {
  prompt: string;
  checks: string[];
  tier: Tier;
  seed?: { path: string; content: string }[];
  followUps?: string[];
}

export const BUILT_IN: Task[] = [
  /* ── core: single-step basics ── */
  {
    tier: "core",
    prompt: "create a file named greeting.txt containing a friendly hello message",
    checks: ["file:greeting.txt", "regex:hello|hi|hey"],
  },
  {
    tier: "core",
    prompt: "create math.txt with the answer to 12 multiplied by 12 written as a sentence",
    checks: ["file:math.txt", "regex:144"],
  },
  {
    tier: "core",
    prompt: "make colors.txt listing the colors of the rainbow, one per line",
    checks: ["file:colors.txt", "lines:colors.txt:7-7", "regex:blue", "regex:violet|purple"],
  },
  {
    tier: "core",
    prompt: "create index.html with a simple page titled About Me and one paragraph about your favorite season",
    checks: ["file:index.html", "contains:About Me", "regex:<html|<body|<h1"],
  },
  {
    tier: "core",
    prompt: "write a haiku about the sea into sea.txt (a haiku is exactly three short lines)",
    checks: ["file:sea.txt", "lines:sea.txt:3-3"],
  },
  {
    tier: "core",
    prompt: "how many continents are there on Earth? answer in one short sentence",
    checks: ["reply-regex:\\b7\\b|seven"],
  },
  {
    tier: "core",
    prompt: "what is 15 percent of 200? answer with just the number",
    checks: ["reply-regex:\\b30\\b"],
  },

  /* ── multi: multiple files, folders, edits, search-then-act ── */
  {
    tier: "multi",
    prompt: "create three files: red.txt, green.txt and blue.txt. Each file should contain the name of its color.",
    checks: ["file-count:3", "file:red.txt", "file:green.txt", "file:blue.txt", "contains:red", "contains:green", "contains:blue"],
  },
  {
    tier: "multi",
    prompt: "create a folder called photos and inside it a file named album.txt listing three photo ideas",
    checks: ["file:album.txt", "file-count:1"],
  },
  {
    tier: "multi",
    prompt: "create story.txt with exactly five lines telling a tiny story about a dragon, one sentence per line",
    checks: ["file:story.txt", "lines:story.txt:5-5", "regex:dragon"],
  },
  {
    tier: "multi",
    prompt: "there is a spelling mistake in notes.txt — fix it",
    checks: ["file:notes.txt", "not-contains:favrite", "contains:favorite", "contains:teal"],
    seed: [{ path: "notes.txt", content: "My favrite color is teal.\nI also like rainy mornings.\n" }],
  },
  {
    tier: "multi",
    prompt: "add bananas to the end of the shopping list in shopping.txt (keep the existing items)",
    checks: ["file:shopping.txt", "contains:bananas", "contains:milk", "contains:bread", "contains:eggs"],
    seed: [{ path: "shopping.txt", content: "milk\nbread\neggs\n" }],
  },
  {
    tier: "multi",
    prompt: "in config.json, change the theme from light to dark. Keep everything else the same.",
    checks: ["file:config.json", "contains:dark", "not-contains:light", "contains:volume"],
    seed: [{ path: "config.json", content: '{\n  "theme": "light",\n  "volume": 3\n}\n' }],
  },
  {
    tier: "multi",
    prompt: "one of the three riddle files mentions a wizard. Read them and tell me which number it is.",
    checks: ["reply-regex:\\b2\\b"],
    seed: [
      { path: "riddle1.txt", content: "I speak without a mouth and hear without ears.\n" },
      { path: "riddle2.txt", content: "An old wizard lives at the edge of the forest.\n" },
      { path: "riddle3.txt", content: "The more you take, the more you leave behind.\n" },
    ],
  },
  {
    tier: "multi",
    prompt: "read the number in code.txt, double it, and save the result in answer.txt",
    checks: ["file:answer.txt", "regex:42"],
    seed: [{ path: "code.txt", content: "21\n" }],
  },
  {
    tier: "multi",
    prompt: "copy the first line of poem.txt into a new file called title.txt",
    checks: ["file:title.txt", "contains:roses"],
    seed: [{ path: "poem.txt", content: "roses are red\nviolets are blue\npixie is for you\n" }],
  },

  /* ── hard: commands, multi-turn, structured edits, deletion, reasoning ── */
  {
    tier: "hard",
    prompt: 'use a command to calculate 6 times 7 (for example: node -e "console.log(6*7)") and save the output into calc.txt',
    checks: ["file:calc.txt", "regex:42"],
  },
  {
    tier: "hard",
    prompt: "create profile.txt where the first line says the assistant's name is Pixie",
    checks: ["file:profile.txt", "contains:pixie", "lines:profile.txt:2-999", "contains:hello"],
    followUps: ["now add a second line to profile.txt that says hello to the user"],
  },
  {
    tier: "hard",
    prompt: "create plan.txt with exactly three numbered steps for making a cup of tea",
    checks: ["file:plan.txt", "contains:pour hot water", "file-count:1"],
    followUps: ["replace whichever step is the boiling step with exactly: pour hot water"],
  },
  {
    tier: "hard",
    prompt: "build a tiny website: index.html must link to page1.html and page2.html, and both of those pages must exist with a heading on each",
    checks: ["file-count:3", "file:index.html", "file:page1.html", "file:page2.html", "regex:href", "regex:<h1|<h2"],
  },
  {
    tier: "hard",
    prompt: "add a new row for apples with price 1.20 to inventory.csv (keep the header and existing rows)",
    checks: ["file:inventory.csv", "contains:apples", "contains:1.20", "contains:banana", "lines:inventory.csv:4-4"],
    seed: [{ path: "inventory.csv", content: "item,price\nbanana,0.80\ncherry,3.10\n" }],
  },
  {
    tier: "hard",
    prompt: "clean up this folder: delete the file called old-data.txt but keep everything else",
    checks: ["missing:old-data.txt", "file:keep-me.txt", "file-count:1"],
    seed: [
      { path: "old-data.txt", content: "stale stuff from 2019\n" },
      { path: "keep-me.txt", content: "still important\n" },
    ],
  },
  {
    tier: "hard",
    prompt:
      "read wishlist.txt, figure out which single item costs the most, and write just that item's name into best.txt",
    checks: ["file:best.txt", "contains:telescope"],
    seed: [
      {
        path: "wishlist.txt",
        content: "skateboard 90\n telescope 250 \nheadphones 120\n",
      },
    ],
  },
  {
    tier: "hard",
    prompt:
      "read menu.txt and orders.txt, then create total.txt containing only the total price of the order (just the number)",
    checks: ["file:total.txt", "regex:\\b13\\b"],
    seed: [
      { path: "menu.txt", content: "pizza 8\nsalad 5\njuice 3\n" },
      { path: "orders.txt", content: "pizza\njuice\nwait no — salad\n" },
    ],
  },
];

function loadTasks(): Task[] {
  const file = arg("tasks-file", "");
  let tasks: Task[] = BUILT_IN;
  if (file) {
    tasks = [];
    for (const line of readFileSync(resolve(file), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parsed = JSON.parse(t) as Partial<Task>;
      if (!parsed.prompt || !parsed.checks?.length) {
        console.error(`Skipping malformed task line in ${file}`);
        continue;
      }
      tasks.push({
        prompt: parsed.prompt,
        checks: parsed.checks,
        tier: parsed.tier ?? "multi",
        seed: parsed.seed,
        followUps: parsed.followUps,
      });
    }
  }
  const limit = Number(arg("limit", "0"));
  if (limit > 0) tasks = tasks.slice(0, limit);
  return tasks;
}

/* ── workspace inspection ── */
interface Found {
  path: string;
  text: string;
}

function collectFiles(dir: string, acc: Found[] = [], depth = 0): Found[] {
  if (depth > 5) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const full = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) collectFiles(full, acc, depth + 1);
    else {
      try {
        acc.push({ path: e, text: readFileSync(full, "utf8") });
      } catch {
        /* unreadable */
      }
    }
  }
  return acc;
}

/** Exported for selftests. */
export function runChecks(
  checks: string[],
  workspace: string,
  reply: string,
): { pass: boolean; failed: string[]; passed: number; total: number } {
  const files = collectFiles(workspace);
  const failed: string[] = [];
  let passed = 0;
  for (const raw of checks) {
    const i = raw.indexOf(":");
    const kind = i >= 0 ? raw.slice(0, i) : raw;
    const value = i >= 0 ? raw.slice(i + 1) : "";
    let ok = false;
    try {
      if (kind === "file") ok = files.some((f) => f.path.toLowerCase() === value.toLowerCase());
      else if (kind === "missing") ok = !files.some((f) => f.path.toLowerCase() === value.toLowerCase());
      else if (kind === "contains") ok = files.some((f) => f.text.toLowerCase().includes(value.toLowerCase()));
      else if (kind === "not-contains") ok = !files.some((f) => f.text.toLowerCase().includes(value.toLowerCase()));
      else if (kind === "regex") ok = files.some((f) => new RegExp(value, "i").test(f.text));
      else if (kind === "file-count") ok = files.length === Number(value);
      else if (kind === "lines") {
        const m = value.match(/^(.+):(\d+)-(\d+)$/);
        const target = m ? m[1] : "";
        const min = m ? Number(m[2]) : 0;
        const max = m ? Number(m[3]) : Number.MAX_SAFE_INTEGER;
        const f = files.find((x) => x.path.toLowerCase() === target.toLowerCase());
        if (f) {
          const n = f.text.split("\n").filter((l) => l.trim() !== "").length;
          ok = n >= min && n <= max;
        }
      } else if (kind === "reply-contains") ok = reply.toLowerCase().includes(value.toLowerCase());
      else if (kind === "reply-regex") ok = new RegExp(value, "i").test(reply);
    } catch {
      ok = false;
    }
    if (ok) passed++;
    else failed.push(raw);
  }
  return { pass: failed.length === 0, failed, passed, total: checks.length };
}

/* ── runner ── */
interface TaskResult {
  pass: boolean;
  rounds: number;
  seconds: number;
  failed: string[];
}

async function runTask(provider: ProviderConfig, task: Task, ws: string): Promise<TaskResult> {
  const cfg: PixieConfig = {
    provider,
    fallback: null,
    workspace: ws,
    beginnerMode: true,
    temperature: 0.2,
    maxToolRounds: 10,
  };
  const logger = new SessionLogger(ws, { note: "eval", model: provider.model });
  const history: ChatMessage[] = [];
  const t0 = Date.now();
  let rounds = 0;
  let reply = "";
  try {
    const r1 = await runTurn(cfg, history, task.prompt, logger, { autoRun: true });
    rounds += r1.toolRounds;
    reply = r1.reply;
    for (const fu of task.followUps ?? []) {
      history.push({ role: "user", content: task.prompt });
      history.push({ role: "assistant", content: reply });
      const r = await runTurn(cfg, history, fu, logger, { autoRun: true });
      rounds += r.toolRounds;
      reply = r.reply;
    }
  } catch (err) {
    return { pass: false, rounds, seconds: (Date.now() - t0) / 1000, failed: [err instanceof Error ? err.message : String(err)] };
  }
  const { pass, failed } = runChecks(task.checks, ws, reply);
  return { pass, rounds, seconds: (Date.now() - t0) / 1000, failed };
}

export async function evalModel(
  spec: string,
  tasks: Task[],
  root: string,
): Promise<{ checksPassed: number; checksTotal: number; tasksPassed: number; seconds: number; avgRounds: number; byTier: Record<Tier, { passed: number; total: number }> }> {
  const provider = resolveModel(spec);
  const key = provider.model.replace(/[^a-zA-Z0-9_-]/g, "-");
  const wsRoot = join(root, key);
  if (existsSync(wsRoot)) rmSync(wsRoot, { recursive: true, force: true });

  let checksPassed = 0;
  let checksTotal = 0;
  let tasksPassed = 0;
  let roundsSum = 0;
  const t0 = Date.now();
  const byTier: Record<Tier, { passed: number; total: number }> = {
    core: { passed: 0, total: 0 },
    multi: { passed: 0, total: 0 },
    hard: { passed: 0, total: 0 },
  };

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const ws = join(wsRoot, `task-${i}`);
    mkdirSync(ws, { recursive: true });
    for (const s of task.seed ?? []) {
      mkdirSync(join(ws, s.path, ".."), { recursive: true });
      writeFileSync(join(ws, s.path), s.content, "utf8");
    }
    const r = await runTask(provider, task, ws);
    checksPassed += r.pass ? task.checks.length : task.checks.length - r.failed.length;
    checksTotal += task.checks.length;
    tasksPassed += r.pass ? 1 : 0;
    roundsSum += r.rounds;
    byTier[task.tier].total++;
    if (r.pass) byTier[task.tier].passed++;
    const mark = r.pass ? "✔" : "✘";
    const tag = task.tier.padEnd(4);
    const fu = task.followUps?.length ? ` (+${task.followUps.length} turn)` : "";
    const detail = r.pass ? "" : `  failed: ${r.failed.slice(0, 3).join(", ")}`;
    console.log(`    ${mark} [${tag}] task ${String(i + 1).padStart(2)}${fu} · ${r.rounds} round${r.rounds === 1 ? "" : "s"}${detail}`);
  }

  return {
    checksPassed,
    checksTotal,
    tasksPassed,
    seconds: (Date.now() - t0) / 1000,
    avgRounds: roundsSum / tasks.length,
    byTier,
  };
}

function printTierRow(label: string, byTier: Record<Tier, { passed: number; total: number }>): void {
  const parts = (Object.keys(byTier) as Tier[]).map((t) => `${t} ${byTier[t].passed}/${byTier[t].total}`);
  console.log(`  ${label.padEnd(24)} ${parts.join("  ·  ")}`);
}

async function main(): Promise<void> {
  const specA = arg("a", "ollama://pixie-7b");
  const specB = arg("b", "ollama://qwen2.5-coder:7b");
  const tasks = loadTasks();
  const root = resolve("training/eval-workspace");
  mkdirSync(root, { recursive: true });

  console.log(`Eval suite : ${tasks.length} task(s) · ${tasks.filter((t) => t.tier === "core").length} core / ${tasks.filter((t) => t.tier === "multi").length} multi / ${tasks.filter((t) => t.tier === "hard").length} hard`);
  console.log(`Model A    : ${specA}`);
  console.log(`Model B    : ${specB}\n`);

  console.log("Model A:");
  const a = await evalModel(specA, tasks, root);
  printTierRow(resolveModel(specA).model, a.byTier);
  console.log(`  → tasks ${a.tasksPassed}/${tasks.length}, checks ${a.checksPassed}/${a.checksTotal}, avg ${a.avgRounds.toFixed(1)} rounds, ${a.seconds.toFixed(0)}s\n`);

  console.log("Model B:");
  const b = await evalModel(specB, tasks, root);
  printTierRow(resolveModel(specB).model, b.byTier);
  console.log(`  → tasks ${b.tasksPassed}/${tasks.length}, checks ${b.checksPassed}/${b.checksTotal}, avg ${b.avgRounds.toFixed(1)} rounds, ${b.seconds.toFixed(0)}s\n`);

  console.log("─".repeat(52));
  const winner = a.checksPassed > b.checksPassed ? "A" : b.checksPassed > a.checksPassed ? "B" : "tie";
  console.log(`  A (${resolveModel(specA).model}): ${a.checksPassed}/${a.checksTotal} checks, ${a.tasksPassed}/${tasks.length} tasks`);
  console.log(`  B (${resolveModel(specB).model}): ${b.checksPassed}/${b.checksTotal} checks, ${b.tasksPassed}/${tasks.length} tasks`);
  console.log(winner === "tie" ? "  🤝 Tie — the fine-tune needs more work (or harder tasks)." : `  🏆 Model ${winner} wins on checks.`);
  console.log("─".repeat(52));

  // Append to results log for tracking progress across fine-tune iterations.
  const resultsPath = resolve("training/eval-results.json");
  let log: unknown[] = [];
  try {
    if (existsSync(resultsPath)) log = JSON.parse(readFileSync(resultsPath, "utf8")) as unknown[];
  } catch {
    log = [];
  }
  log.push({
    date: new Date().toISOString(),
    suite: tasks.length,
    a: { model: resolveModel(specA).model, checks: `${a.checksPassed}/${a.checksTotal}`, tasks: `${a.tasksPassed}/${tasks.length}`, byTier: a.byTier },
    b: { model: resolveModel(specB).model, checks: `${b.checksPassed}/${b.checksTotal}`, tasks: `${b.tasksPassed}/${tasks.length}`, byTier: b.byTier },
    winner,
  });
  writeFileSync(resultsPath, JSON.stringify(log, null, 2), "utf8");
  console.log(`Results appended to ${resultsPath}`);
  console.log(`Workspaces kept in ${root} for inspection.`);
}

// Only run when invoked directly (not when imported by the self-test).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((err) => {
    console.error("Eval failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
