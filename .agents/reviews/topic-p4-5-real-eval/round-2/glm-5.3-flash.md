现在去核对 LongMemEval 的一手来源。
# P4-5 线程方案审核报告

## 先说核对过的前提（都属实）

- `0054_memory_consolidation.sql:1` 加 `tentative`（材料改口 0052→0054 是对的）；`0001_initial_product_schema.sql:398` `status` 含 `'active'`，`0052` 加了 `valid_to`/`superseded_by`。
- `production-memory-consolidation.ts:10-27` `quoteRefOfMemory` 取 `contentRef` 相同、`occurredAt` 最早的 `quoteRef`；`service-main.ts:1461-1478` `readQuote` 经 `episodeProtector.unprotect`，只能在生产服务进程里读——方案「抽样确认在生产机上导出」的前提成立。
- `0069_decision_ledger.sql:27` `owner_rating` CHECK 和 kind 枚举属实。
- `packages/calibration/src/index.ts:2-3` `DEFAULT_MINIMUM_SAMPLES=5`、`WILSON_Z=1.96`，且 `proportion()`（192 行）已经是现成的「Wilson 区间 + 样本不足」实现。
- `evals/memory-retrieval/dataset.json:3` 「合成数据」属实；ADR 0115、`createProductionModelEgress`（`production-model-egress.ts:64`）、规则第 15 条（`.claude/rules/prompt-prefix.md:67`）均属实。
- LongMemEval：README 原话 `longmemeval_s.json` "roughly consumes 115k tokens (~40 history sessions)"、"Within each file, there are 500 evaluation instances"、`evaluate_qa.py gpt-4o`，均与方案一致（https://github.com/xiaowu0162/LongMemEval）。

---

## 问题清单（按严重度）

### 1.【高·证实】B 的标签映射和 `decision_ledger` 的 CHECK 约束对不上——I-73 同类错误

方案 B 写「pushed+useful→提醒……记忆同理」。但：

- `0069_decision_ledger.sql:41`：`CHECK ((kind = 'proactive') = (verdict IS NOT NULL))`——**memory_candidate / consolidation 行的 verdict 必须是 NULL**，「pushed+useful」这类按 verdict 过滤的条件对记忆行永远选不出东西，记忆组会永远「样本不足」。
- 记忆行的「做了没做」在 `outcome`（`kept`/`discarded`/`pending_approval`；consolidation 是 `merge`/`supersede`/`archive`/`reflect`，见同文件 48-55 行）。
- 映射还漏了 `silent+useful`（校准包里明确是「不提醒是对的」，`packages/calibration/src/index.ts:64`），以及 verdict 为 `deferred`/`failed`/`capped`/`capped_daily`/`needs_owner` 的行怎么算。

建议：不要新写映射。`packages/calibration` 已有现成且带测试的等价物——`calibrationGroup()`（index.ts:259-270，用 `COALESCE(outcome, verdict)`，见 629 行 SQL）、`APPLICABLE`（36-46 行）、`mailTruth()`（407-414 行，正是「提醒/不提醒 + useful/unneeded/missed → 正确决定」的换算）。B 直接复用它们，反向用例里加「用 verdict 查记忆行必须选出 0 条、用 COALESCE 才有数」。

### 2.【高·证实】A 的每周定时器在生产服务进程里自动调付费模型，方案里没有代码内的硬费用上限

事故 I-11（`docs/incidents-and-gates.md:50`）的根因就是「评测线程没报费用就跑真模型评测，把预算推过上限，生产对话 402」。现有两道先例门槛都在**脚本**里：ADR 0109（`docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md:38`）`--confirm-cost` + 花到上限不再开新调用；ADR 0115 的 eval 也先发试探请求。本方案的定时器在生产进程里、Andy 不在场、每周自动跑，「每周费用上限」只是待定事项。建议：实现时就把 ADR 0109 的三件套搬进服务：按题数算出的 `costLimitMicros`、开跑试探、超限停止并写日志；开关默认关只是第一道，不是费用防线。

### 3.【中·证实】E 的「`npm run check:prompt-prefix` 覆盖新后台调用的排列」不成立

