import json, os, ssl, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from formats import FORMATS, load
URL = "https://opencode.ai/inference/go/v1/chat/completions"
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt"))
SESSION = f"memory-list-format-{int(time.time())}"

def prompt_tokens(text):
    body = json.dumps({"model": "deepseek-v4.1-flash", "messages": [{"role": "user", "content": text}], "max_tokens": 1}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer dummy", "Content-Type": "application/json", "x-opencode-session": SESSION, "User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, context=CTX, timeout=120) as r:
        data = json.load(r)
    return data["usage"]["prompt_tokens"], data["usage"].get("opencode", {}).get("list_cost", 0)

rows = load()
base, _ = prompt_tokens("x")
result = {"model": "deepseek-v4.1-flash (OpenCode Go)", "memories": len(rows), "baseline_prompt_tokens": base, "formats": {}}
content_only = "\n".join(t for _, _, t in rows)
c_tokens, _ = prompt_tokens(content_only)
result["content_only_tokens"] = c_tokens - base
for key, (label, fn) in FORMATS.items():
    text = fn(rows)
    n, cost = prompt_tokens(text)
    result["formats"][key] = {"label": label, "tokens": n - base, "per_memory": round((n - base) / len(rows), 2), "chars": len(text)}
    print(f"{n-base:6d} {((n-base)/len(rows)):6.2f}/条  {label}", flush=True)
print("只放内容（换行分隔，无编号无类别）:", result["content_only_tokens"], round(result["content_only_tokens"]/len(rows),2))
json.dump(result, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "token-counts.json"), "w"), ensure_ascii=False, indent=2)
