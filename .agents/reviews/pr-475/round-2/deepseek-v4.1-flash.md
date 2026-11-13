已停止读代码和调用工具。以下结论只基于此前读到的内容；没有运行任何检查或测试，运行时结果一律标「未核实」。

---

# 结论

**没有发现高危问题。** 增量里的三条主逻辑（按运行/对话读外来来源、拒绝重放去重、标记写失败不执行）代码上基本自洽；主要问题是**自动检查覆盖不到真正的接线**，另外有一处窄条件下的 `not_sent` 与结果缓存语义冲突，以及若干截断、文档与代码不一致的问题。

---

## 按严重度排列

### 中

**1. 记忆捕获和对话复盘的 `externalOrigins` 只测了纯函数，真正接线没有自动检查**
- 文件:行：`apps/agent-service/src/production-run-composition.ts:556-561`、`:622-626`；`apps/agent-service/test/conversation-review-external-content.unit.test.ts:27-48`；`test/integration/production-memory-capture.test.ts:240-242`、`:1983-2003`
- 问题：本轮核心行为是“捕获计划按 run 读、复盘按 thread 读”。但捕获测试里的 `externalOrigins` 是注入桩（`externalOrigins: async () => externalOrigins`），复盘测试直接把 `externalOrigins` 传给 `parseConversationReview`，没有经过 `ContextExternalContent.read` / `readThread`。如果接线写反（复盘误用 `read(runId)`、或用错作用域），现有测试仍会通过。
- 证据：
  - `production-run-composition.ts:558-559`：`externalOrigins: async (runId) => originsOf(await externalContent?.read(runId))`
  - `production-run-composition.ts:624-625`：`externalOrigins: async (threadId) => originsOf(await externalContent?.readThread(threadId))`
  - `conversation-review-external-content.unit.test.ts:28-35` 直接构造 `parseConversationReview({... externalOrigins})`，没有 `ContextExternalContent`
  - `production-memory-capture.test.ts:240-241` 是 `externalOrigins: async () => externalOrigins` 的桩
- 建议：加一条用真实 `ContextExternalContent` 的集成用例：同一 thread 先 `mark`，再跑捕获/复盘，断言新记忆 `sourceRefs` 带标记；反向用例用另一个 thread 的标记，断言不污染。另补 `readThread` 在“无记录/对话不存在”时返回 `[]` 的测试。
- 性质：**读代码证实的覆盖缺口**（不是已证实的行为错误）。

### 低

**2. 回放时若标记读失败，`not_sent` 可能和已缓存的成功结果矛盾**
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:1228-1250`（标记失败直接返回）对 `:1671-1685`、`:1744-1779`（结果缓存/恢复）
- 问题：标记在进入 `#executeCanonical` 之前做。正常回放时同一 origin 已在状态里，`mark` 会在 `context-external-content.ts:166` 提前返回，不会误报；但如果**状态读取本身失败**，会先返回 `not_sent`，而不去查 `runtime-tool-result:*`。若该 (runId, toolCallId) 之前已成功执行并缓存结果，模型会被告知“没发出”，而副作用其实已经发生，模型可能用新的 `toolCallId` 再发一次。
- 证据：
  - `production-runtime-tools.ts:1229-1249`：捕获 `#markExternalContent` 错误后直接 `return { dispatchState: "not_sent", outcome: "failed", ... }`，没有查看已写入的 intent/result。
  - `context-external-content.ts:163-166`：同名 origin 已存在则直接返回，不需要写；所以通常回放不会在这里失败。
- 建议：`not_sent` 分支先查是否有已写入的 intent/result，只有确实没有已记录结果时才返回 `not_sent`；或把标记放到缓存查询之后、真正派发之前。
- 性质：**读代码证实该逻辑路径存在**；“必须状态读失败才触发”的稀缺性属推断。

**3. `external-content:<记录>` 的 512 截断会丢掉 `|来源`**
- 文件:行：`apps/agent-service/src/context-external-content.ts:24-31`
- 问题：先拼 `${prefix}${recordId}|${origin}` 再 `.slice(0,512)`。`recordId` 本身允许到 512（`packages/gateway-contracts/src/contracts-v2.ts:20` 的 `MEMORY_SOURCE_REF_MAX_LENGTH = 512`），接近上限时 `|origin` 甚至 `|` 会被截掉。ADR 0257 新值表写的是 `external-content:<来源消息引用>|<来源>`，超长时格式不成立；不同 origin 也可能截成同一串。
- 证据：`context-external-content.ts:30`：`.map((origin) => \`${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${recordId}|${origin}\`.slice(0, 512))`
- 建议：先把 `recordId` 截到 `512 - prefix.length - origin.length - 1`，或把 origin 放前面/单独存。现有 `carriesExternalContent` 只查前缀，不影响“算外来”，但会影响去重与排障时“来源名能否读出”。
- 性质：**读代码证实**；是否现实出现取决于消息引用长度（未核实）。

