## 侧重检查

我重点查了这几类路径，结论如下：

- **错误路径**：`perception_read` 的非法参数、未知种类、范围超限、读不到正文；`device_action` 的未知动作、设备不支持、没有设备、`confirm` 未接/返回 false、统一授权拒绝。除下面第 1、3 条外，读到的校验都还在，拒绝路径不会执行动作。
- **不可信输入**：`device_action` 的 `action`、`device`、`arguments` 来自模型，执行端先对参数形状、动作登记表、设备支持清单做校验；未发现注入路径。`perception_read` 的 `query`、`kinds` 也在查询前校验。
- **安全/外来内容**：重点核对了 `resultOrigin`、外来内容标记、统一审批。发现 `perception_read` 在运行层会被无条件标成外来内容，见意见 1；另发现 `device_action` 行的风险事实是粗粒度的，见意见 2（当前不可达）。
- **资源耗尽**：`perception_read` 的 `readMaximumScanned`、`readMaximumRecords`、`readMaximumCharacters`、`readMaximumDays` 仍在配置和代码里，未被这次删除；删除的只是 `runReadMaximumRecords` 及 `perception_run_reads` 相关入口检查。
- **不可撤销操作**：`device_action` 在 `perform` 之前过统一授权，被拒时抛 `OwnerScopeStop` 且不执行；但生产未接 `actions`/`perform`，见意见 3。
- **文档与代码一致性**：核对了设计第 17 节、计划第 122/123/139 行、ADR 0257 新值清单；发现第 1、3、4 条不一致。

本轮查过的范围：`d0ba425..7ec0ab7`，重点读了 `7232d9cd7`（第 3 轮低意见修改）、`dcbd87d4f`/`43fe26b0b` 的合入结果、`0343c5320` 的增量；核对了 `production-tool-actions.ts`、`production-runtime-tools.ts`、`production-perception-tools.ts`、`service-main.ts`、`context-external-content.ts`、`owner-scope-authorization.ts`、迁移 `20261114160000_perception_extraction.sql`、schema catalog、提示词清单和三个相关测试。主分支合入的其余大量文件只在可能改变感知工具行为时跟读，没有整份重读。

## 意见

### 1、中：`perception_read` 在运行层会无条件记外来内容标记，和设计/作者说法 3 的“只有来源为‘其他’的记录才标记”不一致

- 文件:行：
  - `apps/agent-service/src/production-tool-actions.ts:330`
  - `apps/agent-service/src/production-runtime-tools.ts:642`、`:651-656`、`:1283`
  - `apps/agent-service/src/production-perception-tools.ts:408`
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:739`
  - `docs/execution/plans/2026-11-11-apple-device-body-plan.md:122`
- 问题：工具执行层确实只在返回记录含 `origin === "other"` 时调用 `markExternalContent`；但登记表把 `perception_read` 的 `resultOrigin` 记成 `"external"`，而 `ProductionRuntimeTools.execute` 在真正执行前会按 `resultOrigin` 统一记外来内容。结果是每一次 `perception_read`（包括只返回主人自己说的话、空结果、甚至参数非法）都会给这一轮/这个对话记 `perception_read` 外来标记。之后同一对话里的有后果动作会被统一审批当作“读过外来内容”，多问主人或后台直接不做。
- 证据（读代码证实）：
  - `production-tool-actions.ts:330`：`resultOrigin: "external",`
  - `production-runtime-tools.ts:642`：`if (row?.resultOrigin === "owner_data") return null;`
  - `production-runtime-tools.ts:651-656`：`const origin = this.#contentOrigin(invocation); if (origin === null) return; await marker.mark(invocation.runId, origin);`
  - `production-runtime-tools.ts:1283`：`await this.#markExternalContent(invocation);`
  - `production-perception-tools.ts:408`：`if (shown.some((record) => record.origin === "other")) await hooks.markExternalContent();`
  - 设计第 739 行写的是“返回的记录里有来源是‘其他’的就记一条”；计划第 122 行也写“返回的记录里有来源是‘其他’的，就给这一轮运行记一条外来内容标记”。
  - 集成测试 `test/integration/perception-tools.test.ts:207` 明确断言主人只说过的记录 `markExternalContent: 0`，但这只测到 `ProductionPerceptionTools` 的钩子，没有经过运行层的统一标记。
