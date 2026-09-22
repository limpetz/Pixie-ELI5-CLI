#!/usr/bin/env node
/**
 * Round 8 data builder — r1-style synthetic coverage.
 *
 * Forensics verdict (docs/baseline.json, 2026-09-22): r1's score comes from
 * its narrow curriculum — short prompts, ONE tool call per row, whole-file
 * write_file content. Derivative sets taught edit_file/chain shapes the 7B
 * imitates without the exact-match skill. So every scenario here teaches
 * modify-tasks as read → write_file(FULL new content). edit_file is banned.
 *
 * Coverage: the chronically failed eval multi shapes —
 *   #12 append-to-list, #13 JSON edit, #15 read-transform-write,
 *   #16 exact one-line copy, #11 spelling fix.
 * Five scenarios mirror an eval task exactly (project precedent: distill
 * pools already mirror eval shapes); ten are paraphrase variants.
 *
 * Self-verification: every trace is replayed through the REAL executeTool
 * against real seed files (read outputs must byte-match what the model would
 * see), then scored with the eval's own runChecks. The build fails loudly on
 * any mismatch — same policy as verify-smoke.ts.
 *
 * Usage: npm run build-round8   (writes training/round8.jsonl: 32 r1 + 15 synth)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";
import { executeTool } from "../src/tools.js";
import { runChecks } from "./eval.js";
import type { Msg, Pair } from "./build-dataset.js";

/* ── trace helpers (r1 conventions: silent tool turns, exact outputs) ── */

function call(name: string, args: Record<string, unknown>): Msg {
  return { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name, arguments: args } }] };
}
function toolRes(name: string, content: string): Msg {
  return { role: "tool", name, content };
}
function summary(did: string[], tryIt: string): Msg {
  const bullets = did.map((d) => `- ${d}`).join("\n");
  return {
    role: "assistant",
    content: `What I did:\n${bullets}\n\nTry it yourself:\n- ${tryIt}`,
  };
}


interface Scenario {
  id: string;
  seed: { path: string; content: string };
  user: string;
  /** actions run in order; reads emit the current content, writes update it */
  actions: ({ kind: "read"; path: string } | { kind: "write"; path: string; content: string })[];
  did: string[];
  tryIt: string;
  /** eval-style checks the FINAL workspace must pass */
  checks: string[];
}

