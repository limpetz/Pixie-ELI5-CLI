# ✦ Pixie

**Pixie is a friendly AI coding companion that anyone can use — even if you've never written a line of code.**

Tell it what you want in plain language ("make a website about my cat", "fix the bug in my notes app") and Pixie reads, creates, and edits files for you, explaining everything in simple words.

## This is Phase 1 of the Pixie roadmap

| Phase | What | Status |
|---|---|---|
| 1 | **Pixie Agent** — CLI companion powered by existing models (yours, local & free), with streaming responses | ✅ this repo |
| 2 | **Pixie Dataset** — every session is logged to JSONL, ready for training | ✅ built in |
| 3 | **Pixie Model** — QLoRA fine-tune on your GPU: `build-dataset` + training kit included | ✅ scripts ready |
| 4 | **Scaffold & Guardrail Evolution** — shape router, recovery nudges, wrong-premise signal handling | ✅ current focus (record 64/72) |

## Where We Are Now (Current Progress & Benchmarks)

Pixie is pairing a fine-tuned model (**`pixie-7b-r1`**, QLoRA on `qwen2.5-coder-7b-instruct`) with an intelligent agent runtime (Scaffold v2.2+):

- **Benchmark Score**: **64/72** project record (Core 7/7, Multi 7/9, Hard 6/8) on the 24-task eval suite, up from the base model's 31/72.
- **Modify Family Tasks**: 94/96 pass rate across append, in-place edit, and JSON/CSV modifications.
- **Key Scaffold Innovations**:
  - **Wrong-Premise Signal Handling**: Returns clear `"Path not found"` and actionable tool redirects to avoid models accepting invalid premises.
  - **Phantom-Write Detector**: Automatically catches responses claiming a file was written without executing a tool call, and commands a real write.
  - **Apology-Without-Action Recovery**: Catches models apologizing or stalling after not-found errors, nudging them to search or list workspace files instead of burning turn budgets.
  - **Request-Shape Router**: Identifies question, build, or save-result targets and guides model output to the needed deliverable format.

## Quick start

```bash
cd pixie
npm install
npm run dev
```

Answers **stream in live, token by token**. First run walks you through setup: pick a folder for Pixie to work in and choose a brain. Pixie defaults to your **local Ollama models** (free + private). It needs a tool-capable model — `qwen2.5-coder:7b` is a great default:

```bash
ollama pull qwen2.5-coder:7b
```

Works with any cloud model too (OpenAI, Groq, OpenRouter, LM Studio…) via the `/model` command → option "cloud API".

## What Pixie can do

Inside its workspace folder (and **only** there):

- 📂 look at your files, 👁 read them, ✏️ create, 🔧 edit and 🗑️ delete them
- 🔍 search for words across the project
- ▶️ run commands — always **asking you first** in beginner mode

Safety rails, on by default:

- File edits are backed up to `.pixie/backups/` before anything changes
- Commands need your approval (toggle per turn with `/auto`)
- Pixie physically cannot touch files outside the workspace

## Beginner mode (the whole point)

Beginner mode is on by default:

- Plain-English answers, no unexplained jargon
- Every task ends with **"What I did"** and a **"Try it yourself"** section
- Friendly error messages instead of stack traces
- Launch banner shows Pixie's version, model, and workspace at a glance
- A live spinner with elapsed seconds shows when Pixie is thinking

Toggle with `/mode` when you want terser, pro-style replies.

## Commands

`/help` · `/new` (fresh chat) · `/resume` (continue a past conversation) · `/model` (swap brain) · `/mode` (beginner ↔ pro) · `/auto` (command approvals) · `/tools` (capabilities) · `/stats` (training-data collected) · `/exit`

## Where your data lives

- `~/.pixie/config.json` — your setup
- `<workspace>/.pixie/sessions/*.jsonl` — conversation logs = **Phase 3 fine-tuning dataset**
- `<workspace>/.pixie/backups/` — automatic file backups

## Phase 3: train your own Pixie model

Once you've used Pixie for a while (`/stats` shows how much you've collected):

```bash
npm run build-dataset      # sessions → training/dataset.jsonl (filtered + deduped)
npm run distill            # teacher model generates extra grounded traces
npm run prepare-training   # generates lora_config.py + TRAINING.md
npm run eval               # after training: Pixie-7B vs base, head-to-head
npm run selftest           # quick regression tests
npm run verify-smoke       # offline check of the distill goal verifiers
```

Then follow **`training/TRAINING.md`**: QLoRA fine-tune of Qwen2.5-Coder-7B on your own GPU (or a free Colab T4) → export to GGUF → `ollama create pixie-7b` → pick it with `/model`. Your own model, trained on your own conversations.

### Distillation (`npm run distill`)

Uses a bigger *teacher* model through Pixie's real agent loop — same tools, same prompt — on beginner tasks, producing grounded traces in `training/distilled.jsonl` (files really get created, so answers describe real actions):

```bash
npm run distill -- --num 10 --teacher ollama://llama3.1:8b      # free, local
npm run distill -- --num 50 --teacher openai://gpt-4o-mini      # stronger, needs OPENAI_API_KEY
npm run distill -- --tasks-file training/my-tasks.txt --teacher https://api.groq.com/openai/v1|KEY|model
```

Traces from task pools that use the `id | task text` format (see
`training/chain-tasks.txt`) are **goal-verified**: after each attempt Pixie
reseeds the scratch workspace and only keeps traces whose files actually show
the task was achieved (wrong totals, lazy parallel calls, or "exactly three
files" with a bonus fourth are dropped). Add a task? Also add its verifier to
`VERIFY` in `scripts/distill.ts` and a fixture/trap pair to
`scripts/verify-smoke.ts`, then `npm run verify-smoke`.

Mix both files when training (`DATASET_FILE` in `training/lora_config.py`).

### Evals (`npm run eval`)

Objective head-to-head scoring over a **24-task suite** in three tiers — `core` (single-step), `multi` (multi-file/folder/edit/search-and-act) and `hard` (commands, follow-up turns, structured edits, deletion, multi-file reasoning). Tasks can seed files and include follow-up turns, and every run is appended to `training/eval-results.json` so fine-tuning progress is measurable over time:

```bash
npm run eval                                                    # pixie-7b vs qwen2.5-coder:7b
npm run eval -- --a ollama://pixie-7b --b ollama://llama3.1:8b
npm run eval -- --limit 10                                      # quick smoke run
npm run eval -- --tasks-file training/my-evals.jsonl            # your own tasks
```

Task format (JSONL): `{"prompt": "…", "checks": ["file:math.txt", "regex:144"], "tier": "hard", "seed": [{"path": "…", "content": "…"}], "followUps": ["…"]}` — check kinds: `file:`, `missing:`, `contains:`, `not-contains:`, `regex:`, `file-count:`, `lines:<name>:<min>-<max>`, `reply-contains:`, `reply-regex:`.
