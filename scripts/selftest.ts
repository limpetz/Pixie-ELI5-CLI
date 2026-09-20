/**
 * Lightweight self-tests: npm run selftest
 * Covers the stream filter, tool-call text parsing, and dataset extraction.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamFilter } from "../src/stream.js";
import { tryParseToolCall } from "../src/toolparse.js";

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
  const pairs = extractPairs(file, false);
  check("keeps only good pairs", pairs.length, 1);
  check(
    "pair has system/user/assistant",
    pairs[0]?.messages.map((m) => m.role),
    ["system", "user", "assistant"],
  );
  const withTools = extractPairs(file, true)[0];
  check("tool activity appended with flag", withTools ? withTools.messages[1].content.includes("[Tool activity:") : false, true);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll self-tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
