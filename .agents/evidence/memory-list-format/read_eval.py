import json, os, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from formats import FORMATS, load
URL = "https://opencode.ai/inference/go/v1/chat/completions"
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt"))
SYSTEM = "你是主人的私人助理。下面是你记着的关于主人的全部记忆，每条有编号。回答问题时，只输出一行 JSON：{\"ids\": [能直接回答这个问题的记忆编号]}；没有能回答的记忆就输出 {\"ids\": []}。不要输出别的内容。"
TAG = ("thinking" if os.environ.get("THINKING") == "1" else "nothinking") + os.environ.get("TAG_SUFFIX", "")
REPEATS = int(os.environ.get("REPEATS", "2"))

def call(fmt_key, text, q, rep):
    extra = {} if os.environ.get("THINKING") == "1" else {"thinking": {"type": "disabled"}}
    body = json.dumps({"model": "deepseek-v4.1-flash", "temperature": 0, "max_tokens": 8000, **extra,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "记忆：\n" + text + "\n\n问题：" + q}]}).encode()
    session = f"memfmt-{fmt_key}-{rep}"
    for attempt in range(8):
        try:
            req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer dummy", "Content-Type": "application/json", "x-opencode-session": session, "User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, context=CTX, timeout=180) as r:
                data = json.load(r)
            content = data["choices"][0]["message"].get("content") or ""
            usage = data.get("usage", {})
            return content, usage
        except Exception as e:
            err = e
            time.sleep(15 * (attempt + 1))
    return f"ERROR {err}", {}

def parse(content):
    s = content.strip()
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b < 0:
        return None
    try:
        v = json.loads(s[a:b + 1])
        return sorted(int(x) for x in v.get("ids", []))
    except Exception:
        return None

rows = load()
questions = json.load(open(os.path.join(HERE, "questions.json"), encoding="utf-8"))[:int(os.environ.get("LIMIT", "1000"))]
only = os.environ.get("FORMATS")
keys = [k for k in FORMATS if not only or k in only.split(",")]
jobs = [(k, q, r) for k in keys for r in range(REPEATS) for q in questions]
texts = {k: FORMATS[k][1](rows) for k in keys}
MEM = os.environ.get("MEMORIES", "memories.tsv")
import threading
raw_path = os.path.join(HERE, f"read-eval-raw-{TAG}.json")
progress_path = os.path.join(HERE, f"read-eval-progress-{TAG}.jsonl")
lock = threading.Lock()
def run(job):
    k, q, r = job
    content, usage = call(k, texts[k], q["q"], r)
    got = parse(content)
    res = {"format": k, "rep": r, "q": q["q"], "expected": sorted(q["ids"]), "optional": q.get("optional", []), "got": got, "raw": content, "usage": usage}
    with lock:
        with open(progress_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(res, ensure_ascii=False) + "\n")
    return res
prior = []
if os.environ.get("FILL") == "1" and os.path.exists(raw_path):
    prior += json.load(open(raw_path, encoding="utf-8"))
if os.path.exists(progress_path):
    prior += [json.loads(l) for l in open(progress_path, encoding="utf-8") if l.strip()]
qmap = {q["q"]: q for q in questions}
keep = {}
for x in prior:
    if x["got"] is not None and x["format"] in keys and x["q"] in qmap:
        keep[(x["format"], x["q"], x["rep"])] = dict(x, optional=qmap[x["q"]].get("optional", []))
todo = [j for j in jobs if (j[0], j[1]["q"], j[2]) not in keep]
print("todo", len(todo), "kept", len(keep), flush=True)
with ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "4"))) as ex:
    fresh = list(ex.map(run, todo))
results = [keep[(j[0], j[1]["q"], j[2])] if (j[0], j[1]["q"], j[2]) in keep else None for j in jobs]
fresh_iter = iter(fresh)
results = [x if x is not None else next(fresh_iter) for x in results]
json.dump(results, open(raw_path, "w"), ensure_ascii=False, indent=1)
def ok(x):
    g = x["got"]
    return g is not None and set(x["expected"]) <= set(g) <= set(x["expected"]) | set(x.get("optional", []))
summary = {}
for k in keys:
    rs = [x for x in results if x["format"] == k]
    exact = sum(1 for x in rs if ok(x))
    bad = sum(1 for x in rs if x["got"] is None)
    tp = sum(len(set(x["got"] or []) & set(x["expected"])) for x in rs)
    fp = sum(len(set(x["got"] or []) - set(x["expected"]) - set(x.get("optional", []))) for x in rs)
    fn = sum(len(set(x["expected"]) - set(x["got"] or [])) for x in rs)
    cost = sum((x["usage"].get("opencode", {}) or {}).get("list_cost", 0) or 0 for x in rs)
    summary[k] = {"label": FORMATS[k][0], "runs": len(rs), "exact": exact, "exact_rate": round(exact / len(rs), 3), "unparsed": bad, "wrong_ids": fp, "missed_ids": fn, "found_ids": tp, "list_cost_usd": round(cost, 4)}
    print(f"{k:14s} 全对 {exact}/{len(rs)}  多选 {fp}  漏选 {fn}  解析失败 {bad}  标价 ${cost:.4f}", flush=True)
json.dump(summary, open(os.path.join(HERE, f"read-eval-summary-{TAG}.json"), "w"), ensure_ascii=False, indent=2)
