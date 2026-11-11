# P4-5 真实评测集方案

## 结论先行

我建议把这次改动做成**开发侧、离线的两套真实评测流水线**，不碰生产会话的提示词组装：

- 真实记忆回忆集：从生产导出中筛“已确认、未取代、未过期、有原话”的记忆，**答案取数据库里的原话，生成模型只写问题**；Himawari 作答主路径用生产检索代码 + 一次作答调用，完整对话只做小样本回归。
- 主动决策集：先只做 `proactive`、`memory_candidate`、`consolidation` 三类已评价决策的“上下文重放”，按评价分层抽固定面板；样本不足就只报案例和 Wilson 区间，不填合成数据。
- 真实数据不进仓库，放独立的私有快照目录/加密对象存储；仓库只放 schema、生成器、运行器、测试、指标历史和哈希。
- 每周自动更新只能在“快照已经由 Andy 导出并确认”之后自动跑；在“ssh 只能 Andy 执行”的约束下，端到端全自动从生产取数做不到，应明确标成需要 Andy 拍板的边界。
- LongMemEval 建议跑 **S 档 500 题，但用检索 top-k 而不是塞满 115k token**；oracle 500 作为便宜的可比自检；M 不跑。判分模型不用 GPT-4o，必须写明“非官方判分，分数不可直接横比”。

---

## 一、方案依赖的前提（已读代码/来源证实）

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 记忆正文和原话在生产是加密的，只有生产服务进程能解 | `apps/agent-service/src/service-main.ts:1467`：`const quoteRef = quoteRefOfMemory(events, record.contentRef);`；`:1469-1477`：读取 payload 后 `episodeProtector.unprotect` |
| P2 | 原话取的是“与当前 content_ref 相同的最早一条历史事件” | `apps/agent-service/src/production-memory-consolidation.ts:18-25`：`filter((event) => event.quoteRef && event.contentRef === contentRef)`，排序后取 `[0]?.quoteRef` |
| P3 | 原话确实存在记忆历史表，且和当时内容版本绑定 | `packages/persistence-sqlite/src/migrations/0065_memory_history.sql:7-12`：`content_ref ... quote_ref ... occurred_at` |
| P4 | “已确认”在代码里是 `status='active'` 且 `tentative=false` | `packages/application/src/services/durable-memory-service.ts:266-285`：`confirm` 要求 `currently active && attributes.tentative === true`，然后写 `tentative: false`；搜索过滤见 `:401-421` |
| P5 | 原话是在候选记忆提交时存下的；`unchanged` 也会追加一条带 quote 的历史 | `packages/application/src/services/automatic-memory-service.ts:403-413`：`const quoteRef = candidate.quote ? await content.store(...) : null`；`:421-428` 的 `unchanged` 也带 `quoteRef`；`:467`、`:486` 的 create/update 同样带 |
| P6 | 决策记录有 `kind`、`owner_rating` 和 `inputs`，评价只有 useful/unneeded/missed | `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5-9`、`:27`；`packages/application/src/ports/decision-ledger.ts:52-54`、`:71-131` |
| P7 | 已有校准逻辑按组算比例和 Wilson 区间，少于 5 条不出百分比 | `packages/calibration/src/index.ts:12-34`、`:177-207`、`:280-309`；`DEFAULT_MINIMUM_SAMPLES = 5` |
| P8 | 出口遮盖的占位符由“密钥 + 值”决定，但一次 exchange 内会记住前面的值 | `packages/application/src/services/model-egress.ts:121-126`：`placeholderTag` 对 `${kind}\0${value}` 签名；`:200-229` 使用 `this.#known`；`:225` 默认 `TRUSTED_PROMPT_TEXTS` |
| P9 | 请求开头只能追加，会变的值只能放最后一条用户消息 | `.claude/rules/prompt-prefix.md:27-29`：“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”；`:35-36`：“已经发给过模型的内容……只能在末尾追加”；`:53`：改提示词文字会影响老对话冻结的遮蔽字节 |
| P10 | I-73 的教训是：产生方和消费方两端的校验都要核对，不能只测改动 | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”；修复门槛是 `npm run check:model-ref-contract` |
| P11 | 现有记忆导出是所有者发起的，网页导出会解密并遮盖机密；证据字段只在带 `--with-evidence` 的管理命令里 | `apps/agent-service/src/production-data-export.ts:107-140`；`packages/persistence-sqlite/src/data-export/snapshot.ts:45-69`、`:121-139`、`:150-165`；`apps/admin-cli/src/data-command.ts:142-162` |
| P12 | 现有记忆检索评测是合成数据，只追加历史；实际向量调用走 `testModelEgress` | `evals/memory-retrieval/dataset.json:3`：“合成数据，不含 Andy 的真实记忆”；`scripts/memory-retrieval-eval/live.mjs:108` 只做 `appendFileSync`；`test/integration/memory-retrieval-eval/live.test.ts:158` 使用 `testModelEgress()` |
| P13 | 现有记忆抽取 live 评测直接 `fetch`，没有走统一出口，不能照抄 | `scripts/evals/memory-capture-live.eval.ts:79-91`：直接 `fetch(`${GATEWAY}/chat/completions`)` |
| P14 | 现有后台提示词已经按“固定文字在前、数据在后、当前时间最后”拼 | `packages/application/src/services/proactive-mail-check-service.ts:389-410`：`MAIL_JUDGMENT.text` 在最前，`renderPrompt(MAIL_JUDGMENT_NOW, ...)` 在最后；`apps/agent-service/src/production-memory-capture.ts:177-193`：固定提示词 + 一个 JSON 数据块 |
| P15 | 记忆检索返回已经区分“当前/已过期/已被取代” | `apps/agent-service/src/production-memory-recall.ts:206-246`：`current: validTo === null || validTo > now`、`correctedLater: Boolean(attributes?.supersededBy)` |
| P16 | 提示词目录有机械检查，新增条目必须进 manifest | `apps/agent-service/test/prompt-catalog.unit.test.ts:175-195`：`PROMPT_MANIFEST_MISSING/STALE/UNKNOWN`；`:299-318` 检查每个条目 digest 和原因 |
| P17 | 域标识符只允许 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | `packages/domain/src/identifiers.ts:39-50`、`:109-111` |
| P18 | LongMemEval 的三档、题型、规模、判分方式 | https://github.com/xiaowu0162/LongMemEval ；“500 high quality questions”“LongMemEval_S ... roughly consumes 115k tokens (~40 history sessions)”“oracle retrieval. Only the evidence sessions are included”；https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/evaluation/evaluate_qa.py 的 `model_zoo` 含 `gpt-4o` |

