# ✦ Pixie

**Pixie is a friendly AI coding companion that anyone can use — even if you've never written a line of code.**

Tell it what you want in plain language ("make a website about my cat", "fix the bug in my notes app") and Pixie reads, creates, and edits files for you, explaining everything in simple words.

## This is Phase 1 of the Pixie roadmap

| Phase | What | Status |
|---|---|---|
| 1 | **Pixie Agent** — CLI companion powered by existing models (yours, local & free), with streaming responses | ✅ this repo |
| 2 | **Pixie Dataset** — every session is logged to JSONL, ready for training | ✅ built in |
| 3 | **Pixie Model** — QLoRA fine-tune on your GPU: `build-dataset` + training kit included | ✅ scripts ready |

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

- 📂 look at your files, 👁 read them, ✏️ create and 🔧 edit them
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
```

Then follow **`training/TRAINING.md`**: QLoRA fine-tune of Qwen2.5-Coder-7B on your own GPU (or a free Colab T4) → export to GGUF → `ollama create pixie-7b` → pick it with `/model`. Your own model, trained on your own conversations.

### Distillation (`npm run distill`)

Uses a bigger *teacher* model through Pixie's real agent loop — same tools, same prompt — on beginner tasks, producing grounded traces in `training/distilled.jsonl` (files really get created, so answers describe real actions):

```bash
npm run distill -- --num 10 --teacher ollama://llama3.1:8b      # free, local
npm run distill -- --num 50 --teacher openai://gpt-4o-mini      # stronger, needs OPENAI_API_KEY
npm run distill -- --tasks-file training/my-tasks.txt --teacher https://api.groq.com/openai/v1|KEY|model
```

Mix both files when training (`DATASET_FILE` in `training/lora_config.py`).

### Evals (`npm run eval`)

Objective head-to-head scoring — each task must produce verifiable results (files exist, content matches checks):

```bash
npm run eval                                                    # pixie-7b vs qwen2.5-coder:7b
npm run eval -- --a ollama://pixie-7b --b ollama://llama3.1:8b
npm run eval -- --tasks-file training/my-evals.jsonl            # your own tasks
```

Task format (JSONL): `{"prompt": "create math.txt with 12 times 12 as a sentence", "checks": ["file:math.txt", "regex:144"]}` — check kinds: `file:`, `contains:`, `regex:`, `reply-contains:`, `reply-regex:`.
