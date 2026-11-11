你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 131f06b7f156ac731c992ab7f0462b2e2539e8cf。
对比基准是 a857cd40afee3e244c05b2e59ca9777b429e77ef，先运行 git diff a857cd40afee3e244c05b2e59ca9777b429e77ef..131f06b7f156ac731c992ab7f0462b2e2539e8cf 看改动。
上一轮复核到 f7aa5499264a64d188569ddacf446b673637d3a3，先看 git diff f7aa5499264a64d188569ddacf446b673637d3a3..131f06b7f156ac731c992ab7f0462b2e2539e8cf 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# P4-5 用真实数据建评测集：代码复核材料

## 问题

现有记忆评测集全是合成数据，量不到主人真实的记忆分布。任务要求：从主人确认过的记忆和原话自动出题、自动判分，每周自动更新；从决策记录里主人评价过的三类决策算准确率；合成集保留为对照。

## 约束（来自项目规则和主人的决定）

- 出题只用已确认的记忆（status active、tentative 假）和原话，不用待确认的。
- 模型调用走统一出口（会遮盖敏感信息），提示词登记进提示词目录（packages/prompt-catalog）。
- 评测不得和生产共用预算；每周费用硬上限 0.5 美元（500000 微美元），配置超过要在启动时拒绝；花到上限必须立刻停。
- 真实内容不得进仓库；运行结果表只存分数、计数和标识（记忆编号和版本、错误名），不含正文。
- 删除记忆必须连带删掉它的题和题干。
- 发给模型的内容：固定指令在前，这次的数据在后（只追加规则 .claude/rules/prompt-prefix.md 第 15 条）。
- 不写代码注释。

## 作者的说法（请核对，不要直接采信）

1. 迁移 0088 新建 real_eval_questions（外键级联到 memory_records，题干 payload 由治理删除一并清掉）和 real_eval_runs。迁移号合并前会按队列改成 main 上下一个空号。
2. RealMemoryEvalService.run：退役记忆已变的旧题；按记忆编号顺序给没有在用题的已确认记忆出题，泄题、含敏感值、拒绝出题的丢弃，拒绝过的同一版本记忆以后不再问（从最近 52 次运行的 summary.declined 读）；作答前按对话相同规则选档案和记忆；先快判再交模型判分；每次模型调用前预留预估费用，超过上限抛 RealEvalBudgetExceededError，运行记为 budget_exceeded；任何其他错误记为 failed，只记错误名，不记错误文字。
3. 生产：runPolicy.realEval.mode off/once/weekly，默认不配即不跑；once 跑完把遮盖后的抽查样本写到状态目录 real-eval/latest-sample.json（0600）；weekly 每小时检查、距上次运行满 7 天才跑。proactiveModel 新增可选 purpose，默认仍是 mail-judgment，评测用 other。
4. 决策评测只做计数：summarizeDecisions 分五组，主人评 useful 算做对。
5. 数据导出不含题库，导出清单的“未导出”写明理由。
6. 已知与本改动无关的失败：apps/agent-service/test/production-model-composition.unit.test.ts 18 条、model-payload-cleanup.unit.test.ts 8 条，在不含本改动的 production-model-composition.ts 上同样失败（测试里假的 Pi 运行时缺 registerNativeProvider）。

## 请重点看

- 费用上限是否真的挡得住：预估是否可能低估，导致单次调用就超过上限；嵌入（向量）费用是否被计入。
- 敏感信息：抽查样本文件、运行结果 summary、错误记录里是否可能出现记忆正文或原话。
- 题目退役和重新出题的条件是否会漏掉或反复出题、反复花钱。
- 并发：定时器 tick 是否可能同时跑两次评测。
- 删除记忆后是否还有残留（题干 payload、抽查样本文件）。

## 第 2 轮：第 1 轮意见的修改（请核对，不要直接采信）

