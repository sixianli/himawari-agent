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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
待审核的方案：
# P4-5 线程方案（初稿，给两模型审核用）

## 前提（来源和原话）

1. 合成集自述：`evals/memory-retrieval/dataset.json:3` “合成数据，不含 Andy 的真实记忆。”
2. 已确认记忆：`packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql:1` 加 `tentative INTEGER NOT NULL DEFAULT 0`（材料原写 0052，DeepSeek 指出有误）；`memory_records.status` 含 `'active'`（`0001_initial_product_schema.sql`）。
3. 原话：`apps/agent-service/src/production-memory-consolidation.ts:10` `quoteRefOfMemory` 取 `contentRef` 相同的最早一条 `quoteRef`；`service-main.ts:1461` `readQuote` 用 `episodeProtector.unprotect` 解密 → 只能在生产服务进程里读。
4. 决策记录：`0069_decision_ledger.sql` `owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed'))`；`kind IN ('proactive', 'memory_candidate', 'consolidation', …)`。
5. 样本门槛：`packages/calibration/src/index.ts:2` `DEFAULT_MINIMUM_SAMPLES = 5`，Wilson 区间 `WILSON_Z = 1.96`。
6. 统一出口：`packages/application/src/services/model-egress.ts`（`ModelEgress`，`redactForEgress`）；生产用 `createProductionModelEgress`（`apps/agent-service/src/production-model-egress.ts:64`）。
7. 后台调用排列：`.claude/rules/prompt-prefix.md` 第 15 条“先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”
8. LongMemEval：https://github.com/xiaowu0162/LongMemEval ，“Each file has 500 evaluation instances”，S 档“roughly consumes 115k tokens (~40 history sessions)”，官方判分 `evaluate_qa.py gpt-4o`。
9. 禁贵模型：`.claude/rules/owner-standing-rules.md` “不得通过按 token 付费的渠道（例如 Vercel、OpenRouter）调用 Claude、OpenAI 或同价位的模型”。

## 对标

- LongMemEval、LoCoMo、Mem0 论文都用“问答 + LLM 判分（是/否）”量长期记忆，标准答案是一句参考答案，判分提示允许改写和更详细的回答。本方案的判分沿用 LongMemEval 判分提示的结构，换成 DeepSeek（经 Magpie）。
- 根因层面：现状问题是“量的数据不是真实分布”，本方案直接换数据来源，不是表面修补。

## 方案

### A. 记忆回忆评测（现在就做）

1. **题库按版本冻结，存在生产**：服务里新加 `ProductionRealEval`（每周一次的定时器，和 `ProductionObservation` 同样的 `setInterval` + `unref` 写法），步骤：
   - 选样：`status='active' AND tentative=0 AND superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now)`、`isModelVisible(classification)`、有原话的记忆。已在题库里的记忆不重出题（题目冻结 = 可复现）；本周新确认的记忆补题；记忆被取代、删除、过期或改回待确认的，题目标“退役”，不再计分。
   - 出题：一条记忆一次调用，输入“记忆正文 + 原话”（经统一出口遮盖），模型**只写问题**（`question`、`kind`），**标准答案由程序取原话和记忆正文**，不让模型写答案。程序检查题干和原话的字符 n-gram 重叠（中文 6 字）、题干不含原话里的数字/日期/专名，不合格丢弃并计数。原话经遮盖后出现占位符的题丢弃（答案被遮掉无法判分），只计数。另按比例（约 20%）出“拒答题”：把记忆里的人名/对象换成题库里不存在的，标准答案是“没有这条记忆”，作为反向用例。
   - 题库写成加密 payload（和记忆同一个 `episodeProtector`），状态目录里只存“题库版本号 → payload ref、题数、sha256、出题模型和提示词版本”。不加表，不用迁移（避开 0087/0088 的串行）。
2. **作答**：先记检索层指标（标准记忆是否进了前 k 条，`recordUse: false`，不影响使用计数），再作答。不开真实对话线程（会在 Andy 的对话列表里留下几十个测试对话），而是复用对话运行里的记忆注入：用生产的 `DurableMemoryService.search`（同配置、同门槛）取记忆，按对话运行里同样的记忆块格式放进一条作答请求，模型用生产对话默认模型，经统一出口。代价：不测工具调用（`recall` 工具）和对话历史的影响，这一点写进文档。
3. **判分**：先走程序快通道（归一化后回答包含原话关键值即判对），其余交模型。判分调用输入“问题 + 参考答案 + 原话 + Himawari 回答”，输出 `correct` / `wrong` / `abstained`。拒答题答“不知道”算对。分数 = 正确数 / 计分题数，附 Wilson 区间；题数 < 5 不出分。
4. **结果**：每周一行写进状态目录 `real-eval/history.jsonl`（只有数字、版本号、提交号、模型名，不含正文）；`scripts/operations/real-eval-report.mjs` 读它打印趋势。仓库 `docs/` 只记基线数字。
5. **抽样确认**：`scripts/operations/real-eval-sample.mjs` 在生产机上把本版题库遮盖后导出成文件，Andy 在 Mac 线程跑命令拿回来看；Andy 确认前定时器不启用（配置开关默认关）。
6. **提示词**：出题、作答、判分三条进 `packages/prompt-catalog`（新文件 `eval.ts`）并登记 `prompt-manifest.json`。固定指令在前、本条数据在后。

### B. 主动决策评测（等数据）

- 从 `decision_ledger` 取 `owner_rating IS NOT NULL` 且 `kind IN ('proactive','memory_candidate','consolidation')`，按评价换算“正确决定”：pushed+useful→提醒、pushed+unneeded→不提醒、silent+missed→提醒，记忆同理。
- 用现在的判断提示重放当时的输入（`content_ref` 能解密的才重放，不能的计数跳过），比较。每组样本 < 5 时只报“样本不足”。
- 和 A 共用定时器、历史文件。
- 范围：本 PR 只做选样、换算标签、按组计数和“样本不足”报告；重放要用到的证据（邮件头、来源摘要等）不全在 `decision_ledger` 里，等某组评价满 5 条时另开 PR 做重放。不用 `decision_signals` 当标签。固定面板：选中的决策一直保留，新决策只补位。

### C. 合成集降级

- `evals/` 下各集的说明和 ADR 0115 写明“合成对照集”；文档里“主评测”指新集。四个合成集和脚本不动。

### D. LongMemEval

- 跑 S 档 500 题（检索设定，不是官方整段历史喂入），另跑 oracle 500 做读题上限对照；用 Himawari 的混合检索（向量 + 关键词）在每题的会话历史上检索、作答，DeepSeek 判分，提示词用官方结构。文档写明“判分模型不是 GPT-4o，和论文数字只能大致对比”。等 P3-1 合并后用本机向量模型，向量不花钱；作答和判分预计 < 1 美元，跑前报费用。

### E. 测试和检查

- 单元：选样规则（待确认、已取代、过期、分级不可见都不出题）、退役、题干泄题检查、分数和区间、样本不足。
- 集成：真实 SQLite + 本机模型桩，走一遍“出题 → 作答 → 判分 → 写历史”，并有反向用例（拒答题、待确认记忆不出题）。
- `npm run check:prompt-prefix` 覆盖新后台调用的排列；提示词目录检查自动覆盖新提示词。

## 待 Andy 定的点

1. 作答走“检索 + 作答”（便宜、不污染对话列表）还是完整对话运行（更真，但每周几十个测试对话、费用高几倍）。推荐前者。
2. 每周费用上限（按题数估）和走哪个预算。
