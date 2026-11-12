# P4-5 方案：用真实数据建评测集

## 一、方案依赖的前提

### 读代码或来源证实的

**P1 发给模型的内容只能末尾追加，固定在前、可变在后，后台调用同样适用。**
`.claude/rules/prompt-prefix.md:27`：「固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。」`.claude/rules/prompt-prefix.md:67`：「后台调用也是固定的在前、会变的在后……先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。」

**P2 已发内容不可改动，遮盖必须是确定的；提示词目录里的固定文字不参与遮盖。**
`.claude/rules/prompt-prefix.md:35`：「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。」`.claude/rules/prompt-prefix.md:52`：「一条消息遮成什么样，只能取决于它自己和它前面的内容」；`.claude/rules/prompt-prefix.md:53`：提示词目录里不少于 24 个字符的固定文字片段不检查。

**P3 统一出口只认四种请求路径，遮盖用确定性占位符。**
`packages/application/src/services/model-egress.ts:263-269`：只处理 `/chat/completions`、`/responses`、`/messages`、`/embeddings`；`:121-126`：占位符 `letters(sign(key, kind\u0000value))`，同一密钥下同一值遮成同一字节。`.claude/rules/prompt-prefix.md:36`：「遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同。」

**P4 原话在生产上只有服务进程能解，取法已有现成函数。**
`apps/agent-service/src/service-main.ts:1461-1478`：`readQuote` 用 `episodeProtector.unprotect` 解密；`apps/agent-service/src/production-memory-consolidation.ts:10-27`：`quoteRefOfMemory` 按 `(occurredAt, quoteRef)` 排序取最早一条原话。

**P5 检索入口可控、能避免污染生产统计。**
`packages/application/src/services/durable-memory-service.ts:367-390`：`search` 的 `recordUse` 可选、`includeTentative` 默认不含待确认记忆；检索只返回 `status === "active"` 的记录（`:407`）。

**P6 决策记录与评价口径。**
`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:27`：`owner_rating IN ('useful','unneeded','missed')`；`:50-55`：`consolidation` 的 outcome ∈ merge/supersede/archive/reflect。`packages/calibration/src/index.ts:2-3`：`DEFAULT_MINIMUM_SAMPLES = 5`、`WILSON_Z = 1.96`（小样本组只报 Wilson 区间）；`:12,15-25`：`CALIBRATION_RATINGS` 和按 kind 分的组。

**P7 自动检查的挂法与花钱闸门有现成模式。**
`package.json:27`：`check:steps` 是一串 `check:*`；`package.json:94-97`：`eval:jarvis` 离线测试 + `eval:jarvis:live` 真跑分离。`scripts/jarvis-test/live.mjs:36-43`：无 `--confirm-cost` 就拒绝开跑并报上一轮实测费用；`scripts/evals/memory-capture-live.eval.ts:12-19`：评测模型/网关用环境变量注入，默认 `deepseek/deepseek-v4.1-flash`。`scripts/evals/memory-capture-score.mjs:126`：已有 `validateDataset` 确定性数据集校验先例。

**P8 LongMemEval 官方事实。**
https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/README.md ：三档各 500 题；`question_id` 以 `_abs` 结尾的是拒答题；官方判分 `python3 evaluate_qa.py gpt-4o ...`，输出 jsonl 只需 `question_id` + `hypothesis` 两字段；`longmemeval_s` 约 115k token/题（~40 会话），`oracle` 只含证据会话；评测时跳过 30 个拒答题是检索评测的做法。

**P9 合成与真实数据可能得出相反结论。**
https://arxiv.org/abs/2602.04482 （ProAgentBench）：「real-world training data substantially outperforms synthetic alternatives」（LLaMA-3.1-8B SFT：74.0% vs 62.1%）。

### 推测 / 未核实

- 生产机当前 active 且非 tentative 的记忆条数、带 `quoteRef` 的比例、决策表已评价条数（材料只说「要等足够评价」，无数字）——**未核实**。
- 替换判分模型后 LongMemEval 分数的漂移幅度——**推测**，方案里用抽样人工核对兜底。
- 服务进程内做每周定时任务是否与现有调度冲突——**未核实**（`production-background-runs.ts` 的事件驱动框架读过，但没有查它有没有 cron 式入口）。

