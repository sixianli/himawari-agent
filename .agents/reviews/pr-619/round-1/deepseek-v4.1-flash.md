## 意见

### 1. 高：取消提醒被当作“能撤回”的动作直接放行，但代码里取消后无法恢复
文件:行：`apps/agent-service/src/production-tool-actions.ts:61-66、283-287`；`packages/application/src/rules/action-rules.ts:20-21、361-366`；`apps/agent-service/src/production-reminder-writer.ts:403-421`；`apps/agent-service/src/production-memory-control.ts:1996-2000`

问题：`reminder_cancel` 带着 `himawariSideOnly: true`，并从 `OWNER_WRITE_DEFAULTS` 继承 `reversible: true` / `sideEffect: "reversible"`；新规则只看 `reversible == 1` 就直接放行。但取消提醒后代码里没有恢复入口，`memory.reminder.respond` 还明确拒绝已取消提醒的任何非 `cancel` 动作。于是读过外来内容后，邮件里一句“取消提醒 X”会不经卡片直接执行，而且撤不回来。这直接违背新规则“能撤回”的前提，也是这次改动里最需要关注的一类不可撤销操作。

证据（读代码证实）：
- `OWNER_WRITE_DEFAULTS`：`reversible: true, sideEffect: "reversible"`（`production-tool-actions.ts:61-66`）；`tool: "reminder_cancel", himawariSideOnly: true`（`:283-284`）。
- 新规则要求 `reversible == 1`（`action-rules.ts:21`），表达式为 `"context_external_content" in facts && ${HIMAWARI_SIDE_EXPRESSION}`（`:365`）。
- 取消只写 `status: "cancelled"`（`production-reminder-writer.ts:413`）；`if (reminder.status === "cancelled" && action !== "cancel") throw ... "MEMORY_REMINDER_CANCELLED"`（`production-memory-control.ts:1996-2000`），没有复活路径。

建议：把 `reminder_cancel` 的 `himawariSideOnly` 去掉，让它在读过外来内容后走“先问”；或者实现真正的恢复/撤销入口，并把 `reversible` 改成与实际能力一致。补一条“外部事件读到外来内容后取消提醒必须弹卡片（或可撤销）”的测试。

### 2. 高：`ownerApprovedTask` 仍然不打外来内容标记，和设计文档明确要求相反
文件:行：`apps/agent-service/src/context-external-content.ts:84-89`；`apps/agent-service/src/owner-scope-authorization.ts:265-278`；`test/integration/tool-action-registry.test.ts:674-683`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:428`

问题：作者说法 5 和代码一致（同意过的任务不自动打标记），但设计文档在同一节明确写“同意过的任务那条例外随 ADR 0278 一起去掉”，并且本节的目标是“外部事件叫起的运行在组上下文时就给对话打标记”。当前实现保留了旧例外：`external_event` + `ownerApprovedTask` 的运行不会得到 `context_external_content`，于是设备写、改规则等本应“先问”的动作可以按“没读过外来内容”走 `preauthorizeOwnerData`。这是文档与代码的直接冲突，也是权限边界上的实际缺口。

证据（读代码证实）：
- `if (source?.sourceType !== "external_event" || source.ownerApprovedTask) return null;`（`context-external-content.ts:87`）。
- `owner-scope-authorization.ts:265-267` 也复用同一个 helper，`eventOrigin` 为 `null` 时不写标记。
- 测试明确锁定旧行为：`setup({ sourceType: "external_event", ownerApprovedTask: true })` 后断言 `expect(await s.externalContent.read(RUN_ID)).toEqual([])`（`tool-action-registry.test.ts:674-683`）。
- 文档 `:428`：“同意过的任务那条例外随 ADR 0278 一起去掉。”

建议：按文档去掉 `source.ownerApprovedTask` 条件，并更新上述测试为“该运行带标记”；若确实要保留例外，先改设计文档/ADR 写明理由，并补测试证明这种运行里的设备写、改规则为什么可以绕过问询。

### 3. 中：外部事件来源改成逐事件字符串后，长期主对话的标记和记忆出处会无界增长
文件:行：`apps/agent-service/src/context-external-content.ts:82-89、202-206、222-232、33-55`；`apps/agent-service/src/production-reminder-writer.ts:253`；`apps/agent-service/src/production-memory-capture.ts:1211`

问题：旧行为每个对话只加一个常量 `"external_event"`，`mark` 第二次就早退；现在每个外部事件都产生 `external_event:<sourceId>`，主对话又只增不删。结果是：`markRunSource` 在每个模型请求的 projection 都要读整张来源表；每次新事件都要读、排序、重写整张表；之后新建的提醒、规则记忆会按 `externalContentSourceRefs` 给每个历史来源各生成一条 sourceRef。随着收件箱事件累积，状态体积、写入成本和单条记忆的 sourceRefs 数量都会持续增长。

证据（读代码证实）：
- `return \`${EXTERNAL_EVENT_ORIGIN_PREFIX}${source.sourceId}\`;`（`context-external-content.ts:88`）。
- `markRunSource` 每个 projection 都调用 `mark`（`production-run-composition.ts:364`）。
- `#write` 每次 `const sources = sourcesOf(record?.value); if (sources.some(...)) return;`，新来源时 `[...sources, ...].sort(...)` 整体重写（`context-external-content.ts:226-232`）。
- `externalContentSourceRefs` 对每个 origin 生成一条 ref（`:37-54`），提醒写入使用它（`production-reminder-writer.ts:253`），记忆抓取也使用它（`production-memory-capture.ts:1211`）。

