import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { ChatMessage, PixieConfig } from "./types.js";
import { PIXIE_HOME, loadConfig, saveConfig } from "./config.js";
import { SessionLogger } from "./session.js";
import { runTurn, toolLabel, shortArgs } from "./agent.js";
import { Spinner } from "./spinner.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function welcome(cfg: PixieConfig): void {
  console.log(C.cyan(`
  ✦  Pixie v${VERSION} — your friendly coding companion
  ─────────────────────────────────────────`));
  console.log(`  Model      ${cfg.provider.model}${cfg.fallback ? C.dim(`  (fallback: ${cfg.fallback.model})`) : ""}`);
  console.log(`  Workspace  ${cfg.workspace}`);
  console.log(`  Mode       ${cfg.beginnerMode ? "Beginner-friendly" : "Pro"}`);
  console.log(C.dim(`
  Talk to me like a person: "make a website about my cat"
  Commands: /help  /new  /resume  /workspace  /model  /mode  /auto  /tools  /eval  /stats  /exit
`));
}

function help(): void {
  console.log(`
  ${C.bold("Commands")}
  /help          Show this help
  /new           Start a fresh conversation
  /resume        Continue a past conversation
  /workspace     Change the workspace folder (keeps your settings)
  /model         Switch the model Pixie thinks with
  /mode          Toggle beginner ↔ pro mode
  /auto          Toggle auto-run of commands (default: ask first)
  /tools         List what Pixie can do in your workspace
  /eval          Quick skill check of the current model (10 tasks)
  /stats         Show session log size (your future training data)
  /exit          Leave

  ${C.bold("Safety")}
  • Pixie only edits files inside the workspace shown above.
  • Every changed file is backed up to .pixie/backups first.
  • Commands always ask before running (unless you turn on /auto).`);
}

interface LocalModel {
  name: string;
  toolCapable: boolean;
}

async function listLocalModels(): Promise<LocalModel[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(4000) });
    const data = (await res.json()) as { models?: { name: string; capabilities?: string[] }[] };
    return (data.models ?? []).map((m) => ({
      name: m.name,
      toolCapable: (m.capabilities ?? []).includes("tools"),
    }));
  } catch {
    return [];
  }
}

interface Ask {
  (question: string): Promise<string>;
}

async function pickModel(cfg: PixieConfig, ask: Ask): Promise<PixieConfig> {
  console.log(C.dim("  Checking which models are available locally…"));
  const all = await listLocalModels();
  // Pixie acts through tools — models without tool support can't do the job.
  const local = all.filter((m) => m.toolCapable);
  const skipped = all.length - local.length;
  if (skipped > 0) {
    console.log(C.dim(`  (hiding ${skipped} model${skipped === 1 ? "" : "s"} that can't use tools)`));
  }
  if (local.length === 0) {
    console.log(C.yellow("  No tool-capable local models found. Pull one first, e.g.:"));
    console.log(C.yellow("    ollama pull qwen2.5-coder:7b"));
  }
  console.log(`  ${C.bold("Choose Pixie's brain:")} ${C.dim("(local models that can act for you)")}`);
  local.forEach((m, i) => {
    const rec = m.name.startsWith("qwen2.5-coder:7b") ? C.green("  ← recommended") : "";
    console.log(`   ${i + 1}. ${m.name}  ${C.dim("(local, free)")}${rec}`);
  });
  const n = local.length;
  console.log(`   ${n + 1}. Use a cloud API instead (OpenAI-compatible)`);

  const answer = (await ask("  Number: ")).trim();
  const idx = Number(answer);
  if (idx >= 1 && idx <= n) {
    return {
      ...cfg,
      provider: { kind: "ollama", baseUrl: "http://localhost:11434", model: local[idx - 1].name },
    };
  }
  if (idx === n + 1) {
    const base = (await ask("  API base URL (e.g. https://api.openai.com/v1): ")).trim() || "https://api.openai.com/v1";
    const key = (await ask("  API key: ")).trim();
    const model = (await ask("  Model name (e.g. gpt-4o-mini): ")).trim() || "gpt-4o-mini";
    return { ...cfg, provider: { kind: "openai", baseUrl: base, apiKey: key || undefined, model } };
  }
  console.log(C.yellow("  Keeping current model."));
  return cfg;
}