---

## 二、方案本身

### 1. 数据集放哪、怎样可复现

**数据不进仓库，进仓库的是「能重建同一份数据集的一切参数」。**

- 原始数据集（题目、原话）落在生产机 `~/himawari/.ci-output/evals/real-memory/<UTC日期>/dataset.json`，与现有 `.ci-output` 惯例一致，不进 git。
- 仓库里新增 `evals/real-memory/manifest.jsonl`，每行一次生成记录：`dataset_sha256`、`schema`、抽样窗口 `[since, until]`、种子、每题型条数、被拒题目数。只含派生量，不含任何原话，可以进仓库。
- **可复现的做法：生成过程全部确定性。**
  - 生成脚本跑在生产服务进程内（只有它能过 `readQuote` 解密，前提 P4）。复用 `quoteRefOfMemory` 和 `readQuote`，不另写取原话的代码，避免两端分叉。
  - 候选池 = `memory_records` 中 `status='active'` 且 `tentative=0` 且有 `quoteRef` 的记录，按 `(occurredAt, quoteRef)` 排序（与 `quoteRefOfMemory` 同一排序规则），窗口过滤后做固定种子的抽样。同一窗口 + 同一种子 + 同一数据 → 字节级相同的 `dataset.json`（时间戳等元数据写进文件但不参与 sha256，或单独放 `meta.json`）。
  - **Andy 确认环节**：生成两阶段。第一阶段产出候选题目进「待确认」队列（沿用记忆待批准的既有交互模式），Andy 在控制台勾掉不合格的题；确认后的集合才冻结为 `dataset.json` 并写 manifest。每周自动更新 = 服务进程每周固定时刻跑第一阶段，其余等 Andy。
  - 出题的模型调用（改写原话成问题）走统一出口 `ModelEgress`，提示词登记进 `packages/prompt-catalog`（新增 `src/eval.ts` 模块并进 `trusted.ts` 的模块清单）。

### 2. 「Himawari 作答」走哪条路径

**走「检索 + 单轮作答」，不走完整对话运行；检索指标单列。**

- **检索层**：直接调 `DurableMemoryService.search`，`recordUse: false`（前提 P5），量 hit@k / recall：标准答案对应的 memory id 是否被检索出来。这一层免费（本机向量或网关 embedding），且和 P3-1/P3-3 的并行线程天然兼容——他们的改动会立刻反映在这层指标上。
- **作答层**：一条单轮请求：固定指令（提示词目录登记）在前，数据块（问题）放最后一条 user 消息。**只给问题，不给检索结果也不给原话**——这才测的是「Himawari 的记忆系统」，而不是把答案塞给它。要不要给检索结果作对照臂（给了检索结果能答对、不给答不对 → 问题在检索；两臂都答不对 → 问题在作答或记忆本身），作为可选开关。
- **不走完整对话运行的原因**：一整轮 Pi 运行带工具执行和外部副作用（发邮件、写记忆），既不可复现也污染生产状态；每题费用高一个数量级；而且工具循环的非确定性会让「同题不同分」。

### 3. 防泄露、判「对」、过期记忆

**防泄露（三层，前两层是确定性检查，免费）：**
1. 出题提示词要求改写提问，不许复述原话片段。
2. 自动检查：每道题的问题文本与它的标准答案原话做最长公共子串/n-gram 重叠检查，超阈值该题在生成阶段就被拒掉、不进候选队列。检查本身是纯函数，进 `npm run check`。
3. 作答请求物理上不含原话。

**判「对」分两层：**
1. **确定性层（本地，先跑）**：从原话里用规则抽关键值（实体、日期、数字——记忆记录本身有 `entities`/`category` 字段可用），归一化（全半角、空白、标点）后检查回答是否覆盖这些值。覆盖 → 对；明确矛盾（数值/日期冲突）→ 错；都不是 → 进第二层。
2. **模型层（只处理第一层拿不准的）**：单轮请求，把「问题 / Himawari 的回答 / 原话」都放最后一条 user 消息，指令固定在前（前提 P1），temperature 0，输出枚举 `equivalent / different / cannot-determine`。模型选 `deepseek/deepseek-v4.1-flash` 经 AI Gateway（与现有评测一致，前提 P7；不触碰「Claude/OpenAI 同价位」禁令）。判分请求也走 `ModelEgress`——占位符是确定性的（前提 P3），同一个敏感值在回答和原话里遮成同一个占位符，事实等价判断不受影响；含机器机密的内容会被拒发，该题标记 `judge-refused` 不计分。
3. 每次判分记录原始输出进 history，不覆盖。