推测：具体性能退化和状态行大小取决于真实主对话收到多少外部事件，未做压力测试；但从代码路径看是随事件数线性增长，重写整表是额外成本。

建议：对外部事件来源做有界聚合（例如保留最近 N 条 + 一个“发生过外部事件”的布尔值，具体来源另存到动作记录），或在 `#write` / `externalContentSourceRefs` 加明确数量上限和清理策略；补一个大量外部事件后状态大小和 ref 数量的测试。

### 4. 中：新增的“运行一开始就标记”只有单元测试，缺少设计文档要求的端到端检查
文件:行：`apps/agent-service/src/production-run-composition.ts:361-367`；`apps/agent-service/test/context-external-content.unit.test.ts:217-228`；`test/integration/device-action-approval.test.ts:244-262`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:427`

问题：新逻辑的关键是把标记提前到 `resolveProjection`，但现有测试只直接调用 `store.markRunSource(...)`，没有测试 `createProductionRunComposition` 真的在 projection 里调用它。`device-action-approval` 新用例是通过 `startedByOutsideEvent()` 后才调用 `authorization.authorize()`，它验证的是授权时的 `#externalSources` 标记，不能证明“只回话、没调工具”的运行也会留下标记。设计文档明确要求的“一封邮件叫起、只回了话没调工具的运行之后，主对话下一次运行读得到标记”目前没有自动检查。删除或挪动 `production-run-composition.ts:364` 这一行，现有测试不会失败。

证据（读代码证实）：
- 实际接线：`await externalContent.markRunSource(request.runId);`（`production-run-composition.ts:364`）。
- 单元测试只覆盖方法本身：`expect(await store.markRunSource("run-mail" as never)).toEqual(["external_event:mail:42"]);`（`context-external-content.unit.test.ts:221`）。
- 集成用例先改 trigger 再直接授权（`device-action-approval.test.ts:118-126、247-262`），走的是授权时的标记路径。
- 文档 `:427` 明确要求这条测试。

建议：加一条端到端/集成用例：`external_event` 运行只产生最终回答、不调用任何需要授权的工具，然后同一对话下一次运行能读到 `context_external_content` 并因此对设备写或规则修改弹卡片。另补 `reminder_cancel` 的预授权测试，目前只有 `reminder_set` 被覆盖。

### 5. 低：登记表校验没有结构性地保证“不会改规则”，作者说法 2 说得过大
文件:行：`packages/application/src/services/tool-action-registry.ts:83-92`

问题：`assertRow` 对 `himawariSideOnly` 检查了授权路径、可撤销、不外发、不要本人在场、`standingRuleChange` 和不是设备动作，但没有检查 `targetType` 或 `actionKind`。一行 `targetType: "owner-rule"` 却漏写 `standingRuleChange: true` 的登记会通过校验；而新规则只认 `standing_rule_change` 这个事实，于是它仍可能被直接放行。当前两个提醒登记是正确的，问题在防御性约束和“保证”这一说法。