**一处材料更正：** 材料写“`tentative` 迁移 0052 起”，实际 `ALTER TABLE memory_records ADD COLUMN tentative` 在 `packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql:1`；0052 只有 category/importance 等字段。方案以代码为准。

---

## 二、方案本身

### 1. 数据集放哪、怎样可复现、每周谁触发

**仓库内只放“代码和指标”，不放真实原文：**

- `evals/real-memory-recall/`
  - `schema.json`：数据集 schema、字段、允许的分类/状态
  - `history.jsonl`：每轮只记 `schema`、`snapshotId`、`datasetSha256`、`commit`、`modelRef`、`judgeModelRef`、`usage`、逐题指标
  - `baseline.json`：当前基线指标 + 快照 hash
- `evals/real-proactive-decisions/`：同上
- `scripts/real-eval/`：生成、运行、判分、趋势脚本
- `test/tooling/real-eval.test.ts`：无网络测试

**真实原文放仓库外：**

- 默认 `$HIMAWARI_EVAL_DATA`（例如本机私有目录），结构：
  - `snapshots/<snapshotSha256>/source.jsonl`：已脱敏的已确认记忆、原话、决策行
  - `snapshots/<snapshotSha256>/questions.jsonl`：冻结后的题目
  - `snapshots/<snapshotSha256>/manifest.json`
  - `runs/<timestamp>/...`
- 快照建议用现有的 seal/加密格式保存；仓库只记 `snapshotSha256`。这样真实数据不进 git，删掉本地密钥即不可读。
- 数据来源优先复用现有导出：网页导出已经解密并遮盖机密（`production-data-export.ts:107-140`）；但决策重放需要的 `content_ref`/`reason_ref`/邮件证据目前只在 `--with-evidence` 的管理导出里（`snapshot.ts:133-165`、`data-command.ts:150-162`），而且管理导出要求停服务。**所以主动决策集第一阶段应明确“等有证据导出后再做”**，不要假装现有网页导出已经够。

**可复现的元组：**

`snapshotSha256 + generatorVersion + promptManifestDigest + codeCommit + seed + modelRefs + judgeModelRefs + prices`

其中：

- 生成阶段可以调模型写问题，但**生成完就冻结题目**；运行阶段不再重新生成。这样即使模型输出不是逐字节可复现，同一份冻结题目和同一份快照仍可复现分数。
- 生成器输出按稳定 ID 排序，JSON 用固定键序/规范序列化；同一输入重复生成应得到同一“候选集合”，但问题措辞以冻结结果为准。
- 旧合成集继续保留，作为对照组，不改 `evals/memory-retrieval/dataset.json`，也不改它的历史文件；P3-1/P3-3 只追加 `history.jsonl`，新方案不碰它们的文件。

**每周自动更新：**

