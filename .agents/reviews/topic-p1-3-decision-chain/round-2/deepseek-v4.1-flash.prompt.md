你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 fd283e437a172cfbe807dddaae5da674cc814c18。
待审核的方案：
# P1-3 线程方案：给一条决策记录读出并展示完整链

## 前提（来源均已读过）
- P1-1/P1-2 在 main：`production-memory-control.ts:395`（sourceMessageId）、`ports/memory-consolidation.ts:71`（readBasisChain）。
- Gmail 决策的 inputs 已写全：`proactive-mail-check-service.ts:1294-1308`；inputs 读回时缺字段会被补默认值（`sqlite-decision-ledger-operations.ts` entryFromRow）。
- 模型提示词/回答：表 decision_ledger_payloads（迁移 0070），解密入口 `production-proactive.ts:218`。
- 地板规则三条：`proactive-rules.ts:29-34`；出处 ADR 0106 第 4 条；仓库无规则登记册。
- 记忆概览 query() 开头会 `#purgeExpiredTrash()`（`production-memory-control.ts` query 方法），不是纯读。
- 每日打分对敏感记忆隐藏原文：`daily-review.ts:135` `reviewMemoryVisible`。
- 设计基线：`web-design-baselines.md:9` 不新增堆内部运行信息的通用面板；记忆页抽屉 `memory-page.tsx:431-453`。

## 方案
1. 数据：不加迁移。DecisionLedgerPort 新增 `read({ownerId,agentId,decisionId})`，WHERE 带 owner/agent，返回条目 + `inputFields`（inputs JSON 里实际存在的键，用来区分「没记录」和「显式为 off/空」）。不存在或不是自己的 → 端口 NOT_FOUND，网关 DECISION_RECORD_NOT_FOUND。
2. 网关：新增 `decision.chain.read` / `decision.chain.snapshot`（覆盖所有 kind，不只 Gmail）。实现为新类 `ProductionDecisionChain`（apps/agent-service），依赖：账本端口、记忆状态/历史/来源消息读取（从 ProductionMemoryControl 里把「记忆概览单条条目」的组装抽成公共只读方法，概览和链共用，不调用会清回收站的 query()）、`consolidation.store.readBasisChain`、规则登记册、可选的模型输入输出读取。登记处：contracts-v2 类型+schema+fixture、`PRODUCTION_*_OPERATIONS`、approval-gateway 显式派发分支、http-composition 的 installedGatewayV2Operations、控制中心按能力门显示入口。
3. 快照：decision（kind、时间、结论、原因代码、counts、评价与时间）→ rules（state: recorded | none | not_applicable；items: 规则编号、出处类型 owner_setting|built_in、出处文档、命中邮件编号；unknown: 登记册里没有的编号）→ memories（state: recorded|none|not_recorded；recall 状态；条目：记忆编号、当前文本或 textHidden、状态 active|archived|trashed|missing、supersededBy 及其文本、inference、tentative、usedByModel、changedSinceDecision(updatedAt>decidedAt)、来源：沿用概览字段 sourceThreadId/sourceMessageId/sourceRefs/importBatchId/history 首条 quote，让控制中心用 memorySourceState 分类与跳转）→ 每条记忆的 basis（复用 readBasisChain，节点上限 200，complete 标志）→ 评价。记忆取 memoryIds ∪ memoryByMail ∪ usedMemoryIds 去重，上限 100 条，超出标 truncated；一切按编号排序；单条读失败只让该条显示「无记录」，不让整条链失败。
4. 规则登记册：`packages/application/src/services/` 新增常量表（编号 → 出处类型 + 文档锚），三条地板规则；单测双向核对 FLOOR_RULE_IDS 与登记册一致。非 proactive 的 kind 规则段为 not_applicable（memory_candidate 把 reasonCode 写进 ruleIds 是既有形状，不改，约定文档写明新写入方不得再这么做）。只能说「命中了这条规则」，不能说命中的是哪个发件人（账本没存）。
5. 「无记录」定义：规则段无命中、记忆未注入、记忆已删除/读不到、无来源原话、无推论链、无提示词与回答，每一环缺了都显示「无记录」；数字只有「放进提示词的记忆 N 条」（= memoryIds 去重数）和「模型说用到了」标签（= 编号在 usedMemoryIds 内）。记忆正文明确标「当前内容」，changedSinceDecision 时提示「决策后改过」。
6. 敏感记忆：沿用 reviewMemoryVisible，不可见时 textHidden，提示去记忆页看，不在提醒页新增敏感文字暴露面。
7. 提示词与回答：快照只带 {sequence, role} 列表；正文由第二个查询 `decision.chain.model-io.read`（decisionId+sequence）在用户展开时才取，抽屉内默认折叠，标注「这是发给模型时的版本，敏感信息已遮盖」。（待 Andy 拍板：要不要展示。）
8. 界面：提醒页「提醒检查记录」每行加「依据」入口，打开抽屉（复用 memory-drawer 样式，手机底部弹出，Escape/遮罩关闭，焦点回到入口），自上而下：这次判断 → 规则 → 记忆（含来源原话/跳转、状态、被谁取代、推论链）→ 你的评价（复用现有 RatingChoices 与 proactive.decision.rate）。三语文案；glossary 不引入旧叫法。
9. 文档：`docs/execution/specs/2026-11-09-decision-record-write-convention.md`（列、六种 kind 的必填/禁止矩阵、inputs 逐字段含义、不变量、读取端状态定义、新增 kind/字段的流程）+ ADR 0192。
10. 测试：真实 SQLite 集成测试 `test/integration/decision-chain.test.ts`（Gmail 记录正向完整链；反向：无记忆、记忆被删、原话找不到、未登记规则编号、别的主人的编号、inputs 为 {}、依据链超限、敏感记忆 textHidden、读取不触发模型/写库）；网关契约夹具与 schema 反向用例；规则登记册单测；控制中心单元测试（各状态文案、入口能力门、无请求时不显示入口）；真实浏览器测试（扩展 test/e2e/fixtures/control-center-browser-server.mjs），正反向。
11. 不动：任何发给模型的请求、提示词目录、迁移、敏感识别规则。
