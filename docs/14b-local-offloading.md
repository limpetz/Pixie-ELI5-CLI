# Running 14B Quantized Models Locally (Partial CPU/GPU Offloading)

This guide documents how to run `qwen2.5-coder:14b` on an 8 GB VRAM GPU (such as an NVIDIA RTX 4060) by using partial GPU offloading in Ollama.

---

## 1. Why 14B Needs Offloading on 8 GB VRAM

- `qwen2.5-coder:7b` (Q4_K_M): ~4.7 GB -> **Fits 100% in VRAM**.
- `qwen2.5-coder:14b` (Q4_K_M): ~9.0 GB -> **Exceeds 8 GB VRAM**.
- `qwen2.5-coder:14b` (Q3_K_M / Q3_K_S): ~7.2 - 7.8 GB -> Tightly fits or spills over with context window.

When a model is slightly larger than VRAM, **Ollama automatically handles partial offloading**:
- **~25 to 35 layers** run directly on the RTX 4060 GPU (at full GPU speed).
- The remaining **13 to 23 layers** run in system RAM via CPU.
- Inference is slightly slower than pure GPU, but significantly smarter and fits easily within system limits.

---

## 2. Pulling the 14B Model in Ollama

To download the standard Q4_K_M 14B coder model:

```bash
ollama pull qwen2.5-coder:14b
```

*(Size: ~9.0 GB)*

Alternatively, for an even lighter footprint:
```bash
ollama pull qwen2.5-coder:14b-instruct-q3_K_M
```

---

## 3. Verifying GPU & CPU Layer Distribution

After pulling the model, start a quick prompt and check Ollama's logs or run `nvidia-smi`:

```bash
# In one terminal:
ollama run qwen2.5-coder:14b "hello"

# In another terminal:
nvidia-smi
```

You will see ~5.5 GB to 6.8 GB of VRAM utilized, leaving comfortable headroom for Windows display server and system processes.

---

## 4. Benchmarking 14B against Pixie's Eval Suite

Once pulled, you can benchmark how stock 14B performs against `pixie-7b` on the 24-task suite:

```bash
# Run pixie-7b vs 14b:
npx tsx scripts/eval.ts --a ollama://pixie-7b --b ollama://qwen2.5-coder:14b
```

This lets you measure whether 14B's increased parameter count resolves the remaining arithmetic and multi-step reasoning bottlenecks (such as Task #24 menu totals).