- 在**评测机**上用 `launchd`/`systemd timer` 每周跑，不在生产机、不在 GitHub Actions（仓库记录 GitHub Actions 已暂停，见 ADR 0092）。
- 定时器只消费“最新已确认快照”；没有新快照或快照超过阈值就**失败并告警**，不静默复用旧数据。
- 生产取数仍由 Andy 执行/确认，因为 ssh 只能 Andy。端到端无人化与这条约束冲突；只能做到“Andy 导出并确认后，生成、运行、记账、更新文档自动完成”。

### 2. 出题：只用已确认记忆和原话，答案不由模型写

**筛选条件（硬条件）：**

- `status = 'active'`
- `tentative = false`（迁移 0054）
- `supersededBy IS NULL`
- `validFrom IS NULL OR validFrom <= asOf`
- `validTo IS NULL OR validTo > asOf`
- `classification IN ('public','private')`；sensitive/restricted 第一版不进题，只统计数量。理由：`redactForEgress` 会把密码、验证码、卡号等遮掉，强行出题会得到不可回答的问题；真要覆盖敏感记忆，应单开一个经 Andy 批准的分层。
- 该 content_ref 至少有一条带 `quote_ref` 的历史事件；取 `quoteRefOfMemory` 的同一条规则（`production-consolidation.ts:18-25`）。
- 排除纯手动编辑、没有 quote 的记忆；排除 quote 为空或只有寒暄的条目。

**生成步骤：**

1. 对每条候选，把 `memory text + quote + category + stance` 作为**数据放在提示词最后**，固定指令在前。
2. 模型只输出 `{question}`，**不输出答案**；答案由程序从 `quote_ref` 读取，避免“模型顺手把答案写进问题”。
3. 确定性泄漏检查：
   - 归一化后，答案原文不得出现在问题里；
   - 问题与答案的最长公共子串/字符 n-gram 超过阈值就丢弃（中文按字符 6–8 个，英文按词 3–4 个）；
   - 问题里不得出现答案中的数字、日期、专有名词，除非该词本来就在 `entities` 里作为提问线索。
4. 可答性检查：用一次便宜的“蕴含”调用，输入只有 `memory text + quote + question`，要求回答“这条记忆是否足以回答该问题，且 quote 是否支持答案”；不通过就丢弃。这个调用可以缓存，只在生成阶段发生。
5. 去重：按 `normalizedQuote` 哈希 + `memoryId` 去重；同一 quote 只出一道题。
6. 保留反向用例：同一事实的旧版、待确认版、已归档版只作为干扰项放进记忆库，**不作为题目来源**。

### 3. “Himawari 作答”走哪条路径

**主路径：生产检索 + 一次作答（推荐）。**

- 在隔离的临时 state root 中，用快照里的已确认记忆建立与生产同构的 `ProductMemoryRecord` 和索引；
- 使用生产 `ProductionMemoryRecall`（`apps/agent-service/src/production-memory-recall.ts`）或直接 `DurableMemoryService.search`（`packages/application/src/services/durable-memory-service.ts:367-428`）取回结果；
- 把检索结果按固定顺序放进**最后一条用户消息**，系统提示和工具定义保持固定；
- 调一次作答模型，不启用工具、不写记忆、不触发 Gmail/沙箱。

代价：每题约 1 次模型调用，输入主要是固定指令 + 检索到的几条记忆，通常几千 token；可缓存开头，适合每周跑。

**辅助路径：完整对话运行。**

- 用真实 `agent-service` 在隔离 state root 起一条新对话，发送问题，走完整工具/记忆检索/运行环境。
- 代价：每题多次模型调用、工具定义和历史更长，费用和延迟通常是主路径的 5–10 倍；还会引入工具选择、提示词组装等与记忆无关的变量。
- 只建议在“提示词大改、换主模型、换检索融合”时，对固定 20–30 题子集跑一次；不作为每周全量。

**不选“把题目直接当记忆内容塞进存储”**：那样测的是读原话，不是生产记忆检索。

### 4. 判分：原话是标准答案，但不要求逐字一致

分两层：

1. **确定性快通道**
   - 归一化（空白、标点、大小写、全半角）后，回答包含原话或原话的关键值 → 判对；
   - 对短答案（日期、地点、人名、偏好词），用答案关键 span 精确匹配；
   - 对“已过期/已被取代”的旧值出现在回答里且没有给出当前值 → 判错。

2. **模型判分**
   - 固定提示词在前，最后放 `question + referenceQuote + response`；
   - 明确规则：
     - 等价说法、同义改写算对；
     - 只给出一部分信息算错；
     - 给出旧值/过期值算错；
     - 偏好题只要正确回忆并使用主人偏好即可，不要求和 rubric 逐条一致；
   - 判分模型和被测模型**不同厂/不同模型族**，避免自评偏好；
   - 判分模型不接触题目生成阶段的过程、不接触未采用的候选答案。

