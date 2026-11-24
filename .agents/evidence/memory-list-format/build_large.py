import json, os, random
HERE = os.path.dirname(os.path.abspath(__file__))
rows = []
for line in open(os.path.join(HERE, "memories.tsv"), encoding="utf-8"):
    line = line.rstrip("\n")
    if line:
        i, c, t = line.split("\t")
        rows.append((int(i), c, t))
order = []
for _, c, _ in rows:
    if c not in order:
        order.append(c)
items = json.load(open(os.path.join(HERE, "distractors.json"), encoding="utf-8"))
excluded = set()
ex_path = os.path.join(HERE, "excluded-distractors.tsv")
if os.path.exists(ex_path):
    for line in open(ex_path, encoding="utf-8"):
        if line.strip():
            excluded.add(line.split("\t")[0])
items = [x for x in items if x[1] not in excluded]
target = int(os.environ.get("TARGET", "1000"))
random.seed(20261124)
random.shuffle(items)
items = items[: max(0, target - len(rows))]
used = {i for i, _, _ in rows}
pool = [n for n in range(208, 208 + len(items) * 3) if n not in used]
ids = sorted(random.sample(pool, len(items)))
random.shuffle(ids)
merged = rows + [(ids[k], c, t) for k, (c, t) in enumerate(items)]
merged.sort(key=lambda r: (order.index(r[1]), r[0]))
with open(os.path.join(HERE, f"memories-{len(merged)}.tsv"), "w", encoding="utf-8") as f:
    for i, c, t in merged:
        f.write(f"{i}\t{c}\t{t}\n")
print(len(merged))
