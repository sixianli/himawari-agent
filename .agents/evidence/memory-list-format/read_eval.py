import json, os, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from formats import FORMATS, load
URL = "https://opencode.ai/inference/go/v1/chat/completions"
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt"))
SYSTEM = "你是主人的私人助理。下面是你记着的关于主人的全部记忆，每条有编号。回答问题时，只输出一行 JSON：{\"ids\": [能直接回答这个问题的记忆编号]}；没有能回答的记忆就输出 {\"ids\": []}。不要输出别的内容。"
REPEATS = int(os.environ.get("REPEATS", "2"))

def call(fmt_key, text, q, rep):
    body = json.dumps({"model": "deepseek-v4.1-flash", "temperature": 0, "max_tokens": 2000,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "记忆：\n" + text + "\n\n问题：" + q}]}).encode()
    session = f"memfmt-{fmt_key}-{rep}"
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer dummy", "Content-Type": "application/json", "x-opencode-session": session, "User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, context=CTX, timeout=180) as r:
                data = json.load(r)
            content = data["choices"][0]["message"].get("content") or ""
            usage = data.get("usage", {})
            return content, usage
        except Exception as e:
            err = e
            time.sleep(2 ** attempt)
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
questions = json.load(open(os.path.join(HERE, "questions.json"), encoding="utf-8"))
only = os.environ.get("FORMATS")
keys = [k for k in FORMATS if not only or k in only.split(",")]
jobs = [(k, q, r) for k in keys for r in range(REPEATS) for q in questions]
texts = {k: FORMATS[k][1](rows) for k in keys}
def run(job):
    k, q, r = job
    content, usage = call(k, texts[k], q["q"], r)
    got = parse(content)
    return {"format": k, "rep": r, "q": q["q"], "expected": sorted(q["ids"]), "got": got, "raw": content, "usage": usage}
with ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "8"))) as ex:
    results = list(ex.map(run, jobs))
json.dump(results, open(os.path.join(HERE, "read-eval-raw.json"), "w"), ensure_ascii=False, indent=1)
summary = {}
for k in keys:
    rs = [x for x in results if x["format"] == k]
    exact = sum(1 for x in rs if x["got"] == x["expected"])
    bad = sum(1 for x in rs if x["got"] is None)
    tp = sum(len(set(x["got"] or []) & set(x["expected"])) for x in rs)
    fp = sum(len(set(x["got"] or []) - set(x["expected"])) for x in rs)
    fn = sum(len(set(x["expected"]) - set(x["got"] or [])) for x in rs)
    cost = sum((x["usage"].get("opencode", {}) or {}).get("list_cost", 0) or 0 for x in rs)
    summary[k] = {"label": FORMATS[k][0], "runs": len(rs), "exact": exact, "exact_rate": round(exact / len(rs), 3), "unparsed": bad, "wrong_ids": fp, "missed_ids": fn, "found_ids": tp, "list_cost_usd": round(cost, 4)}
    print(f"{k:14s} 全对 {exact}/{len(rs)}  多选 {fp}  漏选 {fn}  解析失败 {bad}  标价 ${cost:.4f}", flush=True)
json.dump(summary, open(os.path.join(HERE, "read-eval-summary.json"), "w"), ensure_ascii=False, indent=2)
