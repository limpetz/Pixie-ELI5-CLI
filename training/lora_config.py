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
EPOCHS = 3            # r1 exposure-equivalent on the 82-pair union (r1: 32x6 ≈ 82x~2.5; extra epoch for the chain traces)
BATCH_SIZE = 1         # per step; batch 2 thrashed system RAM with tool-turn sequences
GRAD_ACCUM = 16        # effective batch = BATCH_SIZE * GRAD_ACCUM (kept at 16)
LEARNING_RATE = 2.5e-4
MAX_SEQ_LEN = 1536     # round-1 recipe (round 2-4 used 1792 for longer chains)

# --- Hardware ---
LOAD_IN_4BIT = True    # QLoRA: fits a 6-8 GB GPU
SEED = 42
