# Pixie — Session Handoff

*Written 2026-09-22 after round 9 arm A (from-scratch on 32 r1 + 5 exact eval-mirror rows) scored **42/72 median, multi 2/9 — second-worst derivative round** and the last pre-registered experiment. **Round 1 is declared TERMINAL for this 7B** (the pre-registered decision rule from next-step E). Read this first when resuming.*

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
| round 8 | 47 = **r1's 32 verbatim** + 15 r1-style synth (read→write_file FULL) | r1's exact recipe, from scratch | 46/45/47 | 46 | 5/3/4 |
| round 9B | 15 r1-convention synth (r8's tasks, style rebuilt to r1's audit) | **continued FROM the r1redo adapter**, 2ep @ LR 2.5e-5 / 1536 | 53/52/44 | **52 (best derivative)** | 7/4/4 |
| round 9A | 37 = **r1's 32 verbatim** + 5 exact eval-mirror synth rows | r1's exact recipe, from scratch | 43/42/42 | 42 | 5/2/4 |

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

**Conclusion (amended by round 9B): the score scales with how closely the
training signal approximates r1's exact 32 pairs under r1's conventions.**
Through round 8, every deviation landed 36–46 with multi 2–3/9: replacing
the data (r2–r5), matching the recipe on other data (r6), gentle
continuation from r1's own weights (r7), and even **adding** r1-style synth
to r1's own data (r8: 46/72, multi 3/9). Round 9B — r8's tasks with all
five style-drift vectors fixed (no trailing newline on write content, mixed
bullets, 4 summary shapes, ~136-char summaries) plus continuation from the
r1redo adapter — is the partial exception: 52/72 median, multi 3–5/9, core
7/7 twice. It entered r1's band without reproducing r1's multi skill or
tightness (run 3: 44). The multi tier (r1: 6/9) is still what every
deviation fails to reach at the bar (≥ 6/9). **Round 9A closed the
investigation: even r1's own 32 pairs plus ONLY the 5 exact eval-mirror
rows (the maximal-convention, minimal-dilution set) scored 42/72 with
multi 2/9 — below plain r8 (46) — so dilution sensitivity is not even
monotone in synth count, and the multi skill lives in something about the
exact-32 training that no data description captures. Round 1 is terminal
for this 7B.**

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
8. **Round-9 infrastructure (2026-09-22)**: `scripts/build-round9.ts`
   (`npm run build-round9`) rebuilds r8's 15 scenarios with r1-AUDITED
   conventions (the five drift vectors from an r1 style audit: no trailing
   newline on write content, bullet mix •/*/‑, 4 summary shapes incl.
   Great-preamble, terse ~136-char summaries, edit_file banned). Every trace
   is replayed through the REAL `executeTool` and scored with the eval's own
   `runChecks` at build time; the builder's `validate()` enforces the
   convention contract (fails loudly on drift).Emits
`training/round9-synth15.jsonl` (15 rows, arm B) and
`training/round9-32plus5.jsonl` (32 r1 verbatim + 5 exact eval-mirror rows,
arm A — now trained and scored).
9. **Round-9 arm A result + terminal decision (2026-09-22)**: from-scratch
   on `round9-32plus5.jsonl` (37 pairs) at r1's exact recipe (6ep / 2.5e-4 /
   1536), train_loss 0.8047. Scored 43/42/42 → **median 42/72, multi 1–2/9**
   — second-worst round ever, below r8 (46) and r9B (52). Even 5
   convention-perfect rows added to r1's own 32 erase the multi skill. Per
   the pre-registered rule: **round 1 is terminal for this 7B — stop
   adapter iterations on this base model.**

### The GGUF-loss incident (do not repeat)

The original round-1 GGUF and adapter were **overwritten with no backup**.
Recovery was retraining from r1's exact recipe (`training/r1.jsonl`, 6 epochs,
max_seq 1536, loss 1.198) — which then validated at 52/72, matching the
original. **Policy: after every `ollama create pixie-7b`, immediately run
`ollama cp pixie-7b pixie-7b-r<N>` BEFORE scoring.** Current snapshots:
`pixie-7b-r1` (shipped), `-r4`, `-r5`, `-r6`, `-r7`. The `-r4` copy in Ollama also
backs the r4 adapter. Round-8 copies: `pixie-7b-r8` in Ollama and
`training/pixie-7b-lora-r8` on disk (46/72).Round-9 copies: `pixie-7b-r9b` in Ollama and
`training/pixie-7b-lora-r9b` on disk (best derivative, 52/72
median, not shipped). Round-9A copies: `pixie-7b-r9a` in Ollama and
`training/pixie-7b-lora-r9a` on disk (42/72, not shipped).

## Environment facts

- **Ollama running** (`localhost:11434`): `pixie-7b` = `pixie-7b-r1` (shipped,
  verified), `qwen2.5-coder:7b` (distill teacher), `llama3.1:8b`, `qwen2.5-coder:1.5b-base`, `nomic-embed-text`.
- **Adapter dirs**: every round now trains to its own `OUTPUT_DIR`, so
  `training/pixie-7b-lora/` is NOT "the latest" — it currently holds the
  **round-8** adapter (sha-verified 2026-09-22); treat it as stale.
  Per-round copies: `pixie-7b-lora-r1redo` (r1 recipe retrained, loss 1.197),
  `pixie-7b-lora-r4`, `-r6`, `-r7`, `-r8`, `-r9b`, `-r9a` (latest). They are whitelisted in .gitignore
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
  (119 verified chains + 12 multi5), `dataset-real.jsonl` 3,
  `round8.jsonl` 47, `round9-synth15.jsonl` 15, `round9-32plus5.jsonl` 37.
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

**C. Round 8 — EXECUTED (2026-09-22), REFUTED.** `scripts/build-round8.ts`
generated 15 verified r1-style synth pairs (read → write_file(full content),
no `edit_file`) covering eval shapes #12/#13/#15/#16; trained from scratch
on r1's 32 + 15 = 47 pairs with r1's exact recipe (6ep / 2.5e-4 / 1536,
loss 0.812). Result: 46/45/47 → median 46/72, multi 2–3/9 in all runs —
the best derivative yet but far short of the success bar (multi ≥ 6/9),
and ~6 checks below r1. Shape coverage was NOT the missing ingredient.
Not shipped; `pixie-7b` tag restored to r1 (`5c4feb1fdbb3`) after scoring.
Full entry: `docs/baseline.json` (round 8). Round-9 options: (a) accept r1
as terminal for this 7B; (b) a ~150-pair same-style synth pool — expensive,
and r8's dilution sensitivity argues against it; (c) provenance archaeology
on the original r1 session's non-content state (chat template/tokenizer) —
weakened but not dead, since the r1redo retrain scored 52–54 from
reconstructed data only. If a future round ever clears multi ≥ 6/9,
codify the no-`edit_file` rule in `scripts/distill.ts` (rewrite distilled
traces to read→write form).

**D. Round 9 — arm B EXECUTED (2026-09-22), bar missed.** r8's scenarios
rebuilt to r1's audited conventions (`scripts/build-round9.ts`), 2 epochs @
LR 2.5e-5 continuing from `pixie-7b-lora-r1redo`, train_loss 0.595. Result:
53/52/44 → **median 52/72, core 7/7/6, multi 5/4/3 (median 4/9), hard 4/4/3** —
the first derivative round to reach r1's 52–54 band and the best single run
of ANY round (53), but short of the multi ≥ 6/9 bar, and run 3's 44 shows
variance r1 never has. Convention-matching + continuation is a real,
directional effect (46 → 52 vs r8) but does not reproduce r1. Full entry:
`docs/baseline.json` (round 9B). NOT shipped; `pixie-7b` restored to r1
(`5c4feb1fdbb3`) after scoring, probe 4/4. Snapshot kept: `pixie-7b-r9b`,
adapter `training/pixie-7b-lora-r9b`.

**E. Round 9 arm A — EXECUTED (2026-09-22), REFUTED; round 1 declared
TERMINAL.** From-scratch on `round9-32plus5.jsonl` (r1's 32 verbatim + the
5 exact eval-mirror rows #11/#12/#13/#15/#16) at r1's full recipe (6ep /
2.5e-4 / 1536, train_loss 0.8047, 18 steps / 62 min). Result: 43/42/42 →
**median 42/72, core 5/7/5, multi 1/2/2, hard 4/4/4** — second-worst
derivative round, BELOW plain r8 (46) and r9B (52). The 5 mirror rows did
not fix the modify shapes they mirror (#12 append, #13 JSON edit, #15
read-transform all still fail), and core lost #3 (rainbow 7 lines) and #6
(continents) in every run. Adding even 5 convention-perfect rows to r1's
own 32 erases the multi skill; dilution sensitivity is not monotone.
Per the pre-registered decision rule: **round 1 is terminal for this 7B —
stop adapter iterations on this base model.** Snapshot `pixie-7b-r9a` +
adapter `training/pixie-7b-lora-r9a` kept; `pixie-7b` tag restored to r1
(`5c4feb1fdbb3`) after scoring, probe 4/4. Full entry: `docs/baseline.json`
(round 9A).

**F. Where future gains could come from (NOT more 7B QLoRA rounds on this
data).** In rough order of expected value: (1) a larger base model (14B
class) run through the same distill→QLoRA→GGUF pipeline — the multi skill
may simply need capacity; (2) provenance archaeology on the ORIGINAL r1
session's non-content state (exact chat template/tokenizer artifacts), if
it ever becomes cheap; (3) scaffold improvements in `src/` so eval
performance depends less on tiny-model skills. Do not run further
same-recipe 7B rounds on variants of this dataset — nine rounds say the
multi skill is not recoverable that way.

Regardless of path: any new eval result goes into `docs/baseline.json` +
this file, and the `pixie-7b` tag must end the session pointing at the best
known model (`pixie-7b-r1`). The env is pinned:
`training/requirements-lock.txt` (committed).
