## 侧重检查

我先按额外侧重查了下面这些路径，结论如下：

- **错误路径**：严格配置会拒绝未知键（`packages/platform-node/src/strict-configuration.ts:1101-1123`、`:1183-1210`）；payload 写入遇到重复 `ref` 会直接失败（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1686-1692`）；状态目录只初始化固定的几个分区（`packages/platform-node/src/state-root-layout.ts:129-142`）。方案没有写这些端点怎么处理。
- **不合规范/不可信输入**：生成的问题是模型产出的文本，会被再次喂给作答模型和判分模型；方案只对“原话”做 6 字 n-gram、数字、日期、专名检查，没有把“记忆正文”也纳入，也没有防提示注入。
- **安全**：题库会复制真实记忆正文和原话；记忆删除时，现有删除流程只释放 `memory_records.content_ref` 和 `memory_history_events` 的 `content_ref/quote_ref`（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:871-884`），不会碰题库里的副本。抽样导出到 Mac 的文件权限、传输、删除也没有写。
- **资源耗尽**：方案没有题量上限、总题库上限、单次运行费用硬上限、调用超时和取消；首轮可能对全部活跃记忆逐条出题、作答、判分。
- **不可撤销操作**：方案只写“退役”，没有写删除题库副本；一旦题库 payload 被清理或版本轮换，历史分数和题目不可恢复。
- **规则、说明文档和代码一致性**：`npm run check:prompt-prefix` 只跑一个文件里的 `[I-66]` 用例（`scripts/check-prompt-prefix.mjs:8-11`），不会自动覆盖新的后台调用；`TRUSTED_PROMPT_TEXTS` 是手工列模块（`packages/prompt-catalog/src/trusted.ts:10-13`），新提示词不会自动进入可信清单；方案对 LoCoMo 的“LLM 判分”判断与一手论文不符。

## 结论：证实的

### 高

**1. 生产定时器里跑付费评测，和“评测不共用生产预算、先报费用”的规则冲突，方案也没有硬上限。**
证据：`.claude/rules/owner-standing-rules.md:16-18` 要求“任何评测……预计要花超过 0.5 美元时，先在项目聊天报出预计费用……等 Andy 明确同意再开跑”“评测和测试绝不和生产共用预算”；[ADR 0109](docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md:38-40) 要求脚本必须带 `--confirm-cost`、先做 1 token 试探、评测 key 单独设预算。方案 A1 用生产服务内的每周 `setInterval`，A2 用生产默认模型，待定第 2 条仍把“走哪个预算”留给 Andy；按现文实施，无法证明它不共用生产预算，也没有每次运行前的硬上限。`createProductionModelEgress` 只做遮盖（`apps/agent-service/src/production-model-egress.ts:64-88`），不负责预算准入。
建议：拆成“操作者手动触发、带 `--confirm-cost`、独立评测 key/预算、1 token 试探、到上限即停”的脚本；如果坚持定时器，必须由 Andy 明确给出长期授权和每周硬上限，并在每次运行前检查剩余额度，失败即停，绝不走生产 key 或生产预算。

**2. 题库复制真实记忆，记忆删除、取代、改为 restricted 后，题库副本仍然保留。**
证据：A1 把“记忆正文 + 原话”写进题库 payload；A1 对删除/取代只写“题目标退役”，没有删除 payload。现有删除流程只释放记忆本身的 payload 和原话引用（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:871-884`）；数据导出只遍历 `memory_records`（`packages/persistence-sqlite/src/data-export/snapshot.ts:45-54`），题库 payload 不在其中。结果是：主人删除一条记忆后，它的正文仍以加密题库副本留在 `payloads` 里，且导出/删除清单不会列出它。
建议：题库按题存 `memoryId + memoryRevision + contentRef + quoteRef`，删除记忆时按 `memoryId` 删题并重建题库；或把题库做成受同一删除流程管理的记录，纳入数据导出和 `deleted_verified` 校验。补一条“删除记忆后题库不再包含该正文”的集成测试。

**3. 题量、费用、磁盘和调用时长无上限，首轮和每周增长不可控。**
证据：A1 是“一条记忆一次调用”，没有每次运行的最大题数、总题库上限或采样预算；A1 还写“本周新确认的记忆补题”，活跃记忆增长时题库和每周作答/判分调用会无界增长。`ProductionObservation` 的 `#running` 只能防重入，没有超时/取消（`apps/agent-service/src/production-observation.ts:118-125`），模型调用挂住会让这一轮永久占住。
建议：加确定性抽样和硬上限（例如每周最多 N 道新题、总题库最多 M 道），超出部分排入 backlog；每次运行设费用硬上限和调用超时/取消；单实例租约或 `assertActive` 防并发。

