我已读够了仓库代码。现在核实业界一手来源。
# P4-8 模型预评方案（独立设计稿）

## 一、读代码或来源证实的前提

**仓库（main aa1b0b0）**

1. `decision_ledger` 已有主人评价字段，值域三元，且与 `rated_at` 成对（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:27-28,40`）：「`owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful','unneeded','missed'))`」「`CHECK ((owner_rating IS NULL) = (rated_at IS NULL))`」。现有表没有任何空位能放第二份评价。
2. `decision_signals.signal` 被锁死（`0080_decision_signals.sql:6`）：「`signal TEXT NOT NULL CHECK (signal IN ('opened','undone','replied'))`」，且有不可更新/不可删触发器（:21-28）。
3. `decision_ledger_payloads.role` 只有两个值（`0070_decision_ledger_payloads.sql:4`）：「`role TEXT NOT NULL CHECK (role IN ('model_input','model_output'))`」。
4. 打分页是纯读服务：`readDailyReview` 汇集 7 天池、键为 `ledger:<id>`/`mail:<id>`（`packages/application/src/services/daily-review.ts:11,168-182,240-261`）；`selectDailyReview` 是确定性纯函数，按 `hash(seed|dayStart|key)` 定序、四组轮流抽取（:81-132）；每组容量 `reviewCapacity(budgetSeconds, secondsPerItem)`（:47-49）；条目 `text` 截 200 字、控制字符已清洗、模型不可见分级时 `textHidden`（:184-199,322-324）；邮件条目 text 只有「发件人 · 主题」（:343）。每日条数上限常量 `DAILY_REVIEW_MAX_RATINGS = 50` 已存在（:13）。
5. 后台模型调用的现成通道：`ProactiveModelInvoker.prepare({invocationId, prompt, deadlineAt, dataClassification})`（`packages/application/src/services/proactive-mail-check-service.ts:72-83`），邮件判断的 prompt 结构是「固定说明 → 记忆数据段 → 邮件数据段 → 末尾时间模板」（`proactivePrompt`，:374-411；`MAIL_JUDGMENT_NOW` 在 `packages/prompt-catalog/src/mail.ts:63-77`）——这就是「会变的值只在最后」的现行样板；输出解析只接受 id 在送评清单内的条目（`parseJudgements`，:469-514），且批超预算时先估费再停下（:771-775）。
6. 校准统计已有一套可复用件：`wilsonInterval`/`proportion`（样本不足返回空值，`DEFAULT_MINIMUM_SAMPLES=5`）、分组与「每组适用评价对」映射（`packages/calibration/src/index.ts:2,36-46,177-207`）、周报只读 SQLite 的 SQL（:626-660）、历史格式 `himawari-calibration-week.v3`（:1,917-971）。
7. 统一出口是硬约束（`docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:39-47`）：「所有模型和嵌入请求只走一个进程内出口」「`npm run check:egress-redaction` 拒绝未登记的新出口」。
8. 前缀规则原文（`.claude/rules/prompt-prefix.md:27-29,35,36,51,52,67`）：「每轮都会变的内容只放在最后一条用户消息里」「已经发给过模型的内容……只能在末尾追加」「同样的内容，每次都要序列化成同样的字节」「遮盖……只能取决于它自己和它前面的内容」「后台调用也是固定的在前、会变的在后」。
9. 配置读取与校验在 `packages/platform-node/src/strict-configuration.ts:1041-1044`（`reviewBudgetSeconds` 默认 120、`reviewSecondsPerItem` 默认 5、`reviewSilentSharePermille`），未知键会被 `rejectUnknown` 拒绝——新配置键必须登记，否则配置直接解析失败。
10. 门槛脚本登记在 `package.json:27`（`check:prompt-catalog`、`check:egress-redaction` 均属 `npm run check`；:54,:56；`report:calibration` :98）。最新迁移编号是 `0086_rule_book.sql`。
11. I-73 教训（`docs/incidents-and-gates.md:112`）：「清单生成出的每个引用都要过两个包的校验……双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」——本方案每个新值都做了两端核对（见第四节）。

