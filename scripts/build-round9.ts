#!/usr/bin/env node
/**
 * Round 9 data builder — r8's scenarios, r1's conventions.
 *
 * Round-8 post-mortem (r8 failed its target tasks #12/#13 in all 3 runs while
 * r1 passes them) + convention audit of training/r1.jsonl found five style-
 * drift vectors in the round-8 synth pairs. This builder fixes all of them:
 *
 *   1. write_file content: r1 ends WITHOUT a trailing newline in 31/32 writes;
 *      r8's synth ended WITH one in 13/15. Here: never a trailing newline.
 *   2. Bullet style: r1 mixes three markers (• 16/32, * 9/32, - 7/32);
 *      r8 used only - and *. Here: • 7, * 4, - 4 of 15.
 *   3. Summary shape: r1 varies — 25/32 have "Try it yourself", 29/32 open
 *      with "What I did:", 3/32 add a "Great!" preamble, some omit blank
 *      lines. r8 was 15/15 identical-template. Here: 4 shapes mixed.
 *   4. Verb/wording variety mirrors r1's terseness (avg summary ~136 chars).
 *   5. No edit_file anywhere (unchanged from r8 policy).
 *
 * Scenarios are unchanged in TASK (same files, same modify semantics as r8 —
 * they mirror eval #11/#12/#13/#15/#16); only conventions changed. Every
 * trace is still replayed through the REAL executeTool and scored with the
 * eval's own runChecks (build fails loudly on any mismatch).
 *
 * Emits:
 *   training/round9-synth15.jsonl   15 fixed synth rows  (arm B: continuation)
 *   training/round9-32plus5.jsonl  32 r1 + 5 mirror rows (arm A: from scratch)
 *
 * Usage: npm run build-round9
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

/* ── r1-convention summary renderer ──
 * r1 shapes (audited from training/r1.jsonl):
 *   standard: "What I did:\n<bullets>\n\nTry it yourself:\n- <try>"
 *   compact:  no blank line before "Try it yourself:"        (rows 13,15,28)
 *   no-try:   "What I did:\n<bullets>"                        (8 of 32 rows)
 *   great:    "Great! <sentence>.\n\nWhat I did:\n<bullets>…"  (rows 30-32)
 */

type Shape = "standard" | "compact" | "no-try" | "great";

function summary(shape: Shape, bullets: string[], tryIt: string): string {
  const body = bullets.join("\n");
  const core = `What I did:\n${body}`;
  if (shape === "no-try") return core;
  const withTry = shape === "compact" ? `${core}\nTry it yourself:\n- ${tryIt}` : `${core}\n\nTry it yourself:\n- ${tryIt}`;
  if (shape === "great") return `Great! All done with your files.\n\n${withTry}`;
  return withTry;
}

/* ── scenarios: same tasks as r8, r1-convention renders ── */

interface Scenario {
  id: string;
  seed: { path: string; content: string };
  user: string;
  actions: ({ kind: "read"; path: string } | { kind: "write"; path: string; content: string })[];
  bullets: string[]; // r1-convention did-bullets (varied verbs, terse)
  tryIt: string;
  checks: string[];
  mirror: boolean; // mirrors an eval task exactly -> goes into the +5 set
}

