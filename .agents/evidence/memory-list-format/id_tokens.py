import json, os, random, sys, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MEMORIES", "memories-1000.tsv")
from formats import load, grouped
import count_tokens_lib as ct
rows = load()
random.seed(7)
uids = {i: "memory:" + str(uuid.UUID(int=random.getrandbits(128))) for i, _, _ in rows}
order = sorted(rows, key=lambda r: r[0])
seq = {r[0]: n + 1 for n, r in enumerate(order)}
variants = {
    "库里原样的长编号（memory:UUID）": lambda: "\n".join(c + "\n" + "\n".join(f"{uids[i]} {t}" for i, t in v) for c, v in grouped(rows).items()),
    "稳定短编号（数据库自增，3~4 位）": lambda: "\n".join(c + "\n" + "\n".join(f"{i} {t}" for i, t in v) for c, v in grouped(rows).items()),
    "本次清单内连续编号（1~1000）": lambda: "\n".join(c + "\n" + "\n".join(f"{seq[i]} {t}" for i, t in v) for c, v in grouped(rows).items()),
}
base = ct.prompt_tokens("x")[0]
out = {}
for k, fn in variants.items():
    n = ct.prompt_tokens(fn())[0] - base
    out[k] = {"tokens": n, "per_memory": round(n / len(rows), 2)}
    print(f"{n:6d} {n/len(rows):6.2f}/条  {k}", flush=True)
json.dump(out, open(os.path.join(HERE, "id-token-counts-1000.json"), "w"), ensure_ascii=False, indent=2)
