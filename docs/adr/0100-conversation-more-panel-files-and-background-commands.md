---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-28"
---

# ADR 0100：对话“更多”栏：产物和后台命令放在同一个栏里

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [七个细节的选择](#details)
- [和“不新增通用详情侧栏”规定的关系](#baseline-rule)
- [比较过的方案](#options)
- [业界做法](#industry)
- [Pi 复用与 Himawari 负责的部分](#pi-reuse)
- [后果](#consequences)
- [关联文档](#references)
- [后续](#follow-up)

<a id="context"></a>

## 背景

Himawari 网页（Andy 日常聊天用的网页，代码在 `apps/control-center`）有两类东西不属于对话正文，却需要一个地方放：

- **产物**：这段对话里 Himawari 做出或改过的文件。2026-10-27 贪吃蛇那次，模型把 `snake.html` 写进了工作目录，却只在回答里写了服务器路径 `/var/lib/himawari/workspace/snake.html`，Andy 拿不到也找不到这个文件（复盘页：<https://claude.ai/artifact/3rQVWJt5pGVM1e9WhaE5ou>）。回答下方的文件卡片（[ADR 0091](0091-chat-ui-v6-file-preview-and-sidebar.md)）只认 `write`、`edit` 两个工具写出的文本文件，命令生成的文件、图片、PDF、网页都看不到。
- **后台命令**：PR #63（ADR 0098，尚未合并）让超过 30 秒的命令转到后台继续跑，跑完由系统另起一轮汇报。网页原计划在回答下方显示“后台命令运行中 · 已运行 2m 14s · 停止”。

Andy 2026-10-28 的原话：

> 我在想，后台命令是不是要个线程产物一样，放到线程的“更多栏”中，更多栏里面有产物栏和后台命令栏，不直接在线程用户界面展示抢用户注意力

> 更多面板你要协调“后台命令”和“线程产物”一起出一个完美的综合设计，而不是分别设计的中间状态

> 更多面板的设计正如你复述的那样，但我不太懂什么样的设计是最佳的，你结合现在各大 ai 大厂的 ai agent 产品的最佳时间，吸收他们各家的有点，给我出一个最佳设计出来，要兼顾手机端和电脑端

Claude 调研各家产品后出了设计说明（<https://claude.ai/artifact/VVkVvPptUS66XvXQ4HdQGJ>）和可点原型（<https://claude.ai/artifact/43oYhEYVyph65tbSdYy7ej>，定稿副本在 `docs/assets/control-center/2026-10-28-v8/`，原型里的对话、文件、数字都是演示数据）。2026-10-28 11:44（日本时间）Andy 批准：

> 原型和方案都审核了，全部按照你的设计和推荐来做！

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **一个按钮、一个栏、两页。** 每段对话的标题栏右端放一个“更多”按钮，点开是同一个栏，里面两页：“产物”和“后台命令”。不给两类东西各开一个入口。
2. **两页共用“第几轮”这条线，互相跳转。** 产物按轮次分组、新的在上；每个文件写明是哪一轮、哪个工具或哪条命令做的，能跳回对话里那一轮。每条后台命令的详情列出它改了哪些文件（来自 [ADR 0097](0097-bash-writes-workspace-with-change-ledger.md) 的改动记录），可以直接打开；“看汇报”跳到系统汇报的那一轮。
3. **主界面只留三处最轻的提示。**
   - “更多”按钮右上角一个小数字：正在跑的后台命令个数，跑完就消失。文件个数不显示，也没有“未读”红点。
   - 命令转后台的那一轮，回答下面一行灰字，例如“npm test 在后台运行 · 已运行 2 分 14 秒”，前面一个小转圈；跑完改成“已跑完，汇报在下面”。点它打开命令详情。原来放在这一行的“停止”按钮移进栏里。
   - 系统汇报那一轮上方一条灰色分隔线，中间写结果，例如“后台命令 npm test 已完成 · 用时 8 分 12 秒 · 15:49”。
4. **电脑上是右侧栏，手机上是底部抽屉。**
   - 电脑：栏在右侧，宽 400 像素，把对话往左挤，不盖住对话。它就是 ADR 0091 的右侧文件预览那一栏：列表是第一层，点一个文件进入预览（第二层），左上角返回列表；预览可以“放宽”到 680 像素。不出现第三栏。
   - 手机：从底部拉起的抽屉，先开到约半屏，点顶部小横条展开到全屏，点空白处收起。命令详情在抽屉里展开；文件预览一律铺满全屏，和 ADR 0091 在手机上的做法一致。
5. **打开时自动选页。** 有后台命令在跑就打开“后台命令”页，否则打开上次看的那一页。
6. **产物页。** 每行：类型小标、文件名、“网页 · 12 KB · 第 2 版 · 第 1 轮写入 · 15:12”；改过的文件显示“+38 −12”。有命令在跑时，页顶一行“1 个命令在后台运行”，点了切到后台命令页。
7. **后台命令页。** 分“运行中”和“已结束”两组。运行中：命令、已运行时长（每秒走）、“最晚 16:11 自动停止”、哪一轮启动、“停止”按钮。已结束：已完成、你停止了、被重启打断，写用时和改了几个文件，右边“看汇报”。命令详情：状态、开始、已运行或用时、最晚停止、启动于哪一轮、改动的文件、输出最后几行和“下载全部输出”。
8. **文件预览。** 沿用 ADR 0091 的按类型显示，再补齐：图片和 PDF 直接看；网页文件在单独的子域名里隔离运行（见第 10 条）；有多个版本时可以切换；最下一行“来自「对话名」第 N 轮 →”跳回对话；有“下载”，网页文件多一个“新标签打开”。
9. **侧栏“文件”页。** 侧栏“记忆”下面加“文件”，跨所有对话找 Himawari 做出的文件：搜索文件名、按类型筛选（全部、文档、表格、网页、图片、代码）、按今天、昨天、更早分组，每行写“来自「东京三日行程」第 4 轮”。后台命令不做跨对话页：哪段对话有命令在跑，侧栏已有的灰色转圈（v5 基线）已经说明。
10. **背后的数据和安全。**
    - 产物登记表：每个文件一条记录（所属对话、轮次、来源工具或命令、路径、类型、大小、SHA-256 内容指纹、版本号、时间），同一路径再写一次就是新一版，并存一份副本，旧版不会被工作目录里的新文件覆盖。命令产生的文件取自 ADR 0097 的改动记录。
    - 读文件和下载接口在 Cloudflare Access（Cloudflare 的登录拦截）之后由 Himawari 再验一次登录会话，只按登记表里的编号放行，不接受任意服务器路径。
    - 模型写的网页文件一律在单独的子域名里运行，由主站的内嵌框加载；那个域名拿不到主站的登录信息，只认短时有效、只对这一个文件有效的签名链接。具体域名和 Cloudflare 配置在实现计划里写，上线前请 Andy 批准。
    - 系统提示加一句：做出文件后只写文件名，不写服务器路径；卡片由登记表自动生成，不靠模型写。
11. **三种语言。** 所有新文字都有中文、英文、日文三份。“产物”在英文里叫“Files”，日文叫“成果物”；“后台命令”分别叫“Background”“バックグラウンド”。文件内容本身不翻译。

[↑ 返回阅读导航](#contents)

<a id="details"></a>

## 七个细节的选择

设计说明里请 Andy 拍板的七件事，Andy 全部选了推荐项：

| 问题 | 选择 | 没选的 |
| --- | --- | --- |
| 栏里第一页叫什么 | “产物”（Andy 自己的说法） | “文件”：会和侧栏“文件”页重名 |
| 对话里还没有文件和后台命令时，“更多”按钮显示吗 | 不显示，第一个文件或后台命令出现时才出现；只有一类时只显示那一页，不显示空页 | 一直显示：位置稳定，但空着时是摆设 |
| 按钮上的小数字什么颜色 | 深橙底白字（`#b4560c`），尺寸 15 像素 | 灰底 |
| 侧栏“文件”页放不放上传的附件 | 第一版只放 Himawari 做的 | 两种都放（ChatGPT Library 的做法），以后加一个筛选即可 |
| 后台命令最长跑多久 | 30 分钟 | 更长；Claude Code 无人值守时默认也是 30 分钟、上限 2 小时 |
| 点“停止”要不要确认 | 不确认，按钮变“正在停止…”，Himawari 在汇报里说明跑到哪了 | 弹确认框：多一次点击 |
| 运行中看不看实时输出 | 这次不做，只在结束后显示最后几行；实时输出留在 BL-20261027-011 | 照 Codex 显示最近 3 行：后端现在做不到 |

[↑ 返回阅读导航](#contents)

<a id="baseline-rule"></a>

## 和“不新增通用详情侧栏”规定的关系

[AGENTS.md](../../AGENTS.md) 和 [v5 增补](../execution/specs/2026-09-15-control-center-v4-design.md)规定不得新增“通用详情侧栏”（一个常驻、什么都往里放的右栏，例如把模型、token、每一步、审批都堆在那里）。这个栏不属于这一类，Andy 在批准时一并确认了这一判断：

- 只放两样东西：文件和后台命令。模型、token、过程步骤、审批、记忆仍在对话里原来的位置。
- 默认关着，点了才开；没有内容时连按钮都不出现。
- 电脑上它就是 ADR 0091 已批准的右侧文件预览那一栏，只多了“列表”这一层。

侧栏“文件”页是新页面，和“记忆”入口并列，是 Andy 批准的设计的一部分。

**2026-10-28 把这条规矩改窄。** Andy 在设计说明的评论里问能不能去掉这条规矩，Claude 建议不删、改窄，Andy 13:30（日本时间）回复：“按照你的建议来”。改窄后的规矩是：

- 不得新增堆放内部运行信息的通用栏或页面，也就是把模型、token、每一步、审批、内部记录等都堆在一起的“详情栏”或“详情页”。
- 有具体用途的新栏、新页面（例如这里的“更多”栏和“文件”页）可以做，但要先出原型、经 Andy 批准，并作为新版本记进设计基线。

AGENTS.md 和 [v5 增补第 5 条](../execution/specs/2026-09-15-control-center-v4-design.md#v5-execution-environment)同时改成这个说法。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| A：后台命令留在回答下方（PR #63 原计划），文件卡片照旧 | 不用新栏 | 命令状态和停止按钮常驻在对话里，抢注意力；Andy 明确不要 | 不采用 |
| B：产物和后台命令各开一个入口、各设计一次 | 各自简单 | 两个按钮、两种栏；Andy 明确要求不要“分别设计的中间状态” | 不采用 |
| C：一个“更多”栏两页，共用轮次互相跳转；电脑右侧栏、手机底部抽屉 | 一个入口；和 ADR 0091 预览同一栏；手机和电脑各用顺手的形式 | 要新做产物登记表、读文件接口和隔离预览 | 采用 |
| D：一个常驻右栏放所有运行信息 | 信息全 | 违反“不新增通用详情侧栏”；抢注意力 | 不采用 |

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

以下页面都在 2026-10-28 打开过，标“搜索摘要”的只看到搜索引擎里的官方摘要。

- Claude Code 桌面版的后台任务栏“shows the background work running inside the current session: subagents, background shell commands, and dynamic workflows”，这类栏“are listed once the session has something to show in those panes”。[Claude Code 桌面版文档](https://code.claude.com/docs/en/desktop)
- Claude Code 命令行用输入框下的小标提示产物：“a ⧉ pill below the prompt shows the artifact’s name, or a count when the session has several”。[Claude Code Artifacts 文档](https://code.claude.com/docs/en/artifacts)
- Claude Code 的后台命令在无人值守的会话里默认 30 分钟、最多 2 小时；前台命令到时没跑完会自动转后台。[Claude Code 工具参考](https://code.claude.com/docs/en/tools-reference)
- Claude 网页和 App：“Everything you make is saved to the Artifacts tab in your Claude sidebar”。[What are artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)
- ChatGPT 的 Library 在侧栏，上传和生成的文件都在，可按来源和文件类型筛选、按文件名搜索（搜索摘要，页面返回 403）。[Library for ChatGPT](https://help.openai.com/en/articles/20001052-library-for-chatgpt)
- Codex 命令行 `/ps`“shows each background terminal’s command plus up to three recent, non-empty output lines”。[Codex 斜杠命令](https://developers.openai.com/codex/cli/slash-commands)
- Devin 的命令历史里点一条命令就跳到会话里那一刻。[Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)
- Apple 设计规范：手机底部抽屉可停在几档高度，“medium is about half of the fully expanded height”，顶部小横条（grabber）用来拖动。[HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)

对比：入口和“没东西不显示”学 Claude Code 桌面版；按钮上只给数字学 Claude Code 的小标；侧栏文件页学 Claude 的 Artifacts 标签和 ChatGPT 的 Library；命令和对话互跳学 Devin。和这些产品不同的是，Himawari 把两类东西放进同一个栏，并用轮次把它们连起来，因为个人 Agent 的一段对话里，命令和它产生的文件本来就是一回事。

[↑ 返回阅读导航](#contents)

<a id="pi-reuse"></a>

## Pi 复用与 Himawari 负责的部分

- 复用：Pi Coding Agent 的 `write`、`edit`、`bash` 工具照常使用，参数形状不变；后台命令沿用 PR #63 里基于 Pi 0.84.2 steer 的做法，不改 Pi。
- Himawari 负责：产物登记表、副本和版本、读文件与下载接口的登录校验、网页隔离预览、栏和文件页的界面。这些都是产品层的数据归属和安全问题，Pi 本来就不管。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：Himawari 做出的任何文件都能在对话里和侧栏里找到、预览、下载；后台命令不再常驻在对话里，只留一个数字和两行灰字。
- 代价：要新增产物登记表（数据库迁移）、副本存储、读文件接口、一个新的预览子域名和对应的 Cloudflare 配置；每次写文件多存一份副本，占用磁盘。
- 分工：栏的外壳（按钮、右侧栏和底部抽屉）、后台命令页和主界面三处提示由 PR #63 实现；产物页、文件页和文件交付后端由本 ADR 所在的线程实现，前端部分在 PR #63 合并后基于 main 做。
- 被取代的部分：PR #63 原计划在回答下方放的“停止”按钮改为放进栏里。ADR 0091 的“网页文件先显示源码”“图片、PDF 以后做”由本 ADR 的第 8、10 条接上；[BL-20261026-013](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-013-file-preview-images-pdf-html.md) 由本设计实现。
- 后续：实现计划另写；BL-20261027-011（运行中实时输出）仍在 Backlog。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0091-chat-ui-v6-file-preview-and-sidebar.md]
- [SOURCE: docs/adr/0097-bash-writes-workspace-with-change-ledger.md]
- [SOURCE: docs/execution/specs/2026-09-15-control-center-v4-design.md#v8-more-panel]
- [SOURCE: docs/engineering-casebook.md#case-more-panel]
- 定稿原型副本：`docs/assets/control-center/2026-10-28-v8/`（`desktop.dc.html`、`phone.dc.html`、`canvas.json`，需要 claude.ai 的 Design 画布才能运行；可点版本见上面的原型链接）
- 设计说明：<https://claude.ai/artifact/VVkVvPptUS66XvXQ4HdQGJ>；上一份文件交付调研：<https://claude.ai/artifact/3DVB7FZb7SKpG1zw9JSVtR>

[↑ 返回阅读导航](#contents)

<a id="follow-up"></a>

## 后续

- 2026-10-29：[ADR 0110](0110-ui-batch-2026-10-29-check-it-before-the-owner-does.md) 按 Andy 选的顶栏方案 A，把“更多”按钮改成文件夹图标，旁边加一个“⋯”对话操作菜单（重命名、置顶、归档），两个按钮彼此分开；并把主人上传的文件列进全局文件页，标“我上传的”。本 ADR 的“更多”面板（文件和后台两个标签、按轮分组）和不加通用面板的基线规则不变。

[↑ 返回阅读导航](#contents)
