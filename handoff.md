# Pixie — Session Handoff

*Written 2026-09-21 after dataset curation. Read this first when resuming.*

## What Pixie is

A local-first, beginner-friendly CLI coding agent (TypeScript, `src/`) plus a
self-improvement pipeline: sessions → dataset → QLoRA fine-tune of
Qwen2.5-Coder-7B → GGUF → back into the CLI as `pixie-7b`. Phases 1–3 are all
built; the project is now in the **fine-tune improvement loop** (rounds).

## Where things stand

**Shipped model: round-1 adapter** (32 pairs, 6 epochs, loss 1.189) — the
strongest fine-tune so far. Round 2 (105 pairs, 4 epochs, loss 0.56) **regressed**:
43/72 vs 53/72 median checks, with the hard tier collapsing to 1/8 (from 4/8).
Diagnosis: the bigger dataset made the model *reflexive* — in run 3 it
one-shot every hard task (0 tool rounds, wrong output). Round-1 stays shipped
until a round-3 recipe beats it on the same eval.

### Eval timeline (canonical record: `docs/baseline.json`)

| Label | Model | Median | Notes |
|---|---|---|---|
| pre-training | qwen2.5-coder:7b | 44/72 | high variance (41–57) |
| round 1 | pixie-7b | **53/72** | hard tier 4/8, never narrates-instead-of-acting |
| round 2 | pixie-7b | 43/72 | hard tier 1/8 — regression, not shipped |
| round 2 control | qwen2.5-coder:7b | 36/72 | |

Eval = 24-task suite (7 core / 9 multi / 8 hard), 72 checks, 3 runs per model,
head-to-head A/B (`npm run eval`). Raw rows append to
`training/eval-results.json` (gitignored) — **baseline.json is the durable record.**

## What this session changed (commit `9af9896`)