**已被取代/过期记忆：**
- 只从 `active && !tentative` 出题（前提 P5/P4），被 supersede/archive 的（0069 迁移 `:51`）天然不入题——标准答案就是当前生效的记忆。
- 时间性记忆（`dueAt`/内容里带日期）在生成时抽出来存 `expiresAt`；评测运行时已过期的题跳过并计 `expired`，不进分母。每周更新数据集本身就缓解了过期问题。

### 4. 主动决策评测

- 构造：从 `decision_ledger` 取 `owner_rating IS NOT NULL` 的行，按 kind 分三组（proactive / memory_candidate / consolidation，对应 calibration 分组，前提 P6）。题目 = 解密后的 `reason_ref` + `inputs` 摘要 + 决策时的上下文，问题 =「当时该不该这么做/做得对吗」，**预测标签就是三分类 useful/unneeded/missed，判分是纯字符串匹配，零模型判分成本**。标签常量直接 `import` 自 `packages/calibration/src/index.ts:12`，不另造词（落实 I-73：值只有一处定义，两端共用）。
- 抽样分层：按组 × rating 分层抽样，保证「错」的例子不被多数类淹没。
- **样本少时**：复用 calibration 的口径——组内样本 < `DEFAULT_MINIMUM_SAMPLES` 时只报 Wilson 区间、不报点值、不进基线对比（前提 P6）；目标本身就写明这一半要等评价够多，所以设硬门槛：**每组 ≥ 30 条已评价样本才记录第一个基线**，之前每周只产出样本量报告（提醒 Andy 去评价）。

### 5. LongMemEval

- **跑 oracle 档全量 500 题，S 档抽 50 题做一次性对照。**理由：oracle 历史只有证据会话，输入小、费用可控，且它测「作答」正好补上我们真实回忆集只测检索+短作答的短板；S 档每题 115k token × 500 题输入费太大（前提 P8），且我们自己的真实数据集已经在量「真实历史规模下的检索」。
- **费用控制**：沿用 jarvis 模式——1-token 预检 + `--confirm-cost` 上限 + 花到上限即停（前提 P7）。被测系统（Himawari 的检索 + 生成）用便宜模型，不碰禁令。
- **判分模型不同时的可比性**：fork 官方 `evaluate_qa.py`（MIT）只替换判分模型参数，保持评分提示词和 `autoeval_label` 逻辑逐字不变；文档里写明「判分器为 X，与官方 GPT-4o 榜不可直接比，仅作趋势对照」；再抽 30 题 Andy 人工核对，报一个「人工-模型判分一致率」，作为可比性校正的实证。输出仍写成官方格式的 jsonl（`question_id` + `hypothesis`，前提 P8），让 fork 的判分脚本能直接吃。
- 拒答题（`_abs`）按官方口径单独报 abstention 分数，不从 QA 分里剔除。

### 6. 每周费用估算方法

- 公式先行、实测校正：`费用 ≈ N_题 × (出题输入×单价 + 出题输出×单价) + N_答 × 作答费 + N_判 × 判分费`，单价的输入 token 数用上一轮 history 里记录的实测 usage 外推——jarvis live 已经这样「报上一轮实测费用」（前提 P7），新脚本照抄。首次运行前先用 5 题试跑一轮，把实测数写进估算。
- 每周更新的预算：确认后的数据集只做「检索 + 作答 + 判分」，出题不重跑（题目冻结），费用远低于首建。估算值打印在脚本拒绝开跑的错误信息里（jarvis 模式），超过 0.5 美元必须 Andy 批 `--confirm-cost`。
- 长期费用大头是 LongMemEval S 档，一次性对照跑之前单独估算报批。

### 7. 自动检查（对应必答 3，详见下）

