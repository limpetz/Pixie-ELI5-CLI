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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTurn } from "../src/agent.js";
import { extractPairs } from "./build-dataset.js";
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
/** Task offset so later batches pick different tasks instead of repeating batch 1. */
const OFFSET = Math.max(0, Number(arg("offset", "0")));
/** Sampling temperature — vary it between batches so repeated tasks still yield new traces. */
const TEMP = Math.min(1.5, Math.max(0, Number(arg("temperature", "0.4"))));
const KEEP = process.argv.includes("--keep");
/** Use ONLY the tasks from --tasks-file, skipping the built-in create-only pool. */
const ONLY = process.argv.includes("--only");
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
  "create groceries.txt with a 6-item shopping list for making pancakes",
  "write weather.txt with a one-sentence forecast for a sunny day",
  "make a folder called music and inside it create playlist.txt with four song titles",
  "create shapes.txt listing four shapes, one per line",
  "write intro.md with a heading Hello and one sentence introducing yourself as Pixie",
  "create phone.txt with a fake phone number formatted like 555-0123 on its own line",
  "make pets.txt listing three pets and one word describing each",
  "create ladder.txt with the numbers 1 to 10, one per line",
  "write garden.txt with three flowers that grow in spring",
  "create code.txt with the word pixie written backwards on one line",
  "make ladder-down.txt with the even numbers from 10 down to 2, one per line",
  "create secret.txt where the content is exactly: the flag is green",
  "write thank-you.txt with a two-sentence thank-you note to a teacher",
  "make sizes.txt with three t-shirt sizes (S, M, L) and an example item for each",
  "create bucket-list.txt with three things to do before turning 30",
  "write study.txt with a 3-line study plan for learning cooking",
  "create dream.txt describing a one-sentence dream from last night",
  "make vowels-count.txt with just the number of vowels in the word encyclopedia",
  "create story-folder/story.txt with a two-sentence story about a robot, inside a new folder called story-folder",
  "write menu.txt with three dinner options and prices, one per line",
];

interface TaskSpec {
  /** Verifier id ("" = unverified) — see VERIFY below. Lines use "id | text". */
  id: string;
  text: string;
}

