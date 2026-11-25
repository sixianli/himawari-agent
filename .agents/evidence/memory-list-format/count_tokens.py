import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from formats import FORMATS, load
from count_tokens_lib import prompt_tokens

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
json.dump(result, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "token-counts" + os.environ.get("TAG_SUFFIX", "") + ".json"), "w"), ensure_ascii=False, indent=2)
