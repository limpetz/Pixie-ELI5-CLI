# Pixie-7B fine-tune settings (QLoRA via Unsloth)
# Tweak, then run the commands in TRAINING.md.

BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_FILE = "training/round5.jsonl"   # 82 pairs: r1 recipe (32) + curated hard/multi (38) + verified multi5 traces (12)
OUTPUT_DIR = "training/pixie-7b-lora"

# --- LoRA adapter ---
LORA_R = 16            # rank: 8 = cheap/fast, 16 = good default, 32+ = heavier
LORA_ALPHA = 32        # usually 2x rank
LORA_DROPOUT = 0.05
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

# --- Training schedule ---
EPOCHS = 6            # round-6 hypothesis: r1's stack exactly (r2-r5 all ran 2-4 epochs)
BATCH_SIZE = 1         # per step; batch 2 thrashed system RAM with tool-turn sequences
GRAD_ACCUM = 16        # effective batch = BATCH_SIZE * GRAD_ACCUM (kept at 16)
LEARNING_RATE = 2.5e-4
MAX_SEQ_LEN = 1536     # r1's value; longest r5 pair renders to ~1050 tokens, nothing truncates

# --- Hardware ---
LOAD_IN_4BIT = True    # QLoRA: fits a 6-8 GB GPU
SEED = 42
