本次复核工具已被禁用，无法再运行测试或补读代码。下面是基于已读内容的完整结论；凡是没读到的地方标「未核实」。测试没有实际运行，反向用例是否真的会变红只是按代码推演。

## 读代码证实的问题

### 高：自动捕获的记忆没有加外来内容标记，跨对话防洗白断开

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:499`
- 问题：ADR 0257 第 2 步明确写“在‘有外来内容’的上下文里写下的提醒、记忆、规则，记录上带一个来源标记”（`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:129`）。代码只给提醒（`production-reminder-writer.ts:228-231`）和规则（`production-owner-rules.ts:456-459`）加了标记；自动记忆捕获写记忆时仍然只有：
  ```ts
  sourceRefs: [input.sourceRef],
  ```
  `ProductionMemoryCaptureOptions` 也没有 `externalContent`/`externalOrigins`。因此外部内容经自动记忆捕获进入长期记忆后，`sourceRefs` 不带 `external-content:`。以后在**另一个对话**里被 `memory.recall` 或组上下文检索读出来时，`carriesExternalContent(memory.sourceRefs)` 为假，不会记 `recalled_external_record`，后续有后果的动作可能继续被 `action_preauthorize_owner_data` 直接放行。
- 证据：上述 `sourceRefs: [input.sourceRef]`；`production-memory-capture.ts` 全文没有引用 `external-content`/`externalOrigins`；`production-run-composition.ts:547-571` 构造 `ProductionMemoryCapture` 时没有传 `externalContent`；ADR 原话见上。
- 建议：把外部来源传进记忆捕获写入端，给捕获记忆的 `sourceRefs` 追加 `externalContentSourceRefs(memoryId, origins)`；同时补“外来上下文里捕获记忆 → 在另一对话检索 → 下一条提醒要等点头/后台拒绝”的集成用例。若认为自动记忆不在本步范围，必须改 ADR 和本 PR 说法，否则文档与代码不一致。

### 中高：后台拒绝的审计记录重放不幂等，会从“拒绝”退化成“授权组件错误”

- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:331-355`、`apps/agent-service/src/owner-policy-authorization.ts:20-32`
- 问题：状态记录 `action-refusal:<intentId>` 有 `existing` 判断，重放时不重写；但审计记录仍然写入：
  ```ts
  id: `owner-scope-rule:${digest([intent.id, `refused:${hit?.id ?? ""}`])}`,
  ...
  occurredAt: clock.now(),
  ```
  而 `appendAuditRecord` 遇到重复 id 时逐字段比较，`occurredAt` 每次不同就会重新抛出 `PORT_DUPLICATE`：
  ```ts
  !(Object.keys(record) ... every((key) => existing[key] === record[key])) throw error;
  ```
  同一动作意图重放（例如拒绝后进程崩溃、续跑再次执行同一 tool call；`#ownerScopedOnce` 在 `production-runtime-tools.ts:847-848` 对 `stopped` 不写结果缓存，重放会再次走 gate）会把第二次拒绝变成异常；外层 `#ownerScopeGate` 捕获后改成 `authorization_component_error`，并写诊断。并发两个相同拒绝时，状态写入的 `expectedRevision: null` 也会让其中一个冲突。新值清单说“同一个动作意图只写一次”（ADR:216），实际审计这条不满足。
- 建议：审计 id 带上不发生变化的字段，或重放时读取已有审计的 `occurredAt`；状态写入与审计写入放进同一个幂等事务；增加“同一 intent 第二次拒绝不再抛错”的测试。

### 中：拒绝记录里的“提议候选”无法恢复参数，与 ADR 的读取说法冲突

- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:154-201`、`:320-330`；ADR:217
- 问题：ADR 说“只存参数指纹不存参数原文，接收端要参数时按动作意图编号去读冻结的意图”（ADR:217）。但冻结的 `GovernedActionIntent` 只有 `input-digest`：
  ```ts
  targets: [
    { type: row.targetType, ref: configuration.ownerId },
    { type: "tool", ref: row.tool },
    { type: "input-digest", ref: inputDigest },
  ],
  ```
  拒绝状态记录也只有 `parameterFingerprint`，没有原始参数，也没有参数 Payload 引用。未来“主动提议”接收端按 intentId 读冻结意图时，拿不到提醒正文、时间、规则内容等参数。当前没有接收端，所以不影响现有运行，但这是一个已写入文档、代码却做不到的约定。
- 建议：在冻结 intent 旁边另存受保护的参数原文或 Payload 引用（并在新值清单写清楚只对提议接收端开放）；或改 ADR，明确指纹不可逆、接收端无法恢复参数。

### 中：标记在工具执行/授权之前落库，失败的调用也会污染对话

- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:1229`、`:614-637`、`:847-848`
- 问题：`execute` 在 `#isTaskManagement`、`#ownerScopeGate`、真正执行之前就调用 `#markExternalContent(invocation)`。登记为 `external` 的工具即使随后被授权拒绝、执行失败、或根本不会把内容交给模型，也会留下 `context-external-content` 标记。结果是后续有后果的动作被错误地问（用户对话）或被直接拒绝（后台），与“读过外来内容”语义不一致。另外 `#markExternalContent` 没有 try/catch，标记写失败会让一个尚未执行的工具直接抛出，Pi 适配器在 `pi-runtime-adapter.ts:2224-2232` 会把它记成 `result_unknown`（`possibly_sent`），既不是真实的未知结果，也可能触发恢复流程。
- 证据：`await this.#markExternalContent(invocation);` 位于所有执行分支之前；`#contentOrigin` 只看登记表的 `resultOrigin`，不看这次调用是否成功。
- 建议：对“工具结果进入上下文”这一事件记标记，而不是对“发起调用”记；至少区分成功/失败，并让标记写失败不改变工具执行结果（例如记录诊断后继续）。补“外部工具被拒/失败后下一条提醒仍直接做”的用例。

### 中低：卡片原因文字无上限，且硬编码中文

- 文件:行：`apps/agent-service/src/owner-scope-authorization.ts:91-101`、`packages/gateway-contracts/src/contracts-v2.ts:2449-2452`
- 问题：`askedBecause` 把 `externalSources` 全量用“、”拼进 `ruleText`，没有长度限制；网关审批展示字段是 `approvalDisplayText(2001)`。来源里可能有 `authorized:<能力名>`、`unregistered:<能力名>`，模型可通过调用多个外部工具把来源数量堆高，超过 2001 后审批快照可能过不了网关校验，影响审批页加载。另外这句原因是服务端写死的中文，而规则页和审批展示有中/日/英三语。
- 建议：`ruleText` 只保留数量或截断后的前几个来源，并按 `answerLocale`/展示层生成多语言文字；补一条来源很多时审批快照仍合法的测试。

### 低中：`ContextExternalContent.mark` 对所有错误都重试，且没有并发测试

- 文件:行：`apps/agent-service/src/context-external-content.ts:133-165`
- 问题：重试循环捕获**所有**错误，包括权限/数据库错误，不是只重试修订号冲突；连续 5 次立即重试无退避。不同来源并发标记时逻辑本身不会丢来源（冲突后重读再合并），但高争用下可能 5 次都冲突并把异常抛给调用方，进而让工具/组上下文失败。新单元测试只测了 `markRecalledExternalRecords` 和来源引用格式，没有测 `ContextExternalContent.mark` 的并发、同来源幂等和冲突重试。
- 建议：只对 `PORT_CONFLICT` 重试，加退避；补“两个运行同时标记不同来源不丢、相同来源不重复”和“非冲突错误不重试”的测试。

### 低：拒绝计数快照在工具执行前保存，续跑可能少算一次；重放结果不计数

- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1556-1570`、`:1638-1659`、`:1755-1760`（后两处由 grep 定位）
- 问题：`saveToolCheckpoint` 在工具执行前保存 `toolProgress.snapshot()`；如果第 3 次拒绝后立即崩溃，续跑恢复的是执行前快照，少一次拒绝。`tool_result` 观察对 `replayedResults.delete(...)` 为真的重放结果会跳过，拒绝也可能不被重新计数。压缩在同一 `run` 调用内沿用同一个 guard，这一点是对的；但“续跑后计数正确”只有 guard 单测，没有“真实检查点 + 拒绝 + 续跑”的适配器用例。
- 建议：在 `observe` 之后更新可恢复状态，或把拒绝计数作为独立 durable run state；补续跑与压缩的端到端用例。

### 低：preflight 拒绝不计入 `refused`

- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:2190-2199`
- 问题：preflight `!decision.allowed` 返回的失败结果没有 `refused: true`，所以“连续被拒到上限”不会覆盖这类拒绝；模型可以在 preflight 拒绝上循环，只靠原有工具循环守卫兜底。若设计只统计统一出口拒绝，应在文档写明；否则应在这里也带上 `refused: true`。

### 低：规则开关并发与审批等待期间的行为没有测试，CAS 冲突会直接失败