**防止题目泄露答案：**

- 答案由数据库 quote 产生，模型不写答案；
- 问题不得包含答案的 n-gram；
- 生成模型和判分模型分离；
- 生成提示词里不放“标准答案”字段给作答模型；
- 每次生成后抽 10% 人工复核（Andy 或指定人）；自动检查替代不了这一步。

### 5. 已被取代或已过期的记忆怎么处理

- **不进当前题源**：`supersededBy` 非空或 `validTo <= asOf` 的记忆不生成问题。
- **作为干扰项保留**：放进评测记忆库，但标记为 `correctedLater/expired`；检索应优先返回当前版本；判分时旧值不算对。
- **知识更新题**：如果同一事实有旧版和新版，可生成“现在是什么”的题，答案取当前 quote；旧 quote 只做干扰项。
- **题目退役**：题目记录 `sourceMemoryId + sourceContentRef + sourceQuoteRef + asOf`。源记忆变化后，旧题进入 `retired` 队列，历史分数保留为 cohort，不混进当前分数。
- **快照删除**：源记忆被删除时，按导出/快照保留规则同步删除或标记；不能从历史快照里“复活”已删除内容。

### 6. 主动决策评测

**“三类”我的落实：** 按 `decision_ledger.kind` 和已有校准主组，取 `proactive`、`memory_candidate`、`consolidation` 三类（依据 `0069_decision_ledger.sql:5-9`、`packages/calibration/src/index.ts:15-34`）。如果 Andy 说的“三类”是别的分法，需要先确认。

**构造：**

- 只取 `owner_rating IS NOT NULL` 的记录；`rated_at` 必须有。
- 按 `kind × owner_rating` 分层；同一 `subject_ref` 只取一条，避免同一封邮件/同一条记忆重复计权。
- 标签映射：
  - `proactive`：实际 `pushed/deferred` + `useful` → `act`；`pushed/deferred` + `unneeded` → `silent`；`silent` + `missed` → `act`；`silent` + `useful` → `silent`。
  - `memory_candidate`：`kept` + `useful` → `keep`；`kept` + `unneeded` → `discard`；`discarded` + `missed` → `keep`；`discarded` + `useful` → `discard`。
  - `consolidation`：`merge/supersede/archive/reflect` + `useful` → `do_action`；+ `unneeded` → `no_action`；该校准组没有 `missed`。
- 重放所需上下文：
  - `decision_ledger.inputs`（`DecisionInputs`，见 `ports/decision-ledger.ts:71-93`）；
  - `content_ref` / `reason_ref` 解密后的正文；
  - 邮件场景需要 `proactive_processed_messages.header_ref`、`source_insights.content_ref` 等证据字段；目前网页导出不带这些，必须用带 evidence 的导出或新增专用“评测导出”。
  - 复用生产提示词：`proactivePrompt`（`proactive-mail-check-service.ts:374-410`）、`memoryCapturePrompt`（`production-memory-capture.ts:169-194`）、记忆整理提示词。不要在评测脚本里另写一套。
- 重放时冻结 `now`、时区、记忆快照、规则版本；不调用 Gmail、不发通知、不写决策记录。
- **样本少时**：
  - 不合成、不用旧合成集补齐；
  - 每个分层少于 5 条只列案例，不报点估计；比例用 Wilson（`packages/calibration/src/index.ts:177-207`）；
  - 先累积评价，等某一层达到最小样本再进入“可下结论”面板；
  - 固定面板：一旦某条决策被选中就保留，直到源数据删除或退役；新决策只填空位，避免每周重抽导致指标抖动。
- 不要用 `decision_signals`（opened/undone/replied）当正确标签，它只能作为观察信号；已有校准代码也明确把它和评价分开（`packages/calibration/src/index.ts:869-895`）。

### 7. LongMemEval

**选择：先跑 S 档，但用检索 top-k；oracle 500 作为便宜的对照；不跑 M。**

- S 档是真正的长历史（README：约 115k token、约 40 段会话），但如果把完整历史塞给模型，500 题约 5,750 万输入 token，费用必然超过 0.5 美元，而且和 Himawari 的“检索后作答”路径不一致。
- 因此用生产检索在 S 档的 500 个历史会话里取 top-k（例如 5–10 段），再走作答。这样测的是 Himawari 的检索+阅读，输入通常几千 token/题。
- oracle 档只包含证据会话（README：“Only the evidence sessions are included in the history”），可作为 harness 自检和“上限”参照，费用低。
- 不建议 M：每段历史约 500 个会话，官方也说明不适合 128k 长上下文直接喂（README：“longmemeval_m.json is too long for long-context testing”）。
- 如果预算只允许一次：选 **S 档 500 题、检索 top-k**，但明确写“LongMemEval-S retrieval setting，不是官方 full-history 分数”。如果 Andy 不批预算，先跑 **oracle 500**，或 S 档预注册 100 题分层子集，并标明子集。