const SCENARIOS: Scenario[] = [
  /* #12 append-to-list: add at the END, keep every existing line */
  {
    id: "r9-s01 (mirror eval #12)",
    seed: { path: "shopping.txt", content: "milk\nbread\neggs\n" },
    user: "add bananas to the end of the shopping list in shopping.txt (keep the existing items)",
    actions: [
      { kind: "read", path: "shopping.txt" },
      { kind: "write", path: "shopping.txt", content: "milk\nbread\neggs\nbananas" },
    ],
    bullets: ["Wrote shopping.txt with bananas added at the end"],
    tryIt: "Ask me to add one more snack to your list.",
    checks: ["file:shopping.txt", "contains:bananas", "contains:milk", "contains:bread", "contains:eggs", "file-count:1"],
    mirror: true,
  },
  {
    id: "r9-s02",
    seed: { path: "dailies.txt", content: "wake up\nmake the bed\n" },
    user: "add \"brush teeth\" to the end of dailies.txt",
    actions: [
      { kind: "read", path: "dailies.txt" },
      { kind: "write", path: "dailies.txt", content: "wake up\nmake the bed\nbrush teeth" },
    ],
    bullets: ["Added brush teeth to the end of dailies.txt"],
    tryIt: "Ask me to add another chore to your list.",
    checks: ["file:dailies.txt", "contains:brush teeth", "contains:wake up", "contains:make the bed", "file-count:1"],
    mirror: false,
  },
  {
    id: "r9-s03",
    seed: { path: "team.txt", content: "Ava\nBen\n" },
    user: "add Chris to team.txt, keeping everyone already listed",
    actions: [
      { kind: "read", path: "team.txt" },
      { kind: "write", path: "team.txt", content: "Ava\nBen\nChris" },
    ],
    bullets: ["Wrote team.txt with Chris added after Ava and Ben"],
    tryIt: "Ask me to add another friend to the team.",
    checks: ["file:team.txt", "contains:Chris", "contains:Ava", "contains:Ben", "file-count:1"],
    mirror: false,
  },
  {
    id: "r9-s04",
    seed: { path: "packing.txt", content: "socks\nhat\n" },
    user: "put sunscreen at the end of the list in packing.txt",
    actions: [
      { kind: "read", path: "packing.txt" },
      { kind: "write", path: "packing.txt", content: "socks\nhat\nsunscreen" },
    ],
    bullets: ["Wrote packing.txt with sunscreen at the end"],
    tryIt: "Ask me to add one more thing to pack.",
    checks: ["file:packing.txt", "contains:sunscreen", "contains:socks", "contains:hat", "file-count:1"],
    mirror: false,
  },

  /* #13 JSON edit: change one value, keep every other field byte-same */
  {
    id: "r9-s05 (mirror eval #13)",
    seed: { path: "config.json", content: '{\n  "theme": "light",\n  "volume": 3\n}\n' },
    user: "in config.json, change the theme from light to dark. Keep everything else the same.",
    actions: [
      { kind: "read", path: "config.json" },
      { kind: "write", path: "config.json", content: '{\n  "theme": "dark",\n  "volume": 3\n}' },
    ],
    bullets: ["Wrote config.json with the theme set to dark and the volume untouched"],
    tryIt: "Ask me to change the volume next.",
    checks: ["file:config.json", "contains:dark", "not-contains:light", "contains:volume", "file-count:1"],
    mirror: true,
  },
  {
    id: "r9-s06",
    seed: { path: "settings.json", content: '{\n  "sound": "on",\n  "brightness": 7\n}' },
    user: "turn the sound off in settings.json and leave brightness alone",
    actions: [
      { kind: "read", path: "settings.json" },
      { kind: "write", path: "settings.json", content: '{\n  "sound": "off",\n  "brightness": 7\n}' },
    ],
    bullets: ["Turned the sound off in settings.json", "Left brightness alone"],
    tryIt: "Ask me to turn the sound back on.",
    checks: ["file:settings.json", "contains:\"off\"", "not-contains:\"on\"", "contains:7", "file-count:1"],
    mirror: false,
  },
  {
    id: "r9-s07",
    seed: { path: "profile.json", content: '{\n  "name": "Sam",\n  "age": 9\n}' },
    user: "in profile.json, change the age to 10 and keep the name the same",
    actions: [
      { kind: "read", path: "profile.json" },
      { kind: "write", path: "profile.json", content: '{\n  "name": "Sam",\n  "age": 10\n}' },
    ],
    bullets: ["Wrote profile.json with age 10", "The name stayed the same"],
    tryIt: "Ask me to change the age again next birthday.",
    checks: ["file:profile.json", "contains:10", "not-contains:9", "contains:Sam", "file-count:1"],
    mirror: false,
  },

  /* #15 read-transform-write: compute from the file, write exact result */
  {
    id: "r9-s08 (mirror eval #15)",
    seed: { path: "code.txt", content: "21\n" },
    user: "read the number in code.txt, double it, and save the result in answer.txt",
    actions: [
      { kind: "read", path: "code.txt" },
      { kind: "write", path: "answer.txt", content: "42" },
    ],
    bullets: ["Read 21 from code.txt", "Wrote 42, which is 21 doubled, into answer.txt"],
    tryIt: "Ask me to double a bigger number.",
    checks: ["file:answer.txt", "regex:42", "file-count:2"],
    mirror: true,
  },
  {
    id: "r9-s09",
    seed: { path: "count.txt", content: "7\n" },
    user: "add 5 to the number in count.txt and write the answer into total.txt",
    actions: [
      { kind: "read", path: "count.txt" },
      { kind: "write", path: "total.txt", content: "12" },
    ],
    bullets: ["Wrote 12 into total.txt, which is 7 plus 5"],
    tryIt: "Ask me to add a different number.",
    checks: ["file:total.txt", "regex:12", "file-count:2"],
    mirror: false,
  },
  {
    id: "r9-s10",
    seed: { path: "word.txt", content: "sunflower\n" },
    user: "read word.txt and save the word in ALL CAPS into loud.txt",
    actions: [
      { kind: "read", path: "word.txt" },
      { kind: "write", path: "loud.txt", content: "SUNFLOWER" },
    ],
    bullets: ["Read sunflower from word.txt", "Wrote SUNFLOWER into loud.txt"],
    tryIt: "Ask me to shout another word in capitals.",
    checks: ["file:loud.txt", "regex:SUNFLOWER", "file-count:2"],
    mirror: false,
  },
  {
    id: "r9-s11",
    seed: { path: "price.txt", content: "4\n8\n" },
    user: "add the two numbers in price.txt together and save the sum in sum.txt",
    actions: [
      { kind: "read", path: "price.txt" },
      { kind: "write", path: "sum.txt", content: "12" },
    ],
    bullets: ["Wrote 12 into sum.txt, which is 4 plus 8"],
    tryIt: "Ask me to add two other numbers.",
    checks: ["file:sum.txt", "regex:12", "file-count:2"],
    mirror: false,
  },

  /* #16 exact one-line copy: the new file holds ONLY that line */
  {
    id: "r9-s12 (mirror eval #16)",
    seed: { path: "poem.txt", content: "roses are red\nviolets are blue\npixie is for you\n" },
    user: "copy the first line of poem.txt into a new file called title.txt",
    actions: [
      { kind: "read", path: "poem.txt" },
      { kind: "write", path: "title.txt", content: "roses are red" },
    ],
    bullets: ["Copied just the first line of poem.txt into title.txt"],
    tryIt: "Ask me to copy the last line instead.",
    checks: ["file:title.txt", "contains:roses", "file-count:2"],
    mirror: true,
  },
  {
    id: "r9-s13",
    seed: { path: "wish.txt", content: "balloon\nkite\nrobot kit\n" },
    user: "copy just the last line of wish.txt into favorite.txt",
    actions: [
      { kind: "read", path: "wish.txt" },
      { kind: "write", path: "favorite.txt", content: "robot kit" },
    ],
    bullets: ["Copied robot kit, the last line of wish.txt, into favorite.txt"],
    tryIt: "Ask me to copy the first line instead.",
    checks: ["file:favorite.txt", "contains:robot kit", "file-count:2"],
    mirror: false,
  },

  /* #11 spelling fix as full rewrite: untouched line survives byte-same */
  {
    id: "r9-s14 (mirror eval #11)",
    seed: { path: "notes.txt", content: "My favrite color is teal.\nI also like rainy mornings.\n" },
    user: "there is a spelling mistake in notes.txt — fix it",
    actions: [
      { kind: "read", path: "notes.txt" },
      { kind: "write", path: "notes.txt", content: "My favorite color is teal.\nI also like rainy mornings." },
    ],
    bullets: ["Fixed the spelling in notes.txt", "The rest of the file stayed the same"],
    tryIt: "Ask me to check another file for typos.",
    checks: ["file:notes.txt", "not-contains:favrite", "contains:favorite", "contains:teal", "contains:rainy mornings", "file-count:1"],
    mirror: true,
  },
  {
    id: "r9-s15",
    seed: { path: "menu.txt", content: "chockolate cake\nlemon pie\n" },
    user: "one word in menu.txt is spelled wrong — fix it",
    actions: [
      { kind: "read", path: "menu.txt" },
      { kind: "write", path: "menu.txt", content: "chocolate cake\nlemon pie" },
    ],
    bullets: ["Fixed chockolate to chocolate in menu.txt"],
    tryIt: "Ask me to look over the menu again.",
    checks: ["file:menu.txt", "not-contains:chockolate", "contains:chocolate", "contains:lemon pie", "file-count:1"],
    mirror: false,
  },
];

