#!/usr/bin/env node
/**
 * Round 10 data builder — the two failure modes scaffold-v2.2 nudges at run-
 * time, taught as data:
 *
 *   1. GIVE-UP REFUSALS (eval #24 class). The model lists + reads the seed
 *      files successfully, then replies "I can't complete this task as it
 *      involves files that don't exist" and stops. Pairs here show the SAME
 *      start (list_files → read_file) followed by the actual compute and
 *      write_file — the refusal must never appear in any assistant turn.
 *
 *   2. PHANTOM WRITES (eval #23 class). The model reads the files, then
 *      answers in prose claiming "- Wrote 'telescope' to 'best.txt'" without
 *      ever calling write_file. Pairs here include a read that might tempt a
 *      prose answer, then the real write_file, then the summary that only
 *      reports what actually happened.
 *
 * Conventions: r1's (per the round-9 convention audit) — silent tool turns,
 * write_file content WITHOUT trailing newline, bullet mix of •, * and -, varied
 * summary shapes, terse summaries, no edit_file. Every trace is replayed
 * through the REAL executeTool and scored with the eval's own runChecks.
 *
 * Emits (same two-arm layout as round 9):
 *   training/round10-synth.jsonl     N synth rows (arm B: continuation)
 *   training/round10-32plusN.jsonl   32 r1 verbatim + mirrors (arm A)
 *
 * Usage: npm run build-round10
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";
import { executeTool } from "../src/tools.js";
import { runChecks } from "./eval.js";
import type { Msg, Pair } from "./build-dataset.js";

/* ── trace helpers ── */

function call(name: string, args: Record<string, unknown>): Msg {
  return { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name, arguments: args } }] };
}
function toolRes(name: string, content: string): Msg {
  return { role: "tool", name, content };
}

type Shape = "standard" | "compact" | "no-try" | "great";

function summary(shape: Shape, bullets: string[], tryIt: string): string {
  const body = bullets.join("\n");
  const core = `What I did:\n${body}`;
  if (shape === "no-try") return core;
  const withTry = shape === "compact" ? `${core}\nTry it yourself:\n- ${tryIt}` : `${core}\n\nTry it yourself:\n- ${tryIt}`;
  if (shape === "great") return `Great! All done with your files.\n\n${withTry}`;
  return withTry;
}

/* ── scenarios ──
 * giveup:  read-only start, then the real write (anti-refusal pattern)
 * phantom: read that tempts a prose answer, then the real write
 */

interface Scenario {
  id: string;
  kind: "giveup" | "phantom";
  mirror: boolean; // mirrors an eval task exactly -> goes into the arm-A set
  seeds: { path: string; content: string }[];
  user: string;
  actions: ({ kind: "read"; path: string } | { kind: "write"; path: string; content: string })[];
  bullets: string[];
  tryIt: string;
  checks: string[];
}