**判分：**

- 复用 `evaluate_qa.py` 的题型模板（single-session、temporal、knowledge-update、preference、abstention），但判分模型换成允许的便宜模型；
- 记录 `judgeModelRef`；
- 文档写清：官方判分是 `gpt-4o-2024-08-06`（`evaluate_qa.py` 的 `model_zoo`），本项目不用；分数只能和同判分模型的内部历史比，不能直接和官方榜单横比；
- 可做 30–50 题的双判分一致率（两个允许的便宜模型），报告 judge variance，不能冒充官方分数。

### 8. 每周费用估算方法

不要写死价格。每次运行前：

1. 从网关 `/models` 拉当前价格（现有 `memory-capture-live.eval.ts:240-252` 已有这个做法）；
2. 用最近一轮的 `usage` 取 90 分位 token 数，估：
   - `生成题：Q_gen × (输入 token × 输入价 + 输出 token × 输出价)`
   - `作答：Q_ans × (固定提示 + 检索结果 + 问题)`
   - `判分：Q_judge × (问题 + 原话 + 回答)`
   - `嵌入：记忆条数 × 每条 token × 嵌入价`，相同文本缓存
3. 预检打印“最坏情况预计费用”，超过 `--confirm-cost` 或 0.5 美元就拒绝开跑；
4. 运行中每次调用后累计 `costMicros`，到上限立即停（参考 `scripts/memory-retrieval-eval/live.mjs:21-27`、`scripts/jarvis-test/live.mjs:36-43`）；
5. 结果里同时记“按网关价目表折算的费用”和“套餐额度消耗”；用套餐额度不能写成 0 美元。

建议每周真实记忆集控制在 60–100 题，使单周费用在 0.5 美元以内；LongMemEval 是一次性，单独向 Andy 报预算。

### 9. 自动检查

新增 `npm run check:real-eval`，加入 `package.json` 的 `check:steps` / `run-all-checks`，无网络、不花钱。至少包含：

- 条件过滤：tentative、archived、superseded、expired、无 quote 的记录不得进题；反向用例故意放一条 tentative，必须被拒绝；
- 泄漏：问题包含答案 n-gram 时生成器必须拒绝；
- 判分：逐字、同义改写、只给部分信息、旧值/过期值四类；反向用例旧值必须判错；
- 去重与确定性：同一快照跑两次，题目 ID 和 JSON 字节一致（生成阶段若用模型则只校验冻结产物）；
- 出口遮盖：带密码/卡号/验证码的源文本必须变成占位符；关掉 egress 的注入测试必须失败；
- 前缀：多轮评测请求第 N+1 条必须以前一条开头；把 `asOf` 或检索结果挪进系统提示的反向用例必须失败；
- 提示词目录：新条目 manifest 缺失/过期必须失败（现有 `prompt-catalog.unit.test.ts` 的 reverse 已覆盖）；
- I-73 式跨边界：生成器产生的 `memoryId` 必须过 `createMemoryId`，`modelRef` 必须过两个合约包；故意造一个带空格/斜杠的 ID，两端必须拒绝或丢弃；
- 预算：`--confirm-cost` 缺失、低于预估、运行中超额都必须失败；
- 快照过期、dataset hash 与 manifest 不符必须失败。

现有 `check:prompt-prefix` 的门槛是 8 条 `[I-66]` 测试（`scripts/check-prompt-prefix.mjs:10-11`）；如果新评测改动生产请求组装才需要扩它；按本方案，评测请求是独立调用，不需要改这个门槛。

---

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
|---|---|
| 直接把真实数据放进仓库或 LFS | 违反“真实数据不宜进仓库”，且删除/泄露不可控；仓库只放指标和哈希 |
| 复用 `evals/memory-retrieval/dataset.json` 并改它 | 它是合成集对照组；P3-1/P3-3 只追加 history，不应改 dataset；新旧 schema 混在一起会让历史不可比 |
| 用 ssh 每周自动拉生产库 | 约束明确 ssh 只能 Andy 执行；自动化会越权 |
| 全量题目都走完整对话 | 费用和方差太大，且会触发工具、记忆写入等副作用；只适合小样本回归 |
| 让生成模型同时写问题和答案 | 答案会漂移，且容易把答案写进问题；答案必须取数据库 quote |
| 只做逐字匹配 | 真实回答不会逐字一致，会系统性低估 |
| 只用 LLM 判分 | 对短事实题不稳定；应与确定性匹配结合 |
| 用 GPT-4o 判 LongMemEval | 约束明确禁止；官方分数不可直接复制 |
| 用合成数据补主动决策小样本 | 正是 ProAgentBench 警告的“合成与真实结论可能相反”；只能报样本不足 |
| 每周重新随机抽题 | 指标会因样本组成变化而抖动；应冻结面板 |
| 把评测提示词加入全局 `TRUSTED_PROMPT_TEXTS` | 会改变生产出口遮盖的 trusted 集合，可能让已冻结对话的请求开头字节变化（`.claude/rules/prompt-prefix.md:53`）；评测提示词只应从评测调用传入 |

