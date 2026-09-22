# Pixie — Session Handoff

*Written 2026-09-22 after round 7 (continuation) was refuted and option-B data forensics was COMPLETED — the missing ingredient is identified (see Next steps). Read this first when resuming.*

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
| round 7 | 53 chain pairs, **continued FROM the r1 adapter** | 2ep @ LR 2.5e-5 / 1536 | 45/44/46 | 45 | 6/2/4 |

Eval = 24-task suite (7 core / 9 multi / 8 hard), 72 checks, 3 runs per model,
head-to-head A/B (`npm run eval`). Raw rows append to
`training/eval-results.json` (gitignored) — **baseline.json is the durable record.**

### The closed investigation (rounds 2–7)

Four hypotheses were tested and **all refuted**:

1. **Data shape** — r4 (curated 41 hard/multi) fixed core/hard but multi
   stayed 3/9; r5 added verified traces for *every* chronically-failed multi
   shape (multi5 pool, 12/12 distilled chained) and multi *still* capped at
   3/9 while core dropped.
2. **Training stack** — r6 ran the exact r1 recipe (6 epochs, max_seq 1536,
   truncation-checked) on the r5 data: 36/72, worst round. Overfit into
   reflexes (loss 0.123), reproducing round 2's collapse at the other seq-len.
3. **Sequence length** — eliminated by the same r6 result.
4. **Continuation from r1's weights** — r7 recovered the r1-retrain adapter
   (retrained r1's recipe, loss 1.197) and fine-tuned further on the 53
   chain pairs at LR 2.5e-5 / 2 epochs: 45/72 with multi 2/9. Gentleness
   didn't matter — even touching r1's weights with chain data erodes multi.

**Conclusion: the score is a property of r1's original 32 pairs.** Only the
two runs trained on them reach 52–54 — every derived dataset scores 36–46
from scratch (r2–r6) AND via gentle continuation from r1's own weights (r7).The multi tier (r1: 6/9) is what every derivative breaks.

**Forensics verdict (2026-09-22, option B executed — full entry in
`docs/baseline.json`, type `data_forensics`):** rendering/provenance and the
env are CLEAN (schemas byte-match `TOOL_SCHEMAS`, r1's embedded system prompt
byte-matches today's `BEGINNER_SYSTEM_PROMPT`, no truncation except 1–2
derivative rows at 1589 tokens — suspects (b) and (c) eliminated). The driver
is **(a) content mix**: r1 is 32 short-prompt, single-call `write_file`
pairs (zero `edit_file`/`read_file`/`run_command`, avg 1.06 calls/row,
21/32 multiline full-file writes, 136-char summaries); derivatives are
2–5-call chains (avg 1.86–3.19) heavy on `edit_file`/`read_file`, and the
model imitates the *shape* without the exact-match skill — failing exactly
the modify-existing-content tasks (eval multi #12 append, #13 JSON edit,
#15 precision, #16 exact copy) that r1 passes by rewriting the FULL file
via `write_file`.

**Policy going forward: never put `edit_file` demonstrations in training
data for this 7B. Teach modify-tasks as read → `write_file`(FULL new
content) — r1's own strategy. New synthetic pairs must copy r1's style:
short prompts (~66 chars), single call per row, full-file content,
terse summaries.** `train.py`'s `BASE_ADAPTER` continuation path stays
available but r7 showed continuation erodes r1 — prefer from-scratch on
an r1-style set.

## What this project changed, in order (recent commits: `dd8887c` continuation trainer + env lock; then the round-7 result commit)

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
   union, 36/72) → r7 (continuation from the recovered r1 adapter on 53
   chain pairs, LR 2.5e-5: 45/72, multi 2/9). Details in `docs/baseline.json`.
7. **Round-7 infrastructure (2026-09-22)**: env pinned
   (`training/requirements-lock.txt`: unsloth 2026.9.7, transformers 5.5.0,
   trl 0.24.0); `train.py` gained the `BASE_ADAPTER` continuation path
   (loads a saved adapter via unsloth, re-enables lora_* params, NO second
   get_peft_model — that would stack a fresh random LoRA — with frozen/
   fresh-init guards). The r1-retrain adapter was recovered and saved
   durably to `training/pixie-7b-lora-r1redo` (loss 1.197 ≈ 1.198); r6/r7
   adapters also kept (`-r6`, `-r7`).

### The GGUF-loss incident (do not repeat)

The original round-1 GGUF and adapter were **overwritten with no backup**.
Recovery was retraining from r1's exact recipe (`training/r1.jsonl`, 6 epochs,
max_seq 1536, loss 1.198) — which then validated at 52/72, matching the
original. **Policy: after every `ollama create pixie-7b`, immediately run
`ollama cp pixie-7b pixie-7b-r<N>` BEFORE scoring.** Current snapshots:
`pixie-7b-r1` (shipped), `-r4`, `-r5`, `-r6`, `-r7`. The `-r4` copy in Ollama also
backs the r4 adapter.

## Environment facts

- **Ollama running** (`localhost:11434`): `pixie-7b` = `pixie-7b-r1` (shipped,
  verified), `qwen2.5-coder:7b` (distill teacher), `llama3.1:8b`, `qwen2.5-coder:1.5b-base`, `nomic-embed-text`.
- **Adapter dirs**: `training/pixie-7b-lora/` = round-7 adapter (latest run
  always overwrites this). Durable copies: `pixie-7b-lora-r1redo` (r1 recipe
  retrained, loss 1.197), `pixie-7b-lora-r4`, `pixie-7b-lora-r6`,
  `pixie-7b-lora-r7`. They are whitelisted in .gitignore
  (`!training/*-lora-*`) but deliberately NOT committed (~160 MB each) —
  they exist only on this machine; the Ollama GGUF snapshots are the backup
  of record.
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

## Next steps

**A. Round-7 continuation — EXECUTED (2026-09-22), refuted.** 45/72 with
multi collapsed to 2/9, even at LR 2.5e-5 resuming r1's own weights. The
`BASE_ADAPTER` path stays in `train.py` (with its guards) but is not the
route back to 52+: r7 proved gentle continuation still erodes multi.

**B. Data forensics — EXECUTED (2026-09-22), verdict recorded.** Render
provenance is clean (suspects (b)/(c) eliminated); the driver is r1's
narrow write-only single-call curriculum. Full findings: `docs/baseline.json`
entry `data_forensics` (2026-09-22), plus the render-forensics script kept
at `training/render_forensics.py` (re-run anytime: `./.venv/Scripts/python.exe
render_forensics.py` from `training/`). Option C is moot — provenance is
not the problem.

**C. Round 8 — NEXT: synthesize r1-style coverage, train r1's recipe.**
Build ~10–15 new pairs in r1's exact style (short prompt, ONE tool call,
FULL-file `write_file` content, terse summary) covering the chronically
failed shapes — append-to-list (#12), JSON edit (#13), read-transform-write
(#15), exact one-line copy (#16) — all as read → write_file(full content),
never `edit_file`. Concat with r1's 32 pairs (~45 total), train 6 epochs /
max_seq 1536 from base (~2 min/step), then standard export →
`ollama create` → `ollama cp pixie-7b pixie-7b-r8` → eval ×3. Success bar:
multi ≥ 6/9 with core ≥ 6/7. If it works, codify the no-`edit_file` rule
in `scripts/distill.ts` (rewrite distilled traces to read→write form).

Regardless of path: any new eval result goes into `docs/baseline.json` +
this file, and the `pixie-7b` tag must end the session pointing at the best
known model (`pixie-7b-r1`). The env is pinned:
`training/requirements-lock.txt` (committed).