**业界来源**

12. Argilla（开源标注工具）把模型预填与人工作答分开存：模型预测叫 Suggestion，人提交的是 Response，二者并列、互不覆盖（https://docs.argilla.io/latest/how_to_guides/annotate/ 「If you agree with the suggestions, you just need to click on Submit…If the suggestion is incorrect, you can modify it」；https://docs.argilla.io/latest/reference/argilla/records/suggestions/ 「Suggestions are typically created by a model prediction, unlike a Response which is typically created by a user」）。这就是本方案「预评存另一条记录、不写主人字段」的直接对应物。
13. Anthropic 评测文档要求评分可量化、评语模型只输出受限集合（https://platform.claude.com/docs/en/test-and-evaluate/develop-tests ：「instruct the LLM to output only ‘correct' or 'incorrect', or to judge from a scale of 1–5」「Have detailed, clear rubrics」）——支持「预评输出只用三元标签 + sure/unsure」。
14. Google Vertex AI AutoSxS：用 autorater（模型评分器）自动评价，并专门提供「对照人工偏好数据检验 autorater 一致性」的流程（https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/side-by-side-eval ；配套 notebook `autosxs_check_alignment_against_human_preference_data.ipynb`，https://github.com/GoogleCloudPlatform/vertex-ai-samples/blob/main/notebooks/official/model_evaluation/model_based_llm_evaluation/autosxs_check_alignment_against_human_preference_data.ipynb ）——「模型评 ≠ 人评，必须持续对齐检验」的一手做法。
15. OpenAI 评测指南（https://platform.openai.com/docs/guides/evals ）主张确定性打分器优先、模板化评分（未核实：本次未抓取该页，凭其被广泛引用的一手状态列出）。

**推测（未读代码、仅设计判断）**：预评批的 token 成本量级；DeepSeek Flash 三分类的置信度校准水平；P4-6 `memory_checkup` 组的最终形态。

## 二、方案

### 1. 存：新迁移 0087，新表，不碰现有表

```
decision_pre_ratings (
  id            TEXT PK CHECK (length(id) BETWEEN 1 AND 128),
  owner_id      NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id      NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  review_key    NOT NULL CHECK (review_key GLOB 'ledger:*' OR review_key GLOB 'mail:*'),
  rating        TEXT CHECK (rating IN ('useful','unneeded','missed')),
  confidence    TEXT CHECK (confidence IN ('sure','unsure')),
  reason        TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  model_ref     TEXT NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 128),
  input_ref     TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  cost_micros   INTEGER NOT NULL CHECK (cost_micros >= 0),
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at    TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (owner_id, agent_id, review_key)
) STRICT;
-- 复制 decision_signals 的不可变触发器：no_update / no_delete
```

- `review_key` 直接复用打分页键（`reviewKey()`，daily-review.ts:171），写端只接受从 `readDailyReview` 池里取出的键，读端用 `parseReviewKey()`（:174）。`ledger:*` 键指向的 `decision_ledger.id` 存在性由服务层保证，并配集成测试（对齐 I-73 的教训，见必答 4）。
- 不设对 `decision_ledger` 的外键：因为 `mail:<messageId>` 键没有对应的 ledger 行，条件外键 SQLite 表达不了；用触发器 + 测试兜底。
- 预评永不写 `decision_ledger.owner_rating` / `proactive_processed_messages.owner_rating`，主人评价字段 schema 不动。

### 2. 什么时候跑：服务进程内、每天、主人打开页面前

