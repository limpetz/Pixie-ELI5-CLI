/**
 * Offline smoke test for scripts/distill.ts goal verifiers — no model calls.
 * Builds tiny fixtures per verifier and asserts:
 *   1. the verifier passes on a correctly-done workspace, and
 *   2. it FAILS on its known trap (missing file, wrong value, lazy shortcut).
 * Run: npx tsx scripts/verify-smoke.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFY } from "./distill.js";

/** Happy-path fixture per verifier id. Every id must be listed here or we
 * warn — new verifiers without a fixture are untested by construction. */
const FIXTURES: Record<string, Array<[string, string]>> = {
  count: [["count.txt", "5\n"]],
  priciest: [["priciest.txt", "olive oil\n"]],
  average: [["average.txt", "80\n"]],
  total: [["total.txt", "Total: 6.70\n"]],
  letterlines: [["linecount.txt", "5\n"]],
  toycount: [["toycount.txt", "4\n"]],
  temp: [["temp.txt", "350\n"]],
  calc2: [["calc2.txt", "72\n"]],
  quotient: [["quotient.txt", "25\n"]],
  today: [["today.txt", "2026-09-21\n"]],
  files: [["files.txt", "letter.txt\nrecipe.md\n"]],
  power: [["power.txt", "1024\n"]],
  wcletter: [["linecount.txt", "5\n"]],
  fixtwo: [
    ["letter-a.txt", "the book, the garden\n"],
    ["recipe-a.md", "sugar\n1 cup of flour\n"],
  ],
  settingsdark: [["settings-a.ini", "[appearance]\ntheme = dark\nvolume = 8\n"]],
  recipesugar: [["recipe-b.md", "- half a cup of sugar\n- 2 cups of flour\n"]],
  settingslook: [["settings-b.ini", "[look and feel]\nvolume = 7\n"]],
  letterrecipe: [
    ["letter-b.txt", "the book\n"],
    ["recipe.md", "Peel and mash the bananas.\n"],
  ],
  cmdsave: [["tmp-calc.txt", "42\n"]],
  wcletter3: [["linecount3.txt", "6\n"]],
  pow2: [["pow2.txt", "128\n"]],
  cmdtotal: [["total-sh.txt", "Total: 6.70\n"]],
  csvappend: [["inventory.csv", "item,amount\napples,4\nbananas,6\ncherries,3\n"]],
  csvsum: [["inv2.txt", "Total: 10\n"]],
  team3: [
    ["team/dev.txt", "dev\n"],
    ["team/design.txt", "design\n"],
    ["team/manager.txt", "manager\n"],
  ],
  shapes4: [
    ["shapes/square.txt", "square\n"],
    ["shapes/circle.txt", "circle\n"],
    ["shapes/triangle.txt", "triangle\n"],
    ["shapes/hexagon.txt", "hexagon\n"],
  ],
  lettersc: [["letter-c.txt", "the book\n"]],
  settingsc: [["settings-c.ini", "[appearance]\ntheme = dark\nlanguage = fr\n"]],
  recipesugar2: [["recipe-c.md", "- half a cup of sugar\n- 2 cups of flour\n"]],
  recipesalt: [["recipe-d.md", "a pinch of salt\nMix the batter in a bowl.\n"]],
  csvprice: [["inv2.csv", "item,amount\napples,5\nbananas,9\n"]],
  contactfix: [["contact.txt", "My favorite color is teal\n"]],
  aboutedit: [["about.html", "<h1>Our Story</h1>\n"]],
  colors3: [
    ["red.txt", "red\n"],
    ["green.txt", "green\n"],
    ["blue.txt", "blue\n"],
  ],
  snacks2: [["chips.txt", "chips\n"], ["soda.txt", "soda\n"]],
  double: [["double-done.txt", "42\n"]],
  half: [["half.txt", "10.5\n"]],
  titleline: [["title-a.txt", "roses are red\n"]],
  lastline: [["ending.txt", "pixie is for you\n"]],
  findfix: [["notes-a.txt", "My favorite color is teal.\nI also like rainy mornings.\n"]],
  findfix2: [["notes-b.txt", "Today I read the best book.\nIt was the best day.\n"]],
  keepadd: [["shopping-b.txt", "milk\nbread\neggs\nbananas\n"]],
  jsonedit: [["config-a.json", '{\n  "theme": "dark",\n  "volume": 3\n}\n']],
  pickfile: [["pick.txt", "2\n"]],
};

/** Extra trap fixtures: (id, fixture that must FAIL despite looking plausible). */
const TRAPS: Array<[string, Array<[string, string]>]> = [
  // The bug this harness exists for: teacher overwrites the csv instead of appending.
  ["csvappend", [["inventory.csv", "item,amount\ncherries,3\n"]]],
  ["csvappend", [["inventory.csv", "item,amount\napples,4\nbananas,6\n"]]],
  // Extra file with a name the old tester.txt-only check would have missed.
  ["team3", [["team/notes.txt", "extra\n"]]],
  // Off-by-one value.
  ["calc2", [["calc2.txt", "71\n"]]],
  // File missing entirely.
  ["aboutedit", []],
  // colors3 with one color file missing.
  ["colors3", [["red.txt", "red\n"], ["green.txt", "green\n"]]],
  // half computed wrong (doubled instead of halved).
  ["half", [["half.txt", "42\n"]]],
  // title line from the wrong end of the poem.
  ["titleline", [["title-a.txt", "pixie is for you\n"]]],
  // "fix the typo" that deleted the whole line instead.
  ["findfix", [["notes-a.txt", "I also like rainy mornings.\n"]]],
  // append that wiped the existing list.
  ["keepadd", [["shopping-b.txt", "bananas\n"]]],
  // json edit that replaced the whole file.
  ["jsonedit", [["config-a.json", '{\n  "theme": "dark"\n}\n']]],
];

let failures = 0;
function run(id: string, fixture: Array<[string, string]>, expectPass: boolean): void {
  const ws = mkdtempSync(join(tmpdir(), "pixie-verify-"));
  try {
    for (const [rel, content] of fixture) {
      const p = join(ws, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    const problem = VERIFY[id](ws);
    const passed = problem === null;
    if (passed !== expectPass) {
      failures++;
      console.log(`  ✘ ${id}${expectPass ? "" : " (trap)"}: expected ${expectPass ? "pass" : "FAIL"}, got "${problem}"`);
    } else {
      console.log(`  ✔ ${id}${expectPass ? "" : " (trap)"}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

for (const id of Object.keys(VERIFY)) {
  const fixture = FIXTURES[id];
  if (!fixture) {
    failures++;
    console.log(`  ✘ ${id}: no fixture — add one to FIXTURES`);
    continue;
  }
  run(id, fixture, true);
}
for (const [id, fixture] of TRAPS) run(id, fixture, false);
// wcletter accepts two output filenames (round-3 vs retry pool) — cover both.
run("wcletter", [["linecount2.txt", "6\n"]], true);
// half accepts a rounded integer too (teacher may compute 10.5 → 10).
run("half", [["half.txt", "10\n"]], true);

console.log(failures === 0 ? "\nAll verifier smoke tests passed." : `\n${failures} verifier smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
