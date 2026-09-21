# Pixie-7B fine-tune settings (QLoRA via Unsloth)
# Tweak, then run the commands in TRAINING.md.

BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_FILE = "training/r7.jsonl"        # round 7: 53 pairs = curated hard/multi (41) + multi5 (12)
BASE_ADAPTER = "training/pixie-7b-lora-r1redo"  # CONTINUE from the r1-retrain adapter (recovered copy)
OUTPUT_DIR = "training/pixie-7b-lora"

# --- LoRA adapter ---
LORA_R = 16            # rank: 8 = cheap/fast, 16 = good default, 32+ = heavier
LORA_ALPHA = 32        # usually 2x rank
LORA_DROPOUT = 0.05
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

# --- Training schedule ---
EPOCHS = 2            # round 7: gentle continuation — add chain competence, keep r1 behavior
BATCH_SIZE = 1         # per step; batch 2 thrashed system RAM with tool-turn sequences
GRAD_ACCUM = 16        # effective batch = BATCH_SIZE * GRAD_ACCUM (kept at 16)
LEARNING_RATE = 2.5e-5 # 10x below r1's 2.5e-4: nudge, don't overwrite
MAX_SEQ_LEN = 1536     # r1's value; longest r5 pair renders to ~1050 tokens, nothing truncates

# --- Hardware ---
LOAD_IN_4BIT = True    # QLoRA: fits a 6-8 GB GPU
SEED = 42
