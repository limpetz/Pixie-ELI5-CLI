# Pixie — Session Handoff

*Written 2026-09-22 after the round-6 refutation closed the investigation. Read this first when resuming.*

## What Pixie is

A local-first, beginner-friendly CLI coding agent (TypeScript, `src/`) plus a
self-improvement pipeline: sessions → dataset → QLoRA fine-tune of
Qwen2.5-Coder-7B → GGUF → back into the CLI as `pixie-7b`. Phases 1–3 are all
built; the project is now in the **fine-tune improvement loop** (rounds).

## Where things stand (top of file = current truth)

**Shipped model: round 1** (32 pairs, 6 epochs, loss ~1.19). The live tag is
verified: `ollama pixie-7b` is blob-identical to `pixie-7b-r1`
(hash `5c4feb1fdbb3`) and passes the behavioral probe 4/4 tool rounds:

```bash
npx tsx scripts/probe.ts --model pixie-7b --rounds 4   # expect "All 4 rounds acted via tools ✔"
rm -rf probe-ws
```

Run that first thing in any new session if you doubt the local model.

### Full scoreboard (canonical record: `docs/baseline.json`)

| Round | Data | Recipe | Runs | Median | Core/Multi/Hard |
|---|---|---|---|---|---|
| base control | — | — | 30/31/33 | 31 | — |
| **round 1** (×2: original + 2026-09-21 retrain from same recipe) | **32 original pairs** | **6ep / seq 1536** | 54/52/52, 53 hist. | **52–54** | 6/6/4 |
| round 2 | 105 merged | 4ep / 1792 | — | 43 | 5/4/1 |
| round 3 | 122 merged | 2ep / 1792 | 42/40/40 | 40 | 5/2/3 |
| round 4 | 41 curated hard/multi | 4ep / 1792 | 43/45/46 | 45 | 7/3/3 |
| round 5 | 82 union (r1+curated+multi5) | 3ep / 1792 | 46/45/46 | 46 | 5/3/3 |
| round 6 | same 82 union | 6ep / 1536 | 44/34/36 | **36 (worst)** | 4/3/2 |

Eval = 24-task suite (7 core / 9 multi / 8 hard), 72 checks, 3 runs per model,
head-to-head A/B (`npm run eval`). Raw rows append to
`training/eval-results.json` (gitignored) — **baseline.json is the durable record.**

### The closed investigation (rounds 2–6)

Three hypotheses were tested and **all refuted**:

1. **Data shape** — r4 (curated 41 hard/multi) fixed core/hard but multi
   stayed 3/9; r5 added verified traces for *every* chronically-failed multi
   shape (multi5 pool, 12/12 distilled chained) and multi *still* capped at
   3/9 while core dropped.
2. **Training stack** — r6 ran the exact r1 recipe (6 epochs, max_seq 1536,
   truncation-checked) on the r5 data: 36/72, worst round. Overfit into
   reflexes (loss 0.123), reproducing round 2's collapse at the other seq-len.
3. **Sequence length** — eliminated by the same r6 result.

**Conclusion: the only variable that tracks score is adapter provenance.**
Both round-1 runs score 52–54; five from-scratch retrains on merged/expanded
data land 36–46 regardless of data mix or recipe. Remaining suspects (untested):
(a) unsloth/env version drift vs the original r1 session, (b) r1's 32 pairs
being the only data whose message rendering predates later build-dataset
changes, (c) subtle interaction between chain traces and simple traces that
neither slicing nor union isolates.

**Policy going forward: stop blind from-scratch iteration.** Next rounds must
*continue training from* an existing good adapter (see options below).

## What this project changed, in order (commits through `8931d61`)

1. **Distillation pipeline** (`scripts/distill.ts`): verifier registry
   (`id | task text` format), 2 attempts with pristine workspace reseed
   (`training/seed-workspace.py`), sequential-chain gate, sha256 dedupe,
   `--only`/`--tasks-file`/`--teacher` flags, attempt-2 scaffolds (per-shape
   step hints — they fixed llama3.1's one-shotting but *narration-poisoned*
   weaker teachers; **qwen2.5-coder:7b is the right teacher** for this pool).
   `VERIFY` is exported for testing.
2. **Verifier gotchas found via smoke harness** (9 bugs total across the
   project): for either/or checks, loop and return null on first success —
   `a ?? b` under null-means-pass semantics means BOTH (this inverted `??`
   chains bit us three times: wcletter/csvprice/contactfix, half, and nearly
   again in the multi5 pool). Verifiers must also require *untouched* fields
   to survive (jsonedit/volume) and reject any extra files, not specific ones.
3. **`scripts/verify-smoke.ts`** — offline fixture/trap harness, no model
   calls. Every verifier must pass a correct workspace and fail its known
   lazy shortcut. Run: `npx tsx scripts/verify-smoke.ts`.