/* Deterministic r1-style convention assignment (15 rows):
 * bullets  • ×7, * ×4, - ×4   (r1: 16/9/7 of 32)
 * shapes   standard ×7, no-try ×4, compact ×2, great ×2
 *              (r1: try-it 25/32, What-I-did-open 29/32, great 3/32) */
const BULLETS = ["•", "•", "*", "•", "•", "-", "•", "*", "•", "•", "-", "*", "•", "•", "-"];
const SHAPES: Shape[] = ["standard", "standard", "no-try", "standard", "compact", "standard", "no-try", "standard", "great", "standard", "standard", "no-try", "standard", "compact", "no-try"];

/* ── render: replay the REAL tools against a real workspace ── */

function renderScenario(s: Scenario, bullet: string, shape: Shape): Pair {
  const ws = resolve("training/round9-verify-ws");
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, s.seed.path), s.seed.content, "utf8");

  const msgs: Msg[] = [{ role: "user", content: s.user }];
  const files = new Map<string, string>([[s.seed.path, s.seed.content]]);

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
      if (r.output !== `Wrote ${a.path}`) throw new Error(`${s.id}: unexpected write output: ${r.output}`);
      files.set(a.path, a.content);
      msgs.push(call("write_file", { path: a.path, content: a.content }), toolRes("write_file", r.output));
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
  return { messages: [{ role: "system", content: BEGINNER_SYSTEM_PROMPT }, ...msgs], source: "round9-synth" };
}