- 文件:行：`apps/agent-service/src/action-rule-switches.ts:70-95`、`apps/agent-service/src/owner-scope-authorization.ts:287-309`
- 问题：两次并发切换都读同一 revision，后提交的一方得到冲突异常，没有重试；`#standingAuthorization` 在读取“开着”后、写入/放行前如果开关被切到“先问”，这一次仍可能按预先授权执行。`#standingAuthorization` 对 `enabled !== true` 返回 `undefined`、不自动重新打开，这部分是正确的。审批等待中切换不会改写已冻结的 intent；但“切换后下一次/已挂起调用到底怎么走”没有用例。
- 建议：明确并发语义（重试或返回冲突给 UI），补“切换与预授权并发”“审批等待中切换”的测试；如果要求切换立即生效，需要在执行前再次核对开关或把开关版本写进授权记录。

### 低：文档与代码不一致

- 文件:行：ADR `docs/adr/0257-...md:147`、`:156`、`:216`、`:232`
- 问题：决定表和第 2 步仍写“记一条决策记录”，但新值清单和代码写的是审计记录 + `product_state_records` 的 `action-refusal:` 记录，没有写 `decision_ledger`。另外登记表的 `mayFollowExternalContent` 列在 `apps/agent-service/src/production-tool-actions.ts` 全部填 `true`，全仓除登记表和测试外没有读取处（grep 只有类型定义和常量），但 ADR 说第 2 步会用到“能不能由外来内容引出”。
- 建议：统一 ADR 用词；要么实现 `mayFollowExternalContent`，要么把 ADR 改成“暂未使用”。

## 推测 / 未核实

- **外部事件正文的标记是懒的**：`owner-scope-authorization.ts:227-229` 只在有 owner-scope 动作授权时才记 `external_event`。若一轮外部事件只调用写代码等非 owner-scope 工具，事件正文本身是否进入后续对话历史、是否需要标记，未核实。
- **上下文块里的外来内容**：组上下文时只看到附件计数和记忆检索标记；worker 结果、线程摘要、其它 context block 是否应算外来内容，代码里没有统一标记，未核实设计意图。
- **MCP/外部提议写下的记忆**：`production-mcp-memory-writer.ts:328` 仍写 `sourceRefs: [contentRef]`，且记忆 id 前缀是 `memory:mcp:`；`memorySourceState` 会显示 `external`，但 `carriesExternalContent` 只认 `external-content:`。这些记忆被回忆时是否应触发外来内容标记，未核实。
- **任务取消直接做的所有权检查**：`production-sandbox-services.ts:2337-2358` 的 `resolveTask` 以 `runId` 查资源并要求模型、对话、租约一致，因此跨运行取消不会真正执行；但 owner-scope 的预授权/审批记录会在所有权检查之前产生，可能留下无效审批噪声。是否需要调整未核实。
- **治理删除**：`sqlite-governed-deletion.ts:1057-1067` 只删 `key = ref` 或 `ref:%`，新键 `context-external-content:thread:...`、`action-refusal:...` 不匹配，删除对话/运行后可能残留。ADR 对内容标记写“只追加不删除”，是否包括整对话删除未核实。
- **未运行测试**：本次不能执行 `npm run check:rule-registry`、`npm run check:prompt-prefix` 或任何集成测试，反向用例是否真的会失败只是按代码推演。

## 侧重检查