async function firstRunSetup(ask: Ask): Promise<PixieConfig> {
  console.log(C.bold("\n  Welcome! Let's set Pixie up (one time only).\n"));
  console.log(C.dim("  Pixie needs a folder to work in — a project folder on your computer."));
  console.log(C.dim("  Press Enter to use a folder called 'workspace' in your home directory.\n"));
  let wsInput = (await ask("  Workspace folder (Enter for default): ")).trim();
  if (wsInput.startsWith("/")) {
    // Piped input (e.g. '/exit' in scripted runs) must not become a folder name.
    console.log(C.yellow("  (That looked like a command, not a folder — using the default.)"));
    wsInput = "";
  }
  const workspace = wsInput ? resolve(wsInput) : join(homedir(), "workspace");
  mkdirSync(workspace, { recursive: true });
  console.log(C.dim(`  Workspace: ${workspace}`));

  const base: PixieConfig = {
    provider: { kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen2.5-coder:7b" },
    fallback: { kind: "ollama", baseUrl: "http://localhost:11434", model: "llama3.1:8b" },
    workspace,
    beginnerMode: true,
    temperature: 0.4,
    maxToolRounds: 8,
  };
  const cfg = await pickModel(base, ask);
  saveConfig(cfg);
  console.log(C.green(`\n  ✔ Saved. You're ready! Config lives at ${join(PIXIE_HOME, "config.json")}\n`));
  return cfg;
}

export async function runRepl(): Promise<void> {
  // One readline interface for the entire process, plus a line queue so input
  // that arrives between prompts (e.g. while awaiting the model list) is kept.
  const rl = createInterface({ input: stdin, output: stdout });
  const queued: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    if (waiting) {
      console.log(C.cyan("\n  ✦ bye!\n"));
      process.exit(0);
    }
  });
  const ask: Ask = (q) => {
    stdout.write(q);
    if (queued.length > 0) return Promise.resolve(queued.shift() as string);
    return new Promise<string>((res) => {
      waiting = res;
    });
  };

  const existing = loadConfig();
  let cfg = existing ?? (await firstRunSetup(ask));

  // Warn if the saved model can't use tools (it would fail every turn).
  if (cfg.provider.kind === "ollama") {
    const locals = await listLocalModels();
    const match = locals.find((m) => m.name === cfg.provider.model);
    if (match && !match.toolCapable) {
      console.log(C.yellow(`\n  ⚠  '${cfg.provider.model}' does not support tools, so Pixie can't act with it.`));
      console.log(C.yellow("     Run /model to pick a tool-capable model (e.g. qwen2.5-coder:7b).\n"));
    }
  }

  welcome(cfg);

  const history: ChatMessage[] = [];
  let logger = new SessionLogger(cfg.workspace, {
    model: cfg.provider.model,
    beginnerMode: cfg.beginnerMode,
  });

  let autoRun = !cfg.beginnerMode;

  while (true) {
    let input: string;
    try {
      input = (await ask(C.cyan("\n  you › "))).trim();
    } catch {
      break; // stdin closed (Ctrl+C / Ctrl+D)
    }
    if (!input) continue;

    if (input === "/exit" || input === "/quit") {
      console.log(C.cyan("\n  ✦ bye! your session was saved.\n"));
      rl.close();
      break;
    }
    if (input === "/help") { help(); continue; }
    if (input === "/new") {
      history.length = 0;
      console.log(C.green("  ✔ Fresh conversation started."));
      continue;
    }
    if (input === "/mode") {
      cfg = { ...cfg, beginnerMode: !cfg.beginnerMode };
      saveConfig(cfg);
      console.log(`  Mode: ${cfg.beginnerMode ? "beginner-friendly" : "pro"}`);
      continue;
    }
    if (input === "/auto") {
      autoRun = !autoRun;
      console.log(`  Commands will ${autoRun ? "run automatically" : "ask you first"}.`);
      continue;
    }
    if (input === "/tools") {
      console.log(`
  ${C.bold("What Pixie can do inside your workspace")}
  📂 list_files    See what's in your folders
  👁  read_file     Look inside a file
  ✏️  write_file    Create a file (auto-backup first)
  🔧 edit_file     Change part of a file (auto-backup first)
  🗑️ delete_file   Remove a file (auto-backup first)
  🔍 search_files  Find where something is mentioned
  ▶️  run_command   Run a command (asks you first)`);
      continue;
    }
    if (input === "/eval") {
      console.log(C.dim("  Running a quick skill check of the current model (10 tasks, 1-2 min)…"));
      try {
        const { BUILT_IN, evalModel } = await import("../scripts/eval.js");
        const spec =
          cfg.provider.kind === "ollama"
            ? `ollama://${cfg.provider.model}`
            : `${cfg.provider.baseUrl}|${cfg.provider.apiKey ?? ""}|${cfg.provider.model}`;
        const r = await evalModel(spec, BUILT_IN.slice(0, 10), resolve("training/eval-workspace"));
        console.log(
          r.tasksPassed >= 7
            ? C.green(`  ✔ ${cfg.provider.model}: ${r.checksPassed}/${r.checksTotal} checks, ${r.tasksPassed}/10 tasks — looking sharp!`)
            : C.yellow(`  ◦ ${cfg.provider.model}: ${r.checksPassed}/${r.checksTotal} checks, ${r.tasksPassed}/10 tasks — room to grow (fine-tuning target: 44/72 median).`),
        );
        console.log(C.dim(`  Details in training/eval-workspace · (${r.seconds.toFixed(0)}s)`));
      } catch (err) {
        console.log(C.red(`  Eval failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      continue;
    }
    if (input === "/stats") {
      const dir = join(cfg.workspace, ".pixie", "sessions");
      let count = 0;
      let bytes = 0;
      try {
        for (const f of readdirSync(dir)) {
          count++;
          bytes += statSync(join(dir, f)).size;
        }
      } catch {
        /* no sessions yet */
      }
      console.log(`  ${count} session file(s), ${(bytes / 1024).toFixed(1)} KB of training data in ${dir}`);
      continue;
    }
    if (input === "/resume") {
      const dir = join(cfg.workspace, ".pixie", "sessions");
      const entries: { file: string; mtime: number; firstUser: string }[] = [];
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const p = join(dir, f);
          if (p === logger.path) continue; // skip the session we just started
          const text = readFileSync(p, "utf8");
          const m = text.match(/\{"type":"user_message","content":"((?:[^"\\]|\\.)*)"/);
          const firstUser = m ? JSON.parse(`"${m[1]}"`) as string : "(no user message)";
          entries.push({ file: p, mtime: statSync(p).mtimeMs, firstUser });
        }
      } catch {
        /* no sessions yet */
      }
      if (entries.length === 0) {
        console.log(C.yellow("  No past sessions found yet."));
        continue;
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      console.log(`  ${C.bold("Continue which conversation?")} (newest first)`);
      entries.slice(0, 8).forEach((e, i) => {
        const when = new Date(e.mtime).toLocaleString();
        console.log(`   ${i + 1}. [${when}] ${e.firstUser.slice(0, 70)}`);
      });
      const ans = (await ask("  Number (Enter to cancel): ")).trim();
      const idx = Number(ans);
      if (!ans || !Number.isInteger(idx) || idx < 1 || idx > Math.min(8, entries.length)) {
        console.log(C.dim("  Cancelled."));
        continue;
      }
      const chosen = entries[idx - 1];
      const rebuilt: ChatMessage[] = [];
      for (const line of readFileSync(chosen.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { type?: string; content?: string };
          if (e.type === "user_message" && e.content) rebuilt.push({ role: "user", content: e.content });
          if (e.type === "assistant_message" && e.content) rebuilt.push({ role: "assistant", content: e.content });
        } catch {
          /* skip malformed line */
        }
      }
      history.length = 0;
      history.push(...rebuilt.slice(-40));
      logger.resume(chosen.file);
      console.log(C.green(`  ✔ Resumed. ${history.length} message(s) back in context — just keep talking.`));
      continue;
    }
    if (input === "/model") {
      cfg = await pickModel(cfg, ask);
      saveConfig(cfg);
      console.log(`  Model: ${cfg.provider.model}`);
      continue;
    }
    if (input === "/workspace") {
      console.log(`  Current workspace: ${cfg.workspace}`);
      console.log(C.dim("  Pixie can only touch files inside this folder."));
      const next = (await ask("  New workspace folder (Enter to cancel): ")).trim();
      if (!next || next.startsWith("/")) {
        console.log(C.dim("  Cancelled."));
        continue;
      }
      const ws = resolve(next);
      if (ws === cfg.workspace) {
        console.log(C.yellow("  That's already the current workspace."));
        continue;
      }
      mkdirSync(ws, { recursive: true });
      logger.write({ type: "workspace_switch", to: ws });
      cfg = { ...cfg, workspace: ws };
      saveConfig(cfg);
      history.length = 0; // fresh conversation in a new place
      logger = new SessionLogger(cfg.workspace, {
        model: cfg.provider.model,
        beginnerMode: cfg.beginnerMode,
      });
      console.log(C.green(`  ✔ Workspace is now ${ws}`));
      console.log(C.dim("  Conversation reset. /resume lists sessions for this workspace."));
      continue;
    }

    const spinner = new Spinner("pixie is thinking");
    try {
      let didStream = false;
      let open = false;
      const result = await runTurn(cfg, history, input, logger, {
        autoRun,
        onThinkStart: () => spinner.start(),
        onToolStart: (name, args) => {
          spinner.stop();
          if (open) {
            process.stdout.write("\n");
            open = false;
          }
          process.stdout.write(C.dim(`  ✦ pixie ${toolLabel(name).toLowerCase()}${shortArgs(args)}…\n`));
        },
        onToken: (text) => {
          spinner.stop();
          if (!open) {
            process.stdout.write(`  ${C.cyan("pixie › ")}`);
            open = true;
          }
          didStream = true;
          process.stdout.write(text);
        },
        onStreamEnd: () => {
          spinner.stop();
          if (open) {
            process.stdout.write("\n");
            open = false;
          }
        },
        approveBash: async (command) => {
          spinner.stop();
          console.log(C.yellow(`\n  Pixie wants to run: ${C.bold(command)}`));
          const ok = (await ask("  Allow it? (y/n): ")).trim().toLowerCase().startsWith("y");
          if (ok) autoRun = true;
          return ok;
        },
      });
      spinner.stop();
      if (!didStream) {
        for (const line of result.reply.split("\n")) console.log(`  ${C.cyan("pixie ›")} ${line}`);
      }
      if (result.toolRounds > 0) console.log(C.dim(`  (${result.toolRounds} tool round${result.toolRounds === 1 ? "" : "s"})`));
      history.push({ role: "user", content: input });
      history.push({ role: "assistant", content: result.reply });
      if (history.length > 40) history.splice(0, history.length - 40);
    } catch (err) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(C.red(`\n  Hmm, something went wrong talking to the model:`));
      console.log(C.red(`  ${msg}`));
      console.log(C.dim(`  If Pixie was using a local model, is Ollama running? Try:  ollama serve\n`));
      logger.write({ type: "error", message: msg });
    }
  }
}