证据（读代码证实）：`row.authorization !== "owner_scope" || !row.reversible || row.disclosure !== "none" || row.ownerPresenceRequired || row.standingRuleChange || row.family === "device_action"`，没有 `targetType`/`actionKind` 检查（`tool-action-registry.ts:83-92`）；`HIMAWARI_SIDE_EXPRESSION` 依赖 `!("standing_rule_change" in facts)`（`action-rules.ts:21`）。

建议：`assertRow` 增加 `targetType` 允许清单（例如只允许 `owner-reminder`、`owner-memory` 等明确属于 Himawari 自己的目标），并要求 `actionKind === "CREATE_OR_UPDATE"`、`sideEffect === "reversible"`，把“能撤回、只改自己这边”从只靠布尔字段变成结构性约束。

### 6. 低：`ruleSource` 对新更长的来源字符串只做裸切片，可能截掉 `|base` 并截断在来源中间
文件:行：`apps/agent-service/src/production-owner-rules.ts:612-621`

问题：新的 `external_event:<sourceId>` 最长约 143 字符（`sourceId` 由 `machineString` 限制 1-128，`packages/gateway-contracts/src/validation.ts`），两个外部事件拼起来就超过 256；`ruleSource` 直接 `.slice(0, 256)`，不像 `externalContentSourceRefs` 那样“截短加哈希”。结果可能是规则 `source` 里 `|base` 被截掉，或者切在某个 origin 中间，出处文字不完整。作者说法 4 的“长度有上限处理”在该字段上成立（不会超长），但语义上不完整。

证据（读代码证实）：`` `${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${origins.join(",")}|${base}` `` 后直接 `.slice(0, 256)`（`production-owner-rules.ts:618-621`）；`externalContentSourceRefs` 的截短+哈希逻辑在 `context-external-content.ts:39-53`。

建议：`ruleSource` 复用 `externalContentSourceRefs` 的截断+哈希做法，或限制来源条数并保证 `|base` 保留；补一个多来源、长 sourceId 的测试。

## 侧重检查

