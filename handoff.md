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

6. **Round 4 trained and evaluated (2026-09-21)** — the curated 41-pair slice
   (38 verified hard/multi traces + 3 real sessions), 4 epochs, final loss
   1.262, ~41 min on the RTX 4060. Three eval runs: **43, 45, 46/72** (median
   45) — the best fine-tune since round 1, beating base 3/3, core now perfect
   (7/7 in two runs). Still short of round 1's 53/72, so **not shipped**;
   the gap is entirely the multi tier (2–3/9 vs round 1's 4/9).
   `docs/baseline.json` records the result.

7. **Round-1 GGUF restored (2026-09-21)** — the original round-1 GGUF had
   been overwritten by rounds 2–4 with **no backup** (the adapter dir too).
   Retrained round 1 from its exact recipe: `training/r1.jsonl` (the same
   32 pairs: rows 0–28 + 3 real sessions of all.jsonl), 6 epochs, max_seq
   1536, final loss 1.198. Exported and imported as `ollama pixie-7b` —
   **the shipped model is live again**. Snapshots now in Ollama:
   `pixie-7b-r1` (shipped baseline) and `pixie-7b-r4` (best challenger).
   **Policy: after every future `ollama create pixie-7b`, run
   `ollama cp pixie-7b pixie-7b-r<N>` before scoring.**

8. **Round-5 multi-tier pool built (2026-09-21)** — `training/multi5-tasks.txt`
   targets the seven multi shapes r4 failed in all 3 runs: flat exact-N
   files (colors3/snacks2), read→compute→save (double/half), extract-line
   (titleline/lastline), unnamed-typo find-and-fix (findfix/findfix2),
   list-append (keepadd), JSON edit (jsonedit), read-3-files→pick (pickfile).
   Verifiers + scaffolds in distill.ts, seeds in seed-workspace.py, smoke
   fixtures/traps in verify-smoke.ts (which caught two more verifier bugs:
   a third ??-on-null inversion in `half`, and jsonedit not requiring the
   untouched `volume` field to survive). All smoke tests pass.

9. **Round-5 trained and evaluated (2026-09-21) — NOT shipped**:
   - Distilled the multi5 pool (9/12 first pass, 3 recovered via retry),
     merged r1 (32) + curated (38) + multi5 (12) → `round5.jsonl`, 82 pairs,
     3 epochs, loss 0.839, 1h48m on the RTX 4060.
   - Eval: **46, 45, 46/72** (median 46) — beats base 3/3 but TIES round 4
     (45) and remains ~7 short of r1's 53. Tier medians: core 5/7 (r4 had
     7/7), multi 3/9 (target was 6/9), hard 3/8.
   - **Key negative result**: verified multi5 coverage did NOT fix the multi
     tier, and the union slightly eroded core. Two dataset-shape experiments
     (r4 curated slice, r5 union) both cap multi at ~4/9 while the retrained
     r1 control sits at 52-54 with multi 5-6/9 — the gap is probably NOT a
     data-shape problem. `docs/baseline.json` records the full entry.
   - Snapshots: `ollama pixie-7b-r5` = round 5; `pixie-7b-r1` = shipped
     baseline; `pixie-7b-r4`. Current `pixie-7b` tag = round 5.

10. **Round 6 trained and evaluated (2026-09-21) — WORST round; stack
    hypothesis refuted.** Same 82-pair r5 dataset on r1's exact stack
    (6 epochs, max_seq 1536, truncation-checked) → loss 0.123, eval
    **44, 34, 36/72** (median 36), run 3 losing to base. 6 epochs overfit
    the union into reflexes exactly like round 2 did — seq-len eliminated.
    Score table: r1 data 52-54 · r2 43 · r3 40 · r4 45 · r5 46 · r6 36.
    The only variable that tracks score is **adapter provenance**: both r1
    runs (original + retrained from its exact data) score 52-54; every
    from-scratch retrain on merged/expanded data lands 36-46.

11. **Current standing + what to do next**:
    - **Shipped model: `pixie-7b-r1` (the retrained round 1, 52-54/72).**
      Restore the tag first thing next session:
      `ollama cp pixie-7b-r1 pixie-7b`. Snapshots in Ollama: r1, r4, r5, r6.
    - **Stop blind from-scratch iteration.** Five from-scratch attempts have
      never beaten r1; the r1-retrain adapter (`training/pixie-7b-lora-r4`
      holds a copy of the r4 adapter — the r1-retrain adapter was overwritten
      by r5/r6 training, but its GGUF lives in `pixie-7b-r1`). Future rounds
      must CONTINUE from an existing good adapter (load `pixie-7b-r1`'s
      adapter/merged weights and fine-tune further on new data) instead of
      starting from the base model.
    - Other open suspects if continuation also fails: unsloth version drift
      vs the original r1 session; r1's pairs being the only data whose
      message rendering predates later build-dataset changes.

12. Optionally regenerate `training/TRAINING.md` via `npm run prepare-training`
   if the recipe changed materially.
