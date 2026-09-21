/** One-off: audit the tail of training/distilled.jsonl for chain structure,
 * narration on tool-call turns, and grounding of verified values. */
import { readFileSync } from "node:fs";

const N = Number(process.argv[2] ?? "4");
const lines = readFileSync("training/distilled.jsonl", "utf8").split("\n").filter((l) => l.trim());
const tail = lines.slice(-N);

for (const [i, line] of tail.entries()) {
  const { messages } = JSON.parse(line) as { messages: Array<{ role: string; content?: string; tool_calls?: unknown[] }> };
  const toolTurns = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
  const narrated = toolTurns.filter((m) => (m.content ?? "").trim().length > 0);
  // collect write_file args to spot literal-arithmetic grounding bugs
  const writes: string[] = [];
  for (const m of toolTurns) {
    for (const c of m.tool_calls as Array<{ function: { name: string; arguments: Record<string, unknown> } }>) {
      if (c.function.name === "write_file")
        writes.push(`${c.function.arguments.path}: ${String(c.function.arguments.content).slice(0, 60).replace(/\n/g, "\\n")}`);
    }
  }
  const seqRounds = countSeq(messages);
  console.log(`--- row -${tail.length - i} | turns=${messages.length} toolTurns=${toolTurns.length} seqRounds=${seqRounds} narrated=${narrated.length}`);
  for (const w of writes) console.log(`    write ${w}`);
}

function countSeq(messages: Array<{ role: string; tool_calls?: unknown[] }>): number {
  let rounds = 0;
  let sawTool = false;
  for (const m of messages) {
    if (m.role === "tool") sawTool = true;
    else if (m.role === "assistant" && m.tool_calls?.length && sawTool) {
      rounds++;
      sawTool = false;
    }
  }
  return rounds;
}