1. **Round-3/4 distillation pipeline is now wired and correct**
   (`scripts/distill.ts`): goal verification via a verifier registry
   (`id | task text` format), 2 attempts per task with a **pristine workspace
   reseed between attempts** (`training/seed-workspace.py`), sequential
   tool-chain requirement (parallel blind calls don't count), sha256 dedupe,
   `--only` flag. `VERIFY` is exported for testing.

2. **Fixed 3 broken + 2 weak verifiers** the new smoke harness caught:
   - `csvappend` checked `inv.txt` (never seeded) instead of `inventory.csv`,
     and didn't require the appended row to preserve existing rows.
   - `team3` only rejected a 4th file named exactly `tester.txt` — now any
     extra entry fails ("exactly three files").
   - `wcletter`, `csvprice`, `contactfix` were built with `a ?? b` chains that
     **invert under null-means-pass semantics**: `a(x) ?? b(x)` requires BOTH
     to pass (?? falls through only when a *succeeded*). wcletter now accepts
     either output filename; csvprice checks both cell changes; contactfix
     checks the one file the task actually mentions.
   - **Gotcha for future verifiers: for either/or, loop and return null on the
     first success. For both-required, `??` chains are fine.**

3. **`scripts/verify-smoke.ts`** — offline fixture/trap harness (no model
   calls). Every verifier must pass on a correct workspace and fail on its
   known lazy shortcut. Run: `npx tsx scripts/verify-smoke.ts`. All 38 checks pass.

4. **`scripts/audit-traces.ts`** — one-off audit of the `distilled.jsonl` tail
   (chain structure, narration on tool turns, grounded write values). Last 6
   rows audited clean: 1–3 sequential rounds, zero narrated tool turns.

5. **Task pools + seeder are now tracked in git** (were gitignored, i.e.
   machine-local): `training/chain-tasks.txt` (round 3), `chain-retry.txt`,
   `chain2-tasks.txt` (round 4 — targets the still-failing shapes:
   command→save chains, exact-N creation, two-edit tasks, create-then-edit),
   `edit-tasks.txt`, `seed-workspace.py`.

6. `training/export-gguf.py` resolves `OUT` to the project root
   (cwd-independent — the round-2 "stale GGUF" incident happened because the
   first import was built from the wrong adapter; always re-export + re-import
   before scoring a new round).

Repo is green: `npm run typecheck` ✔, `npm run selftest` ✔ (all sections).

## Environment facts

- **Ollama is running** (`localhost:11434`) with: `pixie-7b` (the round-2 GGUF
  — note: NOT the shipped round-1 weights), `qwen2.5-coder:7b`, `llama3.1:8b`,
  `qwen2.5-coder:1.5b-base`, `nomic-embed-text`.
- Training venv: `training/.venv/Scripts/python.exe` (exists; run
  `training/train.py` per `training/TRAINING.md` — QLoRA on a local GPU,
  ~3.7h for round-2's 4 epochs on 105 pairs).
- Gitignored (machine-local, do not commit): `training/all.jsonl` (122 pairs
  = 119 verified distilled + 3 real sessions), `distilled.jsonl`,
  `pixie-7b-lora/` (current adapter = round 2), eval logs/results, `*.gguf`.
- Untracked heavy dirs: `pixie-7b-gguf/` (round-2 safetensors),
  `pixie-7b-gguf_gguf/` (Modelfile for `ollama create pixie-7b`),
  `unsloth_compiled_cache/`. Leave untracked; `unsloth_compiled_cache/` could
  be added to `.gitignore`.

## Next steps (the round-3 cycle, in order)

1. **Distill the round-4 pool** (verified chains; reseed is automatic now):
   ```bash
   npm run distill -- --only --tasks-file training/chain2-tasks.txt --num 14 --teacher ollama://llama3.1:8b
   ```
   (Stronger option: `--teacher openai://gpt-4o-mini` with `OPENAI_API_KEY`.)
   Expect skips — that's the verifier working. Retry skips with
   `--offset`/`--temperature` variations. Then `npx tsx scripts/audit-traces.ts 6`.

2. **Dataset rebuilt and validated (2026-09-21)** — merged `distilled.jsonl`
   + `dataset-real.jsonl` with the exported `dedupe()` helper: 122 input/output
   rows (119 verified distilled + 3 real; no exact duplicates). Validation:
   every row has tool calls, no tool result indicates failure, and every row
   ends with an assistant response.

3. **Round 3 trained and evaluated (2026-09-21)** — 122 pairs, 2 epochs,
   final loss **0.933**. Exported and recreated Ollama `pixie-7b`; three eval
   runs scored **42, 40, 40/72** (median 40), with tier medians core 5/7,
   multi 2/9, hard 3/8. This is still a regression from round 1's 53/72;
   do **not** ship round 3. `docs/baseline.json` records the result.

4. **Round 4 is prepared** — `training/round4-curated.jsonl` contains 41
   pairs: the 38 verified hard/multi traces (rows 81–118 of the merged set)
   plus 3 real sessions. `training/lora_config.py` now points to this slice
   and uses 4 epochs, approximately matching round-1 total exposure while
   removing the 81 simple create-only traces that diluted the targeted skill.

5. **Export + import completed for round 3**: `training/export-gguf.py` (writes to project-root
   `pixie-7b-gguf/`) → `ollama create pixie-7b -f pixie-7b-gguf_gguf/Modelfile`
   → verify `ollama run pixie-7b` actually behaves differently from round 2
   before scoring.

6. **Train/evaluate round 4**: the curated slice is ready. Run the normal
   train → export → `ollama create pixie-7b` → three eval runs. The current
   Ollama `pixie-7b` points at round 3, so restore the round-1 GGUF if available
   before using it as the shipped CLI model. **Ship only if median beats 53/72
   and hard tier ≥ 4/8.**

7. Optionally regenerate `training/TRAINING.md` via `npm run prepare-training`
   if the recipe changed materially.
