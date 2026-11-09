# 复核报告：PR 320（BL-20261026-003 复查记录改 deferred）

改动范围（已用 `git diff 71d986b8..ad69095d` 核对）：只改 `docs/backlog/BL-20261026-003-isolated-instance-per-person.md` 一个文件，frontmatter 四个字段（`record_state`→`deferred`、`updated`→2026-11-09、`review_after`→2026-11-16、`reason`）加 Notes 四行。纯文档，无产品代码。

## 发现（按严重度从高到低）

**1. 低：`record_state: "deferred"` 在本仓库无先例、无自动校验，有效性未核实**
- 文件：docs/backlog/BL-20261026-003-isolated-instance-per-person.md:5
- 证据（读代码证实）：
  - `git log -S 'record_state: "deferred"' -- docs/backlog docs/ideas` 只命中本次提交 50ca66a6，仓库历史上首次出现该状态；其余 backlog 文件用的是 open/done/in_progress/rejected/superseded 等。
  - `idea_backlog.py`、`validate_docs.py` 都不在本仓库（glob `**/idea_backlog.py`、`tools/**` 均无结果）；ADR 0133（docs/adr/0133-docs-check-removed-from-npm-run-check.md:46-47）删除了 `npm run check:docs`；`.agents/instructions/document-governance.md:28` 明确写“仓库没有对 docs/ 做全面校验的自动检查”。
  - `grep record_state|review_after scripts/` 无结果：仓库内没有任何脚本消费这些字段。
- 影响：若 "deferred" 不是外部 `idea_backlog.py` 合法状态，没有任何检查会拦（I-06 的门槛已删，状态“缺门槛”）。作者说四个字段是 `idea_backlog.py defer` 改的，字段变化模式与之一致，但工具本身在 agent-skills 仓库，**此说法在本仓库内未核实**。
- 建议：把 `idea_backlog.py defer` 的输出贴进 PR 说明（或让有 agent-skills 仓库的会话确认 `deferred` 在状态白名单里）；长期看这是 ADR 0133 留下的缺门槛。

**2. 低：`reason` 字段与 Notes 对 I-84 修复的表述不一致**
- 文件：docs/backlog/BL-20261026-003-isolated-instance-per-person.md:14 vs :36
- 证据：reason 只写“I-84 的修复 #282 已合进 main”；Notes 写“修复（PR #282、#312）”。#312 确实也是同一分支（claude/project-thread-476wnx）上 I-84 相关修复的合并（`git log 71d986b8^1..71d986b8^2` 含 `f0425bce fix(sandbox): 给模型看的字节上限按 1024 换算`、`d73eaf91 refactor(application): 工具失败原因白名单只留一份` 等）。reason 漏了 #312，不算错但前后不一致。
- 建议：reason 里补成“#282、#312”。

**3. 说明项（非缺陷）：三个事故归为“用不了”级别是作者判断，无正式分级可对照**
- 证据：docs/incidents-and-gates.md 的事故表（第 38 行表头）只有“编号/日期/现象/根因/次数/门槛/状态”，没有严重度列；“用不了级别”只出现在 ADR 0083:54 的开工条件原文里。按现象（I-72 生产停约 3 小时、I-73 消息发不出去、I-84 一轮对话挂约 31 分钟）归类合理，但这是解释而非可机检的事实。

## 读代码证实的（作者说法逐条核对结果）

- **说法 1 成立**：`scripts/delivery-mode/make-packet.py:22` `INSTANCES = HERE / 'instances'`、:93 `path = INSTANCES / (name + '.json')`，`scripts/delivery-mode/instances/andy-production.json` 存在；ADR 0086 文件存在（glob 命中）。
- **说法 2 成立**：I-72（2026-11-02，生产停了约 3 小时）、I-73（2026-11-02，消息“没发出去”）、I-84（2026-11-07，停在“结果未确认”约 31 分钟）分别见 docs/incidents-and-gates.md:107、112、122，现象描述与 Notes 一致。
- **说法 3 成立**：I-81 行（docs/incidents-and-gates.md:119）写明 11-07 上线 f0478c4d 在 `S6_ACCEPTANCE` 被拦下、“生产仍是旧版本 bc380a6e”；#282 合并提交 0f468696、#312 合并提交即 71d986b8，且 #282 的提交都标 I-84（`git log 0f468696^1..0f468696^2`），两者都在 main。“仓库里没有之后的上线记录”：事故清单 I-81 之后最晚到 I-90（11-08，CI 断网），无部署成功记录——与该陈述一致（否定性陈述未穷尽全仓库核实，标**部分核实**）。
- **说法 4 成立**：`../incidents-and-gates.md#incidents` 锚点存在（docs/incidents-and-gates.md:32 `<a id="incidents">`）；`../adr/0086-generate-release-packets-from-parameters.md` 文件存在。
- 附加核对：ADR 0083:54 决定第 6 条确实是四个开工条件，reason 里“其余三条已满足”数量对应；Notes 第一条把“第十一版事故修好”和“真实网页验收”合成一条写，条件总数没变。

## 侧重检查（走的流程和结论）

从一条最普通的使用流程走：2026-11-16 复查者打开 BL-20261026-003 → 读 reason/Notes → 点两个链接 → 回到 ADR 0083 条件 6 → 到事故清单核对。
- 链接、锚点、日期推算都能走通（读代码证实）。
- **没有测试覆盖的路径**：backlog frontmatter 的校验（`check:docs` 已删，`npm run check` 里的 `check:incident-gates`/`check:glossary` 等都不查 backlog）；Notes 第 36 行“仓库里没有之后的上线记录”是时点陈述，出现新上线记录后没有任何检查会提示这条过时——按复查记录的性质可接受；`idea_backlog.py defer` 对这四个字段的写入语义在仓库外，未核实。

## 必答问题逐条回答

1. **请求开头**：不受影响。改动只有一份 docs/ 下的 Markdown，不触系统提示、工具定义、历史消息或遮盖结果（diff 已核对）；“只追加”规则在这里不适用。
2. **同段文字不同字节**：不会。没有代码改动；`updated`/`review_after` 日期只写进文档本身，不进入任何发给模型的内容。
3. **自动检查**：没有。本仓库没有任何检查覆盖 backlog frontmatter（check:docs 已按 ADR 0133 删除，见 `.agents/instructions/document-governance.md:28`）；非法的 `record_state` 或坏链接（backlog 文件里的）不会让任何检查失败，反向用例无从谈起。唯一相关的是 `check:instruction-links`，只查指令文件，不查这份文档。
4. **每个值的产生端和使用端**：
   - `record_state: "deferred"` — 产生端是外部 idea_backlog.py（未核实）；仓库内无消费者（grep 无结果），无校验可失配；仓库外未核实。
   - `updated`/`review_after` — 仓库内无消费者；由复查流程（人工）使用。
   - `reason` — 自由文本，无消费者、无校验。
   - Notes 引用的路径/锚点/提交号 — 逐一核实存在且正确（见上）。
   即：仓库内不存在“产生端合法但使用端拒绝”的失配面；风险集中在外部治理工具对 "deferred" 的接受度（发现 1）。

**总体结论**：Notes 的事实陈述与仓库一致，没有发现会误导后来者在条件不满足时开工的内容；建议补齐发现 1、2 后合并。