---

## 四、风险和反例

1. **quote 不等于记忆正文。** 记忆经过整理/合并后，正文可能是概括，quote 是原始证据；如果 quote 的事实不能被当前正文推出，题目会不公平。对策：生成阶段做一次“正文是否蕴含 quote”的检查，不通过就丢弃；不能只信 quote。
2. **问题改写泄漏。** n-gram 检查挡不住同义改写。反例：答案是“下个月搬去杭州”，问题是“你下个月要去哪个城市定居？”——这已经泄漏了“下个月”和“定居”。对策：人工抽检 + 生成时要求问题只问事实槽位，不给时间/地点线索；必要时用“闭卷可答性”判分。
3. **敏感数据。** `redactForEgress` 主要遮密码/卡号/验证码等，不保证遮住所有人名、地址。第一版排除 sensitive/restricted，仍可能有人名；需要 Andy 确认访问范围和保留期。
4. **出口遮盖的上下文依赖。** 同一段文本在一次 exchange 里出现在不同秘密之后，可能遮出不同字节。对策：一条记录一个 `ModelEgress.exchange`，不要批量共用；所有输入按稳定顺序，不依赖 SQL 返回顺序。
5. **评价标签不是绝对真值。** Andy 的 useful/unneeded/missed 是对当时决策的评价，重放时上下文已经不同；只能作为弱标签。若 `inputs` 缺字段、源邮件正文缺失、决策后记忆已变化，应排除该案例，不要硬重放。
6. **主动决策存在反馈回路。** 被评价为“该提醒没提醒”的决策，后续可能已被系统改变；用历史决策重放会低估/高估。对策：只取上下文完整、决策后未修改的案例，并在报告中写明选择偏差。
7. **LongMemEval 不可直接横比。** 用检索 top-k 代替完整历史、用非 GPT-4o 判分，得到的是“Himawari 设置下的 LongMemEval-S”，不是官方榜单分数。文档必须写明，否则会误导。
8. **每周数据漂移。** 记忆会新增、取代、删除；固定面板和退役机制是必要的，否则同一指标每周不可比。
9. **新增导出接口的攻击面。** 如果为评测新增生产导出路由，会扩大敏感数据出口。优先用现有所有者导出；如必须新增，必须复用现有认证、只读、限流、审计和脱敏，并由 Andy 审核。

---

## 五、需要 Andy 拍板的取舍

1. **私有快照放哪、谁持密钥**：本机加密目录、私有对象存储，还是另一个私有仓库？评测机是否有解密权限？
2. **是否接受“每周自动”= Andy 每周导出/确认后自动跑**；还是愿意新增一个生产侧定时导出（更大攻击面）来换全自动。
3. **主动决策证据导出**：是否接受停服务跑 `data export --with-evidence`，还是新增一个只读、所有者认证的“评测导出”路由？
4. **敏感记忆是否入题**：第一版建议排除；若 Andy 要求覆盖，需要单独批准。
5. **LongMemEval 预算**：S 档 500 题检索版预计会超过 0.5 美元；是否批准？不批准则跑 oracle 500 或 S 100 子集。
6. **判分模型**：在允许的便宜模型里选哪一个作为固定 judge；是否接受“非官方、不可横比”的说明。
7. **主动决策“三类”的定义**：是否就是 `proactive / memory_candidate / consolidation`。

---

## 六、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变生产会话的请求开头。** 依据：

- 本方案不修改生产系统提示、工具定义、历史消息或生产会话组装；新增的评测是独立调用/独立新对话。
- 评测调用遵守 `.claude/rules/prompt-prefix.md:27-29`：固定指令在前，数据在后；`asOf`、题目、检索结果、时间这类每轮会变的值只放在最后一条用户消息。
- 现有后台调用已经采用这个形状：`proactivePrompt` 固定 `MAIL_JUDGMENT.text` 在前，`now/timeZone/today` 在最后（`proactive-mail-check-service.ts:389-410`）；`memoryCapturePrompt` 固定提示词 + 最后 JSON 数据（`production-memory-capture.ts:177-193`）。评测生成/判分照此实现。
- 多轮评测如果复用同一对话，只追加消息，不修改前面的消息（`.claude/rules/prompt-prefix.md:35-36`）。
- 新增评测提示词登记进 `packages/prompt-catalog`，但**不加入 `TRUSTED_PROMPT_TEXTS`**；`trusted.ts:10-13` 只导入生产模块，避免改变生产出口遮盖的 trusted 集合。若加入，会影响老对话已冻结文本的遮蔽字节（`.claude/rules/prompt-prefix.md:53`）。
- 唯一需要额外确认的是：如果为了实现导出而修改生产代码或 `ModelEgress`，要单独跑 `npm run check:prompt-prefix` 并证明请求字节不变；按当前设计不需要改这些。