**4. 第 1 轮 r1-7（续跑拒绝计数少算）仍存在，且仍无适配器级测试**
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1638-1658`、`:2205`、`:1557-1572`
- 问题：作者自述未修。快照在 `saveToolCheckpoint` 里取，而 `checkpoint` 在工具执行**之前**调用；`refused` 在工具结果事件里才 `observe`。因此最后一次拒绝/成功若之后没有新的检查点，就不会进入续跑快照，续跑时计数可能差一。
- 证据：
  - `pi-runtime-adapter.ts:1658`：`toolProgress: toolProgress.snapshot()` 在 checkpoint 时保存
  - `pi-runtime-adapter.ts:2205`：`const continuationRef = await reconciliation.checkpoint(invocation);` 位于 `tools.execute` 之前
  - `pi-runtime-adapter.ts:1562-1572`：`toolProgress.observe(...)` 在 `tool_result` 事件里
  - `pi-tool-progress-guard.compat.test.ts:58-66` 只测手动 `snapshot()/reconstruct`，不覆盖适配器保存时机
- 建议：工具结果观察后也持久化一次快照（或把计数写进工具结果回执），并加一条“连续拒绝后续跑仍达到上限”的适配器用例。
- 性质：**读代码证实的结构缺口**；具体少算一次的场景未复现，部分为推断。

**5. 规则开关冲突重试、`#audit` 写冲突路径没有自动检查**
- 文件:行：`apps/agent-service/src/action-rule-switches.ts:85-92`；`apps/agent-service/src/owner-scope-authorization.ts:338-359`
- 问题：作者声称“规则开关冲突时重读重试”“状态写冲突时以已写入的为准”，但新增测试只有顺序重放（`tool-action-registry.test.ts:893-911`），没有制造 `PORT_CONFLICT` 并发/冲突。若重试循环写错（冲突后不重读、或非冲突也吞掉），现有测试不会失败。
- 证据：`action-rule-switches.ts:85-92` 的 `try/#write/catch(isConflict)`；仓库里搜 `SWITCH_ATTEMPTS` 只有源码，没有测试引用。`#audit` 的 `.catch(async (error) => { if (!(await read())) throw error; })` 同理无冲突用例。
- 建议：给 `setAskFirst` 注入“第一次 `commitStateAndEvents` 抛 `PORT_CONFLICT`、第二次成功”的假仓库；给 `#audit` 注入“提交冲突但已存在记录”，断言不抛错且审计时间取第一次。
- 性质：**读代码证实的覆盖缺口**。

**6. 并行外部工具可能耗尽标记重试（推测）**
- 文件:行：`apps/agent-service/src/context-external-content.ts:21`、`:163-194`；`apps/agent-service/src/production-runtime-tools.ts:480-483`、`:487-490`、`:504-507`
- 问题：`WRITE_ATTEMPTS = 5`，冲突时重新读再写。`read/ls/find/grep` 与 `web_search/web_fetch` 可并行执行；若同一轮出现 6 个不同 external origin，最后一个写者理论上需要 5 次重试才能排到，正好可能耗尽并被新逻辑转成 `external_content_mark_failed`。
- 证据：`context-external-content.ts:21`：`const WRITE_ATTEMPTS = 5;`；`production-runtime-tools.ts:482`：读工具 `executionMode: "parallel"`；`:490`、`:507`：web 工具并行。
- 建议：标记写入串行化（按 thread 合并队列），或让重试次数随并行工具数量/实际冲突次数放宽。
- 性质：**推测**（代码结构支持，未实跑）。