`scripts/check-prompt-prefix.mjs:9-11` 只跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 里带 `[I-66]` 标签的固定一组测试（对话路径，逐字节比前缀）。出题/作答/判分是一次性后台请求，不经过 Pi 适配器的多轮路径，这条检查碰不到它们；规则第 15 条（后台调用固定的在前、会变的在后）目前没有专门门槛。建议：为 eval 三条提示词的拼装写专门的排列断言测试 + golden 快照，并把 golden 名字手工加进 `prompt-rendering-golden` 测试名单（ADR 0161 明说「新增样本要先把名字加进测试的名单」）。

### 4.【中·证实】新提示词必须手工挂进 `trusted.ts`，漏挂是静默故障

`packages/prompt-catalog/src/trusted.ts:10-13` 的模块列表是手写的。新增 `eval.ts` 若忘了挂进去，三条新提示词不进 `TRUSTED_PROMPT_TEXTS`，出口遮盖会把固定指令当外来内容检查——I-78（`incidents-and-gates.md:116`）正是这类静默故障（「1000」被遮成占位符，打分说明坏了很久）。方案没提这一步。建议：写进方案并在 `trusted-prompt-egress.unit.test.ts` 加反向用例（eval 条目不经遮盖原样发出）。

### 5.【中·证实】D 的 LongMemEval 应使用 2025-09 清洗版数据集，且检索评测官方跳过 abstention 题

官方 README News（2025/09）："We have further cleaned up the history sessions to prevent interference on answer correctness"，数据在 https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned （`longmemeval_s_cleaned.json`）。README 另写明检索评测 "we always skip the 30 abstention instances"；QA 判分里 abstention 用独立提示词（`evaluate_qa.py` 的 `get_anscheck_prompt(..., abstention=True)`）。建议：用 cleaned 版、检索指标跳过 `_abs` 题、判分 temperature 设 0（官方 `temperature: 0`，方案没写）。

### 6.【低·证实】`real-eval/history.jsonl` 的生产端（服务写）和消费端（报告脚本读）之间缺契约测试

这正是 I-73 的教训（「双模型复核只看了 diff，没问清单里的 id 能通过后端校验吗」）。仓库里已有可照抄的做法：`test/integration/calibration-report.test.ts:271-413` 对 `history.jsonl` 做读写契约测试。方案 E 的测试清单没列这条。另外要定义：服务写一半崩溃、sha256 不匹配时的行为。

### 7.【低·证实】「题库冻结 = 可复现」依赖选样查询有确定排序，方案没写

选样条件（`status='active' AND tentative=0 AND ...`）如果不加 `ORDER BY memory id`，同一批记忆两次选样的顺序可能不同，题库 payload 的 sha256 就不可复现。出题「一条记忆一次调用」部分独立，但写盘和清单要按稳定键排序。

### 8.【低·证实】C 直接改 ADR 0115 的文字不合本仓库惯例

ADR 0115:113 写着「以后每次改检索都先跑 `npm run eval:memory-retrieval` 与本 ADR 的基线比较」。仓库处理决定变更用 supersedes/新 ADR（如 ADR 0149 取代 0104）。建议：新开一条 ADR 记「真实记忆集为主评测、合成集降为对照」，0115 原文不动（或只加一行指向新 ADR 的链接）。

### 9.【低·推测】「避开 0087/0088 的串行」引用了本检出里不存在的迁移号

`packages/persistence-sqlite/src/migrations/` 只到 0086。可能是并行线程占用，落地前要核实，否则这是幻影前提。

### 10.【低·证实，写进局限】被改写过的记忆不会进题库

`quoteRefOfMemory` 只取 `contentRef` 相同的最早 `quoteRef`（`production-memory-consolidation.ts:20-24`）。「补充细节」等改写换了 `contentRef` 而捕获时没存新 quote 的记忆，取不到原话 → 不出题。题库会系统性地偏向「从未改写过」的记忆。方案 A1 的局限清单（不测工具调用、不测对话历史）应补上这一条。

---

## 侧重检查

走的流程：**最普通使用流程（Andy 发一条消息 → 带记忆回答）**：方案不触碰 `production-run-memory.ts`、`production-memory-recall.ts`、对话组装和冻结前缀，对话路径不受影响（已核对 `DurableMemoryService.search` 支持 `recordUse: false` 和 `includeTentative` 默认关，`durable-memory-service.ts:367-428`——A2 的检索指标做法与生产语义一致）。**新周流程**：定时器 → 选样（读 `memory_records` + 历史事件取原话）→ 出题（遮盖后调模型）→ 程序校验 → 存加密 payload → 作答（生产检索 + 单条请求）→ 判分 → 写 `history.jsonl` → 报告脚本。其中**没有测试覆盖、方案也没提的路径**：① 状态目录里「版本号→payload ref」JSON 的损坏/半写恢复；② `real-eval-sample.mjs` 在生产机上解密再遮盖导出的整条路径；③ 定时器某周失败后的重试/退避（`ProductionMemoryConsolidation` 有 `RETRY_AFTER_MS` 先例可抄，`production-memory-consolidation.ts:8`）；④ 历史文件并发写。**文档一致性**：E 的两条检查声明各有一处不符（见问题 3、4）；C 对 ADR 0115 的处理（问题 8）；「P3-1 合并后用本机向量模型」——P3-1 未核实。