function loadTasks(): TaskSpec[] {
  const fileTasks: TaskSpec[] = [];
  if (TASKS_FILE && existsSync(TASKS_FILE)) {
    for (const line of readFileSync(TASKS_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const sep = t.indexOf("|");
      fileTasks.push(
        sep > 0
          ? { id: t.slice(0, sep).trim(), text: t.slice(sep + 1).trim() }
          : { id: "", text: t },
      );
    }
  }
  if (ONLY) {
    if (!fileTasks.length) {
      console.error("--only needs --tasks-file with at least one task.");
      process.exit(1);
    }
    return fileTasks;
  }
  return [...SEED_TASKS.map((text) => ({ id: "", text })), ...fileTasks];
}

/* ── goal verification ──
 * A trace is only worth training on if the workspace actually shows the task
 * was achieved. Each verifier returns null on success or a problem string.
 * NOTE: because null means success, `a(...) ?? b(...)` requires BOTH checks
 * to pass (?? only falls through when a SUCCEEDED). For either/or, loop.
 * Expected values are documented in training/chain-tasks.txt. */
function fileIs(ws: string, file: string, values: string[]): string | null {
  let content: string;
  try {
    content = readFileSync(join(ws, file), "utf8").trim();
  } catch {
    return `${file} unreadable`;
  }
  return values.includes(content) ? null : `${file} is "${content.slice(0, 30)}"`;
}
function fileContains(ws: string, file: string, needle: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(ws, file), "utf8");
  } catch {
    return `${file} unreadable`;
  }
  return content.includes(needle) ? null : `${file} lacks "${needle}"`;
}
function fileLacks(ws: string, file: string, needle: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(ws, file), "utf8");
  } catch {
    return `${file} unreadable`;
  }
  return content.includes(needle) ? `${file} still has "${needle}"` : null;
}
export const VERIFY: Record<string, (ws: string) => string | null> = {
  count: (ws) => fileIs(ws, "count.txt", ["5"]),
  priciest: (ws) => fileIs(ws, "priciest.txt", ["olive oil"]),
  average: (ws) => fileIs(ws, "average.txt", ["80"]),
  total: (ws) => fileIs(ws, "total.txt", ["6.7", "6.70", "Total: 6.70", "Total: 6.7"]),
  letterlines: (ws) => fileIs(ws, "linecount.txt", ["5", "6"]),
  toycount: (ws) => fileIs(ws, "toycount.txt", ["4"]),
  temp: (ws) => fileIs(ws, "temp.txt", ["350"]),
  calc2: (ws) => fileIs(ws, "calc2.txt", ["72"]),
  quotient: (ws) => fileIs(ws, "quotient.txt", ["25"]),
  today: (ws) => fileContains(ws, "today.txt", "2026"),
  files: (ws) => fileContains(ws, "files.txt", "letter.txt"),
  power: (ws) => fileIs(ws, "power.txt", ["1024"]),
  // Task pools disagree on the output name (chain-tasks: linecount.txt,
  // chain-retry: linecount2.txt) — accept either.
  wcletter: (ws) => {
    for (const f of ["linecount2.txt", "linecount.txt"]) {
      if (fileIs(ws, f, ["5", "6"]) === null) return null;
    }
    return "neither linecount2.txt nor linecount.txt holds 5 or 6";
  },
  fixtwo: (ws) => fileLacks(ws, "letter-a.txt", "teh") ?? fileLacks(ws, "recipe-a.md", "suger"),
  settingsdark: (ws) =>
    fileContains(ws, "settings-a.ini", "theme = dark") ?? fileContains(ws, "settings-a.ini", "volume = 8"),
  recipesugar: (ws) =>
    fileContains(ws, "recipe-b.md", "sugar") ?? fileContains(ws, "recipe-b.md", "2 cups of flour"),
  settingslook: (ws) =>
    fileContains(ws, "settings-b.ini", "[look and feel]") ?? fileContains(ws, "settings-b.ini", "volume = 7"),
  letterrecipe: (ws) => fileLacks(ws, "letter-b.txt", "teh") ?? fileContains(ws, "recipe.md", "Peel and mash"),
  // ── round 4: command→save chains (eval tasks 15/17/24 kept failing these) ──
  // Accept any value containing the digits, so formatting like "42" vs "Total: 42" both pass.
  cmdsave: (ws) => fileContains(ws, "tmp-calc.txt", "42"),
  wcletter3: (ws) => fileIs(ws, "linecount3.txt", ["5", "6"]),
  pow2: (ws) => fileContains(ws, "pow2.txt", "128"),
  cmdtotal: (ws) => fileContains(ws, "total-sh.txt", "6.70") ?? fileContains(ws, "total-sh.txt", "6.7"),
  // Append target is inventory.csv (the seeded data file) — and a true append
  // must not lose the rows that were already there.
  csvappend: (ws) => {
    let content: string;
    try {
      content = readFileSync(join(ws, "inventory.csv"), "utf8");
    } catch {
      return "inventory.csv unreadable";
    }
    if (!content.includes("cherries")) return 'inventory.csv lacks "cherries"';
    return content.includes("bananas,6") ? null : 'inventory.csv lost "bananas,6"';
  },
  csvsum: (ws) => fileContains(ws, "inv2.txt", "10"),
  // ── round 4: exact-N multi-file creation (eval tasks 8/20) ──
  // "Exactly three files" means three files: any extra entry fails, whatever
  // it is named (the teacher loves to sneak in an extra notes.txt/tester.txt).
  team3: (ws) => {
    const need = new Set(["dev.txt", "design.txt", "manager.txt"]);
    let entries: string[];
    try {
      entries = readdirSync(join(ws, "team"));
    } catch {
      return "team/ missing";
    }
    for (const f of need) if (!entries.includes(f)) return `team/${f} missing`;
    const extra = entries.filter((f) => !need.has(f));
    return extra.length ? `team/ has extra file(s): ${extra.join(", ")}` : null;
  },
  shapes4: (ws) => {
    for (const f of ["square.txt", "circle.txt", "triangle.txt", "hexagon.txt"])
      if (!existsSync(join(ws, "shapes", f))) return `shapes/${f} missing`;
    return null;
  },
  // ── round 4: two edits in one task (eval task 13) + csv edit ──
  lettersc: (ws) => fileLacks(ws, "letter-c.txt", "teh"),
  settingsc: (ws) => fileContains(ws, "settings-c.ini", "theme = dark") ?? fileContains(ws, "settings-c.ini", "language = fr"),
  recipesugar2: (ws) => fileContains(ws, "recipe-c.md", "sugar") ?? fileContains(ws, "recipe-c.md", "2 cups of flour"),
  recipesalt: (ws) =>
    fileContains(ws, "recipe-d.md", "pinch of salt") ?? fileContains(ws, "recipe-d.md", "Mix the batter"),
  // Two cells change (apples 4→5 AND bananas 6→9) — both required.
  csvprice: (ws) => {
    let content: string;
    try {
      content = readFileSync(join(ws, "inv2.csv"), "utf8");
    } catch {
      return "inv2.csv unreadable";
    }
    if (!content.includes("apples,5")) return 'inv2.csv lacks "apples,5"';
    return content.includes("bananas,9") ? null : 'inv2.csv lacks "bananas,9"';
  },
  // ── round 4: create-then-edit same conversation (eval task 11) ──
  // Single-file task: create contact.txt, then fix its own typo.
  contactfix: (ws) => fileLacks(ws, "contact.txt", "favrite"),
  aboutedit: (ws) => fileContains(ws, "about.html", "Our Story"),
};

