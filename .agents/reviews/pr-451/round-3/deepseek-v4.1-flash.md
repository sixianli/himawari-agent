## 读代码证实的

### 低 1：新值清单没有登记新错误码，与本节自己写的 I-73 规则不一致
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:696`、`:739`
- 问题：本轮新出现了稳定的工具错误码 `DEVICE_ACTION_CONFIRMATION_REQUIRED` 和固定说明 id `tools.result.device-action.unconfirmed`，但“新值清单”只改了入口检查那一行，没有为这两个值各加一行“产生处 / 使用处 / 两端校验 / 自动检查”。
- 证据：
  - 文档要求：`每个新出现的值，都写明谁产生、谁使用、两端怎样校验、哪道检查守着（事故 I-73 的教训：一个值只在一端认）。`（`:696`）
  - 新错误码产生处：`export const DEVICE_ACTION_UNCONFIRMED_CODE = "DEVICE_ACTION_CONFIRMATION_REQUIRED";`（`apps/agent-service/src/production-perception-tools.ts:73`）
  - 新错误码使用处：`throw new PerceptionToolError(DEVICE_ACTION_UNCONFIRMED_CODE, TOOL_RESULT_DEVICE_ACTION_UNCONFIRMED.text)`（同文件 `:524-528`），以及 `production-runtime-tools.ts:636-638` 把它放进 `modelContent`
  - 新说明 id：`id: "tools.result.device-action.unconfirmed"`（`packages/prompt-catalog/src/perception.ts:295`）
- 建议：在表格中补充错误码一行，写明产生处、使用处（工具错误 → `RuntimeToolExecutionResult.errorCode`/`modelContent`）、两端可接受性（`machineString` 允许该字符串；见下）、自动检查（`test/integration/perception-tools.test.ts` 与 `apps/agent-service/test/production-runtime-tools.unit.test.ts`）。

### 低 2：生产装配没有接 `perform`/`confirm`，新分支目前在生产不可达
- 文件：`apps/agent-service/src/service-main.ts:1515-1536`；`apps/agent-service/src/production-perception-tools.ts:513-528`
- 问题：生产构造 `ProductionPerceptionTools` 时既没有 `perform` 也没有 `confirm`。因为 `perform` 的判断在确认判断之前，生产里任何非 `describe` 的设备动作仍会先返回 `DEVICE_ACTION_UNAVAILABLE`，不会走到新的“未确认”错误码。作者说“没有接下发时仍是 `DEVICE_ACTION_UNAVAILABLE`”与代码一致，但这意味着本轮新错误码/新说明只在测试自行接线的场景生效。
- 证据：
  - `if (!this.#options.perform) throw new PerceptionToolError("DEVICE_ACTION_UNAVAILABLE", ...)`（`:513-517`）
  - 生产装配只有 `scope`、`store`、`devices`、`readText`、`configuration`、`gate`、`now`、`timeZone`（`service-main.ts:1515-1536`），没有 `perform`/`confirm`
- 建议：如果本轮目标只是预留错误码，在 PR 说明里明确“生产尚未接下发”；如果目标包含线上行为，需要补上 `perform`/`confirm` 装配，并加一条生产装配级测试。

### 低 3：`confirm` 根本没接与 `confirm` 返回 false 被合并成同一个“主人没确认”
- 文件：`apps/agent-service/src/production-perception-tools.ts:524-528`；`test/integration/perception-tools.test.ts:427-443`
- 问题：`(await this.#options.confirm?.(request)) !== true` 把“没有 `confirm` 处理器”和“处理器明确返回 false”都当成 `DEVICE_ACTION_CONFIRMATION_REQUIRED`。测试也把 `confirm === undefined` 和 `confirm: false` 放在同一个循环里期望同一错误码。当前生产没有 `perform`，所以暂时走不到；但将来如果只接了 `perform` 而漏接 `confirm`，模型会对主人说“这次没有拿到主人的确认”，而系统实际上从未发起过确认请求。
- 证据：
  - `if (definition.confirm && (await this.#options.confirm?.(request)) !== true)`（`:524`）
  - 测试：`for (const confirm of [undefined, false] as const)` 全部期望 `DEVICE_ACTION_UNCONFIRMED_CODE`（`perception-tools.test.ts:427-443`）
- 建议：区分“确认通道未接线”（更接近 `DEVICE_ACTION_UNAVAILABLE` 或单独配置错误）和“主人拒绝/未确认”，至少不要让说明暗示已经询问过主人。

### 低 4：文档给出的自动检查覆盖不全
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:739`
- 问题：这一行的“自动检查”只写了 `test/integration/perception-tools.test.ts`，但代码里的四种 effect 中，`reminder_cancel` 和 `rule_change`（`rule.set`/`rule.undo`）的入口覆盖实际在 `apps/agent-service/test/production-runtime-tools.unit.test.ts:1596-1622`。只按文档去找，会误以为四种动作都已被该集成测试覆盖。
- 证据：
  - 代码 effects：`ORIGIN_GATED_EFFECTS = ["reminder_create", "reminder_cancel", "rule_change", "device_action"]`（`packages/application/src/services/perception-origin-gate.ts:15-20`）
  - 现有覆盖：`for (const capabilityRef of ["reminder.cancel", "rule.set", "rule.undo"])`（`production-runtime-tools.unit.test.ts:1596-1604`），以及 `gate.mock.calls` 的 effect 断言（`:1616-1622`）
- 建议：文档同时引用这两个测试文件，或改成指出每个 effect 的覆盖位置。

## 推测 / 未核实

- **未核实：新 `prompt-manifest.json` 的 `sha256` 是否与当前文字一致。** 本环境不能执行脚本，无法按 `prompt-catalog.unit.test.ts` 的 `digest(entry)` 算法重新计算 `e05f02c1...`。如果清单没随之更新，`npm run check:prompt-catalog` 会报 `PROMPT_MANIFEST_STALE`；需要实际跑一次该检查确认。
- **未核实：完整 `npm run check` 是否通过。** 我只做了静态核对，不能运行 vitest/typecheck。上述测试的失败条件是按代码推断的。
- **推测：生产没有接 `perform`/`confirm` 是否有意为之。** 从 `service-main.ts` 看确实是没接，但是否属于本 PR 之外的后续接线，无法从代码判断。

## 侧重检查

- **错误路径**：`perform` 不存在 → `DEVICE_ACTION_UNAVAILABLE`；`confirm` 不存在或返回 false → 新错误码；两条都在 `perform` 之前，失败时没有执行设备动作，fail-closed 正确。导入侧校验在 `dryRun` 返回前抛出，正式导入也在事务写入前抛出，未发现绕过。
- **不合规范/不可信输入**：导入的出处分两步校验，`isKnownMemorySourceType` 只认注册类型，`PERCEPTION_MEMORY_SOURCE_ID` 是锚定的 `^...$` 正则且无 `g`/`y`，没有状态性 `lastIndex` 问题，也不会灾难性回溯；`commandUtteranceBatches` 对任意字符串去重并做稳定的默认排序。
- **安全**：新错误码 `DEVICE_ACTION_CONFIRMATION_REQUIRED` 满足 `machineString` 的 `^[A-Za-z0-9][A-Za-z0-9._:-]*$` 和 128 字符上限（`packages/gateway-contracts/src/validation.ts:49-57`）；新说明文字不含数字、密钥或验证码式片段，加入 `TRUSTED_PROMPT_TEXTS` 不会改变旧历史的遮法。
- **资源耗尽**：`commandUtteranceBatches` 现在一次性物化全部批次，比原先逐批 `slice` 多保留一份 O(n) 的批次数组；考虑到调用方 `records` 受抽取分块限制，影响很小，未作为独立问题列出。查询每批仍不超过 1000。
- **不可撤销操作**：确认判断在 `#options.perform` 之前，失败不会执行设备动作；导入校验在 `database.transaction` 之前，坏出处不会留下部分写入。
- **规则/文档与代码一致**：文档改后的“四种动作”与 `ORIGIN_GATED_EFFECTS` 及三个调用点（`rule_change`、`reminder_create/cancel`、`device_action`）一致；不一致点主要是新错误码没进新值清单、文档自动检查列覆盖不全，已列在上面。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。新增文字是 `layer: "tool-result"` 的固定说明，只在设备动作失败时作为工具结果追加到本轮末尾；工具定义仍来自 `perceptionToolDescriptors()`（`production-perception-tools.ts:100-145`），系统提示未变。导入校验和分批函数都不进入发给模型的内容。每轮变化的错误码/说明也只出现在最后一条工具结果消息里，符合“只在末尾追加”。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会由本轮改动引入。新说明和新错误码都是常量；`commandUtteranceBatches` 先 `new Set` 去重再默认 `sort`，与改动前一致，输出确定；导入校验不参与模型内容。唯一理论上的影响是新固定文字进入 `TRUSTED_PROMPT_TEXTS`，但该文字是全新且不含数字/秘密样式，旧历史不会因此改变遮法。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：
   - `test/integration/data-export.test.ts:689-697` 在同一个 `[P1-6]` 测试里断言 `dryRun: true` 也拒绝坏出处。`check:data-export` 会跑 `[P1-6]` 标签；若把校验移回 `dryRun` 返回之后，这条会失败。
   - `test/integration/perception-tools.test.ts:433-444` 断言新错误码和说明；若改回 `DEVICE_ACTION_UNAVAILABLE` 会失败；`:494-501` 仍覆盖没有 `perform` 时的 `DEVICE_ACTION_UNAVAILABLE`。
   - `packages/application/test/perception-extraction.unit.test.ts:280-290` 反向输入是逆序 + 重复，若去掉去重/排序，`batches.flat()` 就不等于 `ids`。
   - `test/integration/perception-extraction.test.ts:643-644` 比较两份正则的 `source`/`flags`，分叉会失败；`:645-674` 覆盖删除记录不能当新出处、已记过的出处更新不再查。
   - 清单由 `check:prompt-catalog` 的 `manifestProblems` 检查；但新 `sha256` 我无法在本环境重算，未核实。
   - 注意：新增的 `[iOS-5]` 集成测试和分批单元测试不在 `check:steps` 的具名门槛里，靠通用集成/单元测试运行；`check:data-export` 和 `check:prompt-catalog` 只覆盖其中一部分。

4. **每个新值的使用处都能接受吗？**
   - `DEVICE_ACTION_CONFIRMATION_REQUIRED`：产生于 `production-perception-tools.ts:73/526`，经 `PerceptionToolError` 进入 `production-runtime-tools.ts:636-638` 的 `errorCode`/`modelContent`；类型只是 `string`，`machineString` 也接受，未发现拒绝它的校验。测试在 `perception-tools.test.ts:441` 使用。
   - `tools.result.device-action.unconfirmed`：在 `perception.ts:294-301` 定义，`prompt-manifest.json:1039` 登记，`index.ts`/`services` 的 `export *` 自动导出；`trustedPromptTexts` 会自动收入；它是 `free-text`，不需要 parser。清单哈希未核实。
   - `COMMAND_UTTERANCE_BATCH` / `commandUtteranceBatches`：产生于 `perception-extraction.ts:345-353`，经 `services/index.ts:104` 导出，调用处只有 `perception-extraction.ts:543` 和单元测试，未发现其他需要同步的清单或校验。
   - 文档中的“四种动作”值：与 `ORIGIN_GATED_EFFECTS` 和三个调用点一致；缺的是新错误码/新说明在新值清单中的登记，以及自动检查列的补全，已在上文列出。
