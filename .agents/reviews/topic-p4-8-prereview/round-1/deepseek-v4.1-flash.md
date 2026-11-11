## 一、方案依赖的前提

以下每条都标了来源和原话；代码行号对应本次检出的 `aa1b0b0`。

### 1. 请求顺序：固定在前，变化在后

- 来源：`.claude/rules/prompt-prefix.md:27-29`
- 原话：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”“每轮都会变的内容只放在最后一条用户消息里。”“要告诉模型新情况时，追加一条消息，不改系统提示。”
- 现有后台调用确实把整个 prompt 放进 user 消息，system 是固定的占位符说明：`packages/runtime-pi/src/egress-context.ts:23-27`：“systemPrompt: EGRESS_PLACEHOLDER_LEGEND，messages: [{ role: \"user\", content: prompt, timestamp }]”。

### 2. 已发出的内容只能追加

- 来源：`.claude/rules/prompt-prefix.md:35-36`
- 原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”“存历史时存实际发出去的那一条。”

### 3. 同一段文字必须序列化成同样的字节

- 来源：`.claude/rules/prompt-prefix.md:51-53`
- 原话：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序（命令清单、服务商、记忆）都要固定，不能依赖对象遍历顺序或数据库返回顺序。”“遮盖敏感信息必须是确定的。”
- 同处还写明：提示词目录里新增的固定文字会进入“可信文字”清单，只有旧消息里逐字出现时才可能改变旧对话的遮法。

### 4. 新模型请求必须走统一出口

- 来源：`docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:39,47`
- 原话：“主对话（`pi-runtime-adapter.ts`）、辅助调用（`pi-model-transport.ts`）、嵌入（`embedding.ts`）都只用这个包过的 `fetch`。”“`npm run check:egress-redaction` 要求三个发送点用 `exchange.wrapFetch(`……并拒绝出口模块之外直接调用 `redactForEgress(` 和任何未登记的模型或嵌入请求出口。”
- 现有便宜模型的调用入口已经符合：`apps/agent-service/src/production-model-composition.ts:495-555` 的 `proactiveModel()`，以及 `apps/agent-service/src/service-main.ts:1629` 把它接到邮件判断。

### 5. 新提示词要进目录并通过目录检查

- 来源：`package.json:56` 的 `check:prompt-catalog`；`apps/agent-service/test/prompt-catalog.unit.test.ts:175-209,299-338`
- 原话（测试名与断言）：“every prompt sent to a model lives in the catalog”“registers every catalog entry in the manifest with its current digest and a reason”“allows only listed slots and no dates, times or hashes in system prompts and tool definitions”。
- `packages/prompt-catalog/src/entry.ts:59-75`：目录里不少于 24 个字符的固定文字会进入可信文字清单。

### 6. 现有表放不下“另一条评价”

- 来源：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:27-28`
- 原话：“`owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed'))`，`rated_at TEXT`”。
- `0080_decision_signals.sql:6`：“`signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied'))`”。
- `0070_decision_ledger_payloads.sql:4`：“`role TEXT NOT NULL CHECK (role IN ('model_input', 'model_output'))`”。
- 结论：另建一张表最干净；把模型评价塞进 `owner_rating` 会覆盖主人评价，塞进 `decision_signals` 或 `payloads` 都会被 CHECK 拒绝或语义不清。

### 7. “每天打分”的现有选择逻辑

- 来源：`packages/application/src/services/daily-review.ts:47-49,81-132,240-371`
- 原话/事实：`reviewCapacity()` 用“预算秒数 ÷ 每条秒数”算容量；`selectDailyReview()` 在四个默认组之间轮流抽取，按 `seed|dayStart|key` 哈希定序；`readDailyReview()` 汇集 `ledger:<id>` 和 `mail:<id>`。
- 配置默认值：`packages/platform-node/src/strict-configuration.ts:1041-1043`：“`reviewBudgetSeconds` 默认 120”“`reviewSecondsPerItem` 默认 5”“`reviewSilentSharePermille` 默认 500”。
- 现有 `DAILY_REVIEW_MAX_RATINGS = 50` 只在 `daily-review.ts:13` 定义，未在仓库其他地方使用；不要把它误当成“每天最多 50 条”的现成强制。

### 8. 校准周报的统计与邮件评分存储语义

- 来源：`packages/calibration/src/index.ts:177-207`
- 原话/事实：`wilsonInterval()` 是 95% Wilson 区间；`proportion()` 在样本数小于 `DEFAULT_MINIMUM_SAMPLES` 时返回 `value: null`。`DEFAULT_MINIMUM_SAMPLES = 5`（第 2 行）。
- 关键不一致：`apps/agent-service/src/production-proactive.ts:511-521` 里，邮件评“有用”时写的是 `owner_rating = null` 并 `markReviewed()`；`daily-review.ts:342` 又把 `reviewedAt !== null` 显示成 `useful`；但 `packages/calibration/src/index.ts:656-659` 的 `mailJudgment` 只查 `owner_rating`。如果新一致率直接 JOIN `owner_rating`，会系统性漏掉所有“邮件有用”的评价。这是 I-73 那类“两端校验只看了一端”的典型。

### 9. 内容加密边界

- 来源：`scripts/calibration-report/report.mjs:78-81`：“`new Database(..., { readonly: true, fileMustExist: true })`”。
- `apps/agent-service/src/service-main.ts:1600-1627`：记忆正文在服务进程里通过 `readReviewText`/`protector.unprotect` 读出。
- 结论：预评必须跑在服务进程内；周报脚本只能读明文元数据，预评表不能存记忆/邮件正文或模型理由原文。

### 10. 便宜模型和运行中的调用

- 来源：`packages/application/src/services/proactive-mail-check-service.ts:72-83` 的 `ProactiveModelInvoker`；`apps/agent-service/src/production-model-composition.ts:521-531` 的 `prepare()`。
- 原话/事实：`prepare()` 把 prompt 写成受保护 payload，`model.invoke()` 再走统一出口；`production-model-composition.ts:499-504` 只接受 `openai-completions` 且允许 `private` 分类的描述符，否则抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`。
- 结论：预评直接复用 `proactive.modelRef` 和 `ProactiveModelInvoker`，既便宜又不新增出口；不要另写 raw fetch。

### 11. 业界一手做法

- OpenAI《Evaluation best practices》：https://developers.openai.com/api/docs/guides/evaluation-best-practices
  - 原话：“Maintain agreement: Use human feedback to calibrate automated scoring.”“validate agreement against your human labels before optimizing for cost or latency.”“Biased design: Creating eval datasets that don't faithfully reproduce production traffic patterns.”
  - 还建议 human eval 用 “randomized, blinded test”，这支持“主人在打分前不应看到模型预评”。
- OpenAI Evals 的 meta-eval：https://github.com/openai/evals/blob/main/docs/build-eval.md
  - 原话：“Add a meta-eval for the model-graded eval! … human-provided labels … the report will output `metascore/` accuracies, which should be close to `1.0` for a good model-graded eval.”
- Google Vertex AI《Evaluate a judge model》：https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/evaluate-judge-model
  - 原话：“prepare an evaluation dataset with human ratings as the ground truth”“2-class balanced accuracy”“Confusion matrix”“Multiple-class balanced accuracy”。
  - 这直接支持：类别不平衡时不能只看总体准确率，要看 balanced accuracy 和混淆矩阵。
- Google Cloud《Evaluating large language models in business》：https://cloud.google.com/blog/products/ai-machine-learning/evaluating-large-language-models-in-business
  - 原话：“Our autoraters are carefully calibrated with human raters to ensure their quality.”“alignment-aggregate statistics … accounting for random agreement (Cohen's Kappa)”。
- Anthropic《A statistical approach to model evaluations》：https://www.anthropic.com/research/statistical-approach-to-model-evals
  - 原话：“report the SEM … alongside each calculated eval score”“A 95% confidence interval can be calculated from the SEM by adding and subtracting 1.96 × SEM”“power analysis … the number of questions that may be included in a random subsample while retaining the desired power properties”。
- Argilla 标注工具文档：https://docs.v1.argilla.io/en/latest/reference/python/python_annotation_metrics.html
  - 原话：“alpha >= 0.8 indicates a reliable annotation, a value >= 0.667 can only guarantee tentative conclusions.”
- Argilla Active Learning：https://docs.v1.argilla.io/en/latest/practical_guides/annotation_workflows/active_learning.html
  - 原话：“The Active Learning system tries to query only the most relevant data from a pool of unlabeled data to be labeled by a so-called oracle … much more sample-efficient.”
- 固定前缀的缓存依据：Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-caching、OpenAI https://developers.openai.com/api/docs/guides/prompt-caching、DeepSeek https://api-docs.deepseek.com/guides/kv_cache。

---

## 二、方案

### 2.1 存储：一张只追加的预评表

新增一次迁移（下一个可用编号，当前最高是 `0086`；按“改表结构要排队”的规则先领号），建 `decision_review_prejudgments`，只存元数据，不存正文：

核心字段：

- `id`：主键，长度 1–128。
- `owner_id`、`agent_id`：外键，级联删除。
- `source`：`ledger` / `mail`。
- `decision_id`：`source = ledger` 时指向 `decision_ledger(id)`，可空。
- `message_owner_id`、`message_agent_id`、`message_source`、`message_id`：`source = mail` 时组成复合外键，指向 `proactive_processed_messages(owner_id, agent_id, source, message_id)`，可空。
- `review_key`：`ledger:<decision_id>` 或 `mail:<message_id>`，加 CHECK 保证与 `source` 和对应 id 一致。
- `rating`：`NULL` 或 `useful` / `unneeded` / `missed`。
- `confidence_permille`：0–1000 的整数；`rating IS NULL` 时必须为 `NULL`。
- `abstain_reason`：`text_hidden` / `no_text` / `model_abstain` / 空。
- `history_bucket`：分组枚举，例如 `proactive_pushed`、`proactive_silent`、`memory_skipped:preference`、`memory_kept:project`、`consolidation`。不要存发件人域名等自由文本。
- `history_samples`、`history_majority`、`history_disagreement`：预评当时的历史快照，0/1 或 NULL。
- `audit`：0/1，是否是“无论模型怎么判都展示”的随机审计样本。
- `model_ref`、`prompt_id`（例如 `review.prejudgment.v1`）、`input_digest`（64 位十六进制）。
- `cost_micros`、`duration_ms`、`prejudged_at`（UTC ISO）、`day`（主人时区日期，仅用于幂等，不用于周报窗口）。
- 唯一键：`(owner_id, agent_id, review_key, day)`。同一天重跑只补缺失项，不覆盖已有预评。
- 索引：`(owner_id, agent_id, prejudged_at)`、`(owner_id, agent_id, source, decision_id)`、`(owner_id, agent_id, source, message_id)`。

为什么不用加列：加列无法保留“哪次模型、哪个 prompt、什么置信度、历史快照”，也无法在模型换版后重新测；一张只追加的表同时解决审计、幂等和报告读取。

另建一张很小的 `review_prejudgment_runs`：

- `(owner_id, agent_id, day)` 唯一。
- `status`：`pending` / `running` / `done` / `failed`。
- `reduction_active`、`gate_reason`、`unbiased_samples`、`matches`、`agreement_low`、`hidden_count`、`cost_micros`、`started_at`、`finished_at`。
- 这张表既做跨进程单飞，也给网页提供“今天为什么减/没减”的可验证数字。

**绝不写** `decision_ledger.owner_rating` 或 `proactive_processed_messages.owner_rating`。加自动测试断言预评前后这两个字段和 `rated_at` 完全不变。

### 2.2 什么时候跑

在服务进程内新增 `ReviewPrejudgmentService`，由 `ProductionProactive` 的定时 tick 或独立日任务调用：

1. 以主人时区的 `startOfZonedDay(now)` 为当天。
2. 先按现有 `readDailyReview` 的同一套规则算出当天“本来会展示”的候选集（`selectDailyReview` 的 `shown`，必要时加 `folded`）。
3. 从候选集里按稳定哈希取 `min(50, 候选数)` 条，作为当天预评上限；`textHidden` 的条目不调用模型，直接写一条 `rating = NULL`、`confidence = NULL`、`abstain_reason = text_hidden`、成本 0 的记录。
4. 每条单独一次模型调用（原因见 2.3），顺序或“等第一条开始返回再发下一条”（规则第 17 条），每天最多 50 条，并在 `reviewPrejudgmentDailyCostMicros` 用尽时停止。
5. 同一天重跑只补缺失的 key；失败不写记录，缺失即“没预评”，减量时按“必须展示”处理。

为什么不在每个决策发生时内联跑：会给真正的决策路径增加延迟和成本，而且预评结果要到日打分时才有用。为什么不在页面打开时懒跑：页面会等模型，且当天结果不稳定。默认用定时任务；页面打开时如果还没跑完，就显示全部（减量不生效），不阻塞。

### 2.3 给模型看什么

每条请求只包含一条待评条目。输入 JSON 用固定键顺序、固定数组顺序，不包含主人评价、不包含模型自己以前的预评、不包含其他条目的内容。建议字段：

- `group`：`proactive_pushed` / `proactive_silent` / `memory_skipped` / `memory_kept` / `consolidation` / `mail`。
- `kind`、`outcome`。
- `text`：与打分页完全相同的、已截到 200 字（合并/前后对比时 80 字）的文本；`textHidden` 时根本不发。
- `category`：记忆分类枚举或 `null`。
- `counts`：主动检查的 `fetched/judged/pushed/skipped` 等计数（页面也看得到这些）。
- `verdict` / `reasonCode`：主动检查的结论码。
- `options`：该组允许的主人评价，例如 `memory_skipped` 只给 `useful/missed`，`memory_kept` 只给 `useful/unneeded`，`mail` 只给 `useful/missed`。

原则：**预评看到的应当是主人当时能看到的信息，而不是重新拿全文做一遍原判断**。如果给模型看主人看不到的邮件正文，一致率就不再代表“主人会不会同意”，会自欺。信息不足时模型应弃权。

提示词放 `packages/prompt-catalog`，新增 `review.prejudgment.v1`：

- 固定指令在前，说明任务、三种评价的含义、只输出 JSON、信息不足要弃权。
- 条目数据在中。
- 当前时间、时区、当地日期放在最后（用现有 `renderPrompt` 的 slot 方式，类似 `mail.judgment.now`，`packages/prompt-catalog/src/mail.ts:63-77`）。
- 不在固定文字里写日期、时间、哈希、模型名、路径。

### 2.4 模型输出什么

单条请求只返回一个对象，不返回数组，避免 key 对不上：

```json
{"rating":"useful","confidence":870,"reason":"…"}
```

- `rating`：该组允许的三个值之一，或 `null`（弃权）。
- `confidence`：0–1000 的整数，表示“我认为这个评价和主人一致”的自评概率；`rating = null` 时必须为 `null`。
- `reason`：最多 60 字，只用于服务进程内调试；可选存入加密封装的 payload，周报不读。

严格校验：

- 不属于该组的 rating（例如 `memory_kept` 给 `missed`，或 `mail` 给 `unneeded`）一律视为无效输出，不写记录、不猜、不强行改成合法值。
- 非整数 confidence、超范围、rating 与 confidence 不一致，一律无效。
- 无效输出按“没预评”处理，减量时展示；不写一条假弃权。

### 2.5 成本

- 复用 `proactive.modelRef`（生产是 Magpie 后面的便宜模型），不新增更贵的模型；不写死模型名。
- 单条调用、小 `maxOutputTokens`（建议 256）、`disableThinking`（若描述符支持）、输出只有一个小 JSON。
- 固定指令放在最前面，50 次调用共享同一前缀，命中提示词缓存后实际成本更低。
- 每天最多 50 条 + 每天成本上限（建议默认 `100_000` micros，按现有 `proactiveCostEstimator` 动态算），两者任一到达就停。
- `textHidden`、无文本且无计数信息的条目不调用模型，成本 0。
- 失败最多重试一次；仍失败就留空，减量时展示。不要为了“凑齐 50 条”反复烧钱。

### 2.6 一致率怎么算才不自欺

**分母和真值定义**：

- 只统计“有预评 `rating` + 有主人评价 + 该组允许这个评价”的条目。
- 主人评价：`ledger` 用 `decision_ledger.owner_rating`；`mail` 用 `COALESCE(proactive_processed_messages.owner_rating, CASE WHEN reviewed_at IS NOT NULL THEN 'useful' END)`，与 `daily-review.ts:342` 的页面语义一致。否则会漏掉邮件“有用”（见前提 8）。
- 弃权、没预评、主人没评、评价不适用于该组的，都不进分子分母，单独报“弃权率/未评率/覆盖率”。
- 报告必须给出公式和排除项，页面上的每个数字都要能按定义复算。

**不一致的防自欺措施**：

1. **总体一致率**：`matches / compared`，配 95% Wilson 区间。这是周报必报的数字，但不是唯一门槛。
2. **分组一致率**：按 `CalibrationGroup` 分别报，并报混淆矩阵、每类 recall。不要只报全池汇总；现有抽样是四组轮转，不是按池中比例，直接汇总会被组间比例扭曲。
3. **平衡准确率/每类召回**：按 Google Vertex 的做法，报 balanced accuracy 和混淆矩阵。原因是类别不平衡时“永远猜 useful”也能拿到很高的总体一致率。建议把“每个样本足够的类别 recall 下限”作为减量的附加门槛；阈值需要 Andy 定（见第五节）。
4. **减量后的选择偏差**：必须有“随机审计样本”。规则是：
   - 从当天候选池里按稳定哈希选 `auditPermille`（建议默认 200‰）作为审计样本，审计样本**无论模型多有把握都照常展示**。
   - 审计样本在预评时标 `audit = 1`，周报只用 `audit = 1` 的已评条目估计“减量后”的一致率。
   - 减量还没开启时，当天所有被展示项都与模型无关，可以用全部已评条目；`review_prejudgment_runs.reduction_active` 记录当天是否减量，报告据此选择“全部”还是“仅审计”。
   - 审计样本不足、或主人没评够，报告写“样本不足”，减量保持关闭或不扩大；绝不拿“被模型挑出来展示的条目”当无偏样本。
5. **门槛应看“会被隐藏的那部分”的一致率，而不是全池一致率**：真正有风险的是“模型有把握、且和历史一致，于是被隐藏”的条目。定义：
   - `wouldHide = rating 非空 AND confidence >= 阈值 AND history_disagreement != 1 AND 不属于 memory_checkup/other AND 文本可见`。
   - 在审计样本中，只取 `wouldHide = 1` 且有主人评价的条目，算 `hiddenAgreement = matches / n`，用 Wilson 下限比阈值。这才直接回答“把这条藏起来，主人会不会漏看”。
   - 全池一致率照报，但不单独用它开门。
6. **样本量**：`DEFAULT_MINIMUM_SAMPLES = 5` 只适合“样本不足就不显示百分比”，绝不能拿来开减量。新增 `reviewAgreementMinimumSamples`（建议默认 200，需 Andy 定），低于它一律“样本不足”。
   - 按仓库 `wilsonInterval(z=1.96)` 粗算：n=50 时全对下限约 92.9%，错 1 条就约 89.5% 不达标；n=100 约需 95% 观测；n=400 约需 93%；n=1000 约需 92%。所以“90% 下限”比“90% 点估计”严格得多，报告要明确写出当前 n 下“至少需要多少观测一致率才可能达标”。
7. **模型/prompt 换版要重置**：门槛只统计当前 `model_ref` + `prompt_id` 的记录。换模型或改提示词后，旧数据不能继续给新模型开门。

### 2.7 “模型没把握”和“和历史不一致”的可验证定义

**模型没把握**：

- `rating = NULL`（明确弃权）；或
- `confidence_permille < reviewConfidenceThresholdPermille`（建议默认 800，需 Andy 定）；或
- 根本没有预评记录 / `textHidden` / 无有效文本。

自评置信度没有校准保证，所以它只作为“展示/隐藏”的初筛；真正的校准靠 2.6 的审计一致率。减量开启后，如果审计发现某个置信度区间的实际一致率低于阈值，应把该区间整体降级为“没把握”，或直接关闭该组减量。这个“按置信度分桶再校准”可以作为下一步，但第一版至少要有总体/分组门槛。

**和历史不一致**：

- 对每条待评条目算一个 `history_bucket`，只用主人已有的评价，不含当天：
  - `proactive_pushed`、`proactive_silent`；
  - `memory_skipped:<category>`、`memory_kept:<category>`；
  - `consolidation`；
  - `mail`（不要用发件人域名，避免引入不必要的信息）。
- 在 `reviewHistoryDays`（建议 28 天）内，取该 bucket 里主人评过的条目：
  - 样本数小于 `reviewHistoryMinimumSamples`（建议 20）= 没有可用历史，`history_disagreement = NULL`，不据此展示；
  - 否则取多数评价；平票也算没有多数；
  - 模型 rating 非空且不等于多数评价 = `history_disagreement = 1`。
- 这三项（bucket、样本数、多数评价）在预评时写进表里，报告和页面都能复核；不要只写一个布尔值。

### 2.8 自动减量规则

减量是“配置开关 + 分组门槛”的双条件，默认关闭：

1. `reviewReductionEnabled` 默认 `false`。关闭时，无论一致率多高，页面完全按现有 `selectDailyReview` 展示，预评只记录。
2. 打开后，按组决定该组是否可减量：
   - 该组在审计样本中有足够的 `wouldHide` 已评条目；
   - `hiddenAgreement` 的 Wilson 下限 ≥ `reviewAgreementThresholdPercent`（默认 90）；
   - 每个样本足够的可用类别 recall 下限 ≥ `reviewPerClassFloorPercent`（建议默认 80，需 Andy 定）；
   - 当前 `model_ref` + `prompt_id` 的数据满足以上条件。
3. 组不可减量时，该组所有条目照常展示；不要因为某个稀有组样本不足就阻塞所有组，也不要把稀有组偷偷隐藏。
4. 组可减量时，当天展示集合 =
   - **审计样本全部**；
   - 加上 `wouldHide = 0` 的条目（没把握、历史不一致、弃权、没预评、文本隐藏）；
   - 加上永远不减量的组：`memory_checkup`（P4-6）和 `other` 折叠组；
   - 按同一个 `hash(seed|day|key)` 排序，受当天 `capacity` 限制。审计样本优先，审计样本本身超过容量时也按哈希取前 `capacity` 条，但绝不因为模型而丢掉审计样本。
5. 被隐藏的条目数记为 `hiddenByModel`，与现有 `notSampled`（因为容量没被抽到）分开统计和显示。
6. 页面在主人评分前**不显示**单条的模型 rating、confidence、是否“没把握”或“历史不一致”。只显示聚合信息，例如“今天自动减量：已隐藏 12 条；审计样本 5 条；本组一致率下限 92.1%”。理由：OpenAI 的最佳实践建议 human eval 用 “randomized, blinded test”；提前给模型评价会锚定主人，污染真值。评分后是否展示，建议第一版也不展示，避免主人为了“配合模型”改评价。
7. 如果主人改了已评条目的评价，记录修改时间；门槛只使用“评分时还没看到模型评价”的评价。第一版最简单：单条模型评价永不下发，所以不存在这个问题。

### 2.9 开关和配置

在 `packages/application/src/ports/configuration.ts` 的 `ProactiveConfiguration` 和 `strict-configuration.ts` 的 `parseProactive()` 里增加，并**同时**加进 `rejectUnknown` 的允许键列表（否则生产配置会启动失败）：

- `reviewPrejudgmentEnabled`：默认 `true`，只记录。
- `reviewPrejudgmentDailyLimit`：默认 50，范围 1–50。
- `reviewPrejudgmentDailyCostMicros`：默认 100000，范围 1–10000000。
- `reviewReductionEnabled`：默认 `false`。
- `reviewAgreementThresholdPercent`：默认 90，范围 50–100（主人已定 90，但要求可配）。
- `reviewAgreementMinimumSamples`：默认 200，范围 1–100000。
- `reviewConfidenceThresholdPermille`：默认 800，范围 0–1000。
- `reviewAuditPermille`：默认 200，范围 0–1000。
- `reviewGateWindowDays`：默认 28，范围 1–366。
- `reviewHistoryDays`：默认 28，范围 1–366。
- `reviewHistoryMinimumSamples`：默认 20，范围 1–100000。
- `reviewPerClassMinimumSamples`：默认 20，范围 1–100000。
- `reviewPerClassFloorPercent`：默认 80，范围 0–100（若采用附加门槛）。

模型引用：直接复用 `proactive.modelRef`，不新增 `reviewPrejudgmentModelRef`，避免多一个可能被写成贵模型的入口；如果以后要分开，必须同样过 `model-ref-contract` 和 `check:expensive-models`。

### 2.10 测试与门槛

新增测试分四层：

1. **单元：提示词和确定性**
   - 同一条目两次构建，prompt 字节完全相同；交换输入 Map 的遍历顺序不影响结果。
   - 条目块在 `now` 之前；`now` 是最后一个 slot。
   - 固定前缀里没有日期、时间、哈希、路径、模型名。
   - 反向：把 `now` 放到条目前面、或把日期写进固定文字，测试必须失败。
   - 反向：把两条条目合成一次请求，同一条目的文本因另一条不同而字节变化，测试必须能暴露（第一版因此坚持一条一请求）。

2. **单元：解析和评价适用性**
   - `memory_skipped` 只接受 `useful/missed`；`memory_kept` 只接受 `useful/unneeded`；`mail` 只接受 `useful/missed`。
   - `mail + unneeded` 必须被拒绝（与 `production-proactive.ts:496` 的 `PROACTIVE_REVIEW_KEY_INVALID` 一致）。
   - 非整数 confidence、rating 与 confidence 不一致、未知字段，必须产生“无效/缺失”，不能强行变成合法值。

3. **单元：选择、门槛和报告**
   - 减量关闭时，展示集合与改动前逐字节相同；这是回归测试的重中之重。
   - 组 A 审计一致率 95%/n=100 且每类达标 → A 可减量；组 B 80% → B 全部展示。
   - 总体 95% 但 `missed` recall 0 → 不可减量（反向用例必须真的失败）。
   - 审计样本不足、主人未评够 → 不可减量。
   - 缺失预评、`textHidden`、弃权、`memory_checkup`、`other` → 必须展示。
   - `audit` 样本无论 confidence 多高都展示。
   - 换 `model_ref` 或 `prompt_id` 后旧数据不再给新模型开门。
   - 邮件“有用”存成 `owner_rating = null` + `reviewed_at` 时，必须按 `useful` 进入一致率；直接只 JOIN `owner_rating` 的版本必须测试失败。
   - `review_prejudgment_runs.reduction_active` 决定报告用“全部已评”还是“仅审计”；两种都要有正反例。
   - 周报 `assertTimestampFormat` 必须覆盖新表的 `prejudged_at`；一条坏时间必须让报告失败。
   - 历史格式从 v3 升 v4：v4 能被 `report.mjs` 读取并去重；v3 旧记录仍可作为“上一周”读取；`sameMeasurement` 包含新字段。

4. **集成：真实服务 + SQLite + 模型桩**
   - 预评不写主人评价字段；主人评分后模型记录仍独立存在。
   - 同一天重跑不重复调用、不重复计费。
   - 敏感文本在出口被遮盖；`check:egress-redaction` 通过；新服务没有 raw fetch。
   - 预算用尽后停止，缺失项仍展示。
   - 服务重启后从 `review_prejudgment_runs` 和唯一键恢复，不重复预评。
   - 页面快照新增的 `reduction` 数字有正向和反向验收：改输入后 `hiddenByModel`、`auditShown`、`sampled`、`notSampled` 按定义变化；不能有一个没有定义的数。

把这些测试加进 `npm test`；再加一个 `check:review-prejudgment`（包含单元 + 集成 + 目录/SQL 静态检查）并放进 `package.json` 的 `check:steps`，同时确认 `check:prompt-catalog`、`check:egress-redaction`、`check:expensive-models` 都跑。

### 2.11 建议落地顺序

1. 迁移 + 新表 + 配置键（一个改表结构块，先排队）。
2. 提示词目录 + 解析器 + 预评服务（只记录，不减量；默认开）。
3. 周报一致率 + v4 历史格式 + 正向/反向测试。
4. 减量选择器 + 审计样本 + 页面聚合数字（默认关）。
5. 打开减量前，用真实生产数据至少跑一个完整窗口，人工确认数字和样本量。

---

## 三、考虑过但不选的做法

1. **把模型预评写进 `decision_ledger.owner_rating`**：会覆盖主人评价，且 `owner_rating` 的 CHECK 无法区分“人评/模型评”；不选。
2. **复用 `decision_signals` 或 `decision_ledger_payloads`**：前者只允许 `opened/undone/replied`，后者只允许 `model_input/model_output`；要么改迁移放宽 CHECK，要么语义混乱；不选。
3. **在 `decision_ledger` 和 `proactive_processed_messages` 各加几列**：看起来少一张表，但没有模型/prompt/置信度/历史快照/审计标记，模型换版后无法重测，且两条写路径容易漏；不选。
4. **在决策发生时内联预评**：会增加真实决策路径的延迟和成本，且结果要到日打分才用；不选。未来如果邮件判断调用已经拿到邮件内容，可以在同一个调用里多输出一个字段，但那会改现有邮件提示词并影响缓存，第一版不混在一起。
5. **一次请求批量评 50 条**：省固定前缀，但会让同一条目的字节受“前面有哪些条目”影响（出口的已学值遮法），还会让一条输出截断毁掉整批；第一版一条一请求。若 Andy 认为成本必须再降，再单独做“逐条预遮 + 稳定排序 + 截断回退”的批量方案。
6. **让模型直接替主人打分，跳过人工**：没有一致率数据，正是问题开头说的自欺；不选。
7. **打分前把模型预评显示给主人**：会锚定主人，污染真值，也违反“randomized, blinded test”的业界建议；不选。只显示聚合数字。
8. **只报总体一致率、点估计 ≥ 90% 就开门**：类别不平衡和选择偏差都会让这个数字虚高；不选。至少要有分组、混淆矩阵、审计样本和“会被隐藏那部分”的一致率。
9. **减量后只测被隐藏的条目**：被隐藏的条目没有主人评价，测不了；只测被展示的条目又有选择偏差；所以必须有随机审计样本，不选“省掉审计”。
10. **让周报脚本解密正文来评**：周报是只读、无解密能力；也会把敏感内容带进报告；不选。预评表只存评分和元数据。
11. **按置信度直接隐藏、不测实际一致率**：模型自评置信度没有校准保证；不选。置信度只做初筛，开门靠审计一致率。

---

## 四、风险和反例

1. **永远猜多数类**：池里 95% 是 `useful`，模型永远输出 `useful`，总体一致率 95%，但所有 `missed` 都错。反例测试必须让“总体高、少数类 recall 低”的组不可减量。
2. **自信地错**：模型给 990 的 confidence，但把“该提醒”判成“不需要”；如果这条被隐藏，主人就漏了。审计样本和 `wouldHide` 分组门槛只能保证“平均错误率 ≤ 10%”，不能保证每一条；这是减量本身的风险，必须让 Andy 知道并接受。
3. **选择偏差**：减量后如果只统计被展示的“没把握”条目，一致率会很难看；如果只统计模型有把握的条目，又会虚高。必须用 `audit = 1` 的随机样本开门，并明确报告“这是审计样本，不是全部”。
4. **主人不评审计样本**：门槛会一直“样本不足”，减量不扩大。这是安全失败，但会让功能看起来没生效；页面要给出“还差多少条审计评价”的可验证数字。
5. **主人评分被锚定**：如果页面提前显示“模型觉得有用”，主人的评价就不再独立。第一版单条预评永不下发；如果以后要下发，必须把“看到之后改的评分”排除出门槛。
6. **同一封邮件被算两次**：`ledger:` 的主动决策和 `mail:` 的邮件条目可能指向同一封邮件；两者都是主人实际会评的 key。第一版以 review key 为统计单位，并在周报报“重复率”；如果重复严重，再按 `message_id` 去重，但不要在没数据前假设。
7. **模型或提示词换版**：旧模型的高一致率会给新模型开门。必须只统计当前 `model_ref` + `prompt_id`；换版后所有组回到“未证明”。
8. **时区不一致**：日打分用 `timeZone` 配置，周报窗口用 JST（`packages/calibration/src/index.ts:216-257`）。如果 Andy 不在日本时区，`day` 和报告窗口会错位。因此一致率 SQL 用 `prejudged_at` 的 UTC 时间落在窗口内，不用 `day` 过滤；`day` 只做幂等。测试要用非 JST 时区。
9. **出口遮法改变字节**：同一段文字里的密码/验证码会被出口按“前面出现过的值”遮掉；一条一请求把这种依赖限制在条目自身，但仍可能因遮盖密钥轮换导致占位符字节变化。这不是内容依赖，但会影响缓存；报告里要记录 `input_digest` 和 `model_ref`，排查时能分辨“模型变了”还是“遮法变了”。
10. **新增提示词文字进入可信清单**：按 `prompt-prefix.md:53`，新增长固定文字只有在旧消息里逐字出现时才可能改变旧对话的遮法。理论上不影响，但生产历史内容未核实；上线前应跑 `check:prompt-prefix`，并用一条“旧消息含新文字”的合成测试确认行为。
11. **Pi 的 message timestamp**：`backgroundModelContext(prompt, Date.now())` 把时间放在消息元数据里；如果 Pi 把它序列化进请求体，这就是一个每次变化的字节。现有后台调用已经如此，本次不新增；但“同一段文字不同字节”这个问题要如实标注为“未核实 Pi 是否把该字段发给服务商”。
12. **成本超预期**：固定指令越长、条目越长，50 次调用的输入成本越高；输出理由太长也会增加成本。用 256 输出上限、60 字理由、每天 50 条和每日成本上限兜底；若仍超，优先砍条目文本而不是砍审计样本。
13. **迁移排队**：新表迁移不能和别的改表结构块同时做；先领号，不要改历史迁移。
14. **P4-6 的 `memory_checkup`**：它不在当前代码里（本检出未找到），如果 P4-6 把它放进 `other` 或新组，减量必须显式排除；测试要覆盖“memory_checkup 永不被模型隐藏”。

---

## 五、需要人拍板的取舍

1. **门槛到底比什么**：是“全池总体一致率下限 ≥ 90%”，还是“会被隐藏那部分的一致率下限 ≥ 90%”？我建议后者，因为它直接对应“藏起来会不会漏”；前者只能说明模型平均还行。若 Andy 坚持字面上的全池一致率，也要同时报隐藏集一致率，且不要把全池数字当唯一开门条件。
2. **按组开门还是全局开门**：我建议按组；稀有组样本不足时只让该组不减量，不阻塞其他组。若 Andy 要求“一个总数字”，则稀有组的样本不足会长期阻塞全局减量。
3. **最小样本量**：90% 下限在小样本上极严。建议 `reviewAgreementMinimumSamples = 200`，审计比例 20%；如果希望更快看到效果，可以降到 100，但要接受“观测一致率必须约 95% 才可能过”。请 Andy 定。
4. **每类 recall 的附加门槛**：建议 `reviewPerClassMinimumSamples = 20`、`reviewPerClassFloorPercent = 80`；这是防止“永远猜多数类”的必要条件，但会推迟减量。请 Andy 决定是否加、加多少。
5. **置信度阈值**：建议先 800，再用审计数据按桶校准；如果模型普遍给 900+，800 等于没筛。请 Andy 定初值。
6. **审计比例**：建议 20%（`200‰`）。太低会长期样本不足，太高会抵消减量效果。请 Andy 定。
7. **历史桶的粒度**：建议只用 `group + category`（邮件只用 `mail`），28 天、最少 20 条。更细（发件人、主题）会更准但引入更多噪声和隐私面。
8. **邮件真值**：建议用页面现有的“`reviewed_at` 视为 useful”语义，这样和主人实际看到的一致；如果你认为“只是点开过、没明确评有用”不能算，就要改邮件评分写路径，把 `useful` 明确写进 `owner_rating`，这会改变现有数据和报告，需单独决定。
9. **是否在评分后展示单条模型预评**：建议第一版不展示；如果展示，必须把“看到后改的评分”排除出门槛，否则一致率会被污染。
10. **一条一请求 vs 批量**：建议一条一请求以保字节确定性和便于定位坏输出；如果每日成本不可接受，再讨论批量方案。
11. **模型选择**：建议直接复用 `proactive.modelRef`；如果要用另一个更便宜的模型，必须新增配置项并过同一套便宜模型检查。
12. **减量开启方式**：达到门槛后自动生效（配置开关打开的前提下），还是第一次需要 Andy 在页面上确认一次？目标写的是“达到阈值后默认只给主人看……自动减量默认关闭”，我理解为“配置默认关，打开后按门槛自动生效”；请确认是否要多一次人工确认。

---

## 六、读代码或来源证实的 vs 推测/未核实

**[已证实]**

- 现有请求顺序、只追加、字节确定规则，以及提示词目录的可信文字机制：`.claude/rules/prompt-prefix.md:27-29,35-36,51-54`。
- 统一出口和 `check:egress-redaction` 的登记方式：ADR 0148:39,47；`scripts/check-egress-redaction.mjs:8-16,189-195`。
- 现有后台调用把 prompt 放进 user 消息、system 固定：`packages/runtime-pi/src/egress-context.ts:23-27`；`pi-model-transport.ts:309`。
- 现有表放不下第二套评价：0069:27-28、0080:6、0070:4。
- 每日打分的抽样、容量、缓存分组和 `ledger:`/`mail:` key：`daily-review.ts:47-49,81-132,171-182,240-371`。
- 配置默认值和 `rejectUnknown`：`strict-configuration.ts:983-1005,1041-1043`。
- Wilson/proportion、`DEFAULT_MINIMUM_SAMPLES=5`、周报只读：`calibration/src/index.ts:2,177-207`；`report.mjs:78-81`。
- 邮件“有用”写为 `null + reviewed_at`、页面映射为 `useful`、校准 SQL 只读 `owner_rating`：`production-proactive.ts:511-521`、`daily-review.ts:342`、`calibration/src/index.ts:656-659`。
- 便宜模型走 `ProactiveModelInvoker` 和统一出口：`production-model-composition.ts:495-555`、`service-main.ts:1629`、`proactive-mail-check-service.ts:72-83`。
- 业界来源的原话：见第一节第 11 条。

**[推测/未核实]**

- 生产里各组的真实条数、主人评价覆盖率、`missed` 的稀有程度：未查生产库，未知。
- 50 次/天在当前 Magpie/DeepSeek 价格下的实际成本：未用真实价目跑，需按 `proactiveCostEstimator` 和当前描述符计算。
- 复用 `proactive.modelRef` 的模型对“预评主人评价”是否足够准：没有数据，必须靠第一窗口实测。
- Pi 是否把 `message.timestamp` 序列化进请求体：未读到转换细节，标“未核实”；这是既有后台调用的行为。
- 新增提示词固定文字是否会改变任何生产旧对话的遮法：取决于旧历史是否逐字包含新文字，未查生产历史；上线前用 `check:prompt-prefix` 和合成测试确认。
- P4-6 的 `memory_checkup` 最终是独立组还是并入 `other`：本检出代码里没有，按任务材料“计划加”处理，实现时要与 P4-6 对齐。
- 网页/网关契约是否已有可放 `reduction` 的字段：本检出未看到，需改 `GatewayV2Snapshot` 和前端。
- `DAILY_REVIEW_MAX_RATINGS=50` 是否在别处有隐藏强制：grep 只见定义；现有评分命令一次最多 50 条，不是每日 50 条。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变现有对话的请求开头。** 预评是一个全新的、单轮的辅助调用，不碰主对话的系统提示、工具定义、历史消息；主对话已有的字节不改、不重排。依据：`.claude/rules/prompt-prefix.md:35`“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

**新调用本身是“固定在前、变化在后”。** 固定指令在最前，单条条目在中，`now`/时区/当地日期在最后；system 是固定的 `EGRESS_PLACEHOLDER_LEGEND`，不是带变量的系统提示。依据：`prompt-prefix.md:27-29` 和 `egress-context.ts:23-27`。因此“发给模型的内容仍然只在末尾追加”对现有对话成立；对新调用则是“每次从同一个固定前缀开始，只在尾部放本次数据”。

**唯一需要留意的例外**：新增提示词条目会进入提示词目录的可信文字清单。按 `prompt-prefix.md:53`，如果生产旧消息里逐字出现了这段新文字，旧对话的遮法可能变一次。这个概率很低，但未核实生产历史；上线前要跑 `check:prompt-prefix`，并用合成测试覆盖。除此之外，不改任何已有提示词文字。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**按本方案不会。** 关键做法是“一条一请求”：

- 请求里只有固定指令 + 这一条条目 + 末尾的 `now`；
- 条目 JSON 固定键顺序、数组按稳定 id 排序、不依赖数据库返回顺序；
- 条目里不放 `decidedAt`、`generatedAt`、随机数、模型自评等会变的值；
- `now` 放在条目之后，出口遮法只依赖它前面的内容，所以不会反过来改变条目本身的字节；
- 出口每次只看到这一条，不存在“上一条里的密码把下一条遮掉”的跨请求差异。

依据：`prompt-prefix.md:51-53`“同样的内容，每次都要序列化成同样的字节”“遮盖敏感信息必须是确定的”。**如果改成批量请求，这条就不成立**：同一段条目可能因为前面放了不同条目而被出口的“已学值”规则遮成不同字节，所以第一版不批量。

**仍有两个全局例外**：出口的 HMAC 遮盖密钥轮换会让占位符编号变化（不是内容依赖）；Pi 的 `message.timestamp` 若进入请求体，则是既有后台调用的行为，标“未核实”。这两点不影响“同一段文字因前后文不同而变”的判断。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，分三层：

- **现有门槛**：`npm run check:prompt-catalog`（目录清单、digest、固定层无日期/时间/哈希、槽位白名单）、`npm run check:egress-redaction`（新调用复用已登记出口，不能出现 raw fetch）、`npm run check:expensive-models`（不写死贵模型名）、`npm run check:prompt-prefix`（现有对话前缀不变）。
- **新增门槛**：`check:review-prejudgment`，包含预评解析、选择、门槛、周报和集成测试，并加进 `npm run check` / `npm test`。
- **反向用例必须真的失败**（要求在实现前先看到红）：
  1. 去掉“审计样本必须展示” → 减量后一致率只来自被挑过的条目，测试失败。
  2. 把门槛改成点估计 ≥ 90% → 类别不平衡用例（总体 95%、`missed` recall 0）通过，测试失败。
  3. 样本数小于最小样本仍开门 → 测试失败。
  4. 只 JOIN `owner_rating` 算邮件一致率 → “邮件有用 = null + reviewed_at”用例漏算，测试失败。
  5. 接受 `mail + unneeded` 或 `memory_kept + missed` → 与 `proactive.review.rate` 的后端拒绝不一致，测试失败。
  6. 缺少预评、`textHidden`、弃权、`memory_checkup`、`other` 被隐藏 → 测试失败。
  7. 同一天重跑重复调用/重复计费 → 测试失败。
  8. 预评写入或覆盖主人评价字段 → 测试失败。
  9. 把 `now` 放在条目前面、或在固定前缀里写日期 → 确定性/目录测试失败。
  10. 新表时间格式坏掉但周报仍出数 → `assertTimestampFormat` 测试失败。
  11. 新配置键没加进 `rejectUnknown` → 启动配置测试失败。
  12. 模型/prompt 换版后旧数据仍开门 → 测试失败。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

按 I-73 的教训，必须逐项核对“产生端 → 使用端”，不能只看 diff：

| 值 | 产生端 | 使用端 | 核对点 / 测试 |
| --- | --- | --- | --- |
| `review_key` (`ledger:`/`mail:`) | `daily-review.ts:171` `reviewKey()` | `parseReviewKey()`（174-182）、预评表、选择器、周报、API | 每个 key 必须能 round-trip；`ledger` id ≤128、`mail` message_id ≤256、key ≤300；测试覆盖含 `:`/Unicode 的 id |
| `source` | `parseReviewKey` | 预评表 CHECK、SQL JOIN | 只允许 `ledger`/`mail`；两种都要有正反 JOIN 测试 |
| `decision_id` / `message_id` | `readDailyReview` 的 ledger/mail 条目 | `decision_ledger(id)`、`proactive_processed_messages(owner_id,agent_id,source,message_id)` | 复合外键/触发器保证存在；测试“预评一个不存在的 id”必须失败 |
| `rating` | 模型解析器 | 预评表 CHECK、选择器、周报、`DECISION_RATINGS` | 必须是三值之一；按组限制；`mail + unneeded` 必须拒绝；不能把非法值 clamp 成合法值 |
| `confidence_permille` | 模型解析器 | 预评表 CHECK、阈值比较 | 0–1000 整数；`rating` 为 NULL 时必须 NULL；非法即“无预评” |
| `model_ref` | `proactive.modelRef` 配置 | `proactiveModel()` 描述符查找（`production-model-composition.ts:499`）、`check:model-ref-contract`、`check:expensive-models` | 必须是配置里存在、允许 `private`、且便宜模型；不符时预评失败 → 展示 |
| `prompt_id` | 提示词目录 | 目录 manifest、预评服务、报告 | 必须存在、digest 一致、`parser` 名字存在；目录测试覆盖 |
| 新配置键 | 配置文件/文档 | `parseProactive()` 的 `rejectUnknown`（`strict-configuration.ts:983-1005`） | 每个键都要进白名单，有默认值/范围/非法值测试；漏一个生产启动就失败 |
| `history_bucket` / `history_majority` | 应用层 | 选择器、周报分组 | 只允许固定枚举/组名+category；不要自由文本；测试非法桶被拒 |
| `day` | `startOfZonedDay(now, timeZone)`（`daily-review.ts:253`） | 预评表唯一键、日任务幂等 | 只做幂等，不做周报窗口；报告用 `prejudged_at` UTC；非 JST 时区测试 |
| `prejudged_at` | 服务时钟 | 预评表 CHECK、`assertTimestampFormat`、周报窗口 | 必须 `????-??-??T??:??:??.???Z`；坏时间让报告失败 |
| `input_digest` | 预评构建器 | 审计/排查 | 同一输入必须同 digest；模型/遮法变化时能区分 |
| `cost_micros` | 模型事件 | 每日成本累计、`review_prejudgment_runs` | 安全整数、非负；超预算必须停 |
| `audit` | 选择器哈希 | 报告、门槛 | 0/1；审计样本必须不受模型影响；测试打乱输入顺序不变 |
| `review_prejudgment_runs.reduction_active` | 日任务 | 周报选择“全部 vs 仅审计”、页面 | 必须和当天实际选择一致；测试正反两种 |
| `HISTORY_SCHEMA` v4 | `calibration/src/index.ts` | `report.mjs` 过滤、`historyRecord`、`sameMeasurement` | v4 能读、v3 能作为上一周；新字段参与去重；测试 |
| 页面 `sampled` / `notSampled` / `hiddenByModel` / `auditShown` | 选择器和 API | 前端、验收 | 每个数都要有定义、正向和反向验收；不能把 `hiddenByModel` 混进 `notSampled` |
| `memory_checkup` | P4-6 | 减量选择器 | 永不被隐藏；测试覆盖（即使当前代码里还没有这个组） |

最后一条是 I-73 的直接类比：“清单里的 id 能通过后端校验吗？”在本方案里就是：“预评产生的 `review_key`/`source`/`rating` 能不能通过预评表 CHECK、两个主人评价写入口的校验、周报 SQL 和前端契约？”答案必须是每一项都有上表这样的产生端→使用端测试，而不是只看预评服务的 diff。
