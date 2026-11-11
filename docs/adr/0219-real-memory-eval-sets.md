---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0219：用主人的真实记忆每周评测记忆回忆，合成评测集降为对照

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P4-5 要求：从主人确认过的记忆和主人当时的原话自动出题、自动判分，建一个记忆回忆评测；再从决策记录里主人评价过的三类决策（主动提醒、记忆候选、记忆整理）算准确率；真实评测取代合成评测集成为主要依据，每周自动更新，合成集保留做对照；另跑一次 LongMemEval（公开的长期记忆问答评测集）做行业对照。

现有四个评测集都是合成数据：`evals/memory-retrieval`（检索）、`evals/memory-capture`（捕获）、`test/integration/memory-evaluation.test.ts`（端到端回忆）、`evals/jarvis-test`（Jarvis Test，产品愿景里的十条验收题）。合成数据量的是我们想象中的记忆分布，不是主人真实的记忆分布。Andy 在 2026-11-11 同意了变更清单（项目文件 `p4-5-real-eval/change-list.md`），并定下评测用第二个 OpenCode Go 账号经 Magpie（生产机上的模型路由程序）单独一组路由，每周费用硬上限 0.5 美元。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 合成集不含真实记忆：`evals/memory-retrieval/dataset.json` 第 3 行，“合成数据，不含 Andy 的真实记忆。”
2. “已确认”的定义：记忆状态为 `active` 且 `tentative` 为假。`packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql` 加了 `tentative` 列，`durable-memory-service.ts` 的 `confirm` 把它置为假。
3. 原话在记忆历史的 `quote_ref` 里，生产上加密保存，只有服务进程能解密：`apps/agent-service/src/production-memory-consolidation.ts` 的 `quoteRefOfMemory`，`service-main.ts` 的 `readQuote` 用 `episodeProtector.unprotect`。所以出题、作答、判分只能在生产服务进程里做，真实内容不进仓库。
4. 删除记忆会连带清掉原话：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`，`SELECT quote_ref FROM memory_history_events WHERE memory_id = ?`。
5. 决策评价已有换算函数：`packages/calibration/src/index.ts` 的 `calibrationGroup`、`summarizeDecisions`、`proportion`（Wilson 区间，`DEFAULT_MINIMUM_SAMPLES = 5`，样本不足 5 条不出比例）。
6. 评测和生产不共用预算、用哪个 key 先问 Andy：`.claude/rules/owner-standing-rules.md`，“评测用哪个 key（API 密钥），评测之前先问 Andy。评测和测试绝不和生产共用预算”。
7. 后台调用的排列：`.claude/rules/prompt-prefix.md` 第 15 条，“先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”
8. LongMemEval：<https://github.com/xiaowu0162/LongMemEval>，S 档 500 题有清洗版 `longmemeval_s_cleaned.json`，官方判分用 GPT-4o；检索指标跳过 30 道拒答题。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **两张新表。**`real_eval_questions` 是题库：每行一道题，记着记忆编号、记忆版本、题型（`fact` 事实、`preference` 偏好、`time` 时间、`abstain` 拒答）、题干（加密 payload，即加密保存的一段内容）、出题模型、出题提示词的 sha256、入库和退役时间。标准答案不复制，判分时从原记忆和原话现读。`real_eval_runs` 每次运行一行，只记分数、计数和标识（各项得分、题数、费用、记忆编号和版本、错误名），不含记忆正文、原话、题干或回答。删除记忆时外键级联删掉它的题，治理删除顺带删掉题干 payload。
2. **出题只用已确认的记忆。**待确认、已被取代、过期或未生效、模型不可见、找不到原话的记忆不出题。记忆变成这些状态之一，或者记忆被改过（版本号变了），它的旧题退役、不再计分；改过的记忆下一次重新出题。模型只写题干，题干当不可信输入：限长、限 JSON 结构，和原话或记忆正文有连续 6 个字相同、含同一个两位以上数字，或含同一个日期时刻（“十二月”和“12 月”、“七点”和“7 点”算同一个）就当泄题丢弃，含银行卡号、密码这类敏感值就丢弃。模型说这条记忆出不了题，或者题被丢弃时，同一版本以后不再问，免得每周为同一条记忆重复花钱；只有模型的回复不是合法 JSON 这一种例外，下次照常再问。题库没收下的题，题干 payload 当场删掉：题库说已有同一版本的题时，这个版本以后也不再出题；写入出错时这次运行记为失败，隔一天重试。退役的题保留在题库里（题干 payload 被题库行引用着，删不掉），记忆被删除时随题一起删。每道正常题另配一道拒答题（问一个记忆里没有的人或事），正确回答是“没有这条记忆”，这是反向用例。
3. **作答走和对话一样的记忆选取。**档案用 `OwnerProfileService.compose`，检索用同一个记忆搜索、同样的 `memoryLimit` 和 `maxSelectedMemories`，排除已在档案里的记忆，检索不改记忆的使用计数。只发一条作答请求，不开对话线程。偏离：对话里还有规则块、对话历史和 `recall` 工具，这里都没有，所以分数量的是“档案加一次检索”的回忆能力。
4. **判分。**回答完整包含原话（归一化后至少 8 个字）直接判对；其余交判分模型，输出对、错、拒答三选一。分数分开报：固定面板（运行开始前就在题库里的题，看趋势）、本周新题、拒答题、检索命中（标准记忆有没有被选进作答材料）。每项附 Wilson 区间，不足 5 题不出比例。
5. **决策评测这次只计数。**从决策记录取最近 365 天主人评价过的决策，用 `summarizeDecisions` 分成五组（提醒了、没提醒、记下了、没记、整理），主人评“有用”算做对，其余算做错，记进同一次运行的结果。重放当时的输入要用到不在决策记录里的证据，等某组评价满 5 条再另开 PR。
6. **费用防线在代码里。**上限按最近 7 天所有运行（包括失败的）实际花的钱累计，这次运行只能用剩下的部分，剩下为零就不跑。每次调用前按模型描述里的单价预估费用（输入按 UTF-8 字节数算，token 数不会超过字节数；输出按最大 token 数的两倍算，给推理留余量），所以服务方按标价收费时，实际费用不超过预估，加上已花的超过上限就不调用；调用后按实际费用记账，实际费用让累计超过上限时立刻停，所以最多超出一次调用的预估误差；调用失败、拿不到实际费用或服务方报的费用不是非负整数时，按预估记账。作答前的检索用题目所出自那条记忆的数据分级去调向量模型（向量模型不允许这一级时拒绝），按向量模型的单价预估（输入按 16384 个 token 算）先查额度，不够就不检索，检索后按实际费用记账。停下的运行记为 `budget_exceeded`，没来得及作答的题数记在 `unanswered`。配置 `runPolicy.realEval.weeklyCapMicros` 最大 500000 微美元（0.5 美元），超过启动时拒绝；`modelRef` 必须是允许 private 和 sensitive 两级数据的生成模型，否则启动时拒绝（敏感记忆也会出题和作答）。模型调用走统一出口（`proactiveModel`，用途记为 `other`），不占生产的模型预算。
7. **运行方式。**`runPolicy.realEval.mode`：不配或 `off` 不跑；`once` 跑一轮手动评测，跑完把遮盖过的约 30 道题、回答和判分写到状态目录下的 `real-eval/latest-sample.json`（权限 0600）给主人抽查，样本写不出来时这次运行记为失败，隔一天重跑；`weekly` 每周跑一次（每小时检查一次，最近 7 天没有成功跑完的运行就跑）。两种模式下，24 小时内跑过就不再跑，所以失败的运行隔一天才重试。作答时先答本周新题，再答固定面板，额度不够时新题先有分数。主人抽查确认后才改成 `weekly`。
8. **合成集降为对照。**四个合成集和它们的脚本不改，继续做回归和对照；判断记忆系统好坏，以真实评测为主。[ADR 0115](0115-memory-search-relevance-threshold-and-retrieval-eval.md) 的检索评测仍然有效，它的地位由本 ADR 改为对照。
9. **数据导出不含题库。**题库和分数是派生数据：导入后下一次评测会从导入的记忆重新出题。导出清单的“未导出”里写明这一项。
10. **报告。**`node scripts/operations/real-eval-report.mjs <product.sqlite>` 只读打开数据库，按时间倒序列出每次运行的分数和费用。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

LongMemEval（论文 <https://arxiv.org/abs/2410.10813>）和 Mem0（<https://arxiv.org/abs/2504.19413>）都用“问答加模型判对错”量长期记忆，标准答案是一句参考答案，换说法也算对，并单独统计拒答题。本 ADR 照这个做法，把数据换成主人的真实记忆，判分模型换成低价模型（项目禁用 GPT-4o 这类贵模型，见 [ADR 0111](0111-no-expensive-models-anywhere.md)），所以分数只能和自己的历史比，不能和论文里的数字直接比。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **第一版只做手动脚本、不做定时器。**“每周自动更新”是验收标准；用“默认关、先手动跑一轮给主人抽查”满足同样的安全要求。
- **作答时只给问题、不给检索结果。**那样量不到记忆系统。
- **复用 `ContextFormationService`。**它绑定一次运行（运行编号、执行租约、追踪事件），评测没有运行；改为按同样的规则选档案和记忆（决定 3）。
- **数据导出带上题库。**要给导出格式新增文件、校验和导入步骤，换来的是一份可以重新生成的数据（决定 9）。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：分数来自主人真实的记忆分布；固定面板能看出改动让回忆变好还是变坏；拒答题能看出是否会编造。
- 代价：被改写过、改写时没存新原话的记忆取不到原话，不出题，题库偏向没改写过的记忆。判分模型可能判错，第一次抽查时主人标出的判错条目用来算判分和人工的一致率。抽查样本文件不随记忆删除立刻删除：只保留最近一次，写入满 7 天后删掉（开着评测时定时器每小时检查一次，关着评测时服务每次启动检查一次），所以被删的记忆在这个文件里通常最多多留 7 天；关着评测且服务一直不重启时会留得更久。评测只在一个服务进程里跑：同一份数据同时开两个服务进程时，两边各跑一次。泄题检查认不出很短的专有名词（例如两三个字的人名、地名），这类题可能把答案带进题干，分数会偏高；第一次抽查时主人看到的话，再加检查。
- 不测：工具调用（`recall` 工具）和对话历史对回答的影响。
- 后续：第一次真实运行后把抽查结果和基线数字写进本 ADR 的关联文档；LongMemEval 等本机向量模型（P3-1）合并后再跑，跑前报费用。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0115：记忆检索的相关度门槛和检索评测](0115-memory-search-relevance-threshold-and-retrieval-eval.md)
- [ADR 0111：任何场景都不用贵模型](0111-no-expensive-models-anywhere.md)
- 代码：`packages/application/src/services/real-memory-eval.ts`、`packages/application/src/services/real-memory-eval-service.ts`、`apps/agent-service/src/production-real-eval.ts`、`packages/prompt-catalog/src/eval.ts`
- 测试：`test/integration/real-memory-eval.test.ts`、`packages/application/test/real-memory-eval*.unit.test.ts`、`apps/agent-service/test/production-real-eval.unit.test.ts`

[返回阅读导航](#contents)
