# Pixie-7B QLoRA fine-tune — ready to run on an 8 GB GPU (RTX 4060).
# Reads lora_config.py for settings. Dataset: training/all.jsonl (65 pairs).
import json
import os

# Windows/WDDM quirk: torch's mem_get_info() can report near-zero *free* VRAM
# even when memory is actually available, which crashes unsloth's fused
# cross-entropy memory probe ("No or negligible GPU memory available").
# Forcing a fixed chunk count bypasses the probe entirely (unsloth_zoo uses
# n_chunks directly when provided). 8 chunks ≈ ~300 MB transient per chunk
# at our batch/seq sizes — safe on an 8 GB card.
os.environ.setdefault("UNSLOTH_CE_LOSS_N_CHUNKS", "8")

from lora_config import (
    BASE_MODEL, DATASET_FILE, OUTPUT_DIR, LORA_R, LORA_ALPHA, LORA_DROPOUT,
    TARGET_MODULES, EPOCHS, BATCH_SIZE, GRAD_ACCUM, LEARNING_RATE,
    MAX_SEQ_LEN, LOAD_IN_4BIT, SEED,
)

# Config paths are relative to the project root (pixie/) — resolve them so
# train.py can be run from any folder.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def rel(p: str) -> str:
    return p if os.path.isabs(p) else os.path.join(ROOT, p)

DATASET_FILE = rel(DATASET_FILE)
OUTPUT_DIR = rel(OUTPUT_DIR)
from unsloth import FastLanguageModel
from datasets import Dataset
from trl import SFTTrainer
from transformers import TrainingArguments

def main():
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LEN,
        load_in_4bit=LOAD_IN_4BIT,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        target_modules=TARGET_MODULES,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=SEED,
    )

    rows = [json.loads(l) for l in open(DATASET_FILE, encoding="utf-8") if l.strip()]
    print(f"Training on {len(rows)} pairs from {DATASET_FILE}")

    # Render the same <tools> block Pixie's runtime prompts contain, so the
    # training text matches what the model sees in production (Ollama injects
    # tool schemas into the system message when tools are passed).
    tools = None
    schemas_path = os.path.join(ROOT, "training", "tool-schemas.json")
    if os.path.exists(schemas_path):
        tools = json.load(open(schemas_path, encoding="utf-8"))
        print(f"Rendering runtime tool schemas ({len(tools)} tools) into training text")

    def to_text(row):
        return tokenizer.apply_chat_template(
            row["messages"], tokenize=False, add_generation_prompt=False, tools=tools
        )

    dataset = Dataset.from_list([{"text": to_text(r)} for r in rows])

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LEN,
        args=TrainingArguments(
            per_device_train_batch_size=BATCH_SIZE,
            gradient_accumulation_steps=GRAD_ACCUM,
            num_train_epochs=EPOCHS,
            learning_rate=LEARNING_RATE,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            logging_steps=5,
            output_dir=OUTPUT_DIR,
            seed=SEED,
            bf16=True,  # RTX 4060 (Ada) supports bfloat16
            optim="paged_adamw_8bit",
            save_strategy="no",
            report_to="none",
        ),
    )
    trainer.train()
    model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    print(f"\nDone! LoRA adapter saved to {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