**7. 文档/消费者不一致：`askedBecause.ruleText` 在网页上没有消费处；ADR 新增小节吞掉一句话**
- 文件:行：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:202-209`、`:228`；`packages/application/src/services/governance-gateway-adapter.ts:385-391`
- 问题 A：ADR 新值表把“网页、苹果端的审批卡片”写成 `askedBecause` 的使用处，但在 `apps/control-center/src` 里搜索不到 `askedBecause`/`ruleText`；`governance-control-center.tsx` 只展示 `intent.*`。`.agents/plans/owner-scope-approval.md:132` 自己也写着“可读标题、正文预览、‘为什么问你’、来源这四项，main 上还没有”，与 ADR 的“使用处”表述不一致。
- 问题 B：ADR 新增的四个 bullet 中，第 4 条把原本属于上一段的“第 1 步真正起作用的列是：……”一起吞进了 bullet，读起来像来源标记这一条的一部分。
- 证据：`governance-gateway-adapter.ts:385-391` 只是把 `ruleText` 放进网关快照；网页代码没有对应读取。ADR 第 209 行以 `- 记录上的来源标记……。第 1 步真正起作用的列是：工具名、家族……` 结尾。
- 建议：要么在网页审批卡片接上 `display.askedBecause.ruleText`，要么把 ADR“使用处”改成“网关快照（网页展示待 PR 428）”；把第 209 行那句挪回新增小节之前的段落。
- 性质：**读代码证实的文档/消费处不一致**；Apple 端是否消费未核实。

---

## 侧重检查

- **错误路径**
  - 标记写失败 → 不执行、返回 `not_sent` + `external_content_mark_failed` + 诊断（`production-runtime-tools.ts:1228-1250`）。若运行已停，`assertRunActive` 会抛错而非返回 `not_sent`，符合“已停不写诊断”的约定。
  - `mark` 现在只在 `PORT_CONFLICT` 重试（`context-external-content.ts:190`），其他错误立即抛；比旧代码“非冲突也重试 5 次”更直接。
  - `#audit` 的顺序重放已修（`owner-scope-authorization.ts:338-370`），测试能反向失败；**提交冲突**路径无测试（见第 5 条）。
- **不可信输入**：来源名来自工具登记表/能力引用，不来自模型参数；`askedBecause` 每个来源截 80、最多 5 个（`owner-scope-authorization.ts:93-105`），`ruleText` 远小于网关 2001 上限；`rule.source` 截 256 与存储校验一致（`production-owner-rules.ts:329-341`、`sqlite-owner-rule-operations.ts:123`）。
- **安全 / 不可逆操作**：任务取消改走 `owner_scope`，内置规则 `action_preauthorize_own_task_cancel` 在读过外来内容时也直接放行（`packages/application/src/rules/action-rules.ts:200-225`）。ADR 明确接受，理由是“只能停自己开的任务”。我核实归属检查仍在：`production-sandbox-services.ts:2337-2358` 用 `readAdmissionByResource({runId: call.runId, ...})` 并核对 model/thread/lease，不能跨运行取消。该规则只按 `target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE"` 匹配，目前只有 cancel 命中；未来若有别的 managed-task 写动作会被自动预授权，属设计风险，非当前缺陷。
- **资源耗尽**：新状态值每个 origin 一条，按 origin 去重；记忆 refs 每个 origin 一条并截 512；来源数受工具/能力名数量限制。并行标记的 5 次重试是唯一可疑点（第 6 条，推测）。
- **文档一致性**：ADR 0257 的“第 2 步不同之处”与代码基本一致；发现的两处不一致见第 7 条。I-73 教训在本轮新值上基本落实（producer/consumer 两端都有长度/类型校验），但存在上述截断和“无消费处”的边角。
- **作者三条特别关注事项的核对结论**：
  1. **运行已删除/无对话会不会拖垮捕获**：不会因此抛错。`#plan` 先 `sources.read(sourceRunId)`，为空或 thread 不匹配就返回（`production-memory-capture.ts:1086-1087`），根本走不到 `:1209-1212` 的 `externalOrigins`；`readRunExecutionSource` 对不存在的运行返回 `undefined`（`sqlite-thread-operations.ts:1546`），不会抛。即使 `externalOrigins` 读抛错，`#captureTurn` 外层的 `.catch(onFailure)`（`production-memory-capture.ts:812-814`）也会接住，不会拖垮整轮。**残留代价**：`#captured` 已在 `:799` 记录该 run，捕获会永久放弃且不走审计（`#plan` 没返回），属低风险（新读点增加了一个失败点）。
  2. **一天的复盘会不会串到别的对话**：不会。`runDue` 每次只取一个 episode（`production-memory-conversation-review.ts:489-496`），`store.begin` 和 `#plan` 都用 `episode.threadId`（`:501`、`:578`），`MemoryEpisode` 本身是 per-thread（`packages/memory-engine/src/episodes.ts:52`、`:468`）。真正的问题是**同一 thread 内按“当前”来源标记历史片段**：episode 是旧片段，但 `readThread(episode.threadId)`（`:734`）读的是线程当前的累计来源，因此这个 thread 后来读过外来内容也会把旧片段产生的记忆标成外来——偏严，符合 ADR 的上下文口径，但会“给不相干的记忆加标记”（同对话内，不是跨对话）。
  3. **`not_sent` 与结果缓存/重放是否冲突**：正常情况下不冲突。标记在 `#executeCanonical` 前（`production-runtime-tools.ts:1228` vs `:1299`），失败时不写 intent/result；回放时同一 origin 已存在，`mark` 直接返回（`context-external-content.ts:166`），随后仍会命中结果缓存。唯一窄口是状态读失败时 `not_sent` 会先于缓存查询返回（见第 2 条）。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？