- **不可撤销操作**：除 `reminder_cancel` 外，检查了家居控制等 `reversible: false` 的设备动作，仍然会走 `ask_owner`，没有被新规则直接放行；没有发现其他不可撤销动作被误标为 `himawariSideOnly`。`reminder_cancel` 是唯一一个“代码实际不可恢复但登记为可撤销”的路径（见意见 1）。
- **错误路径**：`markRunSource` 在 `resolveProjection` 失败会抛 `ExternalContentMarkNotWrittenError`，整个运行在模型调用前失败；这是新增的失败点，但属于 fail-closed，未验证是否会误伤只读运行。`#scopes` 在没有 thread 时只写 run 级标记；`externalEventOrigin(undefined)` 返回 `null`，不会标记，也不会报错（静默跳过），但授权路径另有 source 存在性校验。
- **不可信输入**：`sourceId` 进入网关时受 `machineString` 限制（1-128，字符集 `[A-Za-z0-9._:-]`，不含 `|` 和控制字符），因此 `external_event:<sourceId>` 不会引入分隔符注入，长度也小于 `externalContentSourceRefs` 的 256 上限。但 `ContextExternalContent.mark` 本身不校验 origin 的长度和字符集，安全性依赖所有调用方；以后新增调用方需要单独核对。
- **资源耗尽**：逐事件 origin 导致对话级来源无界增长，已作为意见 3 列出；未实测真实事件量下的数据库行大小和 projection 延迟。
- **规则/说明文档/代码一致性**：规则编号冻结、三种语言 i18n、fact 标签、prompt manifest 和 golden 文本都已改；但发现设计文档与 `ownerApprovedTask` 实现冲突（意见 2），以及作者说法 2 对登记表校验的表述过大（意见 5）。`prompt-manifest.json` 的 sha256 和 `check:prompt-prefix` / 数据库契约没有实际运行核对，标为未核实。
- **模型可见性**：检查了 origin 的消费方（`#externalSources`、`originsOf`、`externalContentSourceRefs`、卡片 `askedBecause`、记忆/提醒写入、规则 `source`），没有发现 origin 被写进系统提示、工具定义、历史消息或工具结果；它只进入授权状态、卡片文字和记忆/规则的 sourceRefs/source。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。系统提示只新增了一条固定文字，按对话冻结（`.agents/instructions/prompt-prefix.md` 第 6 条），只影响新对话，不改变已有对话已经发出的开头；工具定义没有变化。`markRunSource` 只写授权状态，origin 没有进入系统提示、工具定义、历史或工具结果，因此请求仍然是“只在末尾追加”。唯一会变的值（`external_event:<sourceId>`）只出现在授权状态、卡片和记忆 sourceRefs 中，不在模型请求头部，也不在最后一条消息之外进入请求。未核实：无法运行 `check:prompt-prefix` 和 `prompt-catalog` 来验证 sha 与 golden 字节。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   模型可见内容不会。`externalEventOrigin` 对同一个 run 是确定的；`#externalSources` 排序，`externalContentSourceRefs` 排序，`ruleSource` 排序；没有新增时间字段。`originsOf` 本身不排序，但它的上游 `#write` 已把来源按 origin 排序，且现有消费方（提醒写入、规则写入）内部再排序，所以目前没有发现模型可见的非确定字节。建议仍把 `originsOf` 改成显式排序，避免以后新增消费方直接拿它拼提示词或展示文本。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   规则层有：新规则的正/反用例、把 `refuseBackgroundAfterExternalContent` 重新设为 `active` 的反向用例，都是真实会改变结果的测试；`notHimawariSideRegistry` 去掉标记后提醒确实会转成 `awaiting_approval`。但有两处不足：
   - “外部事件运行开始就打标记”的 `resolveProjection` 接线没有端到端测试，设计文档要求的“只回话没调工具后下一次运行读得到标记”缺测（意见 4）。
   - `reminder_cancel` 的预授权没有测试，且 `[ADR-0278] asks the owner...` 用例是通过 `notHimawariSideRegistry` 才通过的，不能代表生产登记表的实际行为。
   另外，因环境限制没有运行 `npm run check` / `check:rule-registry` / `check:prompt-prefix` / typecheck，相关结果未核实。

4. **每个新值/修改值，产生方和使用方两端都能接受吗？**
   - `himawari_side_only`：已加入 `POLICY_FACT_CODES` 和 `POLICY_FACT_REGISTRY`（三语标签），`runtimePolicyFacts` 生成，`validateGovernedActionIntent` 的 `assertPolicyFactCodes` 接受；规则表达式引用它，测试已更新。通过。
   - 新规则 id `action_preauthorize_himawari_side_after_external_content`：已加入冻结清单、三种语言 i18n、`BuiltInActionRuleSwitches` 的 active 列表；`rule-ids-frozen` 和规则示例测试需要新 id，已更新。通过（未实际运行）。
   - `ToolActionRow.himawariSideOnly`：只加在两行提醒写入上；`OwnerScopeAuthorization` 读取后生成 fact；`assertRow` 会拒绝设备行、外发行、改规则行和不可撤销行，但没有校验 `targetType`/`actionKind`（意见 5）。当前登记正确，结构性保证不完整。
   - `external_event:<sourceId>`：`sourceId` 受 128 字符 machine string 限制，origin 最长约 143，小于 `ORIGIN_IN_REF_LIMIT=256`；`externalContentSourceRefs` 生成的总 ref 不超过 512；卡片原因每个来源截到 80 字符；`ruleSource` 只做 256 裸切，可能在多来源时截掉 `|base`（意见 6）。没有发现仍按旧常量 `"external_event"` 比较的地方，所有读取来源的地方都能接受新值。
   - 删除的 `untrustedOriginAllowed` / `readUntrustedContent`：全库检索无残留引用，设备动作仍经 `OwnerScopeAuthorization`，读过外来内容时写入 `context_external_content` 并命中 `ask_owner`。通过。
   - 未核实：没有运行数据库契约测试；没有核对所有 `createProductionRunComposition` 测试夹具是否都给 `externalContent` mock 补上了新方法 `markRunSource`（类型检查未运行）。