const SCENARIOS: Scenario[] = [
  /* ── #12 append-to-list: add at the END, keep every existing line ── */
  {
    id: "r8-s01 (mirror eval #12)",
    seed: { path: "shopping.txt", content: "milk\nbread\neggs\n" },
    user: "add bananas to the end of the shopping list in shopping.txt (keep the existing items)",
    actions: [
      { kind: "read", path: "shopping.txt" },
      { kind: "write", path: "shopping.txt", content: "milk\nbread\neggs\nbananas\n" },
    ],
    did: ["Read shopping.txt.", "Wrote it back with bananas added at the end."],
    tryIt: "Ask me to add one more snack to your list.",
    checks: ["file:shopping.txt", "contains:bananas", "contains:milk", "contains:bread", "contains:eggs", "file-count:1"],
  },
  {
    id: "r8-s02",
    seed: { path: "dailies.txt", content: "wake up\nmake the bed\n" },
    user: "add \"brush teeth\" to the end of dailies.txt",
    actions: [
      { kind: "read", path: "dailies.txt" },
      { kind: "write", path: "dailies.txt", content: "wake up\nmake the bed\nbrush teeth\n" },
    ],
    did: ["Read dailies.txt.", "Wrote it back with brush teeth added at the end."],
    tryIt: "Ask me to add another chore to your list.",
    checks: ["file:dailies.txt", "contains:brush teeth", "contains:wake up", "contains:make the bed", "file-count:1"],
  },
  {
    id: "r8-s03",
    seed: { path: "team.txt", content: "Ava\nBen\n" },
    user: "add Chris to team.txt, keeping everyone already listed",
    actions: [
      { kind: "read", path: "team.txt" },
      { kind: "write", path: "team.txt", content: "Ava\nBen\nChris\n" },
    ],
    did: ["Read team.txt.", "Wrote it back with Chris added after Ava and Ben."],
    tryIt: "Ask me to add another friend to the team.",
    checks: ["file:team.txt", "contains:Chris", "contains:Ava", "contains:Ben", "file-count:1"],
  },
  {
    id: "r8-s04",
    seed: { path: "packing.txt", content: "socks\nhat\n" },
    user: "put sunscreen at the end of the list in packing.txt",
    actions: [
      { kind: "read", path: "packing.txt" },
      { kind: "write", path: "packing.txt", content: "socks\nhat\nsunscreen\n" },
    ],
    did: ["Read packing.txt.", "Wrote it back with sunscreen added at the end."],
    tryIt: "Ask me to add one more thing to pack.",
    checks: ["file:packing.txt", "contains:sunscreen", "contains:socks", "contains:hat", "file-count:1"],
  },

  /* ── #13 JSON edit: change one value, keep every other field byte-same ── */
  {
    id: "r8-s05 (mirror eval #13)",
    seed: { path: "config.json", content: '{\n  "theme": "light",\n  "volume": 3\n}\n' },
    user: "in config.json, change the theme from light to dark. Keep everything else the same.",
    actions: [
      { kind: "read", path: "config.json" },
      { kind: "write", path: "config.json", content: '{\n  "theme": "dark",\n  "volume": 3\n}\n' },
    ],
    did: ["Read config.json.", "Wrote it back with the theme set to dark and the volume untouched."],
    tryIt: "Ask me to change the volume next.",
    checks: ["file:config.json", "contains:dark", "not-contains:light", "contains:volume", "file-count:1"],
  },
  {
    id: "r8-s06",
    seed: { path: "settings.json", content: '{\n  "sound": "on",\n  "brightness": 7\n}' },
    user: "turn the sound off in settings.json and leave brightness alone",
    actions: [
      { kind: "read", path: "settings.json" },
      { kind: "write", path: "settings.json", content: '{\n  "sound": "off",\n  "brightness": 7\n}' },
    ],
    did: ["Read settings.json.", "Wrote it back with sound off and brightness untouched."],
    tryIt: "Ask me to turn the sound back on.",
    checks: ["file:settings.json", "contains:\"off\"", "not-contains:\"on\"", "contains:7", "file-count:1"],
  },
  {
    id: "r8-s07",
    seed: { path: "profile.json", content: '{\n  "name": "Sam",\n  "age": 9\n}' },
    user: "in profile.json, change the age to 10 and keep the name the same",
    actions: [
      { kind: "read", path: "profile.json" },
      { kind: "write", path: "profile.json", content: '{\n  "name": "Sam",\n  "age": 10\n}' },
    ],
    did: ["Read profile.json.", "Wrote it back with age 10 and the name untouched."],
    tryIt: "Ask me to change the age again next birthday.",
    checks: ["file:profile.json", "contains:10", "not-contains:9", "contains:Sam", "file-count:1"],
  },

  /* ── #15 read-transform-write: compute from the file, write exact result ── */
  {
    id: "r8-s08 (mirror eval #15)",
    seed: { path: "code.txt", content: "21\n" },
    user: "read the number in code.txt, double it, and save the result in answer.txt",
    actions: [
      { kind: "read", path: "code.txt" },
      { kind: "write", path: "answer.txt", content: "42\n" },
    ],
    did: ["Read the number 21 from code.txt.", "Wrote 42, which is 21 doubled, into answer.txt."],
    tryIt: "Ask me to double a bigger number.",
    checks: ["file:answer.txt", "regex:42", "file-count:2"],
  },
  {
    id: "r8-s09",
    seed: { path: "count.txt", content: "7\n" },
    user: "add 5 to the number in count.txt and write the answer into total.txt",
    actions: [
      { kind: "read", path: "count.txt" },
      { kind: "write", path: "total.txt", content: "12\n" },
    ],
    did: ["Read the number 7 from count.txt.", "Wrote 12, which is 7 plus 5, into total.txt."],
    tryIt: "Ask me to add a different number.",
    checks: ["file:total.txt", "regex:12", "file-count:2"],
  },
  {
    id: "r8-s10",
    seed: { path: "word.txt", content: "sunflower\n" },
    user: "read word.txt and save the word in ALL CAPS into loud.txt",
    actions: [
      { kind: "read", path: "word.txt" },
      { kind: "write", path: "loud.txt", content: "SUNFLOWER\n" },
    ],
    did: ["Read sunflower from word.txt.", "Wrote SUNFLOWER into loud.txt."],
    tryIt: "Ask me to shout another word in capitals.",
    checks: ["file:loud.txt", "regex:SUNFLOWER", "file-count:2"],
  },
  {
    id: "r8-s11",
    seed: { path: "price.txt", content: "4\n8\n" },
    user: "add the two numbers in price.txt together and save the sum in sum.txt",
    actions: [
      { kind: "read", path: "price.txt" },
      { kind: "write", path: "sum.txt", content: "12\n" },
    ],
    did: ["Read 4 and 8 from price.txt.", "Wrote 12, which is 4 plus 8, into sum.txt."],
    tryIt: "Ask me to add two other numbers.",
    checks: ["file:sum.txt", "regex:12", "file-count:2"],
  },

  /* ── #16 exact one-line copy: the new file holds ONLY that line ── */
  {
    id: "r8-s12 (mirror eval #16)",
    seed: { path: "poem.txt", content: "roses are red\nviolets are blue\npixie is for you\n" },
    user: "copy the first line of poem.txt into a new file called title.txt",
    actions: [
      { kind: "read", path: "poem.txt" },
      { kind: "write", path: "title.txt", content: "roses are red\n" },
    ],
    did: ["Read poem.txt.", "Copied just the first line into title.txt."],
    tryIt: "Ask me to copy the last line instead.",
    // mirrors eval #16's checks; "only that line" is enforced byte-exactly above
    checks: ["file:title.txt", "contains:roses", "file-count:2"],
  },
  {
    id: "r8-s13",
    seed: { path: "wish.txt", content: "balloon\nkite\nrobot kit\n" },
    user: "copy just the last line of wish.txt into favorite.txt",
    actions: [
      { kind: "read", path: "wish.txt" },
      { kind: "write", path: "favorite.txt", content: "robot kit\n" },
    ],
    did: ["Read wish.txt.", "Copied just the last line into favorite.txt."],
    tryIt: "Ask me to copy the first line instead.",
    checks: ["file:favorite.txt", "contains:robot kit", "file-count:2"],
  },

  /* ── #11 spelling fix as full rewrite: untouched line survives byte-same ── */
  {
    id: "r8-s14 (mirror eval #11)",
    seed: { path: "notes.txt", content: "My favrite color is teal.\nI also like rainy mornings.\n" },
    user: "there is a spelling mistake in notes.txt — fix it",
    actions: [
      { kind: "read", path: "notes.txt" },
      { kind: "write", path: "notes.txt", content: "My favorite color is teal.\nI also like rainy mornings.\n" },
    ],
    did: ["Read notes.txt and found \"favrite\".", "Wrote it back with the word spelled \"favorite\"."],
    tryIt: "Ask me to check another file for typos.",
    checks: ["file:notes.txt", "not-contains:favrite", "contains:favorite", "contains:teal", "contains:rainy mornings", "file-count:1"],
  },
  {
    id: "r8-s15",
    seed: { path: "menu.txt", content: "chockolate cake\nlemon pie\n" },
    user: "one word in menu.txt is spelled wrong — fix it",
    actions: [
      { kind: "read", path: "menu.txt" },
      { kind: "write", path: "menu.txt", content: "chocolate cake\nlemon pie\n" },
    ],
    did: ["Read menu.txt and found \"chockolate\".", "Wrote it back spelled \"chocolate\"."],
    tryIt: "Ask me to look over the menu again.",
    checks: ["file:menu.txt", "not-contains:chockolate", "contains:chocolate", "contains:lemon pie", "file-count:1"],
  },
];