---

## 如果由我来定

方案方向（换真实分布的数据源、问答+LLM 判分、题库版本冻结、Wilson 区间、样本不足不出分）是对的，与 LongMemEval/LoCoMo/Mem0 的成熟做法一致，判分提示沿用官方结构换成 DeepSeek 也符合「禁贵模型」规则（DeepSeek 不在 `check:expensive-models` 的拦截范围）。我会这样改：

1. **A**：采纳，但①费用三件套（上限、试探、超限停）进代码，作为启用开关的前置条件；②选样加稳定排序；③`eval.ts` 挂进 `trusted.ts` 并加反向用例；④补「改写过的记忆不出题」局限；⑤定时器失败退避照抄 `RETRY_AFTER_MS` 模式。
2. **B**：不自己写映射，直接复用 `packages/calibration` 的 `calibrationGroup` + `APPLICABLE` + `COALESCE(outcome, verdict)`；反向用例证明按 verdict 过滤记忆行选不出东西。
3. **C**：新 ADR，不改 0115 正文。
4. **D**：用 `longmemeval_s_cleaned.json`；检索指标跳过 30 条 abstention；判分 temperature 0；跑前报费用照 ADR 0109。
5. **E**：修正两条检查声明；补 `history.jsonl` 契约测试、eval 提示词排列测试 + golden、题库状态文件损坏用例。

**必答问题：**

1. **不会改变已见请求开头。** 三条新调用（出题/作答/判分）都是一次性后台请求，没有跨请求共享的前缀；对话请求一个字节都不动（方案不改系统提示、工具定义、历史、遮盖逻辑）；`prompt-catalog` 只新增条目，不动旧条目文字，所以 `TRUSTED_PROMPT_TEXTS` 只增长、已发历史不受影响（规则 11 注明的「改旧文字会让老对话开头变一次」不触发）。作答请求没有「每轮」，会变的值（检索结果、题干、参考答案）全部在末尾的数据段，固定指令在前——符合规则第 15 条。唯一前提是问题 4 里 trusted 挂载要做对。
2. **不会。** 遮盖占位符是 `HMAC(key, kind\0value)` 的确定性函数（`model-egress.ts:121-126`），同文字同字节，满足规则第 11 条；题库冻结后题干/答案字节固定，状态目录只存数字、版本号、sha256。残余的非确定来源：判分模型输出（设 temperature 0 可减）、选样集合顺序（加 ORDER BY 解决）、payload 加密密钥轮换（会换占位符字节，属既有属性，新题库版本标注即可）。
3. **部分有。** 单元/集成测试清单方向对，反向用例（拒答题、待确认不出题）按仓库惯例要求「改前红」；但 E 里「`check:prompt-prefix` 覆盖新后台调用」是错的（它只跑对话路径的 `[I-66]` 测试，`check-prompt-prefix.mjs:9-11`），「提示词目录检查自动覆盖」只对 manifest sha256 成立、golden 和 trusted 挂载都要手工。补齐问题 3、4、6 的检查后这条才算闭环。
4. **逐对核对结果**：① B 的标签 → CHECK 约束：**证实不符**（问题 1）；② `history.jsonl` → 报告脚本：缺契约测试（问题 6）；③ `eval.ts` → `TRUSTED_PROMPT_TEXTS`：手工挂载会漏（问题 4）；④ 出题模型的 `question`/`kind` 输出 → 程序校验：泄题检查有，但 `kind` 要加程序端值域白名单，不能信模型；⑤ 题库 payload → `payloads` 表：走现有 `payloadStore`（参照 `service-main.ts:1480` 的 ref 命名模式），payload ref 本身的校验规则未核实，实现时确认新前缀能过；⑥ 配置开关 → 服务组装：默认关，两端一致。