/** Deterministic workspace restore between tasks/retries, so a half-done
 * previous attempt can never make a later attempt's verify pass spuriously.
 * Uses the same seeder the task files document (training/seed-workspace.py). */
function reseedWorkspace(): void {
  const py = resolve("training/.venv/Scripts/python.exe");
  const seeder = resolve("training/seed-workspace.py");
  if (existsSync(py) && existsSync(seeder)) {
    execSync(`"${py}" "${seeder}"`, { stdio: "ignore" });
  }
}

function isGoodTrace(reply: string): boolean {
  const t = reply.trim();
  return t.length >= 30 && !t.startsWith("Error:") && !t.includes("NEEDS_APPROVAL");
}

/** Tool rounds that happened AFTER a tool result — real read→write chaining.
 * Two calls fired in parallel in one round don't count: that pattern teaches
 * the model to fire blind calls, not to use tool output. */
function countSequentialRounds(path: string): number {
  let rounds = 0;
  let sawResult = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let e: { type?: string };
    try {
      e = JSON.parse(line) as { type?: string };
    } catch {
      continue;
    }
    if (e.type === "tool_result") sawResult = true;
    else if (e.type === "assistant_tool_calls" && sawResult) {
      rounds++;
      sawResult = false;
    }
  }
  return rounds;
}

/** Verified tasks whose goal is pure creation (exact-N files): the teacher
 * may legitimately fire all writes in ONE parallel round, so the
 * sequential-chain requirement below must not apply to them. */
const PARALLEL_OK = new Set(["team3", "shapes4"]);

/** Strong teachers one-shot these tasks (one write_file with the final
 * content) — efficient, but a one-shot trace teaches the student nothing
 * about chaining, so the attempt-1 run is discarded. On attempt 2 we append
 * explicit steps to the task text; the resulting trace is a real
 * tool→result→tool chain and is what gets kept. Keys are pool ids. */
const SCAFFOLD: Record<string, string> = {
  cmdsave: " Work step by step: (1) run the command with run_command, (2) write just its output into tmp-calc.txt with write_file, (3) read the file back to check it, then give your summary.",
  wcletter3: " Work step by step: (1) run the line-count command with run_command, (2) write just that number into linecount3.txt with write_file, (3) read the file back to check it, then give your summary.",
  pow2: " Work step by step: (1) run the command with run_command, (2) write just its output into pow2.txt with write_file, (3) read the file back to check it, then give your summary.",
  cmdtotal: " Work step by step: (1) run the command that adds the prices, (2) write just the total into total-sh.txt with write_file, (3) read the file back to check it, then give your summary.",
  csvsum: " Work step by step: (1) run the command that adds the amounts, (2) write just the total into inv2.txt with write_file, (3) read the file back to check it, then give your summary.",
  csvappend: " Work step by step: (1) run the append command with run_command, (2) read inventory.csv back to check the new line is there AND the old lines are intact, then give your summary.",
  settingsc: " Work step by step: (1) read settings-c.ini, (2) make the theme edit with edit_file, (3) make the language edit with edit_file, (4) read the file back and give your summary.",
  recipesugar2: " Work step by step: (1) read recipe-c.md, (2) fix the suger typo with edit_file, (3) change the flour amount with edit_file, (4) read the file back and give your summary.",
  recipesalt: " Work step by step: (1) read recipe-d.md, (2) add the salt line with edit_file, (3) rewrite the mixing line with edit_file, (4) read the file back and give your summary.",
  csvprice: " Work step by step: (1) read inv2.csv, (2) change the apples amount with edit_file, (3) change the bananas amount with edit_file, (4) read the file back and give your summary.",
  contactfix: " Work step by step: (1) create contact.txt with write_file, (2) read it back, (3) fix the typo with edit_file, (4) read the file again and give your summary.",
  aboutedit: " Work step by step: (1) create about.html with write_file, (2) read it back, (3) change the heading with edit_file, (4) read the file again and give your summary.",
  team3: " Work step by step: (1) create the team folder's first file, (2) the second, (3) the third — counting as you go so there are exactly three — then list the folder and give your summary.",
  shapes4: " Work step by step: (1) create the shapes folder's first file, (2) the second, (3) the third, (4) the fourth — counting as you go so there are exactly four — then list the folder and give your summary.",
};
/** Fallback for verified ids not in SCAFFOLD (e.g. chain-tasks pool ids). */
const DEFAULT_SCAFFOLD =
  " Work step by step: first look at the file(s) you need, then make the change or run the command as its own step, then double-check the result before you summarize.";