- 必须在服务进程内跑（记忆/邮件正文生产加密，只有服务进程能解密；周报脚本只读库），所以不是脚本，而是挂在 agent-service 的每日节奏上（mail check tick 之后追加一步，或独立 interval）——具体挂点由实现线程定，验收只约束行为。
- 每天对「当日会被抽到概率最高的未预评条目」预评，每天最多 `50` 条（主人已定）。抽谁：**复用 `selectDailyReview` 本身**——它是确定性纯函数（seed=`ownerId:agentId` + 日期哈希，daily-review.ts:81-132），后台用当日池重跑一遍，取其排序最靠前的未预评条目。这样预评天然覆盖主人当天实际会看到的条目，同时不依赖主人是否真的打开页面。
- 每条只评一次（UNIQUE 约束 + 幂等跳过）。跑失败不重试超过一次，失败条目当天不补（次日自然进入候选）。

### 3. 给模型看什么

新增 prompt-catalog 条目 `review.pre-rating`（`packages/prompt-catalog/src/review.ts`，`fixedPrompt`，layer background，output json，parser `parsePreRatings`，`usedBy` 写预评服务文件路径），结构照抄 `proactivePrompt` 样板：

1. 固定说明：任务定义（替主人预判这些条目该评什么）、每个 kind 的评价语义——**直接引用校准包的语义**（calibration/index.ts:36-46 的组×适用评价对，如 memory_skipped 只有 useful/missed；proactive_pushed 只有 useful/unneeded），要求模型按条目所属组在适用对里选；
2. 打分对象数据段：JSON 数组，每条 `{key, kind, outcome, category, text}`——`text` 就是打分页给主人看的同一份 clip 后文本（≤200 字），`textHidden` 的条目**不送评**（模型不可见的分级内容不出口）；
3. 末尾时间模板（仿 `MAIL_JUDGMENT_NOW`：「现在是 {now}（主人所在时区 {timeZone}…）」）。

邮件条目（`mail:`）默认只给发件人·主题一行；是否给它看遮盖后的邮件正文，列为待拍板项（见第五节）。

### 4. 模型输出什么

`{"items":[{"key":"ledger:…","rating":"useful|unneeded|missed","confidence":"sure|unsure","reason":"≤60字"}]}`。解析器 `parsePreRatings` 仿 `parseJudgements`（proactive-mail-check-service.ts:469-514）：key 照抄且必须在送评清单内、rating/confidence 在白名单内才收；输出截断或非法时整批记失败。`reason` 存库供 UI 在「没把握」条目上展示，不进任何统计。

### 5. 成本控制

- 复用 proactive 配置里的便宜 `modelRef`（`ProactiveModelInvoker` 现成字段），不新增模型配置；走 `ModelEgress.exchange()` 统一出口（ADR 0148）。
- 一批最多 50 条、每条 ≤200 字，加上说明约几万字符，单批成本对 DeepSeek Flash 一类可忽略；仍加两道硬顶：条数上限（配置，默认 50）+ 单日估费上限（照抄 `estimateCostMicros` + `capped_daily` 模式，:771-775）。
- 新配置键 4 个，全部登记进 `strict-configuration.ts` 的 `rejectUnknown` 白名单（两端核对见必答 4）：`preRatingEnabled`（默认 true，只记录不减量）、`preRatingDailyMaxItems`（默认 50）、`preRatingReductionEnabled`（默认 **false**）、`preRatingAgreementThresholdPermille`（默认 900，主人已定）。

### 6. 一致率怎么算才不自欺

统计放 `packages/calibration`，周报（`report:calibration`，只读库）新增「预评一致率」节，复用 `proportion()`/`wilsonInterval()`：