新增 `check:eval-dataset`（进 `check:steps`，`package.json:27` 模式），全部离线免费：schema 校验（`validateDataset` 先例）、泄露检查（题目-原话重叠）、判分器单测含反向用例、提示词登记检查（复用 `check:prompt-catalog`）、请求组装前缀检查含反向用例。live 跑不进 `npm run check`，沿用 qualification project。

---

## 三、考虑过但不选的做法及原因

1. **「Himawari 作答」走完整对话运行**：最接近真实，但不可复现（工具副作用）、污染生产状态（`recordUse` 会影响校准统计）、每题费用高一个量级。放弃；检索+作答分层能分别归因。
2. **真实数据集进仓库（脱敏后）**：即使遮盖，原话改写题仍含真实人名/日期的组合，属可再识别数据；且仓库里的数据集会随生产数据漂移失效。放弃，只进 manifest 派生量。
3. **判分用嵌入相似度（余弦阈值）**：便宜且确定，但原话与回答的措辞差异会让阈值不可移植（P3-1 换向量模型时阈值还会漂）。只作为确定性层的参考信号，不作为判对标准。
4. **LongMemEval 直接跑 S 档全量**：500 × 115k token 输入，费用和时长都不可控；oracle 档已满足「行业对照」的目标，S 档抽样足够。
5. **判分用 GPT-4o 之外的 Claude/OpenAI 旗舰**：触碰约束禁令；用 deepseek-flash 保持与现有评测同渠道同价位。
6. **决策评测用模型判分**：owner_rating 本身就是三分类标签，字符串匹配即可，引入模型判分反而添噪声和费用。
7. **每周更新用 Andy 的 ssh cron 触发**：ssh 只能 Andy 本人执行，等于不自动。改由生产服务进程内定时，ssh 只用于首次部署和查错。

---

## 四、风险和反例

- **风险：判分模型的占位符等价性失效。**反例：Himawari 的回答里把「サムライカード」说成俗称，原话里是正式名，遮盖后两者占位符不同，模型层可能误判 different。缓解：确定性层抽的是结构化关键值不依赖遮盖；模型层允许 `cannot-determine` 并在报告中单列。
- **风险：出题泄露。**反例：出题模型偷懒，问题就是原话换了个疑问词，检索层命中率虚高。缓解：重叠检查在生成阶段拒绝该题（免费、确定性、进 check）。
- **风险：判分模型与被测模型同源偏差。**反例：同为 deepseek 系，判分模型倾向认可同款措辞。缓解：模型层只处理确定性层拿不准的小部分；抽样人工核对一致率。
- **风险：每周定时生成与服务其他后台任务撞车。**未核实服务调度现状，上线前要确认（见「需要拍板」）。
- **风险：决策三分类在「missed」上的语义歧义**（该做没做 vs 做了没用）。缓解：题目模板按 kind 区分，proactive 组问「该不该提醒」，memory/consolidation 组问「该不该存/该不该整理」。
- **反例（用于验证反向用例真的会失败）**：见必答 3。

---

## 五、需要人拍板的取舍

1. **作答评测要不要带检索结果对照臂**：带则每题两次模型调用（费用×2），但能把「检索问题」和「作答问题」分开归因。建议首月带上，之后视归因需要关闭。
2. **每周更新的触发时刻与失败处理**：服务进程内定时 vs Andy 手动触发（手动则不算「每周自动」）。需 Andy 确认服务内定时可接受。
3. **LongMemEval S 档抽样量**（50 题约 $X，取决于被测模型的输入价）：预算批多少。
4. **判分一致率人工核对的抽样量**（30 题是建议值）。
5. **决策评测的基线门槛**（每组 ≥30）是否接受，还是先出 Wilson 区间版周报。

---

