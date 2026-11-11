# P4-8 方案审核

## 证实的（按严重度从高到低）

**高 1｜「已被主人评过的条目也预评」与现有取数矛盾，历史攒一致率的目标落空**
方案第 2 节说预评扫「打分窗口里还没预评的条目」，并特别说明「已被主人评过的条目也预评……这样一开就能用历史评价攒一致率」。但打分页的取数查询把主人已评的条目排除掉了：
- `packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:374`：`AND (owner_rating IS NULL OR rated_at >= ?)`（`?` = 当天零点，`packages/application/src/services/daily-review.ts:259`）——主人昨天评过的条目根本不在池子里。
建议：预评任务另写一条查询（只按 `checked_at` 窗口 + 唯一约束过滤），不能直接复用 `listReviewPool`。

**高 2｜预评候选集合必须复刻打分页的三个排除条件，方案没写**
打分页在 `readDailyReview` 里还排除了三类条目：主人自行否决的记忆候选（`daily-review.ts:268`，`reasonCode === "approval_rejected"`）、沉默且没有被判定过的主动决策（`daily-review.ts:270`，`judged < 1`）、文字被隐藏的条目（`daily-review.ts:297-311` 的 `hidden` 判断）。方案只写了「文字对模型可见的条目」。直接扫 ledger 会预评一批打分页永远不会显示的条目，配对集合和减量集合不一致，一致率被污染。
建议：预评候选集合复用 `readDailyReview` 的候选构建逻辑（只去掉 selection），或者把三条排除条件抽成共用函数并配测试。

**高 3｜并发预评请求违反项目自己的 KV 缓存规则第 17 条**
`.claude/rules/prompt-prefix.md:69`：「并发发出、开头相同的请求，要等第一个请求开始返回，再发后面的。」预评的请求前缀（遮盖 legend + 目录文字）对所有条目完全相同，方案又要求「每次最多 N 条」批量跑。并发发 N 条 = N-1 条全价重算，「前缀能命中缓存」的收益归零。
建议：预评请求串行发送（反正每天 50 条、单条很小），或在方案里写明「上一条开始返回后再发下一条」。

**高 4｜数据分级与披露校验没写，预评会在运行时被拒（I-73 的模式）**
`proactiveModel.prepare` 会按请求的 `dataClassification` 校验模型描述符：`apps/agent-service/src/production-model-composition.ts:521-523`，`if (!descriptor.allowedDataClassifications.includes(dataClassification)) throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED")`。邮件检查是取 `highestClassification("private", promptMemories...)` 算分级的（`packages/application/src/services/proactive-mail-check-service.ts:1112-1115`）。预评的用户消息含记忆原文，`sensitive` 分级的记忆对模型可见（`model-visibility.ts:10-14`），所以预评请求的分级会到 `sensitive`。方案完全没说：预评请求声明什么分级、模型描述符是否必须允许 `sensitive`、分级不被允许时跳过还是报错。
建议：方案补一节「分级」：预评请求分级 = 该条内容的最高分级（上限于 sensitive），描述符要求写明，不允许时跳过该条并记一条诊断日志；集成测试加对应用例。

**中 5｜新配置键的两端落点都没列**
方案列了 5 个键名，但没说落点。按现有键 `reviewSilentSharePermille` 的先例，需要同步改四处：
- `packages/platform-node/src/strict-configuration.ts:983-1005`（`rejectUnknown` 白名单，不加会被当未知键拒掉整个配置）
- `strict-configuration.ts:1011-1058`（`optional(key, fallback, min, max)` 边界解析）
- `packages/application/src/ports/configuration.ts:215-232`（`ProactiveConfiguration` 接口）
- `packages/platform-node/test/startup-configuration.unit.test.ts:1411-1412`（越界反向用例的先例）
建议：方案明确列出这四处，并按 I-73 的教训写一句「清单/配置里的每个键都要过解析端的校验」。

**中 6｜两套组口径没有映射**
减量按打分页组算（`daily-review.ts:23-28` 四个默认组，`proactive_silent` 并进 `proactive` 队列，`daily-review.ts:99-106`），周报按校准组报（`packages/calibration/src/index.ts:28-34`，`proactive` 按 `delivered` 拆成 `proactive_pushed`/`proactive_silent`，还有 mail 单独走 `proactive_processed_messages`）。同一条目在两边属不同组，周报的「某组一致率」和打分页「某组藏了多少」对不上数。
建议：方案补一张「打分页组 ↔ 校准组」映射表，一致率函数吃同一个映射，两边输出能互相对账。