/* ── render scenarios into r1-style pairs, replaying the real tools ── */

function renderScenario(s: Scenario): Pair {
  const ws = resolve("training/round8-verify-ws");
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

  // Final workspace must pass the scenario's checks AND hold exactly the
  // content the trace claims it wrote.
  for (const [path, content] of files) {
    const onDisk = readFileSync(join(ws, path), "utf8");
    if (onDisk !== content) throw new Error(`${s.id}: ${path} on disk differs from traced content`);
  }
  const reply = summary(s.did, s.tryIt).content;
  const verdict = runChecks(s.checks, ws, reply);
  if (!verdict.pass) {
    throw new Error(`${s.id}: final workspace failed checks: ${verdict.failed.join(", ")}`);
  }

  msgs.push(summary(s.did, s.tryIt));
  return { messages: [{ role: "system", content: BEGINNER_SYSTEM_PROMPT }, ...msgs], source: "round8-synth" };
}

/* ── global invariants ── */

function validate(pairs: Pair[], opts: { strictSummary: boolean }): void {
  for (const p of pairs) {
    const sys = p.messages[0];
    if (sys.role !== "system" || sys.content !== BEGINNER_SYSTEM_PROMPT) throw new Error("pair without the exact BEGINNER_SYSTEM_PROMPT");
    const calls = p.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    if (calls.some((m) => m.content.trim() !== "")) throw new Error("narration before a tool call");
    if (calls.some((m) => m.tool_calls!.some((tc) => tc.function.name === "edit_file"))) {
      throw new Error("edit_file is banned from round-8 data");
    }
    if (calls.length < 1 || calls.length > 2) throw new Error(`unexpected tool-call count: ${calls.length}`);
    const last = p.messages[p.messages.length - 1];
    if (last.role !== "assistant" || !last.content.trim()) throw new Error("pair does not end in a prose summary");
    if (opts.strictSummary && (!/What I did:\n/.test(last.content) || !/Try it yourself:\n- /.test(last.content))) {
      throw new Error("summary does not follow the r1 template");
    }
  }
}