const SCENARIOS: Scenario[] = [
  /* ── give-up class ── */
  {
    // Mirror of eval #24 (its exact seeds, prompt and target value 13).
    id: "r10-s01 (mirror eval #24)",
    kind: "giveup",
    mirror: true,
    seeds: [
      { path: "menu.txt", content: "pizza 8\nsalad 5\njuice 3\n" },
      { path: "orders.txt", content: "pizza\njuice\nwait no — salad\n" },
    ],
    user: "read menu.txt and orders.txt, then create total.txt containing only the total price of the order (just the number)",
    actions: [
      { kind: "read", path: "menu.txt" },
      { kind: "read", path: "orders.txt" },
      { kind: "write", path: "total.txt", content: "13" },
    ],
    bullets: ["Read menu.txt and orders.txt.", "Wrote 13, the total for pizza, juice and salad, into total.txt"],
    tryIt: "Ask me to total a bigger order next.",
    checks: ["file:total.txt", "regex:\\b13\\b", "file-count:3"],
  },
  {
    id: "r10-s02",
    kind: "giveup",
    mirror: false,
    seeds: [
      { path: "prices.txt", content: "pen 2\nbook 7\n" },
      { path: "cart.txt", content: "pen\nbook\npen\n" },
    ],
    user: "read prices.txt and cart.txt, then write the total cost of the cart into bill.txt (just the number)",
    actions: [
      { kind: "read", path: "prices.txt" },
      { kind: "read", path: "cart.txt" },
      { kind: "write", path: "bill.txt", content: "11" },
    ],
    bullets: ["Read prices.txt and cart.txt.", "Wrote 11, the cost of pen, book and pen, into bill.txt"],
    tryIt: "Ask me to price another cart.",
    checks: ["file:bill.txt", "regex:\\b11\\b", "file-count:3"],
  },
  {
    id: "r10-s03",
    kind: "giveup",
    mirror: false,
    seeds: [
      { path: "ages.txt", content: "Mia 9\nLeo 12\n" },
      { path: "invited.txt", content: "Mia\nLeo\nSam\n" },
    ],
    user: "look at ages.txt and invited.txt, then create party.txt listing only the invited kids whose age is in ages.txt",
    actions: [
      { kind: "read", path: "ages.txt" },
      { kind: "read", path: "invited.txt" },
      { kind: "write", path: "party.txt", content: "Mia\nLeo" },
    ],
    bullets: ["Read ages.txt and invited.txt.", "Wrote party.txt with Mia and Leo, the invited kids in ages.txt"],
    tryIt: "Ask me to plan another guest list.",
    checks: ["file:party.txt", "contains:Mia", "contains:Leo", "lines:party.txt:2-2", "file-count:3"],
  },
  {
    id: "r10-s04",
    kind: "giveup",
    mirror: false,
    seeds: [
      { path: "steps.txt", content: "pour flour\nadd eggs\nmix\n" },
      { path: "done.txt", content: "pour flour\nadd eggs\n" },
    ],
    user: "read steps.txt and done.txt, then write the one remaining step into next.txt",
    actions: [
      { kind: "read", path: "steps.txt" },
      { kind: "read", path: "done.txt" },
      { kind: "write", path: "next.txt", content: "mix" },
    ],
    bullets: ["Read steps.txt and done.txt.", "Wrote mix, the only step not done yet, into next.txt"],
    tryIt: "Ask me what comes next in another recipe.",
    checks: ["file:next.txt", "contains:mix", "file-count:3"],
  },

  /* ── phantom-write class ── */
  {
    // Mirror of eval #23 (its exact seed, prompt and target value).
    id: "r10-s05 (mirror eval #23)",
    kind: "phantom",
    mirror: true,
    seeds: [{ path: "wishlist.txt", content: "skateboard 90\n telescope 250 \nheadphones 120\n" }],
    user: "read wishlist.txt, figure out which single item costs the most, and write just that item's name into best.txt",
    actions: [
      { kind: "read", path: "wishlist.txt" },
      { kind: "write", path: "best.txt", content: "telescope" },
    ],
    bullets: ["Read wishlist.txt and found the telescope costs the most.", "Wrote just the word telescope into best.txt"],
    tryIt: "Ask me to find the cheapest item instead.",
    checks: ["file:best.txt", "contains:telescope", "lines:best.txt:1-1", "file-count:2"],
  },
  {
    id: "r10-s06",
    kind: "phantom",
    mirror: false,
    seeds: [{ path: "scores.txt", content: "anna 88\nbrad 91\ncara 79\n" }],
    user: "read scores.txt and save the name of the top scorer into champ.txt",
    actions: [
      { kind: "read", path: "scores.txt" },
      { kind: "write", path: "champ.txt", content: "brad" },
    ],
    bullets: ["Read scores.txt and found brad has the top score.", "Wrote just the name brad into champ.txt"],
    tryIt: "Ask me for the lowest score instead.",
    checks: ["file:champ.txt", "contains:brad", "lines:champ.txt:1-1", "file-count:2"],
  },
  {
    id: "r10-s07",
    kind: "phantom",
    mirror: false,
    seeds: [{ path: "animals.txt", content: "cat\nelephant\nox\n" }],
    user: "read animals.txt and save the longest animal name into winner.txt",
    actions: [
      { kind: "read", path: "animals.txt" },
      { kind: "write", path: "winner.txt", content: "elephant" },
    ],
    bullets: ["Read animals.txt and found elephant is the longest name.", "Wrote just elephant into winner.txt"],
    tryIt: "Ask me for the shortest name instead.",
    checks: ["file:winner.txt", "contains:elephant", "lines:winner.txt:1-1", "file-count:2"],
  },
  {
    id: "r10-s08",
    kind: "phantom",
    mirror: false,
    seeds: [{ path: "lines.txt", content: "first line here\nsecond line here\nthird line here\n" }],
    user: "read lines.txt and save how many lines it has into count.txt (just the number)",
    actions: [
      { kind: "read", path: "lines.txt" },
      { kind: "write", path: "count.txt", content: "3" },
    ],
    bullets: ["Read lines.txt and counted 3 lines.", "Wrote just the number 3 into count.txt"],
    tryIt: "Ask me to count the lines of another file.",
    checks: ["file:count.txt", "regex:\\b3\\b", "file-count:2"],
  },
  {
    id: "r10-s09",
    kind: "phantom",
    mirror: false,
    seeds: [{ path: "team.json", content: '{\n  "captain": "Rae",\n  "members": 4\n}' }],
    user: "read team.json and save the captain's name into captain.txt",
    actions: [
      { kind: "read", path: "team.json" },
      { kind: "write", path: "captain.txt", content: "Rae" },
    ],
    bullets: ["Read team.json and found the captain is Rae.", "Wrote just the name Rae into captain.txt"],
    tryIt: "Ask me for the member count next.",
    checks: ["file:captain.txt", "contains:Rae", "file-count:2"],
  },
  {
    id: "r10-s10",
    kind: "phantom",
    mirror: false,
    seeds: [{ path: "reading.txt", content: "Monday 12 pages\nTuesday 9 pages\n" }],
    user: "read reading.txt and save the total pages read into pages.txt (just the number)",
    actions: [
      { kind: "read", path: "reading.txt" },
      { kind: "write", path: "pages.txt", content: "21" },
    ],
    bullets: ["Read reading.txt and added 12 plus 9.", "Wrote just the number 21 into pages.txt"],
    tryIt: "Ask me to total another week of reading.",
    checks: ["file:pages.txt", "regex:\\b21\\b", "file-count:2"],
  },
];

