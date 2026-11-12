## 复核结果

### 一、读代码证实的问题（按严重度）

#### 1.【中】`supersede` 新守卫直接返回，会把过时旧记忆留在 active 且仍可被检索
- 位置：`packages/application/src/services/durable-memory-service.ts:553-554`（调用点 `:139-140`、`:167`）
- 问题：新增条件在“取代方已失效/已被取代”时直接 `return`，既不写旧记忆的 `supersededBy`，也不写 `validTo`。旧记忆仍是 `active`、`validTo = null`。
- 证据：
  ```ts
  replacement.status !== "active" ||
  (replacement.attributes?.supersededBy ?? null) !== null
  )
    return;
  ```
  检索侧只按 `status = 'active'` 和 `valid_to` 判断“当前”：
  ```ts
  AND (@includeHistory = 1 OR m.valid_to IS NULL OR m.valid_to > @now)
  ```
  （`packages/persistence-sqlite/src/sqlite-memory-operations.ts:277-281`）
  新测试还把这种状态固化为期望：
  ```ts
  expect((await resource.read("osaka"))?.attributes?.supersededBy ?? null).toBeNull();
  ```
  （`test/integration/memory-conversation-review.test.ts:659`）
- 影响：`create` 已保存、`supersede` 未完成时崩溃，随后取代方又被别的消息取代；重试时新守卫跳过 `supersede`。旧事实（例如“下周去大阪”）会一直作为当前记忆被检索，正好违背回看“结束过时事实”的目的。旧代码虽然会形成“指向已失效记忆”的链，但至少会把旧记忆 `validTo` 写掉。
- 建议：不要静默返回。沿 `replacement.attributes.supersededBy` 链找到当前有效 head（带深度/环保护）再取代；或至少把旧记忆 `validTo` 写为链头时间并记录待处理。测试应同时断言旧记忆不再 `current`。

#### 2.【中】评测夹具 `trip-cancelled` 的 `tentative` 字段类型错误
- 位置：`test/fixtures/memory-conversation-review-eval/dataset.json:89`（同类问题还有 `:145`、`:390`）
- 问题：`"tentative": "event"`（以及 `"preference"`）不是布尔值，和评测接口 `tentative: boolean`（`scripts/evals/memory-conversation-review-live.eval.ts:26`）不一致。看起来是把 `category` 的值抄进了 `tentative`。
- 证据：
  ```json
  "text": "主人下个月要去京都旅行",
  "tentative": "event",
  "category": "identity",
  ```
- 影响：`parseConversationReview` 用 `tentative` 真假值构造“待确认记忆”集合，提示词里也会原样输出 `"tentative":"event"`。本轮刚好修改了这个 item 的 `creates` 期望（`:95`），但该 item 的输入仍是坏的；模型可能因此偏向 `unchanged`/确认，而不是期望的 `supersede`。其它两个坏 item 是负例，影响“9 段不该有改动”的可信度。
- 建议：三处改为 `false`（只有真正待确认的条目才用 `true`），并在评测加载时校验 `typeof tentative === "boolean"`。

#### 3.【低】评测不统计多余的 `confirmed`，ADR 的负例结论没有被真正验证
- 位置：`scripts/evals/memory-conversation-review-live.eval.ts:193-201`、`:243-245`；`docs/adr/0231-review-past-conversations-to-fix-memory.md:119`
- 问题：`score()` 只统计 `created`、`superseded`、`wrongSupersedes`，`outcome.confirmed` 只用于期望确认的命中数，多余的确认完全不扣分；`negativesClean` 也只检查 `created`/`superseded`。`forbidSupersede` 字段声明了但从未参与打分（`:34`）。
- 证据：
  ```ts
  pass: hits === expected && extraCreates === 0 && wrongSupersedes === 0 && !outcome.error
  ...
  ({ outcome }) => outcome.created.length === 0 && outcome.superseded.length === 0,
  ```
- 影响：负例里模型错误地把普通记忆当成待确认并 `confirmed`，评测仍算通过。结合问题 2 的错误夹具，ADR 的“9 段不该有改动的全部没动”和“19/20 通过”并没有覆盖“错误确认”这一类改动。
- 建议：增加 `extraConfirms` 并把 `negativesClean` 扩展到 `confirmed.length === 0`；要么删掉未使用的 `forbidSupersede`，要么真正校验它。