1. 费用：RealEvalBudget.record 在实际累计超过上限时抛 RealEvalBudgetExceededError；检索前调用 ensureRemaining；生产按最近 7 天所有运行的 cost_micros 累计（realEvalSpentMicros），只把剩余额度传给本次运行，剩余为 0 不跑；dueRealEvalTrigger 在 24 小时内有任何运行时不跑。
2. addQuestion 返回 false 或抛错时调用 discardQuestion 删掉刚写的题干 payload；题退役时也删其 payload。
3. 所有被拒的出题都记进 summary.declined，窗口 520 次运行。
4. 先答本周新题，再答固定面板；额度用完时 summary.unanswered 记没答的题数。
5. 定时器每次检查时删除写入满 7 天的抽查样本文件（expireRealEvalSample）。
6. 泄题检查新增日期时刻比对（dateTokens）。
请重点看：这些修改是否引入新的漏洞（例如 7 天累计是否会漏算、24 小时规则是否让 once 模式卡住、discardQuestion 失败时的行为、日期解析的误判）。

## 第 3 轮：第 2 轮意见的修改（请核对，不要直接采信）

1. 退役题不再删题干 payload（外键 ON DELETE RESTRICT），记忆删除时随题删。
2. 模型调用或检索抛错时按预估记账（RealEvalBudget.absorb）；检索前 reserve(recallEstimateMicros)，生产取向量模型的 estimatedCostMicros。
3. addQuestion 返回 false 时把记忆版本记进 declined；response_invalid 不记。
4. 评测关着时服务启动时清理满 7 天的抽查样本。
5. 泄题检查认出 7:00 这类时刻。

## 第 4 轮：第 3 轮意见的修改（请核对，不要直接采信）

1. 检索把题目所出自记忆的数据分级传给向量模型（MailEmbeddingContext.dataClassification），邮件检查不传，仍按 private。
2. 服务方报的费用缺失、是小数或负数时抛 COST_INVALID，服务层按预估记账。
3. 输入费用按 UTF-8 字节数预估。
4. 抽查样本在写运行记录之前写（limits.writeSample），写失败这次运行记为 failed。
5. realEval.modelRef 必须允许 private 和 sensitive。

## 第 5 轮：第 4 轮意见的修改，另加案例库文档（请核对，不要直接采信）

1. in-progress.json 标记：运行前写、记录后删；残留时按花光本次额度计。
2. realEval.modelRef 必须 openai-completions；评测开着时向量模型必须允许 sensitive。
3. RealEvalSampleExpiry：关着评测也每小时清样本和临时文件；写样本失败删临时文件；清理失败不挡评测。
4. discardQuestion 失败只计数。
5. “一点”不当时刻。
6. docs/engineering-casebook.md 新增案例 87（只改文档），请核对案例里的说法和代码是否一致。

## 第 6 轮：第 5 轮意见的修改（请核对，不要直接采信）

1. 进行中标记改成每次运行一个文件 `in-progress-<时间>-<uuid>.json`，先写 `.tmp` 再 rename；读不懂或字段不合规（capMicros 负、startedAt 非规范 ISO）的标记按花光整周上限计、开始时间取 mtime；满 7 天删除；新运行不覆盖旧标记。
2. createRealEvalModel 的两个 release 改成 try/finally；production-model-composition.ts 的 proactiveModel.prepare 在申请密钥句柄失败时删掉刚写的 prompt payload（影响所有主动调用）。
3. discardQuestion 失败的题干编号记进 summary.undiscarded，下次运行开头（listRuns 最新一次）重删，仍失败就继续带下去。
4. “一点”前面有时段词（下午等）或后面跟钟、整、半、几分时才算钟点。
5. 跨进程互斥、once 崩溃后等 7 天、budget_exceeded 挡 7 天：判为有意设计，写进 ADR 后果。
请重点看：多个标记文件的累计是否会重复计或漏计（标记和数据库里的运行记录会不会同时存在）、undiscarded 只读最新一次运行是否会丢编号、prepare 修改是否影响其他调用方。