- **分母**：只算同时有预评和主人评价的条目。**按组分别报**（复用 `calibrationGroup` 映射），不报跨组混合一致率。
- **预评有效性**：预评必须落在该组适用评价对内才算有效（模型说 memory_skipped 该评 unneeded → 无效预评，记 mismatation 类别并单独计数）。
- **防自欺三件套**（都写进周报数字，可验证）：
  1. **多数类基线**：每组同时报主人评价的边际分布；若某一类占比 ≥80%，报出「多数类基线 = 该占比」，并标注「一致率须高于基线才有意义」——主人 95% 评 useful 时，全评 useful 的模型有 95% 一致率但毫无价值。达标判定（900‰ Wilson 下限）**要求一致率下限同时高于多数类基线的下限**。
  2. **覆盖率**：报「主人评过的条目里，预评覆盖了多少」；覆盖不足（<50%）时周报标注一致率不代表主人评的总体。
  3. **减量后的对照通道**：一旦减量开启，主人看到的条目已被预评过滤，一致率分母会偏到「模型没把握的条目」上，读数下降不等于模型退步。对策：**减量开启时，每天从「预评想折叠」的条目里按确定性顺序强制抽固定比例（配置，默认 200‰）作为校准抽查条目照常展示**——这借用 AutoSxS 持续对照人工偏好的思路（来源 14）。抽查条目在 UI 标注「系统抽查」，可评可不评，但它们保证被折叠条目持续有流向一致率分母的样本。

### 7. 「没把握」「和历史不一致」的可验证定义

- **没把握**：`confidence='unsure'`；或该条所属组的「组×预评评级」格子的历史一致样本 <5（`proportion()` 语义：样本不足 = 全部当没把握）。第二重不依赖模型自报，防止 Flash 类模型置信度校准差。
- **和历史不一致**：该条目落在「组 × 预评评级」格子里，该格子历史一致率的 Wilson 区间下限 < 900‰。例：memory_kept 组里预评 unneeded 的条目历史上常被主人改判 useful，则这类条目全部照常展示。
- 两个定义都是纯 SQL/纯函数可复算的数，周报里每组的每个格子都报出：格子条数、一致数、区间下限——「可验证的定义」由「周报数字 = 减量判定输入」这一条保证（同一个函数，正反测试见下）。

### 8. 自动减量：规则、开关、测试

- **生效粒度：按组**。`proactive_pushed`、`proactive_silent`、`memory_skipped`、`memory_kept`、`consolidation` 逐组判定：该组一致率 Wilson 下限 ≥900‰ 且高于多数类基线下限，才对该组减量；未达标组照旧全量展示。
- **减量内容**：达标组的默认展示集 = confidence=unsure ∪ 格子下限<900‰ ∪ 校准抽查；其余折叠（UI 提供「显示全部」）。
- **永不减量**：`memory_checkup`（P4-6 主人亲手处理的记忆体检）及一切未来新组。实现上写一个**显式白名单常量**（仿 daily-review.ts:23-28 的 `DEFAULT_GROUPS`），不在名单里的组一律不减量——防止以后加组时默认被减量。
- **开关**：`preRatingReductionEnabled` 默认 false；关闭时代码路径与现状逐字节同。
- **测试**（进 `npm test`）：
  - 正向：构造预评=主人、confidence=sure、组下限 920‰ 的池 → 断言展示集变小且抽查条目在场；
  - 反向一：一致率 89%（下限 <900‰）→ 断言不减量，展示与现状相同；
  - 反向二：样本 4 条 → `insufficient`，不减量；
  - 反向三：预评跑完后断言 `decision_ledger.owner_rating` 仍为 NULL；
  - 反向四：`memory_checkup` 组即使达标也不折叠；
  - 迁移正反用例 + 不可变触发器用例。

### 9. 自动检查清单

| 检查 | 位置 | 反向用例 |
| --- | --- | --- |
| 新迁移 schema + 触发器 | 迁移测试 | 更新/删除预评行必须 RAISE |
| `check:egress-redaction` | 现有门槛 | 预评调用若绕过 `exchange.wrapFetch` 即被拒（现脚本已拒绝未登记出口，无需新增） |
| `check:prompt-catalog`（package.json:56 含 golden / output contracts / wording） | 新条目 + `parsePreRatings` | 非法 key、越权 rating、截断输出、`textHidden` 条目混入 |
| 一致率/门槛纯函数 | `packages/calibration` 单测 | 样本不足、下限越线、多数类基线未超过 → 不得标 `pass` |
| 减量选择逻辑 | `daily-review.ts` 单测（反向一~四） | 见上 |
| 键格式两端一致 | 集成测试：打分页产出的每个 key 写入预评表再读回 | `parseReviewKey` 不认的键必须写不进去 |