## 六、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。本改动全是新增的单轮辅助调用（出题、作答、判分），不触碰任何现有对话的系统提示、工具定义、历史或遮盖结果；不新增会出现在现有对话里的工具，不改提示词目录已有文字（新增条目是新对话才用，且按规则改提示词文字只对新对话生效）。新调用自身遵守：固定指令（提示词目录登记）在前，问题/回答/原话等本次数据放最后一条 user 消息；出题、判分、作答请求里不放当前时间，确需时间上下文的（如时间推理题）作为数据放最后一条消息。依据：`.claude/rules/prompt-prefix.md:27,35,67`。新组装器有前缀单测（见第 3 条），保证「只追加、可变值在末条」。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
已识别并消除三个来源：(a) **排序**——记忆列表、题目列表按 `(occurredAt, quoteRef)`/memory id 稳定排序（与 `quoteRefOfMemory` 同规则，`production-memory-consolidation.ts:21-25`），JSON 键序固定（规则第 10 条）；(b) **遮盖**——走 `ModelEgress`，占位符 `sign(key, kind\u0000value)` 密钥不变则字节相同（`model-egress.ts:121-126`），且提示词文字登记进目录成为不遮的固定文字（`prompt-prefix.md:53`）；(c) **时间**——数据集的 `generatedAt`、评测运行时间只写盘，不进请求体。剩余未消除：遮盖密钥轮换会让同段文字遮成不同字节——这是项目已接受的既有行为（`prompt-prefix.md:79` 排查清单里列明），不是本改动引入。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，进 `npm run check`（新增 `check:eval-dataset`，模式同 `package.json:27`）。反向用例逐个列出：
- 数据集 schema/泄露检查：把一道题的标准答案原话与问题文本对调或复制进问题 → 重叠检查必须拒绝；造一条 `memoryId` 指向不存在记录的题 → `validateDataset` 式校验必须报错。
- 判分器单测：把标准答案换成无关原话 → 判「错」；回答含全部关键值 vs 缺关键值 → 结果必须相反；数值矛盾 → 判「错」。
- 请求组装前缀单测：两次构造不同题目 → 指令段字节必须相同；把时间戳塞进指令段 → 测试必须失败（复刻 `check:prompt-prefix` 的反向用例法，`prompt-prefix.md:74`）。
- 提示词登记：未登记进 `prompt-manifest.json` 的新提示词 → `check:prompt-catalog` 失败（现成门槛）。
- history schema：写入端与读取端共用常量 + tooling 测试（先例 `test/tooling/jarvis-test-history.test.mjs`，`package.json:94`）。
live 真跑不进 check，但保留 `--confirm-cost` 与预检的运行时闸门（`jarvis-test/live.mjs:36-43` 模式）。

**4. 产生的每个值，使用端都能接受吗？（I-73 教训，两端核对表）**

| 产生的值 | 产生端 | 使用端 | 两端校验 |
|---|---|---|---|
| `dataset.json` 字段（question/answer/memoryId/quoteRef/expiresAt） | 服务进程内生成器 | 评测 live 脚本、判分器 | 生成端断言 memoryId 存在且 `active && !tentative`、quoteRef payload 存在且 `contentType==="text/plain"`（与 `service-main.ts:1470` 同一判断）；消费端 `validateDataset` 再校验一遍 |
| `quoteRef` 取法 | 复用 `quoteRefOfMemory` + `readQuote` | 出题器 | 不另写实现，单一来源 |
| 三分类标签 | `CALIBRATION_RATINGS`（`calibration/src/index.ts:12`） | 决策评测判分、周报 | 同一常量 import，零转换 |
| 小样本口径 | `DEFAULT_MINIMUM_SAMPLES`/`WILSON_Z` | 决策评测基线门槛 | 同上，直接复用 calibration 包 |
| `prompt-manifest.json` 新条目 sha256 | 新增 `src/eval.ts` | 出口遮盖 trusted 清单、check 门槛 | `check:prompt-catalog` 现成校验 |
| history schema（如 `himawari-real-memory-eval.v1`） | live 脚本写入 | trend/周报读取、tooling 测试 | 常量单处定义 + 两侧测试 |
| LongMemEval jsonl（`question_id`+`hypothesis`） | 被测系统输出 | fork 的判分脚本 | 字段名逐字对齐官方 README 规定；判分脚本对缺字段显式报错 |
| `manifest.jsonl` 的 `dataset_sha256` | 生成器 | 基线对比、每周 diff | 读端重算 sha256 比对，不符即拒 |
| 模型引用 | 环境变量/清单 | 各请求 `model` 字段 | 记取 I-73：清单产出的引用必须过发送端同一校验（`modelRefString` 门槛已是现成模式）——评测走 AI Gateway 裸模型 id，不经 `modelRef` 合约，两端无转换 |

每个值都能追溯到「一处定义、两端测试」，没有只看单端的项。
