---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "packages/runtime-pi/src/pi-runtime-adapter.ts, scripts/delivery-mode/deploy-preflight.py, scripts/delivery-mode/packet-template/signing/cloud-seal.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0118：生产机预装文档库和中日文字体，用“文档技能”告诉模型怎么做 Word、Excel、PDF

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-29（日本时间），Andy 在生产网页（第十八版）上让 Himawari 做文档，遇到两次问题：

- 写一份 Word 版新闻整理，一轮用了 50.4 秒。按这一轮的步骤时间线拆开（运行 `fee9ac00`，只读诊断脚本的结果存在项目共享目录 `result-20261029.txt`）：模型约 23 秒，工具约 23 秒，前后准备约 4 秒。其中约 30 秒、约 3,300 个输出 token 花在三轮多余的步骤上：先探测有没有 python-docx，发现没有，再手写一段 7.5 KB 的脚本拼 Word 的内部 XML，最后补字体。
- 让它做一份骑行 PDF，它在沙箱里“找不到任何字体”，只能手写 PDF 坐标，用的字体也没有嵌进文件，做出来很难看。

查生产机确认：Ubuntu 24.04 上 pandoc、LibreOffice、python-docx、openpyxl、python-pptx、pypdf、reportlab 都没有装。另外，模型的命令沙箱只允许读 `/usr/bin`、`/usr/lib` 等几个目录（出包脚本 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs` 的 `readOnlyToolchainPaths`），字体所在的 `/usr/share/fonts` 和字体配置 `/etc/fonts` 都读不到。所以就算装了字体，沙箱里的命令也看不见。

模型也不知道服务器上有什么。它只能先跑命令试探，每试一次就多一轮模型调用。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **在生产机上用 apt 预装文档工具**（Andy 2026-10-29 17:00 同意装库，17:25 在 Mac 线程确认“同意装文档库”，17:28 同意加装霞鹜文楷）。只用 Ubuntu 官方源：`python3-docx`、`python3-openpyxl`、`python3-pypdf`、`python3-pdfminer`、`weasyprint`（把 HTML 排成 PDF 的库）、`fonts-noto-cjk`（Noto 中日文字体）、`pandoc`（文档格式转换工具）、`python3-markdown`、`libharfbuzz-subset0`（字体裁剪库）、`fonts-lxgw-wenkai`（霞鹜文楷）。生产机上模拟安装：前 8 个包连依赖共 51 个，下载 125.4 MB，装完占 467.1 MB。python-pptx 不在 Ubuntu 官方源里，这次先不装。
2. **沙箱放开三个只读目录**：`/usr/share`、`/etc/fonts`、`/var/cache/fontconfig`，让命令能读到字体、字体配置和字体缓存。只能读，不能写。这三个目录必须在主机上存在，因为出包时会取它们的真实路径。改动在 `cloud-seal.mjs`，随下一次出包生效。
3. **用“文档技能”告诉模型怎么做**，格式和 Anthropic Agent Skills、OpenAI Skills 相同：
   - 系统提示里只加一行，写明做 Word、Excel、PDF 时先读哪个 `SKILL.md`。这一行每轮都一样，不随问题增减，所以不影响缓存命中。
   - 完整做法放在 `apps/agent-service/src/document-skill/`，随程序一起打包。目录里有 `SKILL.md`（第一句写明“库和字体都已装好，不要探测或安装，也不要手写文件格式”）、A4 模板 `a4.css`、Word 样式 `reference.docx`，以及 `make_pdf.py`。`make_pdf.py` 把 HTML 排成 PDF，再检查字体是否已嵌入、文字能否提取、中日文是否用了中日文字体，结果打印成一行 JSON。
4. **上线前自动检查**：`scripts/delivery-mode/deploy-preflight.py` 新增 `DOCUMENT_TOOLS_INSTALLED`。生产机缺少任何一个库、pandoc、Noto 中日文字体或霞鹜文楷，`deploy.sh` 就拒绝上线，并打印安装命令。这是事故 [I-26](../incidents-and-gates.md#incidents) 的门槛。
5. **PDF 用固定版本的 WeasyPrint 70**（Andy 2026-10-29 17:58 在选择卡上选定）。Ubuntu 自带的 WeasyPrint 61.1 只能用 fontTools 裁剪字体，Noto 中日文字体一个就有约 6.5 万个字形，每份 PDF 要 20 到 22 秒；WeasyPrint 70 配 HarfBuzz 裁剪（`libharfbuzz-subset0`）后，生产机实测（2026-10-29 09:08Z 装好后）同一进程里只算渲染 0.36 秒；但每次新起进程的整条命令是 2.41、2.52、2.48 秒，其中约 2.1 秒是启动 Python、导入 WeasyPrint 和加载字体。模型每做一次 PDF 都是新起进程，所以用户实际多等约 2.5 秒（比 61.1 的 20 多秒快约 8 倍）。要不要做常驻渲染进程省掉这 2 秒，记为 [BL-20261029-004](../backlog/BL-20261029-004-pdf-render-warm-process.md)，先不做。Ubuntu 官方源里没有 70 版，所以从 PyPI 下载，装进单独的 Python 环境 `/usr/lib/himawari-document-python`（用 apt 的 `python3-venv` 建；放在 `/usr/lib` 下，沙箱能读；不碰系统 Python）。版本和每个文件的 SHA-256 都固定，安装时 pip 用 `--require-hashes --only-binary=:all:` 校验，共 14 个包、约 18 MB：weasyprint 70.0、pypdf 6.21.4、fonttools 4.68.0、pydyf 0.13.0、cffi 2.1.1、pillow 13.0.0 等。`make_pdf.py` 用这个环境的 Python 运行；Word、Excel 等其余库仍由系统 Python 和 apt 提供。上线前检查同时确认这个环境里是 70 版、并且找得到 HarfBuzz 裁剪库。

[返回目录](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：apt 预装库和字体，加一个文档技能（选用）

好处是模型不用再探测，也不用手写格式，一次命令就能做出来；只用官方源，以后跟着系统安全更新走。代价是生产机多占约 0.5 GB，而且库只装在生产机上，换机器时要重新装。上线检查保证了不会漏装。

### 方案 B：每次运行时在沙箱里临时安装

沙箱没有外网，命令用的是主机上的系统工具（[ADR 0055](0055-bash-uses-system-commands-in-sandbox.md)），装不了；即使能联网，每轮也要多等下载时间。不选。

### 方案 C：只在系统提示里写一段长说明

能省掉探测，但每轮都要多带几百个 token，大部分对话根本不做文档。大厂的做法是提示里只放一行索引，用到时再读全文，所以不选。

### 方案 E：直接用 Pi 自带的技能加载

Pi（Himawari 底层的 Agent 框架，版本 0.84.2）已经支持 Agent Skills：`loadSkillsFromDir` 读技能目录，`formatSkillsForPrompt` 把名称、用途和路径以 `<available_skills>` 的格式接在系统提示后面；Himawari 的 `packages/runtime-pi/src/pi-runtime-adapter.ts` 也已经留了 `skillPaths` 这个入口，只是生产组装没有接。没有直接用它，原因是 Pi 生成的那段说明写的是“Use the read tool to load a skill's file”，而 Himawari 的 read 工具只能读主人授权的工作目录，技能目录在程序安装目录里，用 read 去读会被拒绝（`CODING_PATH_OUTSIDE_SCOPE`）。要让 read 能读技能目录，就得改授权范围，这超出了这次的改动。所以这次在 Himawari 自己的能力说明里加一行，写明用 bash 的 `cat` 读；`SKILL.md` 按 Agent Skills 标准写了 `name` 和 `description`，以后 read 工具能读安装目录里的技能时，改成经 `skillPaths` 交给 Pi 就行，不用改技能文件。

### 方案 D：装 LibreOffice，统一用它转换

LibreOffice 能转的格式最多，但装完约 1 GB 以上，启动一次要几秒，排版也不如 HTML 加 CSS 好控制。等以后需要“把生成的文件转成图片让模型自己看一遍”时再考虑。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 下一次出包（第十九版）之前，必须先在生产机上执行安装脚本，否则出包时取真实路径会失败，上线检查也会拒绝。
- 模型做文档的轮数应该会减少，PDF 会嵌入字体、能正常显示中日文。上线后在真实网页上重跑 Word 新闻和骑行 PDF 两个任务，用同一个诊断脚本对比时间。
- WeasyPrint 的已知问题（GitHub issue #1593）：用 CFF 格式的 CID 字体（Noto 中日文字体就是这种）时，Mac 的“预览”可能显示空白。要在 Mac 或 iPhone 上打开生成的 PDF 确认。
- 沙箱多了三个只读目录。里面只有字体、文档和配置这类公开文件，不含密钥。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- 事故：[I-26](../incidents-and-gates.md#incidents)
- 案例：[案例 61：做一份 Word 要 50 秒、PDF 找不到字体](../engineering-casebook.md#case-document-tools)
- 一手资料：
  - [Anthropic 工程博客：Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)：“pre-loads the name and description of every installed skill into its system prompt”
  - [Anthropic docx 技能](https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md)：“docx is preinstalled — do not run npm install first”
  - [OpenAI Skills](https://developers.openai.com/api/docs/guides/tools-skills)：“adds each available skill's name, description, and path to user prompt context”
  - [Manus 上下文工程](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)：“avoid dynamically adding or removing tools mid-iteration”

[返回目录](#contents)
