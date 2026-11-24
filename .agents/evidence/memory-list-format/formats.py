import csv, json, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
CAT_EN = {"身份":"identity","偏好":"preference","健康":"health","人物":"relationship","项目":"project","工作":"work","财务":"finance","日程":"routine","地点":"place","设备":"device","兴趣":"interest","待确认":"tentative"}

def load():
    rows = []
    with open(os.path.join(HERE, "memories.tsv"), encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            i, c, t = line.split("\t")
            rows.append((int(i), c, t))
    return rows

def grouped(rows):
    out = {}
    for i, c, t in rows:
        out.setdefault(c, []).append((i, t))
    return out

def f_json(rows):
    return "\n".join(json.dumps({"id": i, "cat": c, "text": t}, ensure_ascii=False) for i, c, t in rows)

def f_markdown(rows):
    return "\n".join("## " + c + "\n" + "\n".join(f"- #{i} {t}" for i, t in v) for c, v in grouped(rows).items())

def f_tsv(rows):
    return "\n".join(f"{i}\t{c}\t{t}" for i, c, t in rows)

def f_space(rows):
    return "\n".join(c + "\n" + "\n".join(f"{i} {t}" for i, t in v) for c, v in grouped(rows).items())

def f_flat_space(rows):
    return "\n".join(f"{i} {t}" for i, _, t in rows)

def f_tight_guarded(rows):
    return "\n".join(c + "\n" + "\n".join(f"{i} {t}" if t[:1].isdigit() else f"{i}{t}" for i, t in v) for c, v in grouped(rows).items())

def f_tight_raw(rows):
    return "\n".join(c + "\n" + "\n".join(f"{i}{t}" for i, t in v) for c, v in grouped(rows).items())

FORMATS = {
    "json": ("一条一行 JSON", f_json),
    "markdown": ("Markdown：## 类别 + “- #编号 内容”", f_markdown),
    "tsv": ("TSV：编号⇥类别⇥内容", f_tsv),
    "space": ("类别一行 + “编号 内容”", f_space),
    "flat_space": ("不分类别，“编号 内容”", f_flat_space),
    "tight_guarded": ("类别一行 + 编号紧贴内容（内容以数字开头才空格）", f_tight_guarded),
    "tight_raw": ("类别一行 + 编号紧贴内容（一律不空格）", f_tight_raw),
}
