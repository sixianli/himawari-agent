"""从冻结 v4 的离线容器构建 r3；不修改冻结资源。"""
from pathlib import Path
from html.parser import HTMLParser
import html
import re

class Frame(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag == 'iframe':
            self.frame = dict(attrs)['srcdoc']

out = Path(__file__).resolve().parent
base = out.parent / '2026-09-15-v4'
parser = Frame()
parser.feed((base / 'index.html').read_text())
old = (base / 'source.html').read_text()
assert parser.frame.count(old) == 1
inner = parser.frame.replace(old, (out / 'source.html').read_text())
# Reuse the exact libraries preserved with the approved v1 instead of fetching CDNs.
v1 = out.parent / '2026-09-10-v1'
bundled = re.findall(r'<script[^>]*>(.*?)</script>', (v1 / 'index.html').read_text(), re.S)
def inline_library(match):
    url = match.group(1)
    candidates = [script for script in bundled if 'Inlined for offline preservation: ' + url in script]
    assert len(candidates) == 1, url
    return '<script>' + candidates[0] + '</script>'
inner = re.sub(r'<script[^>]*src="([^"]+)"[^>]*></script>', inline_library, inner)
(out / 'THIRD-PARTY-NOTICES.txt').write_bytes((v1 / 'THIRD-PARTY-NOTICES.txt').read_bytes())
inner = inner.replace('<html lang="en"', '<html lang="zh-CN"').replace('</head>', '<style>body{background:light-dark(#fcfcfb,#1e1e1e);color-scheme:dark}</style></head>')
inner = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos; data: blob:; style-src &apos;unsafe-inline&apos;; img-src data:; connect-src &apos;none&apos;; form-action &apos;none&apos;; base-uri &apos;none&apos;">', inner, count=1)
(out / 'index.html').write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Himawari 工作区与授权交互审核 r3</title><style>html,body{margin:0;height:100%;background:#1e1e1e}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="工作区与授权交互审核 r3" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="'+html.escape(inner, quote=True)+'"></iframe></body></html>\n')