**不会改变请求开头。**（读代码结论；未运行 `npm run check:prompt-prefix`，运行时结果未核实。）
- 没有碰系统提示、工具定义、历史消息或出口遮盖规则；没有新增/删除工具，没有改工具参数结构。`production-tool-actions.ts` 只改登记列，`descriptors` 的名字/顺序未变。
- 新增的记忆来源标记、`refusedAt`、`externalOrigins`、`builtIn` 快照、规则开关都是程序侧/网关侧数据，不进模型请求。
- `RuntimeProjection.ownerAttachments` 是宿主内部字段（`packages/application/src/ports/intelligence.ts:392`），不在 provider payload 里。
- 唯一的模型可见新文字是“标记失败”的工具结果，作为工具结果追加在末尾；拒绝结果同样是工具结果。每轮会变的值没有新增到头部。
- 符合 `.claude/rules/prompt-prefix.md#rules` 的“只追加”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**模型可见文字不会；程序侧元数据可能不同但都是确定性的。**
- `externalContentSourceRefs` 先 `Set` 去重再 `sort(localeCompare)`（`context-external-content.ts:24-31`）；`ruleSource` 也排序（`production-owner-rules.ts:334-341`）；`askedBecause` 的来源来自 `#externalSources` 的去重排序（`owner-scope-authorization.ts:226-236`）。集合顺序固定。
- 唯一带时间的新值是 `refusedAt`（`owner-scope-authorization.ts:325`），只写状态记录和审计，不进模型上下文；重放时故意取第一次的值，同一意图重复写审计字节稳定。
- 注意：`externalContentSourceRefs` 的 512 截断会把不同 origin 折叠成同一 ref（见第 3 条），但它对模型不可见，且折叠本身是确定的。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？
**有，但覆盖不完整（未运行测试，只读代码判断）。**
- 会真正反向失败的：
  - 拒绝重放：`tool-action-registry.test.ts:893-911` 第二次执行前 `advance(5_000)`，断言仍是 `action_rule_refused` 且只有 1 条审计；旧代码会因 `occurredAt` 不同触发 `DUPLICATE` 不匹配而变成 `authorization_component_error`。
  - 标记写失败不执行：`tool-action-registry.test.ts:913-928` 断言 `not_sent` 且 `managedTasks` 未调用；旧代码会直接抛错。
  - 原因长度：`tool-action-registry.test.ts:930-951` 断言含“等 7 个来源”且长度 <600；不截断会失败。
  - preflight 拒绝计数：`pi-runtime-adapter.compat.test.ts` 新用例断言 3 次 preflight 后 `PI_TOOL_LOOP_DETECTED`；不加 `refused: true` 不会停。
  - 规则开关 UI、规则编号冻结、`refused` 计数上限：各有正/反向。
- **反向覆盖不到**：
  - `read` / `readThread` 的真实接线（第 1 条）。
  - `setAskFirst` 的冲突重试、`#audit` 的提交冲突（第 5 条）。
  - 适配器续跑时的拒绝计数（第 4 条）。
  - 标记失败时诊断记录的内容/键（新测试只断言结果，不查诊断）。
  - “未标记的记忆不带 external-content”只靠注入空 origins，未验证另一个 thread 不会串味。

### 4. 每个新值产生处和使用处两端都能接受吗？
逐项核对（★ 表示发现不匹配）：

