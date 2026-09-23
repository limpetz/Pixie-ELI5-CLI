import type { ChatMessage, PixieConfig, TokenCallback, ToolCallRequest } from "./types.js";
import { chat } from "./llm.js";
import { TOOL_SCHEMAS, executeTool } from "./tools.js";
import type { SessionLogger } from "./session.js";

export const BEGINNER_SYSTEM_PROMPT = `You are Pixie, a super-friendly coding helper. You explain things ELI5 — "explain like I'm 5" — but you still get real work done.

HOW YOU ACT (most important):
- When the user asks for anything that involves files, folders, searches, or commands, you MUST use a tool to do it. Do not describe doing it, and never pretend it is already done.
- Use one tool call at a time and wait for its result before deciding the next step.
- Only AFTER your tools have finished the job, reply with a short summary.

CHANGING A FILE THAT ALREADY EXISTS:
- Read it first, then use write_file with the COMPLETE new content — every old line you keep PLUS the change.
- When you replace a file, keep ALL the lines the user did not ask you to change.
- After writing, check the tool's line-count report: if lines went missing, write the file again with everything back in.

HOW TO SOUND (ELI5):
- Very short sentences. Everyday words a young kid knows.
- If you must use a techy word, explain it with a tiny comparison to something real (like "a file is like a page in your backpack").
- Be warm and encouraging, like a patient grown-up helping a kid. At most one small emoji.
- End every summary with exactly:

What I did:
- <one simple, kid-friendly bullet per action you took with your tools>

Try it yourself:
- <one tiny, safe thing the user could try or ask next>

Rules:
- Work only inside the workspace.
- If the request is unclear, ask ONE short question instead of guessing.
- If you cannot do something, say so plainly — never claim an action you did not take.`;

const PRO_SYSTEM_PROMPT = `You are Pixie, a precise coding and reasoning agent.
- Act via tools yourself; never instruct the user to run commands or edit files when you can do it.
- Plan briefly, act with tools, verify results, then summarize concisely.
- Prefer minimal, surgical edits over rewrites.
- Never touch anything outside the workspace.
- If information is missing, ask one targeted question.`;

export interface AgentTurnResult {
  reply: string;
  toolRounds: number;
}

/**
 * Runs one full agent turn: model → tools → model → … → final answer.
 * Bash commands go through an approval callback unless auto-run is on.
 */
