---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/agent-service/src/production-memory-consolidation.ts, apps/agent-service/src/production-real-eval.ts, apps/agent-service/test/production-real-eval.unit.test.ts, evals/memory-retrieval/dataset.json, packages/application/src/services/real-memory-eval-service.ts, packages/application/src/services/real-memory-eval.ts, packages/calibration/src/index.ts, packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql, packages/persistence-sqlite/src/sqlite-governed-deletion.ts, packages/prompt-catalog/src/eval.ts, test/integration/memory-evaluation.test.ts, test/integration/real-memory-eval.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0239：用主人的真实记忆每周评测记忆回忆，合成评测集降为对照

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

现有四个评测集都是合成数据：`evals/memory-retrieval`（检索）、`evals/memory-capture`（捕获）、`test/integration/memory-evaluation.test.ts`（端到端回忆）、`evals/jarvis-test`（Jarvis Test，产品愿景里的十条验收题）。合成数据量的是我们想象中的记忆分布，不是主人真实的记忆分布。Andy 在 2026-11-11 同意了变更清单（项目文件 p4-5-real-eval/change-list.md），并定下评测用第二个 OpenCode Go 账号经 Magpie（生产机上的模型路由程序）单独一组路由，每周费用硬上限 0.5 美元。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 合成集不含真实记忆：`evals/memory-retrieval/dataset.json` 第 3 行，“合成数据，不含 Andy 的真实记忆。”
2. “已确认”的定义：记忆状态为 `active` 且 `tentative` 为假。`packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql` 加了 `tentative` 列，`durable-memory-service.ts` 的 `confirm` 把它置为假。
3. 原话在记忆历史的 `quote_ref` 里，生产上加密保存，只有服务进程能解密：`apps/agent-service/src/production-memory-consolidation.ts` 的 `quoteRefOfMemory`，`service-main.ts` 的 `readQuote` 用 `episodeProtector.unprotect`（评测自己的读取在 `production-real-eval.ts`，用服务进程传入的 `realEvalProtector` 解密）。所以出题、作答、判分只能在生产服务进程里做，真实内容不进仓库。
4. 删除记忆会连带清掉原话：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`，`SELECT quote_ref FROM memory_history_events WHERE memory_id = ?`。
5. 决策评价已有换算函数：`packages/calibration/src/index.ts` 的 `calibrationGroup`、`summarizeDecisions`、`proportion`（Wilson 区间，`DEFAULT_MINIMUM_SAMPLES = 5`，样本不足 5 条不出比例）。
6. 评测和生产不共用预算、用哪个 key 先问 Andy：`.claude/rules/owner-standing-rules.md`，“评测用哪个 key（API 密钥），评测之前先问 Andy。评测和测试绝不和生产共用预算”。
7. 后台调用的排列：`.agents/instructions/prompt-prefix.md` 第 15 条，“先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”
8. LongMemEval：<https://github.com/xiaowu0162/LongMemEval>，S 档 500 题有清洗版 longmemeval_s_cleaned.json，官方判分用 GPT-4o；检索指标跳过 30 道拒答题。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **两张新表。**`real_eval_questions` 是题库：每行一道题，记着记忆编号、记忆版本、题型（`fact` 事实、`preference` 偏好、`time` 时间、`abstain` 拒答）、题干（加密 payload，即加密保存的一段内容）、出题模型、出题提示词的 sha256、入库和退役时间。标准答案不复制，判分时从原记忆和原话现读。`real_eval_runs` 每次运行一行，只记分数、计数和标识（各项得分、题数、费用、记忆编号和版本、错误名），不含记忆正文、原话、题干或回答。删除记忆时外键级联删掉它的题，治理删除顺带删掉题干 payload。
2. **出题只用已确认的记忆。**待确认、已被取代、过期或未生效、模型不可见、找不到原话的记忆不出题。记忆变成这些状态之一，或者记忆被改过（版本号变了），它的旧题退役、不再计分；改过的记忆下一次重新出题。模型只写题干，题干当不可信输入：限长、限 JSON 结构，和原话或记忆正文有连续 6 个字相同、含同一个两位以上数字，或含同一个日期时刻（“十二月”和“12 月”、“七点”和“7 点”算同一个；“一点”只在前面有“下午”这类时段词、或后面跟着“钟”“整”“半”“几分”时才算钟点，免得“一点也不”被当成时间）就当泄题丢弃，含银行卡号、密码这类敏感值就丢弃。模型说这条记忆出不了题，或者题被丢弃时，同一版本以后不再问，免得每周为同一条记忆重复花钱；只有模型的回复不是合法 JSON 这一种例外，下次照常再问。记忆正文或原话取不到时，这条记忆跳过（计为 `source_missing`），同一版本以后也不再问，免得它每周占掉新题名额；读取（解密）出错时也跳过（计为 `source_unreadable`），但不占名额、下次照常再试，因为出错可能是临时的；一轮最多读名额 4 倍的记忆，读满就留到下一轮，免得一批解不开的记忆让一轮读个没完；上一轮读不出的记忆编号记在运行记录的 `unreadable` 里，下一轮排到最后再读，所以一批解不开的记忆挡不住后面的好记忆。作答时题干、正文或原话读不出的题计为答不了，不影响其他题；档案和检索里读不出的记忆当作没有，不让整轮失败。题库没收下的题，题干 payload 当场删掉；删除出错时把它的编号记进这次运行记录，以后每次运行开头把最近运行记录里的这些编号都再删一次（已经删掉的再删不出错），直到删掉为止；运行记录本身也写不进去时这些编号会丢，题干留在库里：题库说已有同一版本的题时，这个版本以后也不再出题；写入出错时这次运行记为失败，隔一天重试。退役的题保留在题库里（题干 payload 被题库行引用着，删不掉），记忆被删除时随题一起删。出题模型可以为每条记忆另出一道拒答题（问一个记忆里没有的人或事），正确回答是“没有这条记忆”，这是反向用例；模型认为出不了时可以不出。
3. **作答走和对话一样的记忆选取。**档案用 `OwnerProfileService.compose`，检索用同一个记忆搜索、同样的 `memoryLimit` 和 `maxSelectedMemories`，排除已在档案里的记忆，检索不改记忆的使用计数。只发一条作答请求，不开对话线程。偏离：对话里还有规则块、对话历史和 `recall` 工具，这里都没有，所以分数量的是“档案加一次检索”的回忆能力。
4. **判分。**回答完整包含原话（归一化后至少 8 个字）直接判对；其余交判分模型，输出对、错、拒答三选一。分数分开报：固定面板（运行开始前就在题库里的题，看趋势）、本周新题、拒答题、检索命中（标准记忆有没有被选进作答材料）。每项附 Wilson 区间，不足 5 题不出比例。
5. **决策评测这次只计数。**从决策记录取最近 365 天主人评价过的决策，用 `summarizeDecisions` 分成五组（提醒了、没提醒、记下了、没记、整理），主人评“有用”算做对，其余算做错，记进同一次运行的结果。重放当时的输入要用到不在决策记录里的证据，等某组评价满 5 条再另开 PR。
6. **费用防线在代码里。**上限按最近 7 天所有运行（包括失败的）实际花的钱累计，这次运行只能用剩下的部分，剩下为零就不跑。每次调用前按模型描述里的单价预估费用（输入按 UTF-8 字节数算，token 数不会超过字节数；输出按最大 token 数的两倍算，给推理留余量），所以服务方按标价收费时，实际费用通常不超过预估（发出前的遮盖把敏感值换成占位符，可能让发出的内容比预估时略长，余量由“输入按字节算”承担），加上已花的超过上限就不调用；调用后按实际费用记账，实际费用让累计超过上限时立刻停，所以最多超出一次调用的预估误差；调用失败、拿不到实际费用或服务方报的费用不是非负整数时，按预估记账。作答前的检索用题目所出自那条记忆的数据分级去调向量模型（向量模型不允许这一级时拒绝），按向量模型的单价预估（输入按 16384 个 token 算）先查额度，不够就不检索，检索后按实际费用记账。停下的运行记为 `budget_exceeded`，没来得及作答的题数记在 `unanswered`。配置 `runPolicy.realEval.weeklyCapMicros` 最大 500000 微美元（0.5 美元），超过启动时拒绝；`modelRef` 必须是走 openai-completions 接口、允许 private 和 sensitive 两级数据的生成模型，评测开着时向量模型也必须允许 sensitive，否则启动时拒绝（敏感记忆也会出题、检索和作答）。每次运行开始前在状态目录写一个只属于这次运行的“进行中”标记（先写临时文件再改名，写到一半不会留下半个文件），正常写完运行记录后删掉；进程崩溃或运行记录写不进去时标记留下，按“这次花光了本次可用额度”计入 7 天累计和 24 小时规则，满 7 天后删掉。读不懂的标记（包括额度不是正整数的），以及开始时间晚于当前时间的标记，按“花光了整周上限”算，开始时间取文件的修改时间（修改时间也在将来时，先把它改成当前时间，保证 7 天后能删掉；改不了就删掉，删不掉就按今天开始、花光整周上限计）。某个标记文件读不了（例如权限不对）时，按它的修改时间算作花光整周上限，满 7 天后不再计入，其余标记照常读。抽查样本的修改时间在将来时同样先改成当前时间，改不了就直接删掉。后面的运行另写自己的标记，不覆盖前面留下的。标记里记着这次运行的编号，数据库里已经有这个编号的运行记录时（写完记录、删标记前进程崩溃），只按数据库记录算，标记删掉。评测关着时，每小时的清理也删掉满 7 天的标记。模型调用走统一出口（`proactiveModel`，用途记为 `other`），不占生产的模型预算。
7. **运行方式。**`runPolicy.realEval.mode`：不配或 `off` 不跑；`once` 跑一轮手动评测，跑完把约 30 道题、回答、判分和对应的记忆正文、原话（按统一出口的默认遮盖规则遮掉银行卡号、密码这类敏感值，其余正文照原样，主人才能判断判分对不对）写到状态目录下的 real-eval/latest-sample.json（权限 0600）给主人抽查，样本写不出来时这次运行记为失败，隔一天重跑；`weekly` 每周跑一次（每小时检查一次，最近 7 天没有跑完或花到上限的运行就跑）。两种模式下，24 小时内跑过就不再跑，所以失败的运行隔一天才重试。作答时先答本周新题，再答固定面板，额度不够时新题先有分数。主人抽查确认后才改成 `weekly`。
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
- 代价：被改写过、改写时没存新原话的记忆取不到原话，不出题，题库偏向没改写过的记忆。判分模型可能判错，第一次抽查时主人标出的判错条目用来算判分和人工的一致率。抽查样本文件不随记忆删除立刻删除：只保留最近一次，写入满 7 天后删掉（不论开没开评测，服务每小时检查一次，写到一半留下的临时文件也一并删掉），所以被删的记忆在这个文件里最多多留 7 天左右。评测只在一个服务进程里跑：同一份数据同时开两个服务进程时，两边各跑一次，7 天花费最多是上限的两倍。进程崩溃留下标记后，`once` 模式要等这份额度在 7 天后过期才会重跑；`budget_exceeded` 的运行同样算作花光，下一次周跑要等 7 天累计降下来；`once` 模式下它算跑完了一轮（抽查样本已经写出），不再重跑。0.5 美元是“调用前按预估挡住”的上限：服务方实际收费高于预估时，最多超出一次调用的差额。“一点”只在有时段词或“钟、整、半、几分”时才算钟点，所以“下午的一点”“你一点做什么”这种写法认不出，题干可能带出钟点。题库按“记忆、版本、题型”唯一：记忆退役后在版本号不变的情况下又回到可出题状态时，旧的退役题占着位置，这个版本不再出新题，等记忆下次改动才重新出题。固定面板不设上限：题库随新记忆增长，每周额度不够时总是从最老的题开始答，`unanswered` 会逐渐变大，较新的题答到得少。报告脚本 `real-eval-report.mjs` 汇总整个数据库，不分主人（产品现在只有一位主人）。泄题检查认不出很短的专有名词（例如两三个字的人名、地名），这类题可能把答案带进题干，分数会偏高；第一次抽查时主人看到的话，再加检查。
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
