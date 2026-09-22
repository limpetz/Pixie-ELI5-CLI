# FROZEN BASELINE — pixie-7b-r1-final (2026-09-22)

Round 1 is declared **terminal for the 7B** (9-round campaign, `docs/baseline.json`).
This manifest makes it reproducible. The tag `pixie-7b-r1-final` points at the
commit holding everything below. Do not rewrite this file on this branch; new
results go in new files.

## What is frozen

| Artifact | Where | Hash (sha256, first 16) |
|---|---|---|
| Training data — the exact 32 pairs | `training/r1.jsonl` (committed with this freeze) | `b6234a272921db05` |
| Runtime tool schemas (rendered into training text) | `training/tool-schemas.json` | `8ace64ba7dcd57b4` |
| r1redo adapter (r1 recipe retrain, loss 1.197) | `training/pixie-7b-lora-r1redo/` (machine-local) | `372e0be0d5b6b2e8` |
| Raw eval rows (72-check suite, all 45 rows through r9A) | `training/freezes/pixie-7b-r1-final-eval-results.json` (committed) | this file is the copy of record |
| Env lock (unsloth 2026.9.7, transformers 5.5.0, trl 0.24.0) | `training/requirements-lock.txt` (already committed) | — |
| Canonical score record (12 entries, r1 → r9A) | `docs/baseline.json` (already committed) | — |
| Campaign narrative + closed investigation | `handoff.md` (already committed) | — |

## The shipped model (backup of record)

- Ollama tag: `pixie-7b-r1` = live `pixie-7b`, blob id `5c4feb1fdbb3` (4.7 GB, q4_K_M GGUF)
- Verified: `npx tsx scripts/probe.ts --model pixie-7b --rounds 4` → 4/4 tool rounds (re-verified 2026-09-22 after the r9A restore)
- Original r1 adapter/GGUF were lost (the GGUF-loss incident); the r1redo retrain
  from the committed `r1.jsonl` is the verified equivalent (52–54/72, matching the original).

## Scores at freeze time

- r1 / r1redo (identical recipe + data): median **52–54/72**, best run 56, core 6/7, multi 4–6/9, hard 4/8
- Base control (qwen2.5-coder:7b): median 31/72 → **r1 = +71% over base, 30/30 head-to-head wins**
- All 9 derivative rounds: 36–52/72, none cleared the ship bar (multi ≥ 6/9). Investigation closed.

## Exact recipe (reproduction)

`training/lora_config.py` as of this tag: BASE_MODEL `unsloth/Qwen2.5-Coder-7B-Instruct`,
DATASET_FILE `training/r1.jsonl`, from scratch (BASE_ADAPTER=None), 6 epochs,
LR 2.5e-4 cosine, batch 1 × grad-accum 16 (effective 16), max_seq 1536, seed 42,
QLoRA r16 / alpha 32 / dropout 0.05, 7 proj targets, 4-bit, bf16, paged_adamw_8bit.
Reference losses: original r1 ≈ 1.198, r1redo 1.197 (≈18 optimizer steps, ~62 min on RTX 4060 8 GB).

Reproduce:
```
# in training/, venv per requirements-lock.txt; set DATASET_FILE=r1.jsonl, OUTPUT_DIR=training/pixie-7b-lora-r1frozen
./.venv/Scripts/python.exe train.py
./.venv/Scripts/python.exe export-gguf.py   # → project-root pixie-7b-gguf_gguf/
ollama create pixie-7b-r1frozen -f pixie-7b-gguf_gguf/Modelfile
npm run eval                                 # expect ~52-54/72 median over 3 runs
```

## Environment at freeze

Windows, RTX 4060 8 GB (8188 MiB), 63.7 GB system RAM, `UNSLOTH_CE_LOSS_N_CHUNKS=8`
(WDDM VRAM-probe workaround, set in train.py). Ollama with snapshots:
`pixie-7b-r1` (shipped), `-r4`, `-r5`, `-r6`, `-r7`, `-r8`, `-r9b`, `-r9a` — all preserved.

## Phase 2 branches (cut from this tag)

- `pixie-14b` — same data, conventions, harness, philosophy on a 14B base. No synth data, no scaffold changes.
- `scaffold-v2` — move deterministic work out of the model. No training changes.

Baselines measured independently: 7B+r1 scaffold (this freeze) / 14B+r1 scaffold / 14B+scaffold-v2.