#### 4.【低】ADR 新增的“已知空隙”与当前恢复路径不一致
- 位置：`docs/adr/0231-review-past-conversations-to-fix-memory.md:83`；对照 `packages/application/src/services/durable-memory-service.ts:255-257`、`:136-141`、`:553-554`
- 问题：ADR 说“回看中断后主人把旧记忆恢复，下一次重试仍会再取代它”。但 `restore` 会先归档取代方：
  ```ts
  if (replacement?.status === "active")
    await this.deactivate(replacement.id, "archived", generationId);
  ```
  重试时 `applyProposal` 只在 `existing.status === "active"` 时才执行 `supersedes`，新守卫也会因 `replacement.status !== "active"` 跳过。按这条路径推演，重试不会再次取代。
- 影响：文档把风险写得比实际大，可能误导后续决定。属于文档/代码不一致。
- 建议：作者确认是否存在其它不归档取代方的“恢复”路径；若没有，删掉或改写这条“已知空隙”。（其它恢复路径未核实。）

#### 5.【低】新增的 `replacement.status` 检查实际是死代码，且 `confirmed` 分支没有反向测试
- 位置：`packages/application/src/services/durable-memory-service.ts:553`；`packages/application/src/ports/memory-conversation-review.ts:104`
- 问题：`supersede` 只有两个调用点，`sameProposal` 分支外层已判 `existing.status === "active"`，新建分支的 `saved.status` 必为 `"active"`，所以 `replacement.status !== "active"` 不会触发。真正起作用的只有 `supersededBy !== null`。
- 测试缺口：新增反向测试覆盖了 `created` 的“别人改过不算已撤销”（`test/integration/memory-conversation-review.test.ts:572-609`）和“取代方已被取代”（`:633-660`），但 `isReviewChangeUndone` 的 `confirmed` 分支（`tentative === true`）没有直接的反向/恢复测试。
- 建议：要么删掉多余的 `status` 检查，要么补上能说明它必要的场景；补一个 confirmed 变更撤销中途失败、随后被无关修改的用例。

### 二、推测 / 未核实
- **评测环境与生产推理设置不一致（未核实生产 provider）**：评测直接调网关、未禁用思考；生产 `service-main.ts:2350-2351` 传 `disableThinking: true`，但只有 `descriptor.provider === "magpie"` 时才真正生效（`production-model-composition.ts:441-444`）。如果生产走 Magpie，则“推理占输出 89%、1024 被截断”的评测结论不代表生产；如果生产不走 Magpie，则推理模型的有效上限本来就被 `reasoningOutputTokens: 4096` 顶到 4096（`production-model-composition.ts:476-481`），本轮把缺省改成 4096 主要影响禁用思考的路径。建议作者说明生产 provider，并让评测使用与生产相同的思考设置。
- **`recordChange` 不校验 `beforeSupersededBy`/`beforeValidTo`（未构成实际问题）**：`packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts:recordChange` 只校验 action/afterRevision/时间等；这两个字段目前由内部记忆快照产生，导出/导入也保留了它们，所以本轮未发现可被外部输入污染的入口，但属于可加校验的薄弱点。

## 侧重检查

- **不可信/不合规范输入（已读代码）**：`parseConversationReview` 对模型输出做 JSON 截取、数组校验、`messageId` 必须对应 owner 消息、`update/merge` 直接拒绝、pattern 必须跨两天、敏感/推断隐私主题过滤、每日新增上限；`parseMemoryCandidates` 校验 `existingMemoryId` 必须来自提示中的 existing 集合、quote 必须能在对应 owner 消息中找到、分类不得低于源消息。未见本轮新增绕过。
- **安全（已读代码）**：回看只读取 `isModelVisible` 且不高于 episode 分级的消息/记忆；模型输出加密存 payload；遮盖用 `placeholderTable`/`restorePlaceholders`，标签来自稳定 key。未见本轮新增泄露路径。
- **资源耗尽（已读代码）**：消息最多 120 条、每段源文本 16000 字符、每条消息 1500 字符、候选最多 24、每天最多 3 段/5 条新记忆、输出上限 4096；这些都有上限或切片。4096 低于配置上限 8192，也受模型自身 `maxTokens` 再截断。
- **不可撤销/错误路径（已读代码）**：撤销先写 `undone_revision` 再 `revise`，修订号冲突整批拒绝；重试按修订号+实际状态跳过已改回项；崩溃恢复测试覆盖了部分撤销和 `SETTLE_LOST`。主要残留风险就是问题 1 的 `supersede` 静默 no-op。
- **规则/文档一致性（已读代码）**：配置缺省值 4096 与 ADR 一致，`strict-configuration.ts` 上下限 `[256,8192]` 与 ADR 一致；`memory.capture` 只是把文字提成常量，manifest 哈希未变，golden 未改，发给模型的字节不变；ADR 的“已知空隙”与恢复实现不一致（见问题 4）；评测结论的覆盖范围被问题 2、3 削弱。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？
**本轮增量不会改变主对话的请求开头。** 回看是独立的后台调用：`backgroundModelContext(prompt, Date.now())` 用固定系统提示 + 单条 user 消息（`packages/runtime-pi/src/egress-context.ts:23-27`），不向主对话历史插入/改写任何内容。回看提示的排列是固定指令 → 本段 JSON → 最后的当地日期（`conversationReviewPrompt`，`production-memory-conversation-review.ts:117-141`），每轮会变的 `day` 在最后。`memory.capture` 提示词本轮只是把文字提成常量，顺序未变且 manifest 哈希未变，golden 快照未改，所以老对话已见过的系统提示字节不变。输出上限只改 `max_tokens`（规则明确把 `max_tokens` 排除在逐字节比较外），不改变消息前缀。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**本轮未发现新增的非确定性。** 回看提示里：existing 先 `sort()`（`production-memory-conversation-review.ts` 的 `ids` 排序）、people 按 `updatedAt` 降序再 id 升序、subCategories 的 SQL 有 `ORDER BY category, count DESC, sub_category`（`sqlite-memory-book-operations.ts:244-251`），值再排序；模板固定文字来自常量。遮盖标签取决于稳定 key 和值，不依赖请求顺序。评测脚本新增的 `x-opencode-session` 是常量。唯一的每请求变化值是日期，固定在末尾。需要注意的只是问题 2 的 fixture 数据类型错误，那是数据格式问题，不是序列化顺序问题。