**结论：发给模型的内容仍然只在末尾追加；每轮会变的值都在最后一条消息里。**

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**按本方案不会，但有三个必须遵守的条件：**

- 使用快照里的固定 `asOf`，不在提示词里放 `new Date()`；检索的 `now` 也传固定值，避免时间窗口变化。
- 所有集合/JSON 按稳定键排序，用固定键序序列化；SQL 显式 `ORDER BY`，不依赖数据库返回顺序。
- **一条记录一个 `ModelEgress.exchange`**。`model-egress.ts:200-229` 的 `#known` 会在一次 exchange 内记住前面的秘密，同一段文本如果和不同前置秘密一起遮，可能得到不同占位符；分开 exchange 就不会。
- 遮盖密钥固定；不要每次运行生成新 key。`placeholderTag` 对 `${kind}\0${value}` 签名（`model-egress.ts:121-126`），密钥不变则同一值同一占位符。
- 新增评测提示词不要进全局 trusted；否则不同调用如果传入的 trusted 集合不同，也会改变字节。

**注意：** 模型生成问题本身不是逐字节可复现的；所以“可复现”靠**冻结题目**，不靠在运行阶段重新生成。这不属于“同一段文字在不同请求里变字节”的问题，但会影响分数复现。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，见“二、9”。关键是反向用例要**真的在修复前失败、修复后通过**：

- 把一条 `tentative=true` 或 `supersededBy!=null` 的记忆放进候选集，生成器必须拒绝；去掉过滤时测试必须红。
- 把答案原文写进问题，泄漏检查必须拒绝；去掉 n-gram 检查时测试必须红。
- 让回答给旧值/过期值，判分必须判错；去掉“旧值算错”规则时测试必须红。
- 把 `asOf` 挪进系统提示，前缀测试必须报告失败；这与现有 `[I-66]` 反向用例同类（`.claude/rules/prompt-prefix.md:74`）。
- 关闭出口遮盖或去掉 `ModelEgress`，敏感值测试必须失败；现有 `check:egress-redaction` 也覆盖这类。
- 生成一个 `modelRef` 带空格/斜杠、或 `memoryId` 不合法，跨边界测试必须失败；这是 I-73 的门槛（`docs/incidents-and-gates.md:112`、`check:model-ref-contract`）。
- 把 `--confirm-cost` 去掉或设到预估以下，运行必须拒绝；把预算上限调到第一笔调用之前，必须停。
- 删除或改坏 `prompt-manifest.json` 的条目，`check:prompt-catalog` 必须失败（`prompt-catalog.unit.test.ts:299-318`）。

这些测试加入 `npm run check` 的新步骤；live 评测仍单独运行，不放进无网络的 `check`。

### 4. 每个新值/字段/配置键/清单项，产生方和消费方都能接受吗？

逐个核对如下：