## 三、考虑过但不选的做法

- **在 `decision_ledger` 加 `model_pre_rating` 列**：要动 STRICT 表 CHECK 和全部既有读写；且 `mail:` 键条目不在 ledger 里，还得再改 `proactive_processed_messages`——两处 CHECK、两处消费端，改动面和 I-73 式两端失配风险都大。新表一处收敛。
- **复用 `decision_signals`**：值域被三个消费方（周报 SQL、UI、隐信号统计）按枚举消费，加第四个值要改所有 `signal IN (...)` 判断，还违背该表「观察信号」的语义定位（calibration/index.ts:869-871 明确「不当作评价」）。
- **复用 `decision_ledger_payloads` 加 role**：role 是共享 CHECK（0070:4），`model_input/model_output` 语义被周报和恢复逻辑依赖，混入预评会牵连全部读取处。
- **在打分页请求里同步跑预评**：读路径变成会发模型请求的路径，受预算与时延支配，主人在场等模型没意义；且同步路径容易把预评结果诱导性地显示在主人评价旁边（Argilla 的教训是预填会**带偏**标注者，https://docs.argilla.io/latest/how_to_guides/annotate/ 也因此提供始终显示/关闭建议的配置）。后台先存、页面只展示统计，更干净。
- **预评全量池**：成本不可控；主人已定 50 条/天，且每天预评顺序与抽取顺序同构已足够覆盖样本。
- **直接采用 P4-4 线程的 thresholds.ts 建议值当门槛**：那是「建议值」语义，本方案的验收门槛是主人定的 900‰ 下限，两者混用会让周报数字的定义漂移。
- **用语义相似度定义「和历史不一致」**：不可验证、无 SQL 可复算，放弃。

## 四、风险与反例

- **减量污染一致率**（最主要）：已用对照通道（第三节 6.3）缓解，但抽查比例太低时统计功效仍不足——需要拍板（第五节 1）。
- **主人评价与预评看的信息不同步**：预评存档当时的 `input_ref`（payload 引用），事后可审计「模型当时看到了什么」；文本截断规则将来变了只影响新条目，不影响已存预评的一致率（一致率评的是决策不是文本）。
- **主人某天不打开打分页**：当日 50 条预评白跑。止损就是每日上限本身；不另做条件延迟（会引入「预评时机依赖主人行为」的不可测性）。
- **多数类陷阱**：反例——主人 30 天里 92% 评 useful，模型全评 useful，混合一致率 92%「达标」。防线是多数类基线判定写进达标条件 + 按组分报（第三节 6.1）。
- **Flash 模型 confidence 全 sure**：防线是第二重判定（格子历史下限），不信任自报置信度。
- **与 P4-6 冲突**：`memory_checkup` 进默认组列表后，若没人维护减量白名单会被误减量——白名单常量 + 反向四的测试把它钉死；需要两个线程对同一常量文件的合并约定。

## 五、需要人拍板的取舍

1. **校准抽查比例**默认 200‰（约每天 10 条）还是更低（100‰）：抽查越少主人介入越少，但减量后的无偏样本越少、发现模型退步越慢。
2. **按组达标**（我的建议：薄弱组永远全量展示）还是**合计达标**（更激进，可能藏住薄弱组）。
3. **邮件条目要不要给预评模型看遮盖正文**：只看「发件人·主题」几乎评不出 useful/unneeded，给正文要解密 + 多花 token。建议给（走遮盖），但成本归主人知情。
4. **预评跑的挂点**（mail tick 之后 vs 独立 interval）：不影响验收，交实现线程。
5. **`reason` 字段**要不要留（我建议留，60 字上限，只进 UI 不进统计）。

