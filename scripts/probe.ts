/**
 * Regression probe: run the REAL beginner system prompt against the default
 * local model several times and require tool calls (not narration).
 * Run: npx tsx scripts/probe.ts [--model qwen2.5-coder:7b] [--rounds 4]
 */
import { ollamaChat } from "../src/ollama.js";
import { TOOL_SCHEMAS } from "../src/tools.js";
import { BEGINNER_SYSTEM_PROMPT } from "../src/agent.js";
import type { ChatMessage } from "../src/types.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MODEL = arg("model", "qwen2.5-coder:7b");
const ROUNDS = Math.max(1, Number(arg("rounds", "4")));

const provider = { kind: "ollama" as const, baseUrl: "http://localhost:11434", model: MODEL };
const messages: ChatMessage[] = [
  { role: "system", content: `${BEGINNER_SYSTEM_PROMPT}\n\nWorkspace: ./probe-ws` },
  { role: "user", content: "create math.txt with the answer to 12 multiplied by 12 written as a sentence" },
];

let ok = 0;
for (let i = 0; i < ROUNDS; i++) {
  const r = await ollamaChat(provider, messages, TOOL_SCHEMAS, 0.2, i % 2 === 0 ? () => {} : undefined);
  const called = r.toolCalls.length > 0;
  if (called) ok++;
  console.log(
    `round ${i + 1} (stream=${i % 2 === 0 ? "on" : "off"}) → ${called ? `✔ tool: ${r.toolCalls.map((t) => t.name).join(",")}` : `✘ narration: "${r.content.slice(0, 50).replace(/\n/g, " ")}"`}`,
  );
}
console.log(ok === ROUNDS ? `\nAll ${ROUNDS} rounds acted via tools. ✔` : `\n${ROUNDS - ok}/${ROUNDS} rounds narrated instead of acting ✘`);
process.exit(ok === ROUNDS ? 0 : 1);