**中 7｜周报 v4 升级会把既有历史整段丢掉**
`scripts/calibration-report/report.mjs:105-110`：`history.filter(entry => entry.schema === HISTORY_SCHEMA)`。HISTORY_SCHEMA 升到 v4（`packages/calibration/src/index.ts:1`）后所有 v3 记录被过滤掉，`previous` 趋势链从空开始。
建议：要么在方案里明确「接受重置并写进周报」，要么读 v3 时降级转换（v4 新增字段对旧记录填「样本不足」）。

**中 8｜purpose 与计量的两端没对上**
`proactiveModel` 把 `purpose` 硬编码成 `"mail-judgment"` 且许可为 `UNMETERED_PERMIT`（`production-model-composition.ts:508,513-516`）。预评每天 50 条的 token 费用会全部记在「邮件判断」名下，且不占任何预算——主动检查有 `dailyCostMicros` 上限，预评没有（用量的两端：用量报表按 purpose 分组、成本闸按 purpose 闸）。方案没提。
建议：给预评新增独立 purpose（顺带改 `egressContext.purpose`），并给预评单独的日成本上限或并入主动检查预算并写明取舍。

**中 9｜预评请求的实际形状和方案描述不符**
方案说「系统提示（登记进 prompt-catalog）……唯一一条用户消息」。但这条路径实际发的是：system = 出口遮盖 legend（固定）+ 一条 user 消息装下全部提示词——见 `packages/runtime-pi/test/pi-model-transport.unit.test.ts:540-547`（`{role:"system",content:EGRESS_PLACEHOLDER_LEGEND},{role:"user",content:"Say hello"}`）和 `[W-31]` 用例（legend 必须在每次不同的时间之前）。照现路径实施，目录文字要放在 user 消息开头（像 `MAIL_JUDGMENT` 那样，`packages/prompt-catalog/src/mail.ts:3-34`），不存在独立的「系统提示」消息。缓存收益仍在（legend + 目录文字都在前缀里），但方案应按实际形状写，免得实施者另起炉灶发两条 system 消息。

**低 10｜`prompt_id` 的「版本」不存在**
`PromptEntry` 只有 `id`，没有版本字段（`packages/prompt-catalog/src/entry.ts:14-22`），目录里也没有编号体系。建议：`prompt_id` 记目录条目 id + 提示词文字的哈希，或先给 `PromptEntry` 加版本字段（后者是独立的目录改动，别混进这次）。

**低 11｜每日上限 50 的计数状态没说存哪**
存内存则服务重启就清零，一天可能超 50。建议：随预评表按天计数（`count(*) where created_at >= 当日零点`）即可，天然持久。

**低 12｜不可用评级在 3×3 表里怎么算没定义**
校准包已有「每组适用评级」的定义（`calibration/src/index.ts:36-46`，例如 `proactive_silent` 只适用 useful/missed）。模型按方案会被要求在所有组里都可能输出 unneeded/missed/unsure，主人却不会在某些组里输出某些值，3×3 表的空格子会被天然填上「不一致」。建议：kappa 和一致率按组的适用评级子集算，不适用评级剔除（并在周报里注明剔除数）。

## 推测（未完全证实，标出来）

- 邮件条目的配对：现有校准 SQL 里 `proactive_processed_messages` 只为 muse 配对的消息查过 owner_rating（`calibration/src/index.ts:715-722`），周报 v4 要对审计窗口内的邮件新写查询、按 `processed_at`/`reviewed_at` 界窗口——方案没写这条查询（标「推测其工作量被低估」）。
- 数据导出/导入：方案说「一起加」，但导出快照、导出、导入三处（`snapshot.ts:124` 风格、`export.ts`、`import.ts`）和 `test/integration/data-export.test.ts` 的往返用例都没在测试清单里出现，容易漏。
- 禁 UPDATE 触发器与导入的兼容性：仓库已有同类先例（`migrations/0080_decision_signals.sql:21-24` 是 no_update + no_delete 成对），若照抄成 no_delete，未来按所有者删数据的路径会被触发器挡住，需确认删除流程是否要放行这张表。

## 侧重检查（测试覆盖 / 文档一致性 / 一条普通流程）

