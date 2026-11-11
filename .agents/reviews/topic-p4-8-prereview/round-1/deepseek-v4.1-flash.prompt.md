你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
问题、目标和约束：
# P4-8 用模型预评减少主人手动打分：问题、目标、约束、已核对的事实

## 问题
Himawari 把系统里每个由模型做出的门槛决策（要不要提醒主人某封邮件、要不要存一条记忆、要不要整理记忆等）记进「决策记录」表。主人（Andy）每天在网页的「每天打分」页上对抽出的条目一键评价：有用 / 不需要 / 漏了。这一页有每日秒数预算。主人希望尽量少手动介入。直接让模型替人评、没有和人工评价的一致率数据，是自欺。

## 目标（验收标准，不能改）
- 让模型先给每条待评价的条目预评一遍（同样是有用 / 不需要 / 漏了），存成另一条记录，不写进主人的评价字段，也不覆盖主人的评价。
- 校准周报报出模型预评和主人评价的一致率。
- 一致率达到阈值后，「每天打分」默认只给主人看模型没把握或和历史不一致的条目；这个自动减量默认关闭，阈值可配。以上要有测试。
- 主人已定：一致率阈值 90%，用置信区间下限比；预评默认开（只记录不减量），每天最多 50 条。

## 约束
- 新发给模型的请求必须走仓库统一的进程内出口（`docs/adr/0148-send-every-model-request-through-one-in-process-egress.md`），出口先遮盖密钥、密码、验证码、卡号、证件号；`npm run check:egress-redaction` 拒绝未登记的新出口。
- 新提示词登记进 `packages/prompt-catalog` 并通过 `npm run check:prompt-catalog`；系统提示固定，会变的值只放最后一条用户消息（`.claude/rules/prompt-prefix.md`）。
- 识别敏感内容的规则只能写在 `packages/sensitive-capture`。
- 改表结构要新迁移；同一时间只允许一个改表结构的块进行（要排队）。不需要兼容旧数据。能动态获取的值不许写死。
- 禁用贵模型；生产经 Magpie，用便宜模型（DeepSeek Flash 一类）。主人很在意钱。
- 网页上显示的每个数字要有可验证的定义，并有正向和反向验收。
- 新测试要进 `npm test` / `npm run check`。

## 已核对的事实（main aa1b0b0）
- 决策记录表 `decision_ledger`（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql`）：`owner_rating` ∈ useful/unneeded/missed，`rated_at`；kind 有 proactive / memory_candidate / consolidation / context_truncation / retrieval_degrade / external_read，都有 CHECK。邮件逐封处理表 `proactive_processed_messages` 也有自己的 `owner_rating`。
- 现有表放不下另一条评价：`decision_signals.signal` 只允许 opened/undone/replied（`0080_decision_signals.sql`），`decision_ledger_payloads.role` 只允许 model_input/model_output（`0070`）。
- 「每天打分」：`packages/application/src/services/daily-review.ts`。`readDailyReview`（240 行起）汇集最近 7 天的决策记录条目和邮件条目，键是 `ledger:<id>` / `mail:<id>`；`selectDailyReview`（81 行）按 `reviewCapacity(budgetSeconds, secondsPerItem)` 在四个默认组（memory_skipped、proactive(+proactive_silent 按比例混)、memory_kept、consolidation）间轮流抽取，按 seed+日期哈希定顺序；其余归 other 折叠。每条有 `text`（截 200 字）、`textHidden`（模型不可见分级时隐藏）、`kind`、`outcome`、`category`。预算配置在 `packages/platform-node/src/strict-configuration.ts:1041`（reviewBudgetSeconds 默认 120、reviewSecondsPerItem 默认 5）。服务端入口 `apps/agent-service/src/production-proactive.ts` 约 308 行 `review()`。
- 另一线程（P4-6）计划在打分页加一组 `memory_checkup`（主人亲手处理的记忆体检），不该被减量。
- 校准周报：`npm run report:calibration`（`scripts/calibration-report/report.mjs`），只读打开生产 SQLite；统计在 `packages/calibration/src/index.ts`：`wilsonInterval`、`proportion`（样本不足返回空值）、`calibrationGroup`、`buildReport`、`historyRecord`（历史格式 `himawari-calibration-week.v3`），`DEFAULT_MINIMUM_SAMPLES = 5`。另一线程（P4-4）在同包加 `thresholds.ts` 做门槛建议值。
- 记忆正文和邮件内容在生产加密，只能在服务进程里解密；周报脚本只读数据库。
- 模型调用：带运行的辅助调用 `generateText`（`apps/agent-service/src/production-model-composition.ts` 624 行）要求 RuntimeRequest（有 runId、活着的运行）；后台没有运行的调用走 `proactiveModel(modelRef, limits)` → `ProactiveModelInvoker`（`packages/application/src/services/proactive-mail-check-service.ts:72`），邮件判断就是这条路，同样经统一出口。

## 请你回答
- 预评应该怎么存、什么时候跑、给模型看什么、模型输出什么、成本怎么控制。
- 一致率怎么算才不自欺（类别不平衡、选择偏差、减量之后还能不能继续测一致率）。
- 「模型没把握」「和历史不一致」怎么定义才可验证。
- 自动减量的规则、开关和测试怎么设计。
- 业界（Anthropic、OpenAI、Google 及成熟开源评测/标注工具）的一手做法，附 URL。
