# Export the trained Pixie LoRA adapter to a Q4_K_M GGUF for Ollama.
# Run after train.py finishes:  ./.venv/Scripts/python.exe export-gguf.py
import os

# Same Windows/WDDM guard as train.py (harmless for inference, safe for import).
os.environ.setdefault("UNSLOTH_CE_LOSS_N_CHUNKS", "8")

from unsloth import FastLanguageModel
from lora_config import OUTPUT_DIR, MAX_SEQ_LEN, LOAD_IN_4BIT

# OUTPUT_DIR is relative to the project root (pixie/) — resolve so this runs from anywhere.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isabs(OUTPUT_DIR):
    OUTPUT_DIR = os.path.join(ROOT, OUTPUT_DIR)

OUT = "pixie-7b-gguf"

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=OUTPUT_DIR,       # the LoRA adapter dir saved by train.py
    max_seq_length=MAX_SEQ_LEN,
    load_in_4bit=LOAD_IN_4BIT,
)
FastLanguageModel.for_inference(model)

model.save_pretrained_gguf(OUT, tokenizer, quantization_method="q4_k_m")
print(f"Done! GGUF exported to {OUT}/")