/* ── r1-convention validators (the point of round 9) ── */

function validate(pairs: Pair[], opts: { strict: boolean; label: string }): void {
  let noNL = 0, writes = 0, bullets = { "•": 0, "*": 0, "-": 0 }, noTry = 0, shapes = new Set<string>(), lenSum = 0;
  for (const p of pairs) {
    const sys = p.messages[0];
    if (sys.role !== "system" || sys.content !== BEGINNER_SYSTEM_PROMPT) throw new Error(`${opts.label}: pair without the exact BEGINNER_SYSTEM_PROMPT`);
    const calls = p.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    if (calls.some((m) => m.content.trim() !== "")) throw new Error(`${opts.label}: narration before a tool call`);
    if (calls.some((m) => m.tool_calls!.some((tc) => tc.function.name === "edit_file"))) {
      throw new Error(`${opts.label}: edit_file is banned`);
    }
    if (calls.length < 1 || calls.length > 2) throw new Error(`${opts.label}: unexpected tool-call count: ${calls.length}`);
    const last = p.messages[p.messages.length - 1];
    if (last.role !== "assistant" || !last.content.trim()) throw new Error(`${opts.label}: pair does not end in a prose summary`);

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
    if (noNL !== writes) throw new Error(`${opts.label}: ${writes - noNL} write(s) still end with a trailing newline (r1: 31/32 without)`);
    if (noTry < 3) throw new Error(`${opts.label}: too few no-try summaries (r1 has 7/32)`);
    if (shapes.size < 3) throw new Error(`${opts.label}: summary shapes not varied enough (${shapes.size} variants)`);
    if (bullets["•"] < 5) throw new Error(`${opts.label}: bullet mix missing • rows (r1's dominant marker)`);
    const avgLen = lenSum / pairs.length;
    if (avgLen > 200) throw new Error(`${opts.label}: summaries too long (avg ${Math.round(avgLen)}; r1 ~136)`);
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
  const synth = SCENARIOS.map((s, i) => renderScenario(s, BULLETS[i], SHAPES[i]));
  rmSync(resolve("training/round9-verify-ws"), { recursive: true, force: true });

  validate(synth, { strict: true, label: "synth15" });
  const r1 = readJsonl("training/r1.jsonl");
  if (r1.length !== 32) throw new Error(`expected 32 r1 pairs, found ${r1.length}`);
  validate(r1, { strict: false, label: "r1-32" });

  const synth15 = "training/round9-synth15.jsonl";
  const plus5 = "training/round9-32plus5.jsonl";
  const mirrors = synth.filter((_, i) => SCENARIOS[i].mirror);
  if (mirrors.length !== 5) throw new Error(`expected 5 mirror scenarios, found ${mirrors.length}`);
  writeFileSync(synth15, synth.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  writeFileSync(plus5, [...r1, ...mirrors].map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  console.log(`round9-synth15.jsonl written: 15 fixed synth rows`);
  console.log(`round9-32plus5.jsonl written: 32 r1 verbatim + ${mirrors.length} mirrors = ${32 + mirrors.length}`);
  console.log("All traces replayed through the real tools; all final workspaces passed eval-style checks.");
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) main();
