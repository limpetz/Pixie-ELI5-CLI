import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolResult, ToolSchema } from "./types.js";

/* ── Tool definitions (what the model sees) ─────────────────────────── */

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "list_files",
    description:
      "List files and folders in the workspace (or a subfolder). Use this first to see what exists.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Optional subfolder, e.g. 'src'" } },
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a text file so you can understand or improve it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path, e.g. 'notes.txt'" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new FILE or fully replace an existing file. The path must end with a filename, not a folder (e.g. 'photos/album.txt', never 'photos'). The previous version is saved as a backup automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to create/replace, ending in a filename" },
        content: { type: "string", description: "The complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace a short exact snippet inside a file with new text. Safer than rewriting the whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit" },
        old_text: { type: "string", description: "Exact text to find (keep it short but unique)" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "search_files",
    description: "Find which files contain a word or phrase. Great for locating things.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Text to search for" } },
      required: ["query"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file (or an empty folder) that is no longer needed. Use this to clean up mistakes, like a file that was created with the wrong name.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File to delete" } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace (for example 'node script.js' or 'npm install'). Ask the human for approval first unless they enabled auto-run.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run" } },
      required: ["command"],
    },
  },
];

/* ── Path safety: everything stays inside the workspace ─────────────── */

function safePath(workspace: string, p: string | undefined): string {
  const raw = p && p.trim() !== "" ? p : ".";
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Pixie can only touch files inside the workspace (${workspace}).`);
  }
  return abs;
}

function backupFile(workspace: string, abs: string): void {
  if (!existsSync(abs)) return;
  const dir = join(workspace, ".pixie", "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(abs, join(dir, `${basename(abs)}.${stamp}.bak`));
}

/* ── Implementations ────────────────────────────────────────────────── */

interface WalkEntry {
  rel: string;
  isDir: boolean;
  size: number;
}

function walk(dir: string, base: string, out: WalkEntry[], depth: number): void {
  if (depth > 4 || out.length > 400) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === ".pixie" || e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const rel = relative(base, full).split(sep).join("/");
    const isDir = st.isDirectory();
    out.push({ rel, isDir, size: isDir ? 0 : st.size });
    if (isDir) walk(full, base, out, depth + 1);
  }
}

export function executeTool(
  workspace: string,
  name: string,
  args: Record<string, unknown>,
  opts: { autoApproveBash: boolean },
): ToolResult {
  try {
    switch (name) {
      case "list_files": {
        const target = safePath(workspace, args.path as string | undefined);
        const out: WalkEntry[] = [];
        walk(target, target, out, 0);
        const lines = out.map((e) => (e.isDir ? `${e.rel}/` : `${e.rel} (${e.size} bytes)`));
        return { ok: true, output: lines.length ? lines.join("\n") : "(empty folder)" };
      }
      case "read_file": {
        const abs = safePath(workspace, args.path as string);
        if (!existsSync(abs)) return { ok: false, output: `File not found: ${args.path}` };
        const st = statSync(abs);
        if (st.size > 512 * 1024) return { ok: false, output: "File is too large to read (over 512 KB)." };
        return { ok: true, output: readFileSync(abs, "utf8") };
      }
      case "write_file": {
        const abs = safePath(workspace, args.path as string);
        const parent = join(abs, "..");
        if (existsSync(parent) && !statSync(parent).isDirectory()) {
          return {
            ok: false,
            output: `Cannot write '${args.path}': '${basename(parent)}' already exists as a FILE but the path needs it to be a folder. Delete it first (delete_file) or use a different name.`,
          };
        }
        if (existsSync(abs) && statSync(abs).isDirectory()) {
          return {
            ok: false,
            output: `Cannot write '${args.path}': it is already a FOLDER. Write to a file inside it instead, e.g. '${args.path}/my-file.txt'.`,
          };
        }
        const existed = existsSync(abs);
        const beforeLines = existed ? readFileSync(abs, "utf8").split("\n").length : 0;
        const content = String(args.content ?? "");
        mkdirSync(parent, { recursive: true });
        backupFile(workspace, abs);
        writeFileSync(abs, content, "utf8");
        let output = `Wrote ${args.path}`;
        if (existed) {
          const afterLines = content.split("\n").length;
          output += ` (replaced: was ${beforeLines} lines, now ${afterLines})`;
          if (/\.json$/i.test(String(args.path))) {
            try {
              JSON.parse(content);
            } catch {
              output += "\nWARNING: this file is not valid JSON — write it again with correct JSON.";
            }
          }
        }
        return { ok: true, output };
      }
      case "delete_file": {
        const abs = safePath(workspace, args.path as string);
        if (!existsSync(abs)) return { ok: false, output: `Nothing to delete: '${args.path}' does not exist.` };
        backupFile(workspace, abs);
        rmSync(abs, { recursive: true });
        return { ok: true, output: `Deleted ${args.path}` };
      }
      case "edit_file": {
        const abs = safePath(workspace, args.path as string);
        if (!existsSync(abs)) return { ok: false, output: `File not found: ${args.path}` };
        const src = readFileSync(abs, "utf8");
        const oldText = String(args.old_text ?? "");
        const newText = String(args.new_text ?? "");
        if (!src.includes(oldText)) {
          return {
            ok: false,
            output: "Could not find that text in the file. Nothing was changed. Tip: read the file first, then use write_file with the complete new content instead.",
          };
        }
        backupFile(workspace, abs);
        writeFileSync(abs, src.replace(oldText, newText), "utf8");
        return { ok: true, output: `Edited ${args.path}` };
      }
      case "search_files": {
        const query = String(args.query ?? "");
        if (!query) return { ok: false, output: "Empty search query." };
        const entries: WalkEntry[] = [];
        walk(workspace, workspace, entries, 0);
        const hits: string[] = [];
        for (const e of entries.filter((x) => !x.isDir)) {
          try {
            const lines = readFileSync(join(workspace, e.rel), "utf8").split("\n");
            lines.forEach((line, i) => {
              if (line.includes(query) && hits.length < 40) hits.push(`${e.rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
            });
          } catch {
            /* skip unreadable */
          }
        }
        if (hits.length) return { ok: true, output: hits.join("\n") };
        // No content matches — but maybe the query was a file NAME. Point the
        // model at read_file instead of letting it conclude the file is missing.
        const nameHit = entries
          .filter((x) => !x.isDir)
          .some((x) => x.rel.toLowerCase().includes(query.toLowerCase()));
        if (nameHit) {
          return {
            ok: true,
            output: `No file contains "${query}" in its text, but a file is named like it: use read_file on it to see its contents.`,
          };
        }
        return { ok: true, output: `No matches for "${query}".` };
      }
      case "run_command": {
        const command = String(args.command ?? "");
        if (!opts.autoApproveBash) {
          return { ok: false, output: `NEEDS_APPROVAL: ${command}` };
        }
        const out = execSync(command, {
          cwd: workspace,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
        return { ok: true, output: (out || "(no output)").slice(0, 8000) };
      }
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