- **错误路径**：审计重放冲突、标记写失败把未执行工具变成 `result_unknown`、开关 CAS 冲突未重试，均已在上面报告。`markRecalledExternalRecords` 空列表提前返回；`readMany` 失败会向上抛，属于会让组上下文失败的错误路径，未单独处理。
- **不合规范/不可信输入**：`sourcesOf` 会过滤非法的 `sources` 条目；`PiToolProgressGuard` 校验新的计数是非负安全整数，但不校验 `refusalsInARow <= refusals`，也不限制计数大于上限（只影响恢复显示，不是授权绕过）。`parseToolRefusals` 有范围与未知键校验。`memory.rule.respond` 的 `target` 是 `machineString`，服务端对未知 id 返回 `ACTION_RULE_NOT_FOUND`，对“先问/不做”的规则返回 `ACTION_RULE_HAS_NO_SWITCH`。
- **安全**：最主要的问题是自动捕获记忆没有来源标记，可能跨对话洗白。任务取消直接放行按 ADR 是有意为之，所有权检查仍在 `resolveTask`；外部内容标记在执行前产生会造成偏严的误问/误拒，但不是放行漏洞。
- **资源耗尽**：线程级 `sources` 数组按不同 origin 增长，origin 数量受工具数限制但 `askedBecause.ruleText` 无截断；`action-refusal:` 状态记录没有清理路径。
- **不可撤销操作**：任务取消是唯一新增的直接放行的不可撤销动作；其“只能是本轮自己开的任务”检查保留在 `resolveTask`，读代码确认。
- **文档/代码一致**：ADR 的“记忆”标记、决策记录用词、`mayFollowExternalContent` 列与实际代码不一致，已在低严重度条目列出。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   未发现会。改动没有动 `packages/prompt-catalog`、系统提示或工具定义；外部内容标记、开关、审计、`ownerAttachments` 都是程序侧状态；`refused` 只进入 Pi 的工具结果 `details`，不进入 `modelContent`。规则 `source` 前缀和记忆 `sourceRef` 的变化会出现在工具结果/上下文块这类末尾追加内容里，不是请求头。按 `.claude/rules/prompt-prefix.md` 第 4 条，仍然是“只在末尾追加”。每一轮会变的值（`firstSeenAt`、当时的来源列表）没有进入系统提示或工具定义。**未核实**的是 worker 结果等上下文块是否可能出现在头部，按现有设计应在末尾。

2. **同一段文字会不会在不同请求里变成不同字节？**
   在模型可见字节上未发现。`externalContentSourceRefs` 对来源去重并按 `localeCompare(...,"en")` 排序；数据库读取 `sourceRefs` 用 `ORDER BY source_type, source_id`；`parameterFingerprint` 的 `stable()` 对对象键排序；`askedBecause` 的来源也来自排序后的集合。`firstSeenAt` 只存进 `product_state_records`，没有发给模型。唯一潜在的非模型字节问题是 `ruleText` 拼来源，但那是审批展示，不是对话请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`check:rule-registry` 加入了 `test/tooling/rule-ids-frozen.test.ts`，并跑 `test/integration/tool-action-registry.test.ts`；`policy-fact-registry.unit.test.ts` 逐条跑内置动作规则的例子并带“把例子命中翻转”反向；集成测试有“去掉后台拒绝规则”“把任务输出改成 owner_data”“不带标记的记忆不记”“没有内置规则时整块不显示”等反向。
   但缺口也明确：没有 `ContextExternalContent.mark` 并发/幂等测试；没有审计重放测试；没有“真实 owner-scope 拒绝 → `refused:true` → Pi 守卫计数”的端到端用例（适配器测试是 mock 工具直接返回 `refused`）；没有附件标记的实际装配测试；没有自动记忆捕获的防洗白测试。测试是否真的会红，本次无法运行核实。

4. **每个新值的产生处和使用处两端都能接受吗？**
   - `context_external_content`：事实表已登记，规则和事实校验都接受；通过。
   - `target_type`：字段目录已加，规则例子由 `check:rule-registry` 校验；通过。
   - `ownerAttachments`：`ContextProjectionService` 产生，`production-run-composition` 消费；投影测试覆盖计数，但标记装配未测。
   - `refused`：`runtime-tool-authorization` 产生，Pi 适配器消费；类型是可选字段，preflight 路径不产生（见低严重度条目）。
   - `action-refusal:<intentId>` 和审计 `targetRef`：键长和格式没有现有消费者拒绝；但审计重放会冲突，提议接收端也拿不到参数。
   - `action-rule:<id>` 开关状态：`setAskFirst`、`#standingAuthorization`、`list` 三处对 `enabled`/`ruleRevision` 的约定一致；并发切换会冲突但不会静默写坏。
   - `memory.rules.snapshot.builtIn`：网关 schema、控制中心、集成测试都已更新；先问/不做的 `askFirst` 是 `null`，与 schema 一致。
   - `memory.rule.respond` 的 `ask_first`/`allow_directly`：网关枚举、控制中心类型、服务端分支一致；目标不是“直接做”规则时会被拒绝。
   - `runPolicy.toolRefusals`：严格配置解析、默认值、Pi 守卫范围一致。
   - 记忆/规则里的 `external-content:` 引用和规则 `source` 前缀：写入端、记忆来源判断、上下文 `sourceRef`、数据导出（512/256 上限）都能接受；**自动记忆捕获没有使用这个值**，这是最大的缺口。
   - `EXTERNAL_CONTENT_SOURCE_REF_PREFIX`：通过 gateway-contracts 导出，写入和读取共用；通过。
