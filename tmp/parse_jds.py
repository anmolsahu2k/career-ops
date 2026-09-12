import re
import os

files = [
    "/Users/anmolsahu2k/.gemini/antigravity/brain/d03dd32c-ecf6-4a7c-8c9d-62e20452ed42/.system_generated/steps/14/content.md",
    "/Users/anmolsahu2k/.gemini/antigravity/brain/d03dd32c-ecf6-4a7c-8c9d-62e20452ed42/.system_generated/steps/15/content.md",
    "/Users/anmolsahu2k/.gemini/antigravity/brain/d03dd32c-ecf6-4a7c-8c9d-62e20452ed42/.system_generated/steps/16/content.md",
    "/Users/anmolsahu2k/.gemini/antigravity/brain/d03dd32c-ecf6-4a7c-8c9d-62e20452ed42/.system_generated/steps/17/content.md",
    "/Users/anmolsahu2k/.gemini/antigravity/brain/d03dd32c-ecf6-4a7c-8c9d-62e20452ed42/.system_generated/steps/18/content.md",
]

for i, path in enumerate(files):
    if not os.path.exists(path):
        print(f"File not found: {path}")
        continue
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    match = re.search(r'<meta name="description" content="(.*?)"\s*/>', content, re.DOTALL | re.IGNORECASE)
    print(f"--- JD {i+1} ---")
    if match:
        print(match.group(1).strip()[:500] + "...")
        with open(f"jd_{i+1}.txt", "w", encoding="utf-8") as out:
            out.write(match.group(1).strip())
    else:
        print("Meta description not found, dumping start of body...")
        # try getting title or og:description
        match = re.search(r'<meta property="og:description" content="(.*?)"', content, re.IGNORECASE)
        if match:
             print("Found og:description")
             with open(f"jd_{i+1}.txt", "w", encoding="utf-8") as out:
                 out.write(match.group(1).strip())
        else:
             print("Could not extract JD text easily.")