## 六、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？**
不会。预评是全新的、每次独立的单轮后台调用，不挂进主对话，也不改任何既有调用（邮件判断、记忆、整理）的 prompt——所以「已发给过模型的内容只在末尾追加」（prompt-prefix.md:35）对存量请求零影响。新调用内部遵守「固定在前、会变的在后」（同文件:27-29,:67）：目录固定文字 → 数据段（当次 batch）→ 时间模板收尾（仿 `MAIL_JUDGMENT_NOW`，mail.ts:63-77 的现行样板）。后台调用没有多轮历史，「每轮会变的值在最后一条消息里」以「多次调用之间，除数据段和时间模板外逐字节相同」的形式满足。预评也不写主人评价字段、不动 ledger，打分页对模型可见的部分（`textHidden` 逻辑）不变。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会，前提是实现遵守四点：(a) 数据段条目顺序用 `selectDailyReview` 的确定性排序（seed+key 哈希，daily-review.ts:92-97），不依赖数据库返回顺序（规则 10）；(b) `text` 来自打分页同一份确定性 `clipTo`（:184-199），每次相同；(c) JSON 字面量键序固定；(d) 遮盖经统一出口且确定性——「只能取决于它自己和它前面的内容」（prompt-prefix.md:52），同批重复值遮法一致（ADR 0148 第 5 条）。唯一每次必变的值（时间）按规则只在末段。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
有，逐条列在第三节 9。关键反向用例都会失败（即检查能拦住）：89% 一致率/样本 4 条不得标 `pass`、预评写 `owner_rating` 的迁移用例、触发器 UPDATE/DELETE 被拒、`parsePreRatings` 收下非法 key、`memory_checkup` 被折叠、绕过 `exchange.wrapFetch` 的出口。全部进 `npm test` / `npm run check`。

**4. 每个新值，产生端和使用端都核对了吗？**
逐个核对（I-73 教训，docs/incidents-and-gates.md:112）：

| 值 | 产生端 | 使用端 | 两端校验核对 |
| --- | --- | --- | --- |
| 4 个新配置键 | `strict-configuration.ts` `parseProactive` | `production-proactive.ts`（预评服务、减量判定） | 必须**同时**加进 `rejectUnknown` 白名单（:1000-1003），否则旧配置加载直接抛错——这正是 I-73 式的「改了清单没问校验」 |
| `review.pre-rating` 目录 id | `prompt-catalog/src/review.ts` | 预评服务 import；`check:prompt-catalog` 的 golden/wording/output-contract 测试 | `usedBy` 填真实文件路径，golden 同步更新 |
| `decision_pre_ratings` 表 | 迁移 0087 | persistence-sqlite 端口实现、周报只读 SQL | STRICT + CHECK 值域；周报 SQL 用列名（snake_case）与表实现同一份常量 |
| rating/confidence 枚举 | 迁移 CHECK | `parsePreRatings` 白名单、一致率函数、UI | 三处共用 `packages/calibration` 导出的同一常量（现成 `CALIBRATION_RATINGS`，index.ts:12），不许各写一份 |
| `review_key` 前缀 | `reviewKey()`（daily-review.ts:171） | `parseReviewKey()`（:174）、预评表 CHECK、周报 join | 集成测试：打分页每个 key 必须能写入并读回预评表 |
| 模型输出的 key | 模型 | `parsePreRatings` | 照抄且必须在送评清单内（仿 parseJudgements 的 byId 校验，:476-491） |
| 达标组白名单 | `daily-review.ts` 常量 | 减量判定、测试 | P4-6 协同：新组必须显式决定进不进白名单 |

未核实项：OpenAI evals 指南页未抓取（来源 15）；DeepSeek Flash 对三分类+confidence 的实际校准水平（推测，用第二重判定兜底）；P4-6 `memory_checkup` 最终接口。