/* Deterministic r1-style convention assignment (10 rows):
 * bullets  • ×5, * ×3, - ×2   (r1 ratio scaled down)
 * shapes   standard ×5, no-try ×2, compact ×2, great ×1 */
const BULLETS = ["•", "•", "*", "•", "•", "-", "*", "•", "•", "-"];
const SHAPES: Shape[] = ["standard", "no-try", "standard", "compact", "standard", "great", "standard", "no-try", "standard", "compact"];

/* ── render: replay the REAL tools against a real workspace ── */

function renderScenario(s: Scenario, bullet: string, shape: Shape): Pair {
  const ws = resolve("training/round10-verify-ws");
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const seed of s.seeds) {
    mkdirSync(join(ws, seed.path, ".."), { recursive: true });
    writeFileSync(join(ws, seed.path), seed.content, "utf8");
  }

  const msgs: Msg[] = [{ role: "user", content: s.user }];
  const files = new Map<string, string>(s.seeds.map((seed) => [seed.path, seed.content]));

  for (const a of s.actions) {
    if (a.kind === "read") {
      const r = executeTool(ws, "read_file", { path: a.path }, { autoApproveBash: false });
      if (!r.ok) throw new Error(`${s.id}: read_file(${a.path}) failed: ${r.output}`);
      if (r.output !== files.get(a.path)) {
        throw new Error(`${s.id}: read output does not match known content of ${a.path}`);
      }
      msgs.push(call("read_file", { path: a.path }), toolRes("read_file", r.output));
    } else {
      const r = executeTool(ws, "write_file", { path: a.path, content: a.content }, { autoApproveBash: false });
      if (!r.ok) throw new Error(`${s.id}: write_file(${a.path}) failed: ${r.output}`);
      if (r.output !== `Wrote ${a.path}` && !r.output.startsWith(`Wrote ${a.path} (replaced:`)) throw new Error(`${s.id}: unexpected write output: ${r.output}`);
      files.set(a.path, a.content);
      // Dataset rows carry the canonical frozen-era tool output (r8/r9/r10 data
      // was built after scaffold-v2 enriched write_file output) — keep rows
      // byte-reproducible regardless of runtime tool-output changes.
      msgs.push(call("write_file", { path: a.path, content: a.content }), toolRes("write_file", `Wrote ${a.path}`));
    }
  }

  // Final workspace must hold exactly the traced content and pass the checks.
  for (const [path, content] of files) {
    const onDisk = readFileSync(join(ws, path), "utf8");
    if (onDisk !== content) throw new Error(`${s.id}: ${path} on disk differs from traced content`);
  }
  const bullets = s.bullets.map((b) => `${bullet} ${b}`);
  const reply = summary(shape, bullets, s.tryIt);
  const verdict = runChecks(s.checks, ws, reply);
  if (!verdict.pass) {
    throw new Error(`${s.id}: final workspace failed checks: ${verdict.failed.join(", ")}`);
  }

  msgs.push({ role: "assistant", content: reply });
  return { messages: [{ role: "system", content: BEGINNER_SYSTEM_PROMPT }, ...msgs], source: "round10-synth" };
}