async function main(): Promise<void> {
  const teacher = resolveTeacher(TEACHER);
  const cfg: PixieConfig = {
    provider: teacher,
    fallback: null,
    workspace: WORKSPACE,
    beginnerMode: true,
    temperature: TEMP,
    maxToolRounds: 8,
  };

  if (!KEEP && existsSync(WORKSPACE)) rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(resolve("training"), { recursive: true });

  const seen = new Set<string>();
  if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as { messages?: unknown };
        if (p.messages) {
          seen.add(createHash("sha256").update(JSON.stringify(p.messages)).digest("hex").slice(0, 40));
        }
      } catch {
        // ignore malformed lines — they just can't be deduped
      }
    }
  }

  const tasks = loadTasks();
  const picked: TaskSpec[] = [];
  for (let i = 0; i < NUM; i++) {
    picked.push(tasks[(i + OFFSET) % tasks.length]);
  }

  console.log(`Teacher    : ${teacher.kind}/${teacher.model}`);
  console.log(`Tasks      : ${picked.length} (offset ${OFFSET}, temperature ${TEMP})`);
  console.log(`Output     : ${OUT}\n`);

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < picked.length; i++) {
    const { id, text: task } = picked[i];
    const verify = id ? VERIFY[id] : undefined;
    if (id && !verify) {
      console.error(`\nUnknown verifier id "${id}" in the task file — fix it and rerun.`);
      process.exit(1);
    }
    process.stdout.write(`  [${i + 1}/${picked.length}] ${task.slice(0, 60)}… `);
    let saved = false;
    let problem = "";
    // Every attempt starts from a pristine, deterministic workspace: no stale
    // files masking laziness, no task-N fix breaking task-N+1's preconditions.
    for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
      reseedWorkspace();
      const logger = new SessionLogger(WORKSPACE, { note: "distill", task });
      // Attempt 2 gets a step scaffold for verified tasks: a one-shot trace
      // can't pass the chain gate anyway, so use the retry to elicit a chain.
      const taskText = attempt === 1 || !verify ? task : task + (SCAFFOLD[id] ?? DEFAULT_SCAFFOLD);
      try {
        const result = await runTurn(cfg, [], taskText, logger, { autoRun: true });
        if (!isGoodTrace(result.reply)) {
          problem = "weak trace";
          continue;
        }
        const session = readFileSync(logger.path, "utf8");
        const totalCalls = session.split("\n").filter((l) => l.includes('"assistant_tool_calls"')).length;
        const seqRounds = countSequentialRounds(logger.path);
        // Verified tasks exist to teach chaining — require a real
        // tool→result→tool round, not two blind parallel calls.
        // Verified tasks exist to teach chaining — require a real
        // tool→result→tool round, not two blind parallel calls. PARALLEL_OK
        // tasks (exact-N creation) are exempt: parallel writes are their
        // legitimate shape, and the verifier + exact file-count is the gate.
        if (verify && !PARALLEL_OK.has(id) && totalCalls < 2) {
          problem = attempt > 1 ? `one-shot even with scaffold` : `only ${totalCalls} tool round(s)`;
          continue;
        }
        if (verify && !PARALLEL_OK.has(id) && seqRounds < 1) {
          problem = "parallel calls, no sequential chain";
          continue;
        }
        if (verify) {
          problem = verify(WORKSPACE) ?? "";
          if (problem) continue;
        }
        // Rebuild the FULL conversation (tool rounds + results) from the log.
        const exchange = extractPairs(logger.path, "distill").pop();
        if (!exchange) {
          problem = "no healthy exchange";
          continue;
        }
        const pair = { messages: exchange.messages };
        const key = createHash("sha256").update(JSON.stringify(pair.messages)).digest("hex").slice(0, 40);
        if (seen.has(key)) {
          problem = "duplicate";
          continue;
        }
        seen.add(key);
        appendFileSync(OUT, JSON.stringify(pair) + "\n", "utf8");
        written++;
        saved = true;
        console.log(`ok (${totalCalls} call(s), ${seqRounds} chained${attempt > 1 ? `, attempt ${attempt}` : ""})`);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
    }
    if (!saved) {
      skipped++;
      console.log(`skipped (${problem})`);
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