- 影响：偏严而不是漏放，但会造成不必要的审批/后台拒绝，和设计、作者说法不一致。ADR 0257 第 208 行确实写了“工具真正执行之前写，被拒、执行失败的也算，只会偏严”，所以这不是安全漏洞，而是两份文档/说法与运行行为不一致。
- 建议：二选一并写清楚：
  - 如果确实只想在“返回了其他来源”时标记：把 `perception_read` 行的 `resultOrigin` 改成 `owner_data`（让运行层不统一标记），完全由 `production-perception-tools.ts:408` 的条件钩子决定；并补一条把真实 `ProductionPerceptionTools` 接进 `ProductionRuntimeTools`、主人-only 记录不标记的测试。
  - 如果接受 ADR 0257 的“调用外部工具就偏严标记”：删掉条件钩子或明确它只是兜底，改设计第 739 行、计划第 122 行和 `does not mark outside content...` 用例，避免测试给出错误保证。

### 2、低：`device_action` 行把所有设备动作都登记成“可撤销的创建/更新”，没有用动作登记表里的单动作风险；第 9 批接上下发后可能把删除类动作判轻

- 文件:行：
  - `apps/agent-service/src/production-tool-actions.ts:55-70`（`OWNER_WRITE_DEFAULTS`）和 `:339-350`（`device_action` 行）
  - `apps/agent-service/src/owner-scope-authorization.ts:189-198`（用行事实组动作意图）
  - `test/integration/perception-tools.test.ts:34`（`calendar.delete_event`，`reads: false, confirm: true`）
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:722`
  - `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:243`
- 问题：`device_action` 行沿用 `OWNER_WRITE_DEFAULTS`，即 `actionKind: "CREATE_OR_UPDATE"`、`sideEffect: "reversible"`、`reversible: true`、`ownerPresenceRequired: false`、`disclosure: "none"`。统一授权组动作意图时直接用这些字段，并不读 `DeviceActionDefinition` 的每个动作风险。设计第 722 行说“设备动作名和风险级别”应由动作登记表供权限、审批使用；当前实现没有把单动作风险接进来。将来第 9 批接上 `actions`/`perform` 后，像删除日历事件这类动作会被当成可撤销的创建/更新处理，可能自动放行或不需要本人在场。
- 证据（读代码证实）：行事实确实进入意图：`owner-scope-authorization.ts:189` `sideEffect: row.sideEffect`、`:193` `reversible: row.reversible`、`:196` `actionKind: row.actionKind`；测试里的动作定义有 `calendar.delete_event`。
- 推测：目前 `service-main.ts:1567-1582` 构造 `ProductionPerceptionTools` 时没有传 `actions`、`perform`、`confirm`，生产里 `device_action` 只能 `describe`，找不到动作定义，实际不可达；所以这是潜伏问题，不是当前可利用漏洞。ADR 0257 第 243 行也把设备动作接入放在第 4 步/苹果第 9 批。
- 建议：第 9 批接入前，要么按每个 `DeviceActionDefinition` 生成/选择动作事实，要么先用保守占位（例如不可撤销、外部内容、需本人在场），并补一条“删除类设备动作进入统一授权时事实正确”的反向用例。

### 3、低：R3-3 只修好了错误区分，生产仍没有接 `confirm`；而且授权发生在“能不能执行”的检查之前，主人可能被问一次却注定失败

- 文件:行：
  - `apps/agent-service/src/production-perception-tools.ts:498-519`
  - `apps/agent-service/src/service-main.ts:1567-1582`
  - `docs/execution/plans/2026-11-11-apple-device-body-plan.md:123`
  - `test/integration/perception-tools.test.ts:332`、`:382`
- 问题：`7232d9cd7` 已经把“没有接确认入口”改成 `DEVICE_ACTION_UNAVAILABLE`，“接了但返回 false”仍是 `DEVICE_ACTION_CONFIRMATION_REQUIRED`，这一点改好了。但生产构造 `ProductionPerceptionTools` 时仍然没有 `confirm`，所以 `confirm: true` 的动作永远不能执行；计划第 123 行也承认要等第 9 批。更细的问题是 `hooks.authorize()` 在 `if (!this.#options.perform)` 和 `confirm` 可用性检查之前调用：如果将来只接了动作定义和授权、没接 `perform` 或 `confirm`，主人会先被要求批准，然后收到“设备动作暂时用不了”。测试目前把“授权计数为 1 后才报 UNAVAILABLE”固化了（`perception-tools.test.ts:332`、`:382`）。
- 证据（读代码证实）：`production-perception-tools.ts:498` `if (!definition.reads) await hooks.authorize();`；`:499-503` 才检查 `perform`；`:510-519` 才检查 `confirm`。生产构造没有传入这些回调。
- 建议：把 `perform`/`confirm` 可用性检查移到 `hooks.authorize()` 之前；如果这是本批有意的暂时状态，至少在测试里明确区分“未接执行器不应请求授权”，或删除当前断言授权计数为 1 的用例，避免把错误顺序当成正确行为。

### 4、低：计划说后台拒绝会“记决策记录”，实际统一审批写的是审计记录加状态记录，不是 `decision_ledger`

- 文件:行：
  - `docs/execution/plans/2026-11-11-apple-device-body-plan.md:122`
  - `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:206`、`:225`
  - `apps/agent-service/src/owner-scope-authorization.ts:317-370`
- 问题：计划第 122 行改成“后台一轮怎么拒绝并记决策记录，都由统一审批按规则决定”。但 ADR 0257 第 206 行明确说“没有写决策记录表”，实际写成审计记录 `authorization.action_rule.refused` 加 `product_state_records` 里的 `action-refusal:` 状态记录（`#audit` 的实现）。这是文档和代码不一致，容易让后续线程去决策记录表里找不到拒绝记录。
- 证据（读代码证实）：`owner-scope-authorization.ts:346` 命令类型 `authorization.action_rule.refused`，`:351` 写的是 `state`，`:362-370` 写审计；没有 `decisionLedger`。
- 建议：把计划第 122 行改成“记审计记录和按动作意图编号的状态记录，不写决策记录表”，或直接引用 ADR 0257 第 225 行。

## 必答问题

**Q1：这个改动会不会改变模型已经见过的请求开头？**

不会。就这次增量读到的代码看：

- 两个工具的说明和参数仍是提示词目录里的固定文字，`perceptionToolDescriptors()` 的内容没有改；
- 新登记表行是静态常量，`listAuthorized` 里的 `registry.offer()` 只按行过滤、保持原顺序，净效果仍是把 `device_action`、`perception_read` 排在最后；
- 删除的两条闸门提示词只可能出现在工具结果的尾部说明里，不会进入系统提示或工具定义；
- 没有新增每轮变化的值到请求头。迁移、提示词清单、测试指纹都不进入模型请求。

因此发给模型的内容仍然只会在末尾追加，每轮会变的值仍在最后一条消息/工具结果里。**未核实**：没有实际运行 `npm run check:prompt-prefix` 或抓请求体，只按代码和 diff 判断。

**Q2：会不会让同一段文字在不同请求里变成不同的字节？**

没有发现新增的不确定性。新代码没有引入依赖后文的外来内容遮盖、时间字段或无序集合：`perception_read` 的记录顺序仍是查询里按 `occurred_at_ms, id` 排；`sortedEvidence` 仍排序；来源标记写入按 `origin` 排序；迁移文件名和表名固定；`detail` 文字只用于审批展示，不进模型请求。**未核实**：没有运行确定性/请求字节比对测试。

**Q3：改动有没有对应的自动检查，反向用例是否真的会失败？**

有检查，但不完全够：

- 登记表缺行：`production-runtime-tools.unit.test.ts` 的 `[ADR-0257] only the listing, recall and perception read tools...` 断言内置行精确列表和长度 9；删掉 `perception_read`/`device_action` 会失败。
- 来源名不对：同一 `[iOS-5]` 用例断言 `mark` 被以 `"perception_read"` 调用；改常量会失败。
- 条件标记：`test/integration/perception-tools.test.ts` 断言主人-only 记录不标记、含 `other` 标记一次；删掉 `production-perception-tools.ts:408` 的条件判断会失败。
- 授权拒绝不执行：`production-runtime-tools.unit.test.ts` 的 `[iOS-5]` 用第二次授权返回 DENY，断言 `performed` 只有 `a0`、`a1`。

不足：

- 没有任何测试把真实的 `ProductionPerceptionTools` 接进真实的 `ProductionRuntimeTools` 再配一个会拒绝的 `ownerScope`，所以 `OwnerScopeStop` 两条真实接线之间仍有一处只靠类型和分别的单元/集成测试保证。
- 没有运行层“主人-only 记录不标记”的反向用例；单元测试里的感知替身对 `perception.read` 无条件调用 `hooks.markExternalContent()`（`production-runtime-tools.unit.test.ts:1566-1568`），而 `mark` 又被运行层统一标记调用，测试无法区分是哪一层记的。这正是意见 1 的检查缺口。
- 没有测试“未接 `perform`/`confirm` 时不应请求授权”，现有测试反而断言授权次数为 1。

**未核实**：没有实际执行这些测试；“反向用例真的会失败”是按断言和代码路径推断的。

**Q4：改动产生或修改的每个值，使用它的地方都能接受吗？**

逐个核对如下：

- `perception_read`、`device_action` 两行：产生于 `production-tool-actions.ts`，使用于 `ToolActionRegistry.offer`、`preflight`、`#builtinRow`、`#builtinExecutor`、`#ownerScopeGate`。`assertRow` 会拒绝缺字段、读取却有后果、`owner_scope` 没能力名、设备专用列放错等情况；两行都能通过。`device_action` 的 `capabilityRef: "device.action"` 与描述符和调用时的 `capabilityRef` 一致，`OwnerScopeAuthorization` 第 142 行会核对它。**但** `device_action` 行的动作事实太粗，见意见 2。
- 来源名 `perception_read`：产生于 `PERCEPTION_EXTERNAL_ORIGIN` 和 `row.tool`，使用于 `ContextExternalContent.mark`、`originsOf`、`externalContentSourceRefs`、`OwnerScopeAuthorization`。长度 16，小于 256 的来源名上限；写入时按 `origin` 排序、去重，字节确定。没有运行时的来源名白名单，只有测试约束；目前没有和其他来源名冲突。
- 迁移项 `20261114160000_perception_extraction.sql`：迁移引擎按目录自动发现时间戳文件并排序（`loadBundledMigrations`），新文件在 `20261114151212_perception_records.sql` 之后，`perception_episodes` 已先创建；只创建 `perception_extractions`、`perception_command_utterances`，与 `sqlite-perception-operations.ts` 的列、状态值、长度校验一致；`schema-catalog.ts` 已登记两张表；`LEGACY_MIGRATION_COUNT` 仍是 95，旧 `0096` 引用已不存在。旧的 `perception_run_reads` 表、`markRunRead`/`runReadRecordIds`/`runInitiator`、`runReadMaximumRecords`、两条闸门提示词在全仓库已搜不到。
- 错误码 `DEVICE_ACTION_CONFIRMATION_REQUIRED`：产生于 `production-perception-tools.ts:70`，使用于同文件抛错和 `PerceptionToolError`；说明文字 `tools.result.device-action.unconfirmed` 在提示词清单里有登记。没有发现过窄的白名单会把它丢掉；模型结果走 `modelContent`。设计第 745 行已登记。
- 测试指纹 `EVERY_TOOL_DEFINITIONS_SHA256`：只出现在测试里，没有生产使用端。**未核实**它是否确实等于当前工具定义序列化后的值，也没有核实“main 上本来红”。

**对上一轮三条意见的结论：**

- **R3-1：已改好。** 设计第 745 行已登记 `DEVICE_ACTION_CONFIRMATION_REQUIRED` 和说明；原闸门错误码已随入口检查一起删除，仓库里搜不到引用。
- **R3-3：按作者设计改好了错误区分，但仍留有意见 3 的顺序问题。** 未接确认入口现在是 `DEVICE_ACTION_UNAVAILABLE`，返回 false 才是 `DEVICE_ACTION_CONFIRMATION_REQUIRED`；计划第 123 行也写明本批不接确认，等第 9 批。
- **R3-4：文档指向的测试已补，但覆盖仍不完整。** 设计第 739 行现在同时指 `test/integration/perception-tools.test.ts` 和 `production-runtime-tools.unit.test.ts`；但运行层“主人-only 记录不标记”和“真实工具 + 真实运行层拒绝”仍没有端到端用例，见 Q3。

**未核实的事项：**

- 没有运行任何测试或检查命令，所有“会/不会失败”都是读代码推断。
- `.agents/reviews/pr-451/round-3/` 在当前工作区不存在，上一轮原话只能以本次材料里的摘要为准。
- `prompt-manifest.json` 的 sha256 没有重新计算。
- 作者说法 6 中“main 上该用例本来就是红的”没有核实。