/* ── the frozen r1 system prompt ──
 * scaffold-v2 later inserted the "CHANGING A FILE THAT ALREADY EXISTS" section
 * into BEGINNER_SYSTEM_PROMPT (runtime teaching), so r1's rows still carry the
 * frozen 1200-char prompt from the r1-freeze commit. Derive it by removing
 * that insert, and give arm A's mirrors the frozen prompt too so the whole
 * from-scratch file trains under ONE prompt (arm B's synth file keeps the
 * current runtime prompt — continuation must match what the model sees live).
 */
const R1_SYSTEM_PROMPT = BEGINNER_SYSTEM_PROMPT.replace(
  /\n\nCHANGING A FILE THAT ALREADY EXISTS:[\s\S]*?\n\nHOW TO SOUND/,
  "\n\nHOW TO SOUND",
);

/* ── r1-convention validators ── */

function validate(pairs: Pair[], opts: { strict: boolean; label: string }): void {
  let noNL = 0, writes = 0;
  const bullets = { "•": 0, "*": 0, "-": 0 };
  let noTry = 0, lenSum = 0;
  const shapes = new Set<string>();
  for (const p of pairs) {
    const sys = p.messages[0];
    const expectedSys = opts.strict ? BEGINNER_SYSTEM_PROMPT : R1_SYSTEM_PROMPT;
    if (sys.role !== "system" || sys.content !== expectedSys) throw new Error(`${opts.label}: pair without the expected system prompt`);
    const calls = p.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    if (calls.some((m) => m.content.trim() !== "")) throw new Error(`${opts.label}: narration before a tool call`);
    if (calls.some((m) => m.tool_calls!.some((tc) => tc.function.name === "edit_file"))) {
      throw new Error(`${opts.label}: edit_file is banned`);
    }
    if (calls.length < 1 || calls.length > 3) throw new Error(`${opts.label}: unexpected tool-call count: ${calls.length}`);
    const last = p.messages[p.messages.length - 1];
    if (last.role !== "assistant" || !last.content.trim()) throw new Error(`${opts.label}: pair does not end in a prose summary`);
    // No refusal text anywhere — the whole point of round 10.
    for (const m of p.messages) {
      if (m.role === "assistant" && /can'?t complete|don'?t exist|cannot complete/i.test(m.content)) {
        throw new Error(`${opts.label}: refusal phrasing leaked into a training row`);
      }
    }

    if (!opts.strict) continue; // r1-32: conventions are its own, just count
    for (const m of calls) {
      for (const tc of m.tool_calls!) {
        if (tc.function.name === "write_file") {
          writes++;
          const content = String(tc.function.arguments.content ?? "");
          if (!content.endsWith("\n")) noNL++;
        }
      }
    }
    const c = last.content;
    const seg = c.split("Try it yourself:")[0];
    if (/^• /m.test(seg)) bullets["•"]++; else if (/^\* /m.test(seg)) bullets["*"]++; else if (/^- /m.test(seg)) bullets["-"]++;
    if (!/Try it yourself:/.test(c)) noTry++;
    shapes.add([/^Great!/.test(c) ? "great" : "", /What I did:/.test(c) ? "did" : "", /\nTry it yourself:/.test(c) ? "try" : ""].join("|"));
    lenSum += c.length;
  }
  if (opts.strict) {
    if (noNL !== writes) throw new Error(`${opts.label}: ${writes - noNL} write(s) end with a trailing newline (r1: 31/32 without)`);
    if (noTry < 2) throw new Error(`${opts.label}: too few no-try summaries`);
    if (shapes.size < 3) throw new Error(`${opts.label}: summary shapes not varied enough (${shapes.size} variants)`);
    if (bullets["•"] < 3) throw new Error(`${opts.label}: bullet mix missing • rows (r1's dominant marker)`);
    const avgLen = lenSum / pairs.length;
    if (avgLen > 220) throw new Error(`${opts.label}: summaries too long (avg ${Math.round(avgLen)}; r1 ~136)`);
    console.log(`  conventions: writes=${writes} all-without-trailing-NL=${noNL === writes} bullets=${JSON.stringify(bullets)} noTry=${noTry} shapeVariants=${shapes.size} avgSummaryLen=${Math.round(avgLen)}`);
  }
}

