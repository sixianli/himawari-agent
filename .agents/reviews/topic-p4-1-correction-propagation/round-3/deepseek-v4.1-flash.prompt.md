你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5974bb75fb5f31c3606c91a6ddae8e2520336f7c。
待核对的方案：
方案文件：docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md（在提交 5974bb75fb5f31c3606c91a6ddae8e2520336f7c 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md, docs/adr/0219-read-only-mcp-entry-with-static-token.md"
superseded_by: ""
date: "2026-11-12"
---

# ADR 0232：改了记忆，沿依据链标出推出来的记忆和规则；规则由模型重读来源后自动核对，对不上就暂停

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [一致率和漏标怎么算](#agreement)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 的记忆不是孤立的：整理记忆（“做梦”）时，模型会从几条记忆推出一条新的（`reflect`，即“反思”出来的结论）；Andy 用一句话立的硬规则（例如“日本入管局相关的邮件以后必须通知我”）也指回一条规则类记忆（[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)）。当 Andy 改了、删了或换掉一条记忆，依据它推出来的记忆和由它立的规则可能已经不对了，但以前系统只会把“来源记忆直接被改”的规则标成待重审，而且规则照常执行、没人核对。

任务 P4-1 要做到：改、取代或删除一条记忆时，沿依据链找到所有推出来的记忆，以及由它立的硬规则，全部标成“待重审”；给 Andy 一张清单，能算出建议值的给建议，算不出的只列出来；待重审的规则自动核对，核对不过就暂停并留下决策记录，核对通过就清掉标记；记忆的文字一律不自动改。任务 P4-3 并进来：清单上 Andy 每点一次都记进决策记录，算“系统标了 N 条，你认可 M 条”的一致率；Andy 还能顺手指出“还有哪条也该跟着改”，记成漏标。

方案经过两个模型的独立出方案和审核，记录在 `.agents/reviews/topic-p4-1-correction-propagation/`，整合后的方案在 `/mnt/project-files/p4-1-correction-propagation/integrated-plan.md`。Andy 选了“① 模型重读再对比”，2026-11-11 回“同意”批准变更清单；P4-3 的两项在 2026-11-12 回“同意”。

<a id="premises"></a>

## 前提

1. SQLite 触发器里不能写递归查询。来源 <https://sqlite.org/lang_with.html>，原话：“The WITH clause cannot be used within a CREATE TRIGGER.”
2. 待重审的规则照常执行。来源 [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 决定 2：“待重审的规则**照常执行**……规则停掉等于主人的要求悄悄失效”。
3. 以前只有一个触发器管规则，而且不管恢复：ADR 0211 决定 3：“同样的文字再次确认、只改重要度、改的是别的记忆、记忆从回收站恢复，都不触发；已经是 `needs_review` 的规则不会重复触发”。
4. 只有 `reflect` 是“从别的记忆推出来”：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts` 的 `derivedMemories` 只沿 `action = 'reflect' AND undone_at IS NULL` 的整理记录走（同一文件的 `MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`）。
5. 后台模型调用要固定内容在前：`.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后。”
6. 理解用户意思交给模型，不用关键词表：项目记忆里 Andy 2026-11-12 的硬规则“理解用户意思一律交模型判断，不用关键词表/正则/写死词典”。规则核对因此由模型重读来源记忆，再由程序比较参数。

<a id="decision"></a>

## 决定

1. **触发器只标直接下游，程序再沿依据链展开。**迁移 0095 的 `memory_change_flags_downstream`（修改后）和 `memory_delete_flags_downstream`（删除前）在记忆的正文、状态、取代关系或分类任一变化时，把直接从它推出来的记忆写进新表 `memory_review_items`（一行是“哪条记忆、因为哪条上游”），原因分为改了、被取代、删除或归档、恢复、换分类。打开待重审清单前和后台每次查邮件前，程序把还没展开的行沿依据链往下展开（最多 8 层、200 条），超过的不再追，这一行记“已截断”，网页上写明“超过上限的没有标出”。上游编号不设外键，所以上游被永久删除后这一行还在。
2. **规则的触发条件同样扩大。**来源记忆以上述任一方式变化时，指向它的规则（只限 Andy 用一句话立的 `owner:` 规则，且来源记忆改前或改后是规则类）都改成待重审，并重新排队核对；已经暂停的规则保持暂停但重新排队。这修改了前提 3 的两点：恢复也触发；同一条规则再次变化时修订号再加 1、重新核对，但不重复写“待重审”决策记录。
3. **规则多一个状态 `suspended`（已暂停）。**暂停的规则不执行：裁判的 `ruleIsEnforced`、`enforceableOwnerRule`、MCP 的 `rule_book`、数据导出的“生效规则数”都只认 `active` 和 `needs_review`。数据库约束要求暂停必带原因（来源没了、读下来不再是长期要求、参数对不上），只有“参数对不上”能带建议值。
4. **待重审的规则自动核对。**`RuleReviewService` 用邮件检查的同一个模型连接，用途记为 `rule-review`：提示先放固定的说明和规则类型说明，最后放这次的来源记忆和当前规则（前提 5）；模型回答“是否仍是长期要求、类型和参数”，程序比较参数：一样就清掉标记回到 `active`；不一样就暂停并存下建议值；不再是长期要求或来源没了就暂停。每次结果都写一条决策记录。模型调用失败最多重试 3 次（间隔 1 小时），3 次都失败写一条 `recheck_failed`，规则照常执行（前提 2 的理由）。每次写入都核对修订号，核对期间规则被改过就丢弃这次结果。核对在每次查邮件之前跑完，一次最多 3 条，所以暂停当场对这次查邮件生效；方案里写的“在对话开始时触发”没有做，因为硬规则只作用在查邮件上。
5. **待重审清单。**记忆页新增“改了记忆后待重审”一区。规则：暂停且有建议的可以“采用建议”（用建议值恢复执行）、“确认暂停”（停用）、“恢复原规则”；还在等核对的只有“看过没问题”。记忆：“打开修改”或“看过没问题”。Andy 在记忆页改、删、恢复旧版本一条待重审的记忆，它就算处理过。系统不改任何记忆的文字。
6. **漏标。**记忆详情里有“还有哪条也该跟着改”，选出的那条按“你指出它也该跟着改”加进清单，并写一条 `owner_reported_missed` 决策记录。
7. **决策记录。**`decision_ledger` 第 3 次重建：类型加 `memory_review`；`rule_review` 的结果加 `suspended`、`cleared`、`recheck_failed`、`owner_adopted`、`owner_confirmed`、`owner_restored`；`memory_review` 的结果是 `flagged`、`owner_edited`、`owner_dismissed`、`owner_reported_missed`。Andy 自己点的结果不进每日回顾和校准统计，避免“让 Andy 评价他自己的点击”。
8. **不加进导出。**待重审标记和规则的建议值是可以重算的过程状态，数据导出在“未导出”清单里写明这两项；暂停的规则连同暂停原因照常导出。

<a id="agreement"></a>

## 一致率和漏标怎么算

- 认可：规则点“采用建议”或“确认暂停”；系统标出的记忆被 Andy 改了（包括删除、恢复旧版本）。
- 不认可：规则点“恢复原规则”；记忆点“看过没问题”。
- 不计入：还没处理的；规则还在等核对时点的“看过没问题”（那时系统还没下结论）；Andy 自己指出的漏标条目被处理时。
- 一致率 = 认可数 ÷ 处理数，累计不分周，显示在周报的“改记忆后跟着标的一致率”卡片，带样本数。处理数少于 5 条（`DEFAULT_MINIMUM_SAMPLES`）时只显示“样本不足（N 条）”，不显示比例。
- 漏标单独计数，不进一致率的分母。
- 计数直接从决策记录的结果和原因码算（`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts` 的 `agreement`），不另建表。

<a id="industry"></a>

## 业界怎么做

- 数据管道工具在上游变化时沿依赖图把下游一起选出来重算，而不是只处理改动本身。dbt（一个数据转换工具）文档（<https://docs.getdbt.com/reference/node-selection/methods>）原话：“`state:modified`: All new nodes, plus any changes to existing nodes.”，并写明 CI 里用 `state:modified+`（“including downstreams”）把下游一起带上。这里同理沿依据链带上下游，但只标记，记忆文字由 Andy 改。
- 规则的“核对后暂停、等人确认”对应特性开关系统里“自动检查失败就关掉开关、人确认后再开”的做法；我们保留了 [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 的取舍：只有模型给出了对不上的结论才暂停，模型调用失败不暂停。
- 一致率附样本数和 Wilson 区间、样本不够不出比例，沿用本项目周报其他比例的做法（`packages/calibration` 的 `proportion`）。

<a id="options"></a>

## 放弃的做法

- 在触发器里用递归查询一次标完：SQLite 不允许（前提 1）。
- 单独的事件表加游标：触发器直接写直接下游、程序展开，已经覆盖删除、多上游和截断，少一张表。
- 截断后下次接着往下追：每次展开都从头算，截断点不变，这个库的规模用不上。
- 模型调用失败就暂停规则：失败不是规则错了的证据。
- 用关键词或正则判断来源记忆改没改意思：违反前提 6。

<a id="consequences"></a>

## 后果

- 迁移 0095 重建 `decision_ledger` 及引用它的全部子表（含 0091 的 `decision_prereviews`）、`rule_book_rules`、`rule_book_history`、`model_usage_observations`，新增 `memory_review_items` 和两个触发器，删掉 0087 的两个旧触发器。迁移不可逆，回退要从迁移前的快照恢复。
- 规则核对是新的后台模型调用，只在来源记忆变化时发生，每条最多 1 次成功调用加 3 次失败重试，用量按用途 `rule-review` 记在模型用量里；它不占邮件检查的每日费用上限。没有配置邮件检查的部署不会自动核对，规则停在待重审并照常执行。
- 网关新增 `memory.review.read`、`memory.review.respond`、`memory.review.reportMissed`；周报快照多一个 `correction` 字段。
- 对 [ADR 0219](0219-read-only-mcp-entry-with-static-token.md)：MCP `rule_book` 里规则的 `status` 可以是 `suspended`，此时 `enforced` 为假。
- 还没做：已暂停规则对应的规则类记忆仍会作为文字进入模型上下文；要拿掉它会改变发给模型的内容，另行出方案。

<a id="references"></a>

## 关联文档

- [ADR 0211：硬规则指回它的规则记忆](0211-hard-rule-points-back-to-its-rule-memory.md)
- [ADR 0219：只读 MCP 入口](0219-read-only-mcp-entry-with-static-token.md)
- [ADR 0209：规则手册](0209-rule-book-with-cel-expressions-and-judge.md)
- [工程案例库](../engineering-casebook.md)
