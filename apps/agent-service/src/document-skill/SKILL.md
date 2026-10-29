---
name: document-skill
description: 做 Word、Excel、PDF 文档或读 PDF 时使用：库和中日文字体已装好，给出命令、A4 模板和检查脚本。
---

# 做文档：Word、Excel、PDF

服务器已经装好下面这些库和字体，直接用。不要先探测有没有，不要 pip 或 apt 安装，也不要手写 docx、xlsx、PDF 的内部格式。本文件所在的目录记作 `技能目录`。

| 要做的事 | 用什么 |
| --- | --- |
| 写 Word（.docx） | 先写 Markdown，再用 pandoc 转；要精细控制时用 python-docx |
| 写或读 Excel（.xlsx） | openpyxl |
| 读 PDF 正文 | pypdf；表格多、排版复杂时用 pdfminer |
| 写 PDF | 写 HTML，再用 `技能目录/make_pdf.py` 转 |
| Markdown、HTML、Word 互转 | pandoc |

中日文字体已装好：Noto Sans CJK（SC、JP）、Noto Serif CJK，以及霞鹜文楷（字体名 `LXGW WenKai`，只有常规和粗体，用它时标题字重写 700）。

## 写 Word

一条命令完成：

```bash
pandoc 内容.md -o 文件名.docx --reference-doc=技能目录/reference.docx
```

`reference.docx` 已设好字体（中文 Microsoft YaHei、英文 Calibri）和标题层级。Markdown 里用 `#` 标题、列表和表格，pandoc 会转成 Word 自己的标题、列表和表格样式。需要页眉、批注、合并单元格这类 pandoc 做不到的事，再用 python-docx 打开刚生成的文件改。

## 写 PDF

1. 把内容写成 HTML，放在 `$TMPDIR`。只写结构，比如 `h1` 标题、`h2` 小节、`p` 段落、`ul` 列表和 `table` 表格，不要写字体、颜色或页面大小，这些由模板负责。
2. 运行：

```bash
python3 技能目录/make_pdf.py $TMPDIR/内容.html 文件名.pdf
```

它会套上 A4 模板 `技能目录/a4.css`（页边距、标题层级、表格、页眉、页码），把字体嵌进 PDF，然后检查结果，并打印一行 JSON。`problems` 为空就是合格；不为空就按提示改 HTML 再跑一次。

模板里的写法：

- 第一个 `h1` 是文档标题，第二页起它会出现在页眉。
- 标题下面加一行 `<div class="meta">日期 · 来源概述</div>`。
- 数字列加上 `class="num"`，会右对齐。
- 补充说明放进 `<div class="note">…</div>`。
- 来源写在 `<p class="source">…</p>`。
- 日文片段加上 `<span lang="ja">…</span>`，会改用日文字形。

## 写 Excel

```python
from openpyxl import Workbook
from openpyxl.styles import Font
book = Workbook()
sheet = book.active
sheet.append(["日期", "项目", "金额"])
for cell in sheet[1]:
    cell.font = Font(bold=True)
book.save("文件名.xlsx")
```

## 交付

成品文件写进工作目录，用户在回答下方就能看到文件卡片并预览。中间文件（HTML、Markdown 草稿）放进 `$TMPDIR`，不要留在工作目录。