走的普通流程：服务启动配置解析（`strict-configuration.ts` 的 `parseProactive`）→ `ProductionProactive` 按 `intervalMs` tick（`production-proactive.ts:192-216`）→ 主人打开打分页 `proactive.review.read`（`production-proactive.ts:324-345` → `readDailyReview`）→ 主人打分 `proactive.review.rate`（`production-proactive.ts:491-527`，写 `decision_ledger.owner_rating` / `proactive_processed_messages.owner_rating`）→ 每周 `scripts/calibration-report/report.mjs` 出周报、追加 `evals/calibration/history.jsonl`。

结论：
- 方案新增的代码路径里，**预评后台任务**和**减量注入 `readDailyReview`** 是这条流程上全新的两段；方案的单测覆盖了减量的正反用例（含「默认关时逐字节相同」，这是好的反向用例），但**预评请求本身没有任何字节级断言**。
- `check:prompt-prefix` 只跑线程对话（规则文件 :74 自己写明覆盖范围），后台路径不在其中；现有后台调用（邮件判断）靠 `pi-model-transport.unit.test.ts` 的 `[W-31]` 单测守住 legend/时间顺序，但「目录文字在前缀里逐字节稳定」对预评是新需求、无既有闸。反向用例现在不存在：把当天日期拼进预评模板、或把主人评价漏进数据段，现在没有任何测试会失败。
- 建议补三条测试（方案第 6 节没有）：①同一系统提示在两天、两条不同条目上逐字节相同、数据段在最后；②主人评价前后，同一预评请求字节不变（一条测试同时证明「不含主人评价」和「确定性」）；③导出→导入往返后预评表逐行相等。
- 文档一致性：方案若实施，`.claude/rules/prompt-prefix.md` 第七节的检查清单和 `docs/kv-cache-guide.md` 应补一句「后台预评请求的前缀稳定性靠哪条测试守」；否则规则文档和代码会再次脱节。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。预评是全新的单轮后台请求，不触碰任何线程的系统提示、工具定义、历史和遮盖结果；打分页只是显示层，改它不影响任何已发请求。每轮会变的值（组、kind、outcome、category、文字）全部在唯一一条消息里，方案满足「只追加」规则。两个保留意见：见证实的第 3 条（并发相同前缀违反规则 17）和第 9 条（实际请求形状是 legend system + 单条 user，目录文字在 user 开头）。
2. **同一段文字会不会变成不同字节？** 基本不会。文字来自 `clip()`（`daily-review.ts:186-199`，确定函数），组/kind/outcome/category 是库中定值，消息里没有时间字段（比邮件判断还干净），唯一约束保证每条只评一次，出口遮盖确定。两个前提要写进方案：用户消息的 JSON 键序固定写死；周报 v4 的 JSON 键序同样固定。
3. **有没有对应的自动检查、反向用例会不会真的失败？** 减量逻辑有（默认关逐字节相同的单测就是反向用例）；预评请求没有。现有阻断检查 `check:prompt-prefix` 不覆盖后台路径，方案测试清单里也没有预评请求的字节断言——按侧重复核，这是这次改动里唯一「坏了也没人报」的地方。按上面侧重检查的三条补。
4. **每个值的两端都能接受吗？** 逐个核过：`review_key` 与 `reviewKey()` 格式一致（`daily-review.ts:171-172`）；`rating` 新增 `unsure` 要同步 CHECK 约束（先例 `migrations/0069_decision_ledger.sql:27`）、校准配对（unsure 剔除口径）、导出/导入三处；`confidence_permille` 0–1000 与仓库 `*Permille` 键的边界惯例一致；`model_ref` 来自 `proactiveConfiguration.modelRef`，已过 `safeReference`（`strict-configuration.ts:1036`）；**配置键→解析端校验没列落点**（证实的第 5 条）；**预评请求的 dataClassification→描述符披露校验没写**（证实的第 4 条，最接近 I-73 的原形）；`prompt_id` 的「版本」无中生有（第 10 条）。

## 如果由我来定

保留方案主体（预评表、默认关的减量、Wilson 下限、抽检、不在条目上显示预评），但先补六件事再动工：①预评候选复用打分页的候选构建（含三个排除条件），并另写绕过 `ratedSince` 的查询以兑现「历史攒一致率」；②补「分级」一节并加披露拒绝的跳过用例；③预评串行发送；④按实际请求形状改写第 3 节，并补三条字节级测试（含反向用例）；⑤列出配置键的四处理论落点，组映射表、`unsure` 剔除口径、邮件配对查询写进方案正文；⑥v4 历史重置显式写明。purpose/计量拆分可以放进同一批或紧随的第二批，但要在方案里留一条「预评费用目前记在 mail-judgment 名下、无日上限」的已知问题，不能不写。
