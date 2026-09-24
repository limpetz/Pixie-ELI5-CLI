import type { ChatMessage, PixieConfig, TokenCallback, ToolCallRequest } from "./types.js";
import { chat } from "./llm.js";
import { TOOL_SCHEMAS, executeTool } from "./tools.js";
import { tryParseToolCall } from "./toolparse.js";
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
  let fakeWriteNudged = false;
  let giveUpNudges = 0;
  let keepGoingNudged = false;
  let temp0Retry = false;
  const toolsUsed = new Set<string>();
  const writtenPaths = new Set<string>(); // successful write/edit/delete targets (lowercased)
  // Per-shape nudge budgets (independent, like the classic nudges above).
  let questionNudges = 0;
  let saveNudges = 0;
  let buildNudges = 0;
  const shape = classifyRequestShape(userInput);

  while (toolRounds < cfg.maxToolRounds) {
    hooks.onThinkStart?.();
    const { content, toolCalls } = temp0Retry
      ? await chat({ ...cfg, temperature: 0 }, messages, TOOL_SCHEMAS)
      : await chat(cfg, messages, TOOL_SCHEMAS, hooks.onToken);
    temp0Retry = false;
    hooks.onStreamEnd?.();

    // The backends already re-parse narrated calls (bare JSON, <tool_call>,
    // fenced). This belt-and-braces pass catches a narrated call that arrives
    // as *content* with toolCalls still empty — e.g. the parser rejected a
    // slightly malformed call while narration around it survived. Executing
    // it directly beats nudging the model to emit it again (#8/#23 class).
    if (toolCalls.length === 0) {
      const recovered = tryParseToolCall(content);
      if (recovered && TOOL_SCHEMAS.some((t) => t.name === recovered.name)) {
        toolCalls.push({ id: `call_0_${Date.now()}`, name: recovered.name, args: recovered.args });
        logger.write({ type: "nudge", kind: "narrated-call-recovered", trigger: content.slice(0, 200) });
      }
    }

    if (toolCalls.length === 0) {
      const wroteAnyFile = toolsUsed.has("write_file") || toolsUsed.has("edit_file") || toolsUsed.has("delete_file");
      // Give-up refusal: the model read real files and then claims the task
      // "can't be completed" because the files "don't exist" (eval #23/#24
      // class — the reads SUCCEEDED; the refusal is hallucinated). Runtime
      // complement to the round-10 training data. Checked before every other
      // nudge: a refusal is unambiguous in every request shape, and by the
      // time it appears the shape-router has usually spent its budget. Push
      // up to twice, deterministically; ground the push in what WAS read.
      if (!wroteAnyFile && toolRounds > 0 && looksLikeGiveUp(content) && giveUpNudges < 2) {
        giveUpNudges++;
        temp0Retry = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content:
            giveUpNudges === 1
              ? `Your tool calls DID work — the files exist and you read them. Do not apologize and do not stop. Finish the task now: use write_file with the requested content, then give your summary.`
              : `The files are real: your earlier reads returned their content. Use write_file now on the file the user asked for with the correct content, then summarize. There is nothing missing.`,
        });
        logger.write({ type: "nudge", kind: "give-up", trigger: content.slice(0, 200) });
        continue;
      }
      // Small models sometimes hallucinate a fake tool result (<tool_response>…)
      // instead of calling the tool. Push once, deterministically. (Checked first:
      // it is a hard malfunction in every request shape.)
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
      // Phantom-write check: the reply CLAIMS a file was written/edited/saved
      // but no write tool ever succeeded this turn (#23: "- Wrote 'headphones'
      // to 'best.txt'" with zero write_file calls). One deterministic push to
      // actually perform the claimed write. Checked before the shape router:
      // like a fake tool response, this is a hard malfunction in every request
      // shape, and the shape-router must not spend its budget on it first.
      // Skipped when run_command was used — it may have written files we cannot
      // track.
      const claimed = claimedWriteFiles(content).filter((f) => !writtenPaths.has(f));
      if (!fakeWriteNudged && claimed.length > 0 && !toolsUsed.has("run_command")) {
        fakeWriteNudged = true;
        temp0Retry = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `Your summary says '${claimed[0]}' was written, but no write actually happened. Use write_file to create '${claimed[0]}' with the correct content now, then give your summary.`,
        });
        logger.write({ type: "nudge", kind: "fake-write", trigger: content.slice(0, 200) });
        continue;
      }
      // ── Shape-aware nudges: push the step this request is actually missing ──
      // Question requests ("which file is it?") need an ANSWER, not more work.
      if (shape === "question" && toolRounds > 0 && !wroteAnyFile && looksLikeDescribedAction(content) && !looksLikeAnswered(content) && questionNudges < 3) {
        questionNudges++;
        temp0Retry = true;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content:
            questionNudges === 1
              ? "You looked at the files but have not given the answer yet. Decide the answer and end your reply with one line in this form:\nAnswer: <the answer>"
              : questionNudges === 2
                ? "The user still does not have the answer. Reply now with the answer itself — one line starting with 'Answer:' — using what you read from the files."
                : "Final reminder: state the answer in one short line starting with 'Answer:'. Do not describe your steps again — just answer.",
        });
        logger.write({ type: "nudge", kind: "answer", trigger: content.slice(0, 200) });
        continue;
      }
      // Transform-then-save requests ("read X, …, write it into Y"): the model
      // explores and summarizes but never saves. Name the target file.
      if (shape === "save-result" && !wroteAnyFile && looksLikeDescribedAction(content)) {
        if (toolRounds === 0 && !narrationNudged) {
          narrationNudged = true;
          temp0Retry = true;
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content: "You described those actions but did not actually do them. Use your tools now to do it for real, then give your summary.",
          });
          logger.write({ type: "nudge", kind: "narration", trigger: content.slice(0, 200) });
          continue;
        }
        if (toolRounds > 0 && saveNudges < 2) {
          saveNudges++;
          const target = saveTargetFile(userInput);
          temp0Retry = true;
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content:
              saveNudges === 1
                ? target
                  ? `You read the file(s) but did not save anything yet. Work out the result and write it to "${target}" now with write_file. Only after the save, give your summary.`
                  : "You read the file(s) but did not save anything yet. Work out the result and write it to the file the user asked for, now with write_file. Only after the save, give your summary."
                : target
                  ? `Nothing has been saved to "${target}" yet. Use write_file on "${target}" with just the final result as its content, then give your summary.`
                  : "Nothing has been saved yet. Use write_file on the file the user asked for, with just the final result as its content, then give your summary.",
          });
          logger.write({ type: "nudge", kind: "save-result", trigger: content.slice(0, 200) });
          continue;
        }
      }
      // Build-several-files requests (websites, file sets): narration about
      // creating them must become one write_file call per (missing) file.
      if (shape === "build" && looksLikeDescribedAction(content)) {
        const missing = missingAmongMentioned(userInput, writtenPaths);
        if (missing.length > 0 && buildNudges < 3) {
          buildNudges++;
          const all = mentionedFiles(userInput).slice(0, 4).join(", ");
          temp0Retry = true;
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content:
              buildNudges === 1
                ? `You described creating files but have not written them yet. Use write_file once per file, each with its full content, for: ${all}. Then give your summary.`
                : `Still missing: ${missing.join(", ")}. Use write_file on each missing file now (one call per file, with its full content), then give your summary.`,
          });
          logger.write({ type: "nudge", kind: "build", trigger: content.slice(0, 200) });
          continue;
        }
      }
      // Small models sometimes *describe* doing the task ("What I did: - Created…")
      // instead of actually calling tools. Give them exactly one chance to act.
      // Skipped when the shape-router owns this situation (a summary AFTER real
      // writes or after reads on a question task is legitimate, not narration)
      // and when files were actually written this turn.
      const routerOwns =
        (shape === "question" && toolRounds > 0) ||
        (shape === "save-result" && toolRounds > 0) ||
        shape === "build";
      if (!narrationNudged && !routerOwns && !wroteAnyFile && looksLikeDescribedAction(content)) {
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
      if ((call.name === "write_file" || call.name === "edit_file" || call.name === "delete_file") && result.ok) {
        writtenPaths.add(String(args.path ?? "").toLowerCase());
      }
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

/**
 * True when the reply is a give-up refusal: the model claims the task cannot
 * be done because files/information "don't exist" — even though the tools may
 * have just read them (eval #23/#24 class: reads succeed, then "I can't
 * complete this task as it involves files that don't exist"). Deliberately
 * narrow: requires an apology/refusal stem AND an existence complaint, so a
 * legitimate "this file doesn't exist yet, want me to create it?" does not
 * match (no refusal stem there). Exported for selftests.
 */
export function looksLikeGiveUp(text: string): boolean {
  return /can'?t (?:complete|do|help)|cannot (?:complete|do|help)|unable to (?:complete|do|help)/i.test(text) && /don'?t exist|does(?:n'?t| not) exist|not (?:found|exist)|no (?:such )?files?/i.test(text);
}

/**
 * File paths the reply CLAIMS were written, e.g. "- Wrote 'best.txt'",
 * "I created shopping.txt", "saved the result to answer.txt". Past-tense only
 * — "I'll write…" is a plan, not a claim — and negations ("has not been
 * written") are ignored. Deliberately narrow so ordinary narration about
 * existing files cannot false-positive. Exported for selftests.
 */
export function claimedWriteFiles(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:wrote|written|created|saved)\s+(?:the\s+)?(?:file\s+)?(?:to\s+)?['"`]?([\w./\\-]+\.(?:txt|json|md|html|css|js|csv))['"`]?/gi;
  for (const m of text.matchAll(re)) {
    const lineStart = text.lastIndexOf("\n", m.index ?? 0) + 1;
    const line = text.slice(lineStart, (m.index ?? 0) + 30);
    if (/(?:\bnot\b|\bnever\b|n't\b)/i.test(line)) continue;
    out.push(m[1].toLowerCase());
  }
  return Array.from(new Set(out));
}

/**
 * Broad request-shape classifier used to pick the right nudge.
 * Three shapes matter for the nudges:
 *  - "question"    → the deliverable is a REPLY ("which file is it?")
 *  - "save-result" → the deliverable is a FILE the user names ("save it in x")
 *  - "build"       → several files must be created (website, file sets)
 * Everything else (and short/ambiguous input) → "other". Conservative by
 * design: a misclassified shape only changes the nudge wording, and every
 * nudge is still gated on the model actually stalling. Exported for selftests.
 */
export type RequestShape = "question" | "save-result" | "build" | "other";

export function classifyRequestShape(userInput: string): RequestShape {
  const t = userInput.toLowerCase();
  if (t.length < 12) return "other";
  const createWord = /\b(create|write|make|add|update|edit|fix|save|build)\b/.test(t);
  // A target file is an explicit destination for the result ("in/into/inside X").
  const hasTargetFile =
    /\b(in|into|inside|to)\s+(a\s+(?:new\s+)?file\s+(?:called\s+)?|[\w.-]+\.(?:txt|json|md|html|css|js|csv)\b)/.test(t) ||
    /\bfile\s+(?:called\s+)?[\w.-]+\.(?:txt|json|md|html|css|js|csv)\b/.test(t);
  // Question requests: the user asks for a fact/choice, not a file. A question
  // word wins over "write" ("tell me which one it is" is still a question).
  const questionWord =
    /\b(which|what is|what's|how many|how much|who|where|when|why)\b/.test(t) ||
    /\b(tell me|figure out)\b/.test(t) ||
    /\?\s*$/.test(t.trim());
  if (questionWord && !hasTargetFile) return "question";
  // Build-several-files requests: check BEFORE save-result — "build a website:
  // index.html must link to page1.html" contains "to page1.html", which looks
  // like a save destination but is only a link reference.
  if (
    createWord &&
    (countMatches(t, /\b(page\d|page\\?_?\d)\b/g) >= 1 ||
      /\b(website|three files|3 files|four files|4 files|each file|all \w+ files|files:)\b/.test(t) ||
      countMatches(t, /\b[\w.-]+\.(?:txt|json|md|html|css|js|csv)\b/g) >= 3)
  )
    return "build";
  if (createWord && hasTargetFile) return "save-result";
  return "other";
}

/**
 * True when the reply contains an actual answer to a question request —
 * the explicit "Answer:" line (taught in the system prompt), a plain-digit
 * answer like "It is file 2", or a pointed "the answer is X" statement.
 * Exported for selftests.
 */
export function looksLikeAnswered(text: string): boolean {
  const t = text.trim();
  if (/^answer\s*:/im.test(t)) return true;
  if (/\bthe answer is\b/i.test(t)) return true;
  if (/\b(it('| i)?s|file|number|riddle)\s*#?\s*\d+\b/i.test(t)) return true;
  return false;
}

/**
 * Extracts the destination file a save-result request names, e.g. "save the
 * result in answer.txt" → "answer.txt". Only paths with a known extension
 * count (a folder name is not a save target). Exported for selftests.
 */
export function saveTargetFile(userInput: string): string | null {
  const m = userInput.match(/\b[\w.-]+\.(?:txt|json|md|html|css|js|csv)\b/g) ?? [];
  return m.length > 0 ? m[m.length - 1] : null;
}

/**
 * File paths mentioned anywhere in a build-style request. Exported for selftests.
 */
export function mentionedFiles(userInput: string): string[] {
  const m = userInput.match(/\b[\w./-]+\.(?:txt|json|md|html|css|js|csv)\b/g) ?? [];
  return Array.from(new Set(m));
}

/**
 * Which of the request's mentioned files have NOT been written yet (so a
 * build nudge can name them precisely). Exported for selftests.
 */
export function missingAmongMentioned(userInput: string, writtenPaths: Set<string>): string[] {
  return mentionedFiles(userInput).filter((f) => !writtenPaths.has(f.toLowerCase()));
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
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
