/**
 * Lightweight self-tests: npm run selftest
 * Covers the stream filter, tool-call text parsing, and dataset extraction.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamFilter } from "../src/stream.js";
import { tryParseToolCall } from "../src/toolparse.js";
import {
  looksLikeDescribedAction,
  usedOnlyReadOnlyTools,
  looksLikeCompletionSummary,
  looksLikeFakeToolResponse,
  classifyRequestShape,
  looksLikeAnswered,
  saveTargetFile,
  mentionedFiles,
  missingAmongMentioned,
} from "../src/agent.js";
import { runChecks } from "./eval.js";
import { executeTool } from "../src/tools.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✘ ${name}\n      expected ${e}\n      got      ${a}`);
  }
}

/* ── StreamFilter ── */
console.log("StreamFilter:");
{
  const f = new StreamFilter();
  let out = "";
  for (const c of ["Let", "'s", " make", " a", " file", "."]) out += f.filter(c);
  out += f.flush();
  check("streams prose token-by-token", out, "Let's make a file.");
}
{
  const f = new StreamFilter();
  let leaked = "";
  for (const c of ['{"name"', ': "write_', 'file", "arg', 'uments": {"path', '": "t.txt", "content"', ': "hi"}}']) leaked += f.filter(c);
  check("suppresses raw JSON tool call", leaked + f.flush(), "");
}
{
  const f = new StreamFilter();
  let leaked = "";
  for (const c of ["<tool", '_call>{"name', '": "list_files", "argu', 'ments": {}}</tool', "_call>"]) leaked += f.filter(c);
  check("suppresses <tool_call> blocks", leaked + f.flush(), "");
}
{
  const f = new StreamFilter();
  let leaked = "";
  for (const c of ["```json\n", '{"name": "write_file", "arg', 'uments": {"path": "x", "content": "y"}}\n```']) leaked += f.filter(c);
  check("suppresses fenced JSON tool call", leaked + f.flush(), "");
}
{
  const f = new StreamFilter();
  let out = "";
  for (const c of ["```python\n", "print('hi')\n", "```"]) out += f.filter(c);
  out += f.flush();
  check("lets normal code fences through", out, "```python\nprint('hi')\n```");
}
{
  const f = new StreamFilter();
  let out = "";
  for (const c of ["Sure! Let's create", " the file.\n\n", '{"name": "write_file", "arg', 'uments": {"path": "x", "content": "y"}}']) out += f.filter(c);
  out += f.flush();
  check("cuts mid-prose before embedded JSON", out, "Sure! Let's create the file.\n\n");
}
{
  const f = new StreamFilter();
  let out = "";
  for (const c of ["Here you go.\n\n{\"na", 'me": "write_file", "arguments": {"path": "x", "content": "y"}}']) out += f.filter(c);
  out += f.flush();
  check("catches opener split across chunks", out, "Here you go.\n\n");
}
{
  const f = new StreamFilter();
  const text = "Hello there, friend! This is a longer reply that keeps flowing along nicely.";
  let out = "";
  for (const c of text.match(/.{1,3}/gs) ?? []) out += f.filter(c);
  out += f.flush();
  check("guard window preserves prose exactly", out, text);
}
{
  // Interplay: after mid-prose JSON suppression, parser must find the embedded call.
  const f = new StreamFilter();
  const full = 'Sure, let\'s create it!\n\n{"name": "write_file", "arguments": {"path": "colors.txt", "content": "Red\\nBlue"}}';
  let shown = "";
  for (const c of full.match(/.{1,7}/gs) ?? []) shown += f.filter(c);
  shown += f.flush();
  check("suppressed tail not shown", shown.includes("{\"name\""), false);
  check(
    "parser finds embedded call in full content",
    tryParseToolCall(full)?.name,
    "write_file",
  );
}

/* ── tryParseToolCall ── */
console.log("tryParseToolCall:");
check("parses plain JSON", tryParseToolCall('{"name": "edit_file", "arguments": {"path": "x", "old_text": "a", "new_text": "b"}}'), {
  name: "edit_file",
  args: { path: "x", old_text: "a", new_text: "b" },
});
check("parses fenced JSON", tryParseToolCall('```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```'), {
  name: "read_file",
  args: { path: "a.txt" },
});
check("parses <tool_call> tag", tryParseToolCall('<tool_call>{"name": "list_files", "arguments": {}}</tool_call>'), {
  name: "list_files",
  args: {},
});
check("rejects prose", tryParseToolCall("I will now read the file."), null);
check("rejects JSON without name", tryParseToolCall('{"arguments": {}}'), null);
check(
  "parses JSON embedded after prose",
  tryParseToolCall('Sure, let\'s create it!\n\n{"name": "write_file", "arguments": {"path": "colors.txt", "content": "Red\\nBlue"}}')?.name,
  "write_file",
);