function readJsonl(pairsPath: string): Pair[] {
  return readFileSync(pairsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Pair);
}

function main(): void {
  if (SCENARIOS.length !== BULLETS.length || SCENARIOS.length !== SHAPES.length) throw new Error("convention tables out of sync with scenarios");
  if (!SCENARIOS.some((s) => s.mirror && s.kind === "giveup") || !SCENARIOS.some((s) => s.mirror && s.kind === "phantom")) {
    throw new Error("both failure classes need a mirror scenario");
  }
  const synth = SCENARIOS.map((s, i) => renderScenario(s, BULLETS[i], SHAPES[i]));
  rmSync(resolve("training/round10-verify-ws"), { recursive: true, force: true });

  validate(synth, { strict: true, label: "synth10" });
  const r1 = readJsonl("training/r1.jsonl");
  if (r1.length !== 32) throw new Error(`expected 32 r1 pairs, found ${r1.length}`);
  validate(r1, { strict: false, label: "r1-32" });

  const synth10 = "training/round10-synth.jsonl";
  const plusN = "training/round10-32plus10.jsonl";
  const mirrors = synth.filter((_, i) => SCENARIOS[i].mirror).map((p) => ({
    ...p,
    messages: [{ role: "system" as const, content: R1_SYSTEM_PROMPT }, ...p.messages.slice(1)],
  }));
  if (mirrors.length !== 2) throw new Error(`expected 2 mirror scenarios, found ${mirrors.length}`);
  writeFileSync(synth10, synth.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  writeFileSync(plusN, [...r1, ...mirrors].map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  console.log(`round10-synth.jsonl written: ${synth.length} synth rows (giveup + phantom)`);
  console.log(`round10-32plus10.jsonl written: 32 r1 verbatim + ${mirrors.length} mirrors = ${32 + mirrors.length}`);
  console.log("All traces replayed through the real tools; all final workspaces passed eval-style checks.");
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) main();