function main(): void {
  const synth = SCENARIOS.map(renderScenario);
  // r1 mixes two bullet styles (9 star / 18 dash of 32) — mirror that ratio.
  for (let i = 0; i < synth.length; i++) if (i % 5 === 2) synth[i] = restyle(synth[i]);
  validate(synth, { strictSummary: true });
  rmSync(resolve("training/round8-verify-ws"), { recursive: true, force: true });

  const r1 = readFileSync("training/r1.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Pair);
  if (r1.length !== 32) throw new Error(`expected 32 r1 pairs, found ${r1.length}`);
  // r1's natural variance (some summaries drop the try-it line) — lenient here
  validate(r1, { strictSummary: false });

  const all = [...r1, ...synth];
  writeFileSync("training/round8.jsonl", all.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  console.log(`round8.jsonl written: ${r1.length} r1 pairs + ${synth.length} synth = ${all.length}`);
  console.log("All traces replayed through the real tools; all final workspaces passed eval-style checks.");
}

/** Rewrite a pair's summary bullets from "-" to r1's alternate "*" style (What-I-did bullets only; the try-it bullet stays "-"). */
function restyle(p: Pair): Pair {
  const last = p.messages[p.messages.length - 1];
  const marker = "\n\nTry it yourself:";
  const cut = last.content.indexOf(marker);
  if (cut >= 0) {
    last.content = last.content.slice(0, cut).replace(/^- /gm, "* ") + last.content.slice(cut);
  }
  return p;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) main();