| 值 | 产生方 | 使用方 | 两端校验/结论 |
|---|---|---|---|
| `schema` | 生成器 | runner、schema 检查、history | 精确字符串白名单；未知 schema 拒绝 |
| `snapshotSha256` | 导出/生成器 | manifest、history、快照目录 | 64 位十六进制；缺失或与内容不符拒绝 |
| `datasetSha256` | 生成器 | history、README、check | 64 位十六进制；比对人读的 hash |
| `questionId` | 生成器（稳定 hash） | 去重、退役、history | 按 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` 生成/校验，避免 I-73 类“清单 id 过不了后端” |
| `memoryId` | 生产导出 DB | `createMemoryId`、`DurableMemoryService.readMany`、检索 | 必须过 `packages/domain/src/identifiers.ts:39-50`；失败就丢弃并记数，不写入 dataset |
| `contentRef` / `quoteRef` | DB 历史行 | payload 读取、判分 | 必须存在、`content_type='text/plain'` 且可解密；失败就丢弃 |
| `classification` | DB `memory_records` | 筛选、检索策略 | 只接受 `public/private/sensitive/restricted`；第一版只放 public/private |
| `category` | DB | 筛选、报告分组 | 用 `MEMORY_CATEGORIES` 白名单（`memory-projection.ts:13-24`） |
| `status` / `tentative` / `supersededBy` / `validFrom/To` | DB | 生成过滤、检索、判分 | 用 `ProductMemoryRecord`/`ProductMemoryAttributes` 类型和迁移约束；未知值拒绝 |
| `asOf` | 快照元数据 | 时间窗口、检索、判分 | 必须是 UTC 毫秒 + `Z` 格式，和 `assertTimestampFormat` 一致（`packages/calibration/src/index.ts:624-669`） |
| `modelRef` | 评测配置/生产配置 | 两个合约包、Magpie 清单、网关 | 必须过 `gateway-contracts` 和 `execution-contracts` 的 `modelRefString`；用 I-73 式跨包测试（`apps/agent-service/test/model-ref-contract.unit.test.ts:59-77`） |
| `promptId` / manifest digest | `packages/prompt-catalog/src/*` | `prompt-catalog.unit.test.ts`、manifest | 每个新条目必须有 sha256、changedIn、reason；缺失/过期/未知都失败（`:175-195`） |
| `prompt text` 的 trusted 集合 | prompt catalog | `ModelEgress` 的 `trusted` | 不加入全局 `TRUSTED_PROMPT_TEXTS`；评测调用显式传自己的 trusted 列表；生产字节不变 |
| `usage.costMicros` / `prices` | 网关响应/价目表 | 预算、history、报告 | 必须有限、非负整数；价目表缺失就拒绝开跑（参考 `memory-capture-live.eval.ts:240-252`）；不写死价格 |
| `history.jsonl` 字段 | runner | trend/report/check | 新文件独立 schema；只放指标和 hash，不放原文；未知字段/缺字段失败 |
| `decisionId` / `kind` / `outcome` / `ownerRating` | `decision_ledger` | 主动决策生成器、报告 | 用 `DECISION_KINDS`、`DECISION_RATINGS`、迁移 0069 的 CHECK 白名单；未知值丢弃 |
| `decision.inputs` 字段 | ledger | 重放提示词 | 用 `DecisionInputs` 类型逐字段校验；缺 `sourceIds`/`contentRef`/`reasonRef` 的案例不重放 |
| 导出文件字段 | `buildPortableExport` | 生成器 | 只读现有格式；带 evidence 的版本需用 `data.inspect` 验证 manifest；不能假设网页导出包含决策证据 |
| CLI 参数 `--confirm-cost` 等 | 新 runner | 文档、check | 用现有 live 脚本的已知参数白名单模式（`memory-retrieval-eval/live.mjs:15-19`、`jarvis-test/live.mjs:22-34`）；未知参数拒绝 |

**I-73 的直接教训：** 不要只测“生成器能产出这些值”，还要把生成出的 `memoryId`、`modelRef`、`promptId` 分别喂给真正的消费端校验。新 check 里应有一条“跨边界”测试，专门把 dataset 里的每个 ID 交给 domain/合约/检索入口，失败就红。

---

## 七、已核实与推测的区分

**已核实（读代码/一手来源）：**

- 原话加密、`quoteRefOfMemory` 的选取规则、`confirm` 的 tentative 语义、搜索的 active/classification 过滤；
- `decision_ledger` 的 kind/rating/inputs 结构和校准的 Wilson/最小样本；
- `ModelEgress` 的 trusted/known/占位符机制；
- 提示词只能追加、变更值放最后、trusted 变化会影响老对话字节；
- I-73 的具体根因和门槛；
- 现有导出/管理导出的能力边界；
- 现有记忆抽取 live 评测绕过 ModelEgress；
- LongMemEval 的档位、规模、题型和官方 judge。

**推测/建议（需要实际运行验证）：**

- 每周 60–100 题能把费用控制在 0.5 美元以内——取决于当前网关价格、检索 top-k 长度和判分模型；
- S 档检索 top-k 的费用和效果——需要先跑 20 题试算；
- 主动决策重放的稳定性——取决于 `inputs` 和证据字段是否完整记录；如果实际缺失严重，第一版可能只能做 `proactive`，`memory_candidate/consolidation` 继续等；
- “问题 n-gram + 蕴含检查”足以挡住大部分泄漏——仍需人工抽检；
- 生产导出能否在不新增路由的情况下提供足够证据——当前网页导出不带 evidence，管理导出要停服务；这一点需要 Andy 选路径。

---

**最短落地顺序：** 先做记忆回忆集的 schema/生成/判分/check（不含主动决策证据导出）；用现有网页导出做第一版快照，Andy 确认后跑基线；再补主动决策导出和 LongMemEval 预算审批。这样第一版就能替换合成集的主地位，同时不阻塞在“等待足够评价”和“生产证据导出”上。
