# Training Pixie-7B (Phase 3)

Turn your collected Pixie sessions into your own fine-tuned model.

## 0. What you need
- **GPU with 6-8 GB+ VRAM** for QLoRA on a 7B model (or a free Colab T4)
- Python 3.10 or 3.11
- Your dataset: `training/dataset.jsonl` (from `npm run build-dataset`)

## 1. Install (one-time)

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install "unsloth[cu121-torch230]" datasets trl transformers
```

## 2. (Optional but recommended) Distill extra traces from a teacher model

```bash
npm run distill -- --num 30 --teacher ollama://llama3.1:8b   # free, local
# or: npm run distill -- --num 30 --teacher openai://gpt-4o-mini  (needs OPENAI_API_KEY)
```

This appends grounded teacher traces to `training/distilled.jsonl`. To train on
sessions + distilled traces together, concatenate them first:

```bash
cat training/dataset.jsonl training/distilled.jsonl > training/all.jsonl
```

then set in `lora_config.py`:

```python
DATASET_FILE = "training/all.jsonl"
```

## 3. Sanity-check the dataset

```bash
python -c "import json; rows=[json.loads(l) for l in open('training/dataset.jsonl', encoding='utf-8')]; print(len(rows), 'pairs; example user msg:', rows[0]['messages'][1]['content'][:80])"
```

Aim for 50+ pairs minimum; several hundred is better.

## 4. Train

Save this as `training/train.py` (it reads your `lora_config.py`):

```python
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
print(f"\nSaved LoRA adapter to {OUTPUT_DIR}")
```

```bash
cd training && python train.py
```

On a consumer GPU this takes minutes for a few hundred short examples.

## 5. Test your Pixie-7B

```bash
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
```

## 6. Use it inside Pixie

After training, score it against the base model before shipping it into your CLI:

```bash
npm run eval -- --a ollama://pixie-7b --b ollama://qwen2.5-coder:7b
```

Export to GGUF and drop it into Ollama:

```python
m.save_pretrained_gguf("pixie-7b-gguf", t, quantization_method="q4_k_m")
```

Then create `Modelfile`:
```
FROM ./pixie-7b-gguf/*.gguf
```

```bash
ollama create pixie-7b -f Modelfile
```

Pick it in Pixie with `/model` → `pixie-7b`. That's the loop closed:
**you trained your own model on your own conversations.**