### 3. 有没有自动检查？反向用例真的会失败吗？
- 有：集成测试新增了三条反向用例，并把缺省输出上限断言改为 4096（`test/integration/memory-conversation-review.test.ts:397`）。
- 反向用例的判别力（按旧代码推演，**未能实际运行测试**）：
  - `:572-609` “别人改过不算已撤销”：旧 `isReviewChangeUndone` 只看修订号，第二次撤销会被当成已改回并成功；新代码看到 `status === "active"` 不是 `archived` 而拒绝，所以该用例会区分新旧实现。
  - `:633-660` “取代方已被取代就不取代”：旧代码会把 osaka 标成被替换，新代码因 `supersededBy !== null` 跳过，断言会区分。
  - `:611-631` “批次外的取代不算”对应的是 5f9b3af 已有的 `#settle` 逻辑，旧版本大概率也通过，是对既有行为的回归保护，不是本轮新代码的反向证明。
- 缺口：`confirmed` 分支没有反向测试；评测脚本默认 `skipIf`，不属于 CI；评测还漏统计多余的 `confirmed`（问题 3）。

### 4. 改动产生/修改的每个值，使用端都能接受吗？
逐个核对结果：
- **`maximumOutputTokens: 4096`**：`production-memory-conversation-review.ts:84` 产生 → `service-main.ts:2305-2308` 与配置合并 → `#output` 传给 generate（`:685`）→ `service-main.ts:2349` 使用 `call?.maxOutputTokens`；配置校验上限 8192（`strict-configuration.ts:147-153`），模型层再 `Math.min(模型 maxTokens, ...)`（`production-model-composition.ts:476-481`）。两端都接受。
- **新建记忆 ID `memory:${generationId}:${ordinal}`**：`#commit` 先按此 ID 记 `created`（`production-memory-conversation-review.ts` 的 `intent`）→ `sqlite recordChange` 对 `created + afterRevision === null` 允许记忆尚不存在；实际写库时 `production-memory-capture.ts:609` 的 `memoryIdFor` 生成同样的格式；长度约 55，低于 256 校验。两端一致。
- **`beforeSupersededBy` / `beforeValidTo`**：由 `#commit` 从 `plan.existing` 快照产生，写入 `memory_conversation_review_changes`，`listChanges` 读回，导出/导入保留（`export.ts:335-336`、`import.ts:525-528`、`schemas.ts:203-204`），本轮 `isReviewChangeUndone` 直接消费。格式和可空性两端一致；导入时若引用的 memory 不在导入集合会置 null，属可接受降级。
- **`replacement.status` / `replacement.attributes.supersededBy`**：来自 `ProductMemoryRecord`，两个调用点都传 active 记录；但“直接被跳过”这一行为会让旧记忆留在可检索状态，见问题 1。
- **评测数据集 `creates` 期望**：`supersede` 候选在 `parseMemoryCandidates` 中被归一成 `decision: "create"` 且带 `supersedes`（`production-memory-capture.ts:337-341`），所以同一个候选同时计入 eval 的 `created` 和 `superseded`；`trip-cancelled` 补 `creates: [["取消"]]` 与评分逻辑相容。但这个 item 的 `tentative` 类型仍是坏的（问题 2）。
