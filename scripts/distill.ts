#!/usr/bin/env node
/**
 * Pixie Phase 3, step 1.5 — distillation.
 *
 * Runs a *teacher* model (ideally bigger/stronger than your local default)
 * through Pixie's real agent loop — same tools, same beginner system prompt —
 * on a set of beginner tasks, and saves the resulting final answers as extra
 * training pairs in training/distilled.jsonl (same format as dataset.jsonl).
 *
 * Because traces are produced by actually executing tools in a scratch
 * workspace, they are grounded: files really get created, so the answers
 * describe real actions.
 *
 * Teacher spec:
 *   ollama://llama3.1:8b                        (local Ollama model)
 *   openai://gpt-4o-mini                        (uses OPENAI_API_KEY env var)
 *   https://api.groq.com/openai/v1|APIKEY|model (any OpenAI-compatible base)
 *
 * Usage:
 *   npm run distill -- --num 10 --teacher ollama://llama3.1:8b
 *   npm run distill -- --tasks-file training/my-tasks.txt --teacher openai://gpt-4o-mini
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";
import { runTurn } from "../src/agent.js";
import { SessionLogger } from "../src/session.js";
import type { PixieConfig, ProviderConfig } from "../src/types.js";

/* ── args ── */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const NUM = Math.max(1, Number(arg("num", "10")));
const TEACHER = arg("teacher", "ollama://llama3.1:8b");
const TASKS_FILE = arg("tasks-file", "");
const KEEP = process.argv.includes("--keep");
const OUT = resolve("training/distilled.jsonl");
const WORKSPACE = resolve("training/distill-workspace");

/* ── teacher spec → provider config ── */
function resolveTeacher(spec: string): ProviderConfig {
  if (spec.startsWith("ollama://")) {
    return { kind: "ollama", baseUrl: "http://localhost:11434", model: spec.slice("ollama://".length) };
  }
  if (spec.startsWith("openai://")) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.error("openai:// teacher needs the OPENAI_API_KEY environment variable.");
      process.exit(1);
    }
    return { kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: key, model: spec.slice("openai://".length) };
  }
  const parts = spec.split("|");
  if (parts.length === 3) {
    return { kind: "openai", baseUrl: parts[0], apiKey: parts[1], model: parts[2] };
  }
  console.error(`Unrecognized teacher spec: ${spec}`);
  console.error("Use ollama://<model>, openai://<model>, or https://base|apikey|model");
  process.exit(1);
}

/* ── starter tasks (beginner-flavored, unambiguous, varied) ── */
const SEED_TASKS: string[] = [
  "create a file named greeting.txt containing a friendly hello message",
  "make a file named fruit.txt that lists five fruits, one per line",
  "create index.html with a simple page titled About Me and one paragraph about hobbies",
  "write a haiku about mountains into haiku.txt",
  "create a file named recipe.txt with a short 3-step sandwich recipe",
  "make colors.txt listing the colors of the rainbow, one per line",
  "create math.txt with the answer to 12 multiplied by 12 written as a sentence",
  "write a short friendly note in card.txt inviting a friend to a birthday party on Saturday",
  "create todo.txt with a 4-item to-do list for cleaning a bedroom",
  "make a file named animals.txt with three animals and one fun fact each",
  "create facts.md with a markdown heading and two interesting space facts",
  "write diary.txt with a two-sentence diary entry about a rainy day",
  "create team.txt listing three team members, each with a name and a role on one line",
  "make a folder called school and inside it create homework.txt listing three subjects to study",
  "create prices.txt with three items and their prices, one per line, like 'apple 1.20'",
  "write smoothie.txt listing the ingredients for a simple fruit smoothie",
  "create countdown.txt with the numbers 5 down to 1, one per line",
  "make birthday.md with a markdown heading Party Plan and two lines about the party",
  "create questions.txt with three friendly questions to get to know someone",
  "write links.html with three list items naming favorite websites",
  "create joke.txt with one short, family-friendly joke",
  "make goals.txt listing three goals for this month",
  "make a folder called projects and inside it create ideas.txt with two project ideas",
  "create time.txt with the answer to how many hours are in 3 days, written as a sentence",
  "write packing.txt listing five things to take on a beach trip",
  "create vowels.txt with the letters a, e, i, o and u, one per line",
  "make book.txt with a one-sentence review of a famous book",
  "create budget.md with a heading Monthly Budget and two example expense lines",
  "write compliments.txt with three kind compliments, one per line",
  "create city.txt with a two-sentence description of a famous city",
  "make schedule.txt with a Monday plan showing three activities with times",
  "create minutes.txt containing just the number of minutes in 2 hours",
  "write superhero.txt inventing a superhero name and their one superpower",
  "create planet.txt with one fun fact about each of three planets, one per line",
  "make notes.txt with a tiny meeting summary: topic, decision, and next step",
];

