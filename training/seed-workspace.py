# Seeds training/distill-workspace with files whose known flaws the
# edit-tasks.txt batch fixes, plus data files whose contents the round-3
# chain tasks must read (or run commands against) before they can write.
# Run once before a batch:
#   training/.venv/Scripts/python.exe training/seed-workspace.py
import os

WS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "distill-workspace")
os.makedirs(WS, exist_ok=True)

FILES = {
    # --- original flaw files (edit-tasks.txt / chain-tasks.txt edit targets) ---
    "settings.ini": "[appearance]\ntheme = light\nvolume = 3\n\n[locale]\nlanguage = en\n",
    "letter.txt": (
        "Dear Grandma,\n"
        "Thank you for teh wonderful book you sent me.\n"
        "I read it in teh garden last weekend.\n"
        "The part about the lighthouse was my favorite.\n"
        "We should talk soon about your visit in July.\n"
        "Best wishes, Alex\n"
    ),
    "recipe.md": (
        "# Banana Bread\n\n"
        "Serves 2 people.\n\n"
        "## Ingredients\n"
        "- 2 ripe bananas\n"
        "- 1 cup of flour\n"
        "- half a cup of suger\n"
        "- one egg\n\n"
        "## Steps\n"
        "1. Mash the bananas.\n"
        "2. Mix everything in a bowl.\n"
        "3. Bake for 30 minutes at 350 degrees.\n"
    ),
    # --- data files for the round-3 chain tasks ---
    "stock.txt": "apples\nbananas\ncherries\nmilk\nbread\n",
    "prices.txt": "olive oil 6.80\nbread 2.50\ncheese 4.20\napples 1.20\n",
    "scores.txt": "80\n90\n70\n",
    "shopping.txt": "flour 2.50\nmilk 1.20\neggs 3.00\n",
    "wishlist.txt": "robot dog\ntoy truck\npuzzle\nstorybook\n",
    # --- data files for the round-4 chain2 tasks ---
    "inventory.csv": "item,amount\napples,4\nbananas,6\n",
    # inv2.csv is a pristine COPY of inventory.csv so the csvprice two-edit
    # task edits an existing file (the teacher hallucinates a nonexistent
    # copy_file tool when asked to copy first — see distill-chain2e.log).
    "inv2.csv": "item,amount\napples,4\nbananas,6\n",
}

# Per-task copies of the flaw files so every two-edit task starts pristine —
# otherwise task N's fix removes the typo task N+1 is supposed to edit.
for letter_copy in ("letter-a.txt", "letter-b.txt"):
    FILES[letter_copy] = FILES["letter.txt"]
for recipe_copy in ("recipe-a.md", "recipe-b.md", "recipe-c.md", "recipe-d.md"):
    FILES[recipe_copy] = FILES["recipe.md"]
for settings_copy in ("settings-a.ini", "settings-b.ini"):
    FILES[settings_copy] = FILES["settings.ini"]
# Round-4 two-edit targets use their own pristine copies too.
FILES["letter-c.txt"] = FILES["letter.txt"]
FILES["settings-c.ini"] = FILES["settings.ini"]

# Derived outputs from earlier distill runs must never survive a reseed:
# a stale correct file would let a lazy teacher trace pass verification.
for derived in (
    "count.txt", "priciest.txt", "average.txt", "total.txt", "linecount.txt",
    "toycount.txt", "temp.txt", "calc2.txt", "quotient.txt", "power.txt",
    "files.txt", "today.txt", "linecount2.txt", "linecount3.txt", "pow2.txt", "tmp-calc.txt",
    "total-sh.txt", "inv.txt", "inv2.txt",
    # round-4 two-edit targets and multi-file shapes
    "letter-c.txt", "settings-c.ini", "recipe-c.md", "recipe-d.md",
    "contact.txt", "contact-b.txt", "about.html",
    # round-4 exact-count folder shapes (a stale full folder would break them)
    os.path.join("team", "dev.txt"), os.path.join("team", "design.txt"),
    os.path.join("team", "manager.txt"), os.path.join("team", "tester.txt"),
    os.path.join("shapes", "square.txt"), os.path.join("shapes", "circle.txt"),
    os.path.join("shapes", "triangle.txt"), os.path.join("shapes", "hexagon.txt"),
):
    path = os.path.join(WS, derived)
    if os.path.exists(path):
        os.remove(path)
        print("wiped stale", derived)

for name, content in FILES.items():
    with open(os.path.join(WS, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print("seeded", name)