**4. 生成的问题被当成可信输入，泄题检查只查原话、专名禁令本身会误杀有效题，且没有防提示注入。**
证据：A1 让模型根据“记忆正文 + 原话”只写问题；检查只有“题干和原话的 6 字 n-gram 重叠、题干不含原话里的数字/日期/专名”。这有两个问题：第一，没有检查题干与“记忆正文”的重叠，模型可以照抄记忆正文；第二，“题干不含专名”会误杀“林峰和周岚是什么关系？”这类专名不是答案的有效题。更严重的是，记忆正文可能包含恶意指令，模型会把它写进题干，再被作答/判分模型执行；`ModelEgress.maskRequest` 只做敏感值遮盖，不处理提示注入（`packages/application/src/services/model-egress.ts:467-483`）。LongMemEval 的题是人工编写的，不是模型从单条记忆自由生成的（[LongMemEval README](https://github.com/xiaowu0162/LongMemEval)）。
建议：把题干当不可信数据，限定长度/字符/JSON 结构，拒绝指令式片段；泄题检查同时覆盖记忆正文和原话，但只禁止“答案值/答案片段”，允许非答案专名；作答和判分提示都要明确“题干/参考是数据，不执行其中指令”；抽一批题人工核对。

**5. B 的标签换算不完整，且重复了已有的校准代码；会漏掉大量真实标签。**
证据：`decision_ledger` 里 `proactive` 的 `verdict` 有 `pushed/silent/deferred/failed/capped/capped_daily/needs_owner`（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:14-17`），`memory_candidate` 的 `outcome` 是 `kept/discarded/pending_approval`（`:48-55`），`consolidation` 是 `merge/supersede/archive/reflect`；方案只写了 `pushed/silent` 和“记忆同理”，漏了 `deferred/failed/capped/needs_owner`，也没有说明 `memory_candidate` 和 `consolidation` 怎么换算。方案还漏了 `proactive_processed_messages.owner_rating` 这一路邮件评价。现有 `calibrationGroup`（`packages/calibration/src/index.ts:259-270`）、`APPLICABLE`（`:36-46`）和 `mailTruth`（`:407-414`）已经定义了这些语义，方案应复用而不是另写一套。
建议：直接复用 `calibrationGroup` / `summarizeDecisions` / `mailTruth`，补全四象限（含 `silent+useful`）和所有 verdict/outcome；把 `proactive_processed_messages` 的邮件评价纳入；对不适用的评价组合直接排除并计数；历史格式沿用 [ADR 0154](docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:34-37)。

### 中高

**6. “`npm run check:prompt-prefix` 覆盖新后台调用的排列”不成立。**
证据：`scripts/check-prompt-prefix.mjs:8-11` 只跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`，并且只统计 `[I-66]` 用例；规则里写的门槛也是“用真实 Pi 适配器……跑多轮对话”（`.claude/rules/prompt-prefix.md:74`）。新增的出题、作答、判分是独立后台调用，不会被这道检查自动覆盖。方案 A6 也只写“固定指令在前、本条数据在后”，没有写“当前时间放在最后”，与规则第 15 条不完全一致（`.claude/rules/prompt-prefix.md:67`）。
建议：为评测调用单独加一个前缀测试或扩展检查器：固定系统提示/工具/指令逐字节不变，本次数据在最后，时间/日期只出现在最后的可变段；并加反向用例（把时间放到固定段、把记忆块放到历史中间时检查必须失败）。

**7. 新配置键、payload ref、题库版本号、历史 schema、状态目录都没有定义；严格配置和 payload 存储会拒绝或产生歧义。**
证据：`parseRunPolicy` 对 `runPolicy` 做 `rejectUnknown`（`packages/platform-node/src/strict-configuration.ts:1101-1123`），新键没进白名单会直接启动失败；`parseProductConfiguration` 对顶层同样拒绝未知键（`:1183-1210`）。`putPayload` 对重复 `ref` 抛 `PORT_DUPLICATE`（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1688-1692`），方案没有写内容寻址/幂等；`initializeStateRoot` 只建固定的 data/runtime/cache/payload-ciphertext（`packages/platform-node/src/state-root-layout.ts:129-142`），新增 `real-eval/` 目录没有权限、备份、清理设计。题库版本号如果直接拼进文件名，还有路径穿越风险。
建议：明确配置键名并加入 `RunPolicyConfiguration`、`parseRunPolicy` 白名单和解析函数；题库版本号限定固定字符集或直接用哈希；payload ref 用独立前缀 + 内容哈希，写入前先 `get` 复用；状态文件用临时文件 + fsync + rename，目录 0700 并校验 owner；补严格配置、重复写入、路径穿越、状态目录权限的测试。

**8. 敏感值/占位符检查不完整；新提示词不会自动进入可信清单。**
证据：A1 只写“原话经遮盖后出现占位符的题丢弃”，没有写记忆正文或标准答案关键值出现占位符怎么办；A3 的程序快通道用“原话关键值”匹配，但作答模型看到的是遮盖后的文本，敏感题的快通道必然对不上。`ModelEgress` 默认用全局 `TRUSTED_PROMPT_TEXTS`（`packages/application/src/services/model-egress.ts:225`），而 `trusted.ts` 是手工列模块（`packages/prompt-catalog/src/trusted.ts:10-13`）；`prompt-catalog.unit.test.ts:299-318` 只检查 manifest，`trusted-prompt-egress.unit.test.ts:130,148-149` 只断言 `MEMORY_CAPTURE`，不会发现新 `eval.ts` 没加入可信清单。这正是 I-78 的同类问题。
建议：对记忆正文、原话、标准答案关键值都计算同一套遮盖结果，任一出现占位符就丢弃该题或改用不依赖该值的判分；作答和判分使用各自固定的可信清单（可通过 `ModelEgress` 的 `trusted` 覆盖参数传入，避免改全局清单），并补“目录里每个条目经生产出口原样发出”的测试。

**9. 作答路径用裸 `DurableMemoryService.search`，不是生产对话的 context formation；k、模型、档案、规则没有固定，分数不可比。**
证据：生产对话通过 `ContextFormationService` 取记忆并排除 `profileMemoryIds`、应用分类上限和 `maxSelectedMemories`（`packages/application/src/services/context-formation-service.ts:236-281`）；`createProductionRunMemory.search` 还有自己的分类/ref 校验（`apps/agent-service/src/production-run-memory.ts:339-381`）。方案 A2 直接说“用生产的 `DurableMemoryService.search`”，没有说是否包含主人档案、主人要求、k 是否等于 `maxSelectedMemories`、是否排除 profile 记忆。A2 又用“生产对话默认模型”，主人换模型后分数会跟着变，无法区分是记忆变好还是模型变好。
建议：直接复用 `ContextFormationService`/`ContextProjection` 组装与生产完全相同的头部（固定系统提示、工具、档案、规则），把当前时间、记忆块和问题只放在最后一条消息；固定 k、固定评测模型（只允许低价模型）、固定 `asOf`，并在历史里记录。

**10. 题库逐周累积、按记忆退役，分母和样本组成每周变化，和“题目冻结 = 可复现”矛盾。**
证据：A1 写“已在题库里的记忆不重出题；本周新确认的记忆补题”“退役不再计分”。这会让题库越来越大、老记忆占比越来越高，且每周计分题数随退役变化；同一道题在不同周看到的环境（记忆库、日期、其他记忆）也变了。LongMemEval 是固定的 500 题（[README](https://github.com/xiaowu0162/LongMemEval)），方案 A 没有类似固定面板。
建议：同时维护“固定面板”和“本周新抽样”：固定面板只冻结题和判分标签，用于趋势；新抽样用于覆盖当前分布；两者分开报告。抽样用确定性种子，记录退役/跳过数量，固定 `asOf`，不要让分母随退役悄悄变化。

**11. 判分没有和人工标注对齐；生成题也没有验证，LongMemEval 的 GPT-4o 判分不能直接换成 DeepSeek 就宣称可比。**
证据：工程案例库要求“模型裁判先和人工标注对齐”（`docs/engineering-casebook.md:2587`）；LongMemEval 官方 `evaluate_qa.py` 的 `model_zoo` 明确是 `gpt-4o`（[源码](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py)），方案 D 却只说“和论文数字只能大致对比”，没有对齐步骤。方案 A 的判分同样是 DeepSeek，但没有人工校准。
建议：让 Andy 对分层抽样（例如 50 题：正题、拒答题、敏感题各若干）给标签，计算判分模型与人工的一致率；一致率不达标就先改提示词或改规则，不要直接出分。生成题也做同样的人工核对，记录“不可答/歧义/泄题”的比例。

### 中

**12. D 的 LongMemEval 设计缺每题隔离、检索指标、oracle 全量上下文、类型化判分和 30 道弃权题处理；本机 embedding 门槛也没有校准。**
证据：LongMemEval README 明确 `longmemeval_oracle.json` 只包含证据会话（“Only the evidence sessions are included in the history”），所以 oracle 若也走检索，就不是“读题上限”；官方检索指标是 session/turn 的 `recall_all@5/10`、`ndcg_any@5/10`（[print_retrieval_metrics.py](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py)），并且检索评估跳过 30 道 `_abs` 弃权题；判分按题型有不同模板（temporal 允许 off-by-one、knowledge-update 允许旧信息+新答案、preference 用 rubric、abstention 用单独模板）。方案只写“检索设定 + 作答 + DeepSeek 判分”，没有这些。另，[ADR 0115](docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md:42) 明确“门槛和向量模型绑定，换模型要重新校准”，方案 D 用本机向量模型却没有说重新定门槛。
建议：每个 question 单独 owner/agent 或索引 scope，禁止跨题检索；报告 session/turn recall@5/10 和 ndcg；oracle 对照直接喂全部 oracle 会话作为上下文；判分按题型用对应模板；检索指标跳过 30 道弃权题，QA 指标保留；本机 embedding 要么用生产模型，要么先校准门槛并记录。

**13. “Andy 确认前定时器不启用”和“先抽样确认题库”互相矛盾；没有一次性运行入口、崩溃恢复和并发/租约设计。**
证据：A1 说题库由定时器生成，A5 说 Andy 确认前定时器不启用，但又要“把本版题库遮盖后导出”给 Andy 看；如果定时器关着，题库从哪来没有写。A1 用状态目录只存 metadata，崩溃可能留下“payload 已写、metadata 未写”或反之；多实例部署时没有租约，两个进程可能同时生成、同时花钱。
建议：提供显式的一次性 `runOnce` 命令（手动触发、带费用上限），先生成候选题库和样本，Andy 确认后再打开定时器；题库写入用事务或临时文件 + rename，先写 payload 再写 metadata，启动时清理孤儿；用数据库租约或现有 authority lease 保证单实例；补崩溃恢复和并发测试。

### 低到中

**14. 对 LoCoMo 的判断错了：LoCoMo 原论文用 F1/ROUGE/FactScore，不是 LLM 是/否判分。**
证据：LoCoMo 论文原文“For each category, we calculate the F1 score for exact matches”（[arXiv HTML](https://arxiv.org/html/2402.17753v1)），表 2 也写“Results are based on F1-score for answer prediction”；Mem0 论文才明确使用“LLM-as-a-Judge”（[arXiv 2504.19413](https://arxiv.org/abs/2504.19413)）。方案的“LongMemEval、LoCoMo、Mem0 论文都用问答 + LLM 判分（是/否）”把 LoCoMo 说错了。
建议：改掉这条前提；如果只是借鉴 Mem0 的 judge，就写 Mem0；不要把 LoCoMo 当成是/否判分的依据。

**15. C 修改 ADR 0115 的写法有风险；ADR 0115 已经写明是合成数据，不需要改正文。**
证据：ADR 0115 第 66 行已经写“全部是合成数据，不含 Andy 的真实记忆”；仓库既有做法是旧 ADR 正文不变，用新 ADR/注记表达取代关系（例如 ADR 0067/0069 的说明）。方案说“文档里‘主评测’指新集”，这是改变评测定位的决定，不应只改旧 ADR 的措辞。
建议：新开一份 ADR 说明“真实记忆评测为主、合成集降为对照/回归”；ADR 0115 正文不改，最多加一行指向新 ADR 的注记；等新评测有门槛后再用“主评测”这个词。

**16. 用“生产对话默认模型”作答，可能随主人偏好变化，甚至命中贵模型；也没有说明离线判分和作答模型是否固定。**
证据：`.claude/rules/owner-standing-rules.md:18` 禁止在按 token 付费渠道调用 Claude/OpenAI 或同价位模型，代码和评测脚本不得写死 `anthropic/`、`openai/` 开头的模型名；`scripts/check-expensive-models.mjs:45-48` 会扫描这些模式。生产默认模型由主人的选择决定，不是固定值。
建议：评测固定用 DeepSeek V4.1 Flash 这类低价模型，并在配置里显式写评测模型；如果确实要测“生产默认模型”，单独一列报告并记录模型名，不要把它和记忆能力趋势混在一起。

## 推测（实施前需要验证）

1. **首轮实际题量和费用可能远超 0.5 美元。** 方案没有给当前活跃记忆数、每题 token 估算、失败重试次数；需要先查生产 `memory_records` 数量和 `payloads` 大小，再按最坏情况估算。
2. **本机向量模型与生产 Qwen 的门槛不兼容。** P3-1 合并后的本机模型维度和相似度分布未核实；按 ADR 0115，换模型必须重新校准 `minimumSimilarity`，否则 LongMemEval 结果没有意义。
3. **`episodeProtector` 是否适合保存任意题库 payload。** 目前只在记忆 episode/consolidation 路径看到它的使用；它的 `protect/unprotect` 是否接受任意 `contentType`、分类和 ref，未核实。
4. **新增 `real-eval/` 目录是否会被备份、清理、S9 控制文件覆盖。** 现有 `initializeStateRoot` 只建固定分区，`release-cleanup-remote.py` 会遍历 state root 子目录；需要确认新目录不会被误删或漏备份。
5. **把 `eval.ts` 加入全局 `TRUSTED_PROMPT_TEXTS` 是否会改变老对话的遮盖字节。** 规则第 11 条说可信固定文字清单变化会影响遮盖；如果评测固定文字包含通用短语，可能影响已有消息。用独立 `trusted` 清单可以规避，但需要验证。
6. **6 字 n-gram + 专名禁令会不会把大部分有效题丢掉。** 对中文短原话和关系类记忆，这个启发式可能过严或过松；需要先用真实记忆做小样本试跑，统计丢弃率。
7. **“Andy 在 Mac 线程拿回来看”的传输路径未定义。** 题库导出文件在 Mac 上如何保存、如何删除、是否加密，方案没有写；需要按生产机到 Mac 的安全传输流程补。
8. **0087/0088 的串行状态未核实。** 仓库当前迁移到 0086，方案说“避开 0087/0088 的串行”，但这两份迁移的排期和是否存在无法从当前提交确认。

## 如果由我来定，我会这样改

我会把方案拆成“先离线、后定时”的两步，并先解决数据生命周期和费用，再谈自动化：

1. **不做生产服务内的周定时器作为第一版。** 先做一个操作者手动触发的评测脚本：显式 `--confirm-cost`、独立评测 key/预算、1 token 试探、硬费用上限、超时/取消、单实例租约。等脚本稳定、Andy 看过样本和费用后，再决定是否加定时器；定时器默认关，且必须有每周硬上限和失败即停。
2. **题库落到可事务管理的表，而不是“payload + 状态文件”。** 表里存 `questionId、bankVersion、memoryId、memoryRevision、contentRef、quoteRef、question、kind、standardAnswer、createdAt、retiredAt、retiredReason、questionModel、promptVersion`，唯一键 `(bankVersion, memoryId, memoryRevision, questionId)`。题库 payload 仍可加密，但题库的元数据、退役、删除、租约、幂等都在一个事务里。迁移排期可以等，但不要用文件模拟事务。
3. **选样冻结 `asOf`，固定面板 + 每周新抽样。** 固定面板用于趋势，新抽样用于当前分布；每轮确定性抽样、硬上限、backlog；只选 `active + tentative=0 + superseded_by IS NULL + valid_to 未过期 + isModelVisible + 有原话 + 当前 revision 已索引` 的记忆。记忆内容 revision 变化、删除、取代、过期、改为 restricted/tentative 时退役，并删除题库里的正文副本。
4. **出题只让模型写问题，不让它写答案；但把题干当不可信输入。** 解析 JSON，限制长度/字符，拒绝指令式文本；泄题检查同时覆盖记忆正文和原话，只禁止答案值/答案片段，允许非答案专名；敏感值遮盖后出现占位符的题直接丢弃；用一小批人工标注估计“不可答/歧义/泄题”率。
5. **作答复用生产 context formation 的头部。** 用与生产相同的系统提示、工具、主人档案、主人要求和记忆块格式；固定 k = `maxSelectedMemories`、固定评测模型、固定 `asOf`；当前时间、记忆块、问题只放在最后一条消息。所有题共用同一个冻结头部，以命中 KV 缓存并保证可比。
6. **判分按题型写提示词。** 正题、拒答题、时间题、知识更新题、偏好题分别用对应模板；程序快通道只做确定性归一化和明确的答案匹配，并处理否定；其余交模型。先用 Andy 的人工标签校准判分模型，一致率达标后才出分；报告正确/错误/弃答，以及固定面板、新抽样、退役/跳过数量。
7. **B 不再另写一套。** 直接复用 `calibrationGroup`、`summarizeDecisions`、`mailTruth` 和 ADR 0154 的周报/历史格式；补全所有 verdict/outcome，纳入 `proactive_processed_messages` 的邮件评价；本轮只做标签和计数，重放等有足够样本另开 PR。
8. **C 用新 ADR 表达“合成集降为对照”，不改 ADR 0115 正文。** D 的 LongMemEval 每题隔离、报告检索指标、oracle 全量上下文、按题型判分、跳过 30 道弃权题的检索指标、用生产 embedder 或重新校准门槛、先报费用。
9. **检查补齐。** 至少要有这些自动检查，并且反向用例在旧代码上会失败：配置未知键被拒、题库重复写入幂等、记忆删除后题库不再含该正文、敏感题被丢弃/不再用明文快通道、题库顺序和 JSON 序列化确定、评测调用前缀固定、可信提示条目原样发出、费用上限到达即停、定时器默认关、抽样导出文件遮盖且权限正确、历史 schema 兼容、LongMemEval 每题隔离。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会改变现有对话的请求开头，前提是评测不接入、不改写任何真实对话线程。方案 A2 明确不开真实对话线程，这是对的。但方案需要进一步约束：所有评测请求应共用同一份冻结头部（系统提示、工具、档案、主人要求），每道题只把当前时间、记忆块、问题放进最后一条消息；不要每道题重新组装不同的系统提示。规则要求固定在前、会变的在后（`.claude/rules/prompt-prefix.md:27-29`），生产 `turnPrompt` 也是把时间和记忆块放在最后一条用户消息里（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`）。另外，如果为了新提示词把 `eval.ts` 加入全局 `TRUSTED_PROMPT_TEXTS`，会改变可信固定文字清单，按规则第 11 条可能改变老对话的遮盖字节（`.claude/rules/prompt-prefix.md:53`）；建议用评测专用的 `trusted` 清单，不改全局清单，或加一条“老提示词遮盖前后逐字节相同”的测试。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

有风险，需要设计约束：
- 题库的序列化顺序必须确定：查询要有 `ORDER BY memoryId, memoryRevision, questionId`，JSON 键顺序固定；否则同一题库的 `sha256` 和 payload ref 可能不同。
- 随机抽样和 20% 拒答题替换必须用确定性种子，或者在写入题库前就冻结；不能在每次运行时重新随机。
- 记忆块里的日期、`asOf`、当前时间会随周变化；这些必须只出现在最后一条消息，并记录到历史/题库版本中，不能进入固定指令。
- 遮盖必须确定：同一段文字只能依赖它自己和前面的内容（`.claude/rules/prompt-prefix.md:51-54`）；不要依赖后文、时间、无序集合。评测提示词如果包含时间/哈希，也要放在最后的可变段。
- `history.jsonl` 里的提交号、模型名不是模型输入，不影响字节；但题库 payload 的 `sha256` 不要把这些每轮变化的值算进去，除非明确作为版本的一部分。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

按现方案不够。方案 E 列了单元和集成测试，但没有覆盖：费用硬上限和到达即停、定时器默认关、严格配置未知键、payload 重复写入幂等、记忆删除后题库副本消失、可信提示清单包含新条目、评测调用前缀（现有 `check:prompt-prefix` 不覆盖后台调用，见 `scripts/check-prompt-prefix.mjs:8-11`）、抽样导出遮盖和文件权限、历史 schema 兼容、LongMemEval 每题隔离、判分与人工一致率。反向用例也不能只写“拒答题、待确认记忆不出题”两条，还要有“把时间放进固定段检查必须失败”“把记忆块放进历史中间检查必须失败”“去掉删除级联后测试必须失败”“把新提示移出可信清单后出口遮盖测试必须失败”这类会真正失败的用例。按 `.claude/rules/incident-gates.md:14-17`，没有“在复现上会失败、修复后会通过”的证据不算门槛。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不能，方案还没有逐个核对两端。至少这些值需要明确：
- 新配置键：必须加进 `RunPolicyConfiguration`、`parseRunPolicy` 白名单和解析函数，否则启动直接失败（`packages/platform-node/src/strict-configuration.ts:1101-1123`）。
- 题库版本号：如果用于文件名，必须限定安全字符集或哈希，防路径穿越。
- payload ref：`putPayload` 遇重复直接失败（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1688-1692`），必须内容寻址 + 先 `get` 复用，并定义独立前缀。
- `kind`、`question`、`standardAnswer` 的长度和允许值：没有定义，判分/报告/数据库都没有校验。
- 历史 schema：没有定义版本号、必填字段和损坏行处理；ADR 0154 明确历史损坏行要跳过并提示（`docs/adr/0154-weekly-calibration-report-and-muse-mail-pairing.md:57`），新文件也应照做。
- 提示词 ID、`layer`、`output`、`parser`、`usedBy`：要能被 `prompt-catalog.unit.test.ts:299-318` 和 `prompt-wording` 接受；新 `eval.ts` 还要决定是否加入 `trusted.ts`（`packages/prompt-catalog/src/trusted.ts:10-13`）。
- 题库 payload 的分类、生命周期、数据导出/删除：要能被 `payloads` 的 `classification/lifecycle_state` 和治理删除接受；目前删除流程不认识题库副本（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:871-884`）。
- `real-eval/` 状态目录：要能被 `initializeStateRoot` 的权限模型和备份/清理流程接受（`packages/platform-node/src/state-root-layout.ts:129-142`）。

这正是 [I-73](docs/incidents-and-gates.md#incidents) 的教训：不能只看改动本身，要把产生值的端和使用值的端都接起来测一遍。