function loadTasks(): string[] {
  const tasks = [...SEED_TASKS];
  if (TASKS_FILE && existsSync(TASKS_FILE)) {
    for (const line of readFileSync(TASKS_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) tasks.push(t);
    }
  }
  return tasks;
}

function isGoodTrace(reply: string): boolean {
  const t = reply.trim();
  return t.length >= 30 && !t.startsWith("Error:") && !t.includes("NEEDS_APPROVAL");
}

async function main(): Promise<void> {
  const teacher = resolveTeacher(TEACHER);
  const cfg: PixieConfig = {
    provider: teacher,
    fallback: null,
    workspace: WORKSPACE,
    beginnerMode: true,
    temperature: 0.4,
    maxToolRounds: 8,
  };

  if (!KEEP && existsSync(WORKSPACE)) rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(resolve("training"), { recursive: true });

  const seen = new Set<string>();
  if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, "utf8").split("\n")) {
      if (line.trim()) seen.add(line.slice(0, 200));
    }
  }

  const tasks = loadTasks();
  const picked: string[] = [];
  for (let i = 0; picked.length < NUM && i < Math.max(NUM, tasks.length) * 3; i++) {
    picked.push(tasks[i % tasks.length]);
  }

  console.log(`Teacher   : ${teacher.kind}/${teacher.model}`);
  console.log(`Tasks     : ${picked.length}`);
  console.log(`Output    : ${OUT}\n`);

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < picked.length; i++) {
    const task = picked[i];
    process.stdout.write(`  [${i + 1}/${picked.length}] ${task.slice(0, 60)}… `);
    const logger = new SessionLogger(WORKSPACE, { note: "distill", task });
    try {
      const result = await runTurn(cfg, [], task, logger, { autoRun: true });
      if (!isGoodTrace(result.reply)) {
        skipped++;
        console.log("skipped (weak trace)");
        continue;
      }
      const pair = {
        messages: [
          { role: "system", content: BEGINNER_SYSTEM_PROMPT },
          { role: "user", content: task },
          { role: "assistant", content: result.reply.trim() },
        ],
      };
      const key = createHash("sha256").update(JSON.stringify(pair.messages)).digest("hex").slice(0, 40);
      if (seen.has(key)) {
        skipped++;
        console.log("skipped (duplicate)");
        continue;
      }
      seen.add(key);
      appendFileSync(OUT, JSON.stringify(pair) + "\n", "utf8");
      written++;
      console.log(`ok (${result.toolRounds} tool round${result.toolRounds === 1 ? "" : "s"})`);
    } catch (err) {
      skipped++;
      console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDistilled ${written} trace(s) → ${OUT}${skipped ? ` (${skipped} skipped)` : ""}`);
  console.log("Combine with your own sessions when training:");
  console.log('  DATASET_FILE = "training/dataset.jsonl,training/distilled.jsonl"  # in lora_config.py');
  if (!KEEP) console.log(`\nScratch workspace kept at ${WORKSPACE} (inspect it, then delete or rerun without --keep).`);
}

// Only run when invoked directly (not when imported by tests).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((err) => {
    console.error("Distillation failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