/* ── dataset extraction ── */
console.log("dataset extraction:");
{
  const { extractPairs } = await import("../scripts/build-dataset.js");
  const dir = mkdtempSync(join(tmpdir(), "pixie-test-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session_start" }),
    JSON.stringify({ type: "user_message", content: "make a poem file" }),
    JSON.stringify({ type: "assistant_tool_calls", toolCalls: [{ name: "write_file", args: { path: "poem.txt", content: "roses" } }] }),
    JSON.stringify({ type: "tool_result", name: "write_file", ok: true, output: "Wrote poem.txt" }),
    JSON.stringify({ type: "assistant_message", content: "Done! I created poem.txt with a poem.\n\nWhat I did:\n- Created poem.txt\n\nTry it yourself:\n- Ask me to change it!" }),
    JSON.stringify({ type: "user_message", content: "now break something" }),
    JSON.stringify({ type: "assistant_message", content: "Error: user declined to run: rm -rf /" }),
    JSON.stringify({ type: "user_message", content: "too short" }),
    JSON.stringify({ type: "assistant_message", content: "ok" }),
  ];
  writeFileSync(file, lines.join("\n"), "utf8");
  const pairs = extractPairs(file);
  check("keeps only good pairs", pairs.length, 1);
  check(
    "tool-faithful roles (system/user/assistant+tools/tool/assistant)",
    pairs[0]?.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant"],
  );
  const tc = pairs[0]?.messages[2];
  check(
    "assistant tool call in Qwen format",
    tc && tc.tool_calls?.[0]?.function.name === "write_file" &&
      tc.tool_calls[0].function.arguments.path === "poem.txt",
    true,
  );
  check("tool result carried into tool message", pairs[0]?.messages[3].content, "Wrote poem.txt");
  // A narration-only exchange (no tool calls) must be dropped — that's the
  // failure mode that taught pixie-7b v1 to claim actions in prose.
  const narrFile = join(dir, "narration.jsonl");
  writeFileSync(
    narrFile,
    [
      JSON.stringify({ type: "user_message", content: "make a poem file" }),
      JSON.stringify({ type: "assistant_message", content: "What I did:\n- Created poem.txt with a lovely poem for you today." }),
    ].join("\n"),
    "utf8",
  );
  check("drops narration-only exchanges", extractPairs(narrFile).length, 0);
  // Narration attached to a tool-call turn must be stripped — prose before a
  // <tool_call> tag is the v1 narration-instead-of-acting failure mode.
  const narrFile2 = join(dir, "narrated-toolcall.jsonl");
  writeFileSync(
    narrFile2,
    [
      JSON.stringify({ type: "user_message", content: "make a poem file" }),
      JSON.stringify({ type: "assistant_tool_calls", content: "Sure! I'll write that poem now.", toolCalls: [{ name: "write_file", args: { path: "poem.txt", content: "roses" } }] }),
      JSON.stringify({ type: "tool_result", name: "write_file", ok: true, output: "Wrote poem.txt" }),
      JSON.stringify({ type: "assistant_message", content: "Done! I created poem.txt with a lovely poem for you today." }),
    ].join("\n"),
    "utf8",
  );
  const narrated = extractPairs(narrFile2);
  check(
    "narration stripped from tool-call turns",
    narrated[0]?.messages[2].content === "" && (narrated[0]?.messages[2].tool_calls?.length ?? 0) === 1,
    true,
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ── narration detector ── */
console.log("looksLikeDescribedAction:");
check("detects 'What I did' summary", looksLikeDescribedAction("What I did:\n- Created poem.txt"), true);
check("detects 'I'll create…'", looksLikeDescribedAction("Sure! I'll create a file for you right away."), true);
check("ignores informational answers", looksLikeDescribedAction("There are 7 continents on Earth. In one short sentence, that is the answer."), false);
check("ignores greetings", looksLikeDescribedAction("Hello! How can I help you today?"), false);

/* ── keep-going nudge detectors ── */
console.log("keep-going nudge detectors:");
check(
  "read-only tool set detected",
  usedOnlyReadOnlyTools(new Set(["list_files", "read_file"])),
  true,
);
check(
  "search counts as read-only",
  usedOnlyReadOnlyTools(new Set(["search_files"])),
  true,
);
check(
  "write tool breaks read-only",
  usedOnlyReadOnlyTools(new Set(["read_file", "write_file"])),
  false,
);
check("empty tool set is not read-only exploration", usedOnlyReadOnlyTools(new Set()), false);
check("detects completion summary", looksLikeCompletionSummary("What I did:\n- Listed files"), true);
check("plain answer is not a completion summary", looksLikeCompletionSummary("There are 7 continents."), false);
check("detects fake tool_response", looksLikeFakeToolResponse("<tool_response>menu.txt (24 bytes)</tool_response>"), true);
check("detects fake tool_result tag", looksLikeFakeToolResponse("<tool_result>42</tool_result>"), true);
check("normal prose is not a fake tool response", looksLikeFakeToolResponse("I read the file and it says 21."), false);

/* ── shape router (picks the right nudge; prompts are the real eval tasks) ── */
console.log("classifyRequestShape (real eval prompts):");
check("riddle task #14 is a question", classifyRequestShape("one of the three riddle files mentions a wizard. Read them and tell me which number it is."), "question");
check("continents #6 is a question", classifyRequestShape("how many continents are there on Earth? answer in one short sentence"), "question");
check("percent #8 is a question", classifyRequestShape("what is 15 percent of 200? answer with just the number"), "question");
check("website #20 is a build task (not fooled by 'link to page1.html')", classifyRequestShape("build a tiny website: index.html must link to page1.html and page2.html, and both of those pages must exist with a heading on each"), "build");
check("three-files task #10 is a build task", classifyRequestShape("create three files: red.txt, green.txt and blue.txt. Each file should contain the name of its color."), "build");
check("code-double #15 is save-result", classifyRequestShape("read the number in code.txt, double it, and save the result in answer.txt"), "save-result");
check("wishlist #23 is save-result despite 'figure out'", classifyRequestShape("read wishlist.txt, figure out which single item costs the most, and write just that item's name into best.txt"), "save-result");
check("csv-append #19 is save-result", classifyRequestShape("add a new row for apples with price 1.20 to inventory.csv (keep the header and existing rows)"), "save-result");
check("haiku #5 is save-result", classifyRequestShape("write a haiku about the sea into sea.txt (a haiku is exactly three short lines)"), "save-result");
check("profile follow-up is save-result", classifyRequestShape("now add a second line to profile.txt that says hello to the user"), "save-result");
check("single-file create #1 stays other", classifyRequestShape("create a file named greeting.txt containing a friendly hello message"), "other");
check("json-edit #13 stays other", classifyRequestShape("in config.json, change the theme from light to dark. Keep everything else the same."), "other");
check("boiling-step follow-up stays other", classifyRequestShape("replace whichever step is the boiling step with exactly: pour hot water"), "other");
check("short input is other", classifyRequestShape("hi"), "other");

console.log("looksLikeAnswered:");
check("explicit Answer line", looksLikeAnswered("I read the three files.\nAnswer: file 2"), true);
check("'the answer is' statement", looksLikeAnswered("The answer is riddle 2."), true);
check("'it is file 2' counts", looksLikeAnswered("It is file 2."), true);
check("summary without answer is not answered", looksLikeAnswered("What I did:\n- Read the riddle files"), false);

console.log("saveTargetFile:");
check("finds the destination file", saveTargetFile("read the number in code.txt, double it, and save the result in answer.txt"), "answer.txt");
check("no file named means no target", saveTargetFile("what is the biggest number here?"), null);

console.log("mentionedFiles / missingAmongMentioned:");
{
  const site = "build a tiny website: index.html must link to page1.html and page2.html";
  check("lists each mentioned file once", mentionedFiles(site), ["index.html", "page1.html", "page2.html"]);
  check(
    "missing files exclude already-written ones",
    missingAmongMentioned(site, new Set(["index.html"])),
    ["page1.html", "page2.html"],
  );
}

/* ── eval harness checks ── */
console.log("runChecks (eval harness):");
{
  const dir = mkdtempSync(join(tmpdir(), "pixie-eval-"));
  writeFileSync(join(dir, "config.json"), '{"theme": "dark", "volume": 3}', "utf8");
  writeFileSync(join(dir, "list.txt"), "a\nb\nc", "utf8");

  const r1 = runChecks(["file:config.json", "contains:DARK", "not-contains:light-mode", "lines:list.txt:3-3", "file-count:2"], dir, "done!");
  check("all positive checks pass", r1.pass, true);

  const r2 = runChecks(["missing:ghost.txt"], dir, "");
  check("missing passes when absent", r2.pass, true);

  const r3 = runChecks(["missing:config.json"], dir, "");
  check("missing fails when present", r3.pass, false);

  const r4 = runChecks(["not-contains:dark"], dir, "");
  check("not-contains fails when present", r4.pass, false);

  const r5 = runChecks(["lines:list.txt:4-5"], dir, "");
  check("lines range enforced", r5.pass, false);

  const r6 = runChecks(["file-count:3"], dir, "");
  check("file-count exact", r6.pass, false);

  const r7 = runChecks(["reply-regex:DONE"], dir, "All DONE here");
  check("reply-regex case-insensitive", r7.pass, true);

  rmSync(dir, { recursive: true, force: true });
}

/* ── tool implementations (integration) ── */
console.log("tools (integration):");
{
  const dir = mkdtempSync(join(tmpdir(), "pixie-tools-"));
  mkdirSync(join(dir, "photos"), { recursive: true });
  writeFileSync(join(dir, "riddle2.txt"), "An old wizard lives here.\n", "utf8");
  writeFileSync(join(dir, "photos", "album.txt"), "no magic here\n", "utf8");
  const opts = { autoApproveBash: false };

  const r1 = executeTool(dir, "search_files", { query: "wizard" }, opts);
  check("search finds text in nested file", r1.output.includes("riddle2.txt:1") && r1.output.includes("wizard"), true);

  const r2 = executeTool(dir, "write_file", { path: "photos", content: "oops" }, opts);
  check("write onto folder path gives actionable error", r2.output.includes("already a FOLDER"), true);

  writeFileSync(join(dir, "blocker.txt"), "x", "utf8");
  const r3 = executeTool(dir, "write_file", { path: "blocker.txt/album.txt", content: "x" }, opts);
  check("write under file path suggests delete_file", r3.output.includes("delete_file"), true);

  const r4 = executeTool(dir, "delete_file", { path: "blocker.txt" }, opts);
  const r5 = executeTool(dir, "write_file", { path: "blocker.txt/album.txt", content: "now it works" }, opts);
  check("delete_file clears the way for write", r4.ok && r5.ok, true);

  const r6 = executeTool(dir, "list_files", {}, opts);
  check("list_files shows nested folders", r6.output.includes("photos/"), true);

  rmSync(dir, { recursive: true, force: true });
}

/* ── scaffold-v2 tool signals (runtime-only guardrails) ── */
console.log("scaffold-v2 tool signals:");
{
  const dir = mkdtempSync(join(tmpdir(), "pixie-scaffold-"));
  const opts = { autoApproveBash: false };

  writeFileSync(join(dir, "notes.txt"), "line1\nline2\nline3", "utf8");
  const w1 = executeTool(dir, "write_file", { path: "notes.txt", content: "line1\nline2\nline3" }, opts);
  check(
    "write_file replace reports was→now line counts",
    w1.output === `Wrote notes.txt (replaced: was 3 lines, now 3)`,
    true,
  );

  const w2 = executeTool(dir, "write_file", { path: "brand-new.txt", content: "hi" }, opts);
  check("write_file create has no replace signal", w2.output, "Wrote brand-new.txt");

  writeFileSync(join(dir, "config.json"), '{ "theme": "light" }', "utf8");
  const w3 = executeTool(dir, "write_file", { path: "config.json", content: "{ broken" }, opts);
  check(
  	"invalid JSON write warns on .json replace",
  	w3.output.includes("not valid JSON"),
  	true,
  );

  const w4 = executeTool(dir, "write_file", { path: "config.json", content: '{ "theme": "dark" }' }, opts);
  check("valid JSON write gets no warning", w4.output.includes("not valid JSON"), false);

  writeFileSync(join(dir, "data.txt"), "{}", "utf8");
  const w5 = executeTool(dir, "write_file", { path: "data.txt", content: "{ broken" }, opts);
  check("no JSON warning for non-.json paths", w5.output.includes("not valid JSON"), false);

  writeFileSync(join(dir, "poem.txt"), "roses are red\n", "utf8");
  const e1 = executeTool(dir, "edit_file", { path: "poem.txt", old_text: "violets", new_text: "tulips" }, opts);
  check(
    "edit_file failure suggests read → write_file",
    e1.output.includes("Nothing was changed") && e1.output.includes("write_file"),
    true,
  );

  const s1 = executeTool(dir, "search_files", { query: "poem.txt" }, opts);
  check(
    "search by filename points to read_file",
    s1.output.includes("read_file"),
    true,
  );
  const s2 = executeTool(dir, "search_files", { query: "zzz-nothing" }, opts);
  check("truly empty search stays plain", s2.output.includes('No matches for'), true);

  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll self-tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