| 值 | 产生处 | 使用处/校验 | 结论 |
| --- | --- | --- | --- |
| `external-content:<记录>\|<来源>` | `context-external-content.ts:24-31`，截 512 | `carriesExternalContent` 只查前缀；网关 `sourceRefs` 每项 `boundedString(512)`（`contracts-v2.ts:1638`）；持久化只拒空串（`sqlite-memory-operations.ts:660-661`）；`memorySourceState` 过滤该前缀（`memory-source.ts:35-40`）；`production-run-memory.ts:465` 取第一个非 external ref | 可接受；★ 接近 512 的 recordId 会丢 `|来源`（第 3 条） |
| 规则 `source` 前缀 | `production-owner-rules.ts:329-341`，截 256 | 存储校验 1..256（`sqlite-owner-rule-operations.ts:123`）；导出 `text(1,256)` | 可接受；截断可能丢掉 `\|base`，但当前无解析消费处 |
| `runPolicy.toolRefusals.{consecutive,total}` | `strict-configuration.ts:1378-1391`，`DEFAULT_TOOL_REFUSALS` | `service-main.ts:2587-2588` → `production-run-composition.ts:457` → 适配器；守卫再校验正整数（`pi-tool-progress-guard.ts:46-54`） | 可接受；对象形式要求两个键都写，与 ADR“默认值”表述略有出入 |
| `refused: true` | `runtime-tool-authorization.ts:21-35`、`pi-runtime-adapter.ts:2198` | 适配器 `:1571` → 守卫 `observe` 计数 | 可接受 |
| `refusedAt` | `#audit` 写状态/审计 | 仅 `#audit` 读回（`owner-scope-authorization.ts:361-369`）；审计 `occurredAt` 为字符串时间 | 可接受 |
| `action-refusal:<intentId>` | `actionRefusalKey`（`owner-scope-authorization.ts:65-67`） | `#audit` 状态键、审计 `targetRef` | 可接受（状态键列无 256 限制） |
| `builtIn`（`memory.rules.snapshot`） | `production-memory-control.ts:809-813` | 网关必填数组（`contracts-v2.ts:1851-1860`）；网页 `memory.ts:127` 读取 | 新老服务混部时旧服务快照会缺该必填字段而整块失败（版本偏差风险，未核实部署方式） |
| `ask_first` / `allow_directly` | 契约 `contracts-v2.ts:1817-1823` | `production-memory-control.ts:1393-1405` → `setAskFirst`；网页 `rule-receipt.tsx` | 可接受 |
| `action-rule:<id>` 开关 | `action-rule-switches.ts:95-117` | `owner-scope-authorization.ts:290-314` 同一 `actionRuleAuthorizationKey` | 可接受 |
| `target_type` | `actionGateFacts`（`action-rules.ts:48`） | 内置规则表达式；字段目录 | 可接受 |
| `askedBecause.ruleText` | `owner-scope-authorization.ts:93-105` | 网关 `contracts-v2.ts:2449-2452`；**网页无读取** | ★ 文档说网页是使用处，代码里没有（第 7 条） |
| `ownerAttachments` | `context-projection-service.ts:104-107` | `production-run-composition.ts:361-362` 标记 `owner_attachment` | 可接受；对历史/当前附件标签计数，旧附件也会重复标记（按 origin 去重，无害） |

**未核实**：`check:prompt-prefix`、`check:rule-registry`、类型检查与测试的实际运行结果；以上只做了代码阅读和 diff 核对。

---

## 对作者这次三条特别关注事项的直接回答

1. **捕获里多读一次外来来源，会不会因为没有对话/运行已删除而抛错拖垮捕获？**
   不会因这两个原因抛错。`#plan` 在 `production-memory-capture.ts:1086-1087` 先读运行来源，不存在或 thread 不匹配就返回，根本到不了 `:1209-1212`；`readRunExecutionSource` 对不存在的运行返回 `undefined`（`sqlite-thread-operations.ts:1546`）。即使读状态抛错，也被 `#captureTurn` 外层的 `.catch(onFailure)`（`:812-814`）接住。残留风险是：`#captured` 在 `:799` 已加入该 run，`#plan` 抛错会永久放弃该轮捕获且不写审计（低）。

2. **一天的复盘覆盖多段对话，会不会给不相干的记忆加标记？**
   不会跨对话：一次只处理一个 episode（`production-memory-conversation-review.ts:489-496`），episode 是 per-thread（`packages/memory-engine/src/episodes.ts:52`、`:468`），`readThread(episode.threadId)`（`:734`）只读该 thread。但**同一 thread 内会按“当前累计来源”标记历史片段产生的记忆**（偏严，符合 ADR 的上下文口径）。

3. **标记写失败返回 `not_sent` 会不会和工具结果缓存、重放冲突？**
   正常路径不冲突：标记在 `#executeCanonical` 前，失败时不写 intent/result；回放时同一 origin 已存在，`mark` 提前返回（`context-external-content.ts:166`），再命中缓存。窄口是状态读取失败时 `not_sent` 会在查缓存前返回（第 2 条），此时若此前已有成功缓存，会误报“没发出”，需要修。