export async function runTurn(
  cfg: PixieConfig,
  history: ChatMessage[],
  userInput: string,
  logger: SessionLogger,
  hooks: {
    autoRun?: boolean;
    onToolStart?: (name: string, args: Record<string, unknown>) => void;
    approveBash?: (command: string) => Promise<boolean>;
    /** Streams model text token-by-token as it is generated. */
    onToken?: TokenCallback;
    /** Called when a streamed model response has finished (print a newline etc.). */
    onStreamEnd?: () => void;
    /** Called right before each model call — show a spinner here. */
    onThinkStart?: () => void;
  },
): Promise<AgentTurnResult> {
  const systemPrompt = cfg.beginnerMode ? BEGINNER_SYSTEM_PROMPT : PRO_SYSTEM_PROMPT;
  const messages: ChatMessage[] = [
    { role: "system", content: `${systemPrompt}\n\nWorkspace: ${cfg.workspace}` },
    ...history,
    { role: "user", content: userInput },
  ];
  logger.write({ type: "user_message", content: userInput });

  let toolRounds = 0;
  let autoApprove = hooks.autoRun ?? !cfg.beginnerMode;
  let narrationNudged = false;
  let fakeResponseNudged = false;
  let keepGoingNudged = false;
  let temp0Retry = false;
  const toolsUsed = new Set<string>();

  while (toolRounds < cfg.maxToolRounds) {
    hooks.onThinkStart?.();
    const { content, toolCalls } = temp0Retry
      ? await chat({ ...cfg, temperature: 0 }, messages, TOOL_SCHEMAS)
      : await chat(cfg, messages, TOOL_SCHEMAS, hooks.onToken);
    temp0Retry = false;
    hooks.onStreamEnd?.();

    if (toolCalls.length === 0) {
      // Small models sometimes *describe* doing the task ("What I did: - Created…")
      // instead of actually calling tools. Give them exactly one chance to act.
      if (!narrationNudged && looksLikeDescribedAction(content)) {
        narrationNudged = true;
        temp0Retry = true; // retry deterministically (temp 0): same narration can't repeat
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: "You described those actions but did not actually do them. Use your tools now to do it for real, then give your summary.",
        });
        logger.write({ type: "nudge", trigger: content.slice(0, 200) });
        continue;
      }
      // Small models sometimes hallucinate a fake tool result (<tool_response>…)
      // instead of calling the tool. Push once, deterministically.
      if (!fakeResponseNudged && looksLikeFakeToolResponse(content)) {
        fakeResponseNudged = true;
        temp0Retry = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: "That looked like tool output, but you did not call a tool. Use your tools now to do the real work, then give your summary.",
        });
        logger.write({ type: "nudge", kind: "fake-response", trigger: content.slice(0, 200) });
        continue;
      }
      // Exploration-only stop: the model looked at files but never acted, then
      // declared the task done (classic on read → transform → save requests).
      // One deterministic push to finish the job with its tools.
      if (!keepGoingNudged && toolRounds > 0 && usedOnlyReadOnlyTools(toolsUsed) && looksLikeCompletionSummary(content)) {
        keepGoingNudged = true;
        temp0Retry = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: "You only looked at files but did not create or change anything yet. If this task asks you to make or change something, keep going with your tools now and finish it. If it was only a question, answer it now.",
        });
        logger.write({ type: "nudge", kind: "keep-going", trigger: content.slice(0, 200) });
        continue;
      }
      messages.push({ role: "assistant", content });
      logger.write({ type: "assistant_message", content });
      return { reply: content, toolRounds };
    }

    const assistantMsg: ChatMessage = { role: "assistant", content, toolCalls };
    messages.push(assistantMsg);
    logger.write({ type: "assistant_tool_calls", content, toolCalls });

    for (const call of toolCalls as ToolCallRequest[]) {
      let args = call.args;
      let approved = true;

      if (call.name === "run_command") {
        const command = String(args.command ?? "");
        if (autoApprove) {
          approved = true;
        } else if (hooks.approveBash) {
          approved = await hooks.approveBash(command);
          if (approved) autoApprove = true; // user approved once → trust for the rest of this turn
        } else {
          approved = false;
        }
        if (!approved) {
          const denial = `User declined to run: ${command}`;
          messages.push({ role: "tool", content: denial, toolCallId: call.id, name: call.name });
          logger.write({ type: "tool_result", name: call.name, ok: false, output: denial });
          continue;
        }
      }

      hooks.onToolStart?.(call.name, args);
      toolsUsed.add(call.name);
      const result = executeTool(cfg.workspace, call.name, args, { autoApproveBash: true });
      if (result.output.startsWith("NEEDS_APPROVAL: ")) {
        const command = result.output.slice("NEEDS_APPROVAL: ".length);
        const ok = hooks.approveBash ? await hooks.approveBash(command) : false;
        if (!ok) {
          const denial = `User declined to run: ${command}`;
          messages.push({ role: "tool", content: denial, toolCallId: call.id, name: call.name });
          logger.write({ type: "tool_result", name: call.name, ok: false, output: denial });
          continue;
        }
        const executed = executeTool(cfg.workspace, call.name, { ...args, command }, { autoApproveBash: true });
        messages.push({ role: "tool", content: executed.output, toolCallId: call.id, name: call.name });
        logger.write({ type: "tool_result", name: call.name, ok: executed.ok, output: executed.output });
        continue;
      }
      messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name });
      logger.write({ type: "tool_result", name: call.name, ok: result.ok, output: result.output });
    }

    toolRounds++;
  }

  hooks.onThinkStart?.();
  const final = await chat(
    cfg,
    [...messages, { role: "user", content: "Please wrap up and give your final answer now." }],
    [],
    hooks.onToken,
  );
  hooks.onStreamEnd?.();
  logger.write({ type: "assistant_message", content: final.content });
  return { reply: final.content, toolRounds };
}

/**
 * Detects the classic small-model failure: a summary of actions that were
 * never actually performed with tools (e.g. "What I did: - Created file…",
 * "Sure! I'll create a file…"). Kept conservative to avoid false positives
 * on plain informational answers. Exported for selftests.
 */
export function looksLikeDescribedAction(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/what i did:/i.test(t)) return true;
  if (
    /\b(created|wrote|made|added|updated|edited|saved|deleted|writing|creating|adding|updating|editing|saving|deleting|making)\b/i.test(
      t,
    )
  )
    return true;
  return (
    /\b(let's|i'll|i will|i'm going to)\b/i.test(t) &&
    /\b(create|write|make|add|update|edit|save|run|delete|fix)\b/i.test(t)
  );
}

/**
 * True when every tool used this turn only inspects the workspace (no writes).
 * Exported for selftests.
 */
export function usedOnlyReadOnlyTools(toolsUsed: Set<string>): boolean {
  if (toolsUsed.size === 0) return false;
  for (const t of toolsUsed) {
    if (t !== "list_files" && t !== "read_file" && t !== "search_files") return false;
  }
  return true;
}

/**
 * True when the message reads like the model's final completion summary
 * (the beginner prompt requires the "What I did:" footer). Exported for selftests.
 */
export function looksLikeCompletionSummary(text: string): boolean {
  return /what i did:/i.test(text.trim());
}

/**
 * True when the model emits a hallucinated tool result instead of calling a
 * tool (e.g. "<tool_response>…</tool_response>"). Exported for selftests.
 */
export function looksLikeFakeToolResponse(text: string): boolean {
  return /<\/?(tool_response|tool_result)\b/i.test(text);
}

export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_files: "Looking at your files",
    read_file: "Reading",
    write_file: "Writing",
    edit_file: "Editing",
    delete_file: "Deleting",
    search_files: "Searching",
    run_command: "Running a command",
  };
  return labels[name] ?? name;
}

export function shortArgs(args: Record<string, unknown>): string {
  const p = args.path ?? args.query ?? args.command ?? "";
  return p ? ` → ${String(p).slice(0, 60)}` : "";
}
