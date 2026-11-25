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
