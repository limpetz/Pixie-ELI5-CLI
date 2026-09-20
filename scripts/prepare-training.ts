#!/usr/bin/env node
/**
 * Pixie Phase 3, step 2 — generate the QLoRA training kit.
 *
 * Produces the files you need to fine-tune Qwen2.5-Coder-7B-Instruct on your
 * own GPU with Unsloth (free Colab T4 also works):
 *   - lora_config.py      adapter/rank settings to tweak
 *   - dataset_template.json   expected dataset shape for the trainer
 *   - TRAINING.md         exact commands, Windows and Colab
 *
 * Usage:  npm run prepare-training
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "training");

const LORA_CONFIG = `# Pixie-7B fine-tune settings (QLoRA via Unsloth)
# Tweak, then run the commands in TRAINING.md.

BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_FILE = "training/dataset.jsonl"   # built by npm run build-dataset
OUTPUT_DIR = "training/pixie-7b-lora"

# --- LoRA adapter ---
LORA_R = 16            # rank: 8 = cheap/fast, 16 = good default, 32+ = heavier
LORA_ALPHA = 32        # usually 2x rank
LORA_DROPOUT = 0.05
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

# --- Training schedule ---
EPOCHS = 3             # 2-3 is plenty for a few hundred examples
BATCH_SIZE = 2         # per step; raise if you have VRAM headroom
GRAD_ACCUM = 8         # effective batch = BATCH_SIZE * GRAD_ACCUM
LEARNING_RATE = 2e-4
MAX_SEQ_LEN = 2048     # Pixie answers are short; no need for huge context

# --- Hardware ---
LOAD_IN_4BIT = True    # QLoRA: fits a 6-8 GB GPU
SEED = 42
`;

const DATASET_TEMPLATE = `[
  {
    "messages": [
      { "role": "system", "content": "You are Pixie, a friendly coding helper..." },
      { "role": "user", "content": "make a file with a poem about my cat" },
      { "role": "assistant", "content": "Done! ...\\n\\nWhat I did:\\n- Created poem.txt ...\\n\\nTry it yourself:\\n- Ask me to change the poem to a haiku!" }
    ]
  }
]
`;

const TRAINING_MD = `# Training Pixie-7B (Phase 3)

Turn your collected Pixie sessions into your own fine-tuned model.

## 0. What you need
- **GPU with 6-8 GB+ VRAM** for QLoRA on a 7B model (or a free Colab T4)
- Python 3.10 or 3.11
- Your dataset: \`training/dataset.jsonl\` (from \`npm run build-dataset\`)

## 1. Install (one-time)

\`\`\`bash
python -m venv .venv
# Windows:
.venv\\Scripts\\activate
# macOS/Linux:
source .venv/bin/activate

pip install "unsloth[cu121-torch230]" datasets trl transformers
\`\`\`

## 2. (Optional but recommended) Distill extra traces from a teacher model

\`\`\`bash
npm run distill -- --num 30 --teacher ollama://llama3.1:8b   # free, local
# or: npm run distill -- --num 30 --teacher openai://gpt-4o-mini  (needs OPENAI_API_KEY)
\`\`\`

This appends grounded teacher traces to \`training/distilled.jsonl\`. To train on
sessions + distilled traces together, concatenate them first:

\`\`\`bash
cat training/dataset.jsonl training/distilled.jsonl > training/all.jsonl
\`\`\`

then set in \`lora_config.py\`:

\`\`\`python
DATASET_FILE = "training/all.jsonl"
\`\`\`

## 3. Sanity-check the dataset

\`\`\`bash
python -c "import json; rows=[json.loads(l) for l in open('training/dataset.jsonl', encoding='utf-8')]; print(len(rows), 'pairs; example user msg:', rows[0]['messages'][1]['content'][:80])"
\`\`\`

Aim for 50+ pairs minimum; several hundred is better.

## 4. Train

Save this as \`training/train.py\` (it reads your \`lora_config.py\`):

\`\`\`python
import json
from lora_config import *
from unsloth import FastLanguageModel
from datasets import Dataset
from trl import SFTTrainer
from transformers import TrainingArguments

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL, max_seq_length=MAX_SEQ_LEN, load_in_4bit=LOAD_IN_4BIT,
)
model = FastLanguageModel.get_peft_model(
    model,
    r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=LORA_DROPOUT,
    target_modules=TARGET_MODULES,
    bias="none", use_gradient_checkpointing="unsloth", random_state=SEED,
)

rows = [json.loads(l) for l in open(DATASET_FILE, encoding="utf-8")]
def to_text(row):
    return tokenizer.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False)
dataset = Dataset.from_list([{"text": to_text(r)} for r in rows])

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=dataset,
    dataset_text_field="text", max_seq_length=MAX_SEQ_LEN,
    args=TrainingArguments(
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        num_train_epochs=EPOCHS,
        learning_rate=LEARNING_RATE,
        lr_scheduler_type="cosine", warmup_ratio=0.03,
        logging_steps=5, output_dir=OUTPUT_DIR, seed=SEED,
        bf16=False, fp16=True, optim="paged_adamw_8bit",
        save_strategy="no", report_to="none",
    ),
)
trainer.train()
model.save_pretrained(OUTPUT_DIR); tokenizer.save_pretrained(OUTPUT_DIR)
print(f"\\nSaved LoRA adapter to {OUTPUT_DIR}")
\`\`\`

\`\`\`bash
cd training && python train.py
\`\`\`

On a consumer GPU this takes minutes for a few hundred short examples.

## 5. Test your Pixie-7B

\`\`\`bash
# Quick chat test:
python -c "
from unsloth import FastLanguageModel
from lora_config import *
m, t = FastLanguageModel.from_pretrained(OUTPUT_DIR, MAX_SEQ_LEN, LOAD_IN_4BIT)
FastLanguageModel.for_inference(m)
msgs = [{'role':'user','content':'create a file with a haiku about the sea'}]
prompt = t.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
ids = m.generate(**t(prompt, return_tensors='pt').to(m.device), max_new_tokens=200)
print(t.decode(ids[0][ids['input_ids'].shape[1]:], skip_special_tokens=True))
"
\`\`\`

## 6. Use it inside Pixie

After training, score it against the base model before shipping it into your CLI:

\`\`\`bash
npm run eval -- --a ollama://pixie-7b --b ollama://qwen2.5-coder:7b
\`\`\`

Export to GGUF and drop it into Ollama:

\`\`\`python
m.save_pretrained_gguf("pixie-7b-gguf", t, quantization_method="q4_k_m")
\`\`\`

Then create \`Modelfile\`:
\`\`\`
FROM ./pixie-7b-gguf/*.gguf
\`\`\`

\`\`\`bash
ollama create pixie-7b -f Modelfile
\`\`\`

Pick it in Pixie with \`/model\` → \`pixie-7b\`. That's the loop closed:
**you trained your own model on your own conversations.**
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "lora_config.py"), LORA_CONFIG, "utf8");
writeFileSync(join(OUT, "dataset_template.json"), DATASET_TEMPLATE, "utf8");
writeFileSync(join(OUT, "TRAINING.md"), TRAINING_MD, "utf8");
console.log(`Training kit written to ${OUT}/`);
console.log("  - lora_config.py        (adapter + schedule settings)");
console.log("  - dataset_template.json (dataset shape reference)");
console.log("  - TRAINING.md           (step-by-step: Windows or Colab)");
console.log("\nNext: read training/TRAINING.md, then run the build-dataset script if you haven't.");