4. **`scripts/audit-traces.ts`** — audits `distilled.jsonl` tail: chain
   structure, narration on tool turns, grounded write values.
5. **Task pools + seeder tracked in git**: `chain-tasks.txt` (r3),
   `chain-retry.txt`, `chain2-tasks.txt` (r4), `multi5-tasks.txt` +
   `multi5-retry.txt` (r5), `edit-tasks.txt`, `my-tasks.txt` (r2),
   `seed-workspace.py`. Datasets (`*.jsonl`) are machine-local — regenerate
   with the node one-liners in the sections below if lost.
6. **Round history**: r3 (122 pairs, 40/72) → r4 (curated 41, 45/72, core
   7/7) → r1-retrain + multi5 pool → r5 (82 union, 46/72) → r6 (r1 stack on
   union, 36/72). Details in `docs/baseline.json`.

### The GGUF-loss incident (do not repeat)

The original round-1 GGUF and adapter were **overwritten with no backup**.
Recovery was retraining from r1's exact recipe (`training/r1.jsonl`, 6 epochs,
max_seq 1536, loss 1.198) — which then validated at 52/72, matching the
original. **Policy: after every `ollama create pixie-7b`, immediately run
`ollama cp pixie-7b pixie-7b-r<N>` BEFORE scoring.** Current snapshots:
`pixie-7b-r1` (shipped), `-r4`, `-r5`, `-r6`. The `-r4` copy in Ollama also
backs the r4 adapter.

## Environment facts

- **Ollama running** (`localhost:11434`): `pixie-7b` = `pixie-7b-r1` (shipped,
  verified), `qwen2.5-coder:7b` (distill teacher), `llama3.1:8b`, `qwen2.5-coder:1.5b-base`, `nomic-embed-text`.
- **Adapter dirs**: `training/pixie-7b-lora/` = round-6 adapter (latest run
  always overwrites this); `training/pixie-7b-lora-r4/` = round-4 copy.
  The **r1-retrain adapter no longer exists on disk** — only its GGUF
  (`pixie-7b-r1`). To get it back: copy the current `pixie-7b-lora/` aside,
  rerun r1's recipe (`r1.jsonl`, 6ep, 1536 — ~8 min), and save the result
  somewhere durable before anything else touches `pixie-7b-lora/`.
- Training venv: `training/.venv/Scripts/python.exe`; run from `training/`
  (`train.py` reads `lora_config.py`: DATASET, EPOCHS, MAX_SEQ_LEN, SEED=42).
  RTX 4060 8 GB; ~8 min/step on the 82-pair union, ~2 min/step on 32 pairs.
- Export path: `training/export-gguf.py` → project-root `pixie-7b-gguf/`
  (cwd-independent; re-export + re-import before scoring — the stale-GGUF
  incident) → `ollama create pixie-7b -f pixie-7b-gguf_gguf/Modelfile`.
- Datasets on disk (all gitignored): `r1.jsonl` 32, `round4-curated.jsonl`
  41, `round5.jsonl` 82, `all.jsonl` 122, `distilled.jsonl` 131
  (119 verified chains + 12 multi5), `dataset-real.jsonl` 3.
- Run `npm run typecheck`, `npm run selftest`, `npx tsx scripts/verify-smoke.ts`
  before committing; all green as of this writing.

## Next steps — three options, in recommended order

**A. Round 7: continuation training (the documented policy).**
1. Recover the r1-retrain adapter (see Environment facts — ~8 min).
2. Teach `training/train.py` to load the base as the r1 adapter + merged
   weights and continue (unsloth `model = FastLanguageModel.get_peft_model`
   on a loaded PeftModel, or merge-then-LoRA).
3. Train on `multi5` + `curated` traces at LOW LR (e.g. 2e-5) / 1–2 epochs —
   the goal is *adding* chain competence without eroding r1's simple-task
   behavior. Watch that loss starts near r1's ~1.2 scale, not at 0.5+.
4. Export → import → `ollama cp pixie-7b pixie-7b-r7` → 3-run eval.
5. Ship only if median > 54 and hard ≥ 4; otherwise restore:
   `ollama cp pixie-7b-r1 pixie-7b`.

**B. If continuation fails: r1-only replication sweep.** Rebuild r1's data
through the *current* build-dataset path (rendering check: diff the chat
template output of an r1 pair vs a distilled pair) and train r1's exact
recipe — if that scores ~36–46, the regression is in the *data rendering /
env drift*, not the data selection. This cleanly separates suspect (b).

**C. Env archaeology** (only if A and B fail): pin/inspect unsloth +
transformers versions vs whatever was installed when r1 was first trained
(`pip freeze` history is not available — the venv has been reused; consider
locking versions now: `pip freeze > training/requirements-lock.txt`).

Regardless of path: any new eval result goes into `docs/baseline.json` +
this file, and the `pixie-7b` tag must end the session pointing at the best
known model (currently `pixie-7b-r1`).
