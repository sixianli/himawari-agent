## 侧重检查

- **不可信输入 / 数据导入**：检查了 `data-export/import.ts` 的出处类型、编号校验和事务边界。类型与 perception 编号校验确实在写库循环里执行，抛错后由外层 `database.transaction` 回滚（`import.ts:334` 起），正式导入不会留下半条记忆；但 **dry-run 在进入写库事务前就返回**，见下方发现。
- **记忆出处伪造**：检查了保存路径的 `recordedSource` / `perceptionRecord` 查询。确实要求同一 `owner_id`、`agent_id` 且 `status='active'`；已记录的出处跳过检查，和作者说法一致。未发现可通过 `sourceTypes` 缺省绕过 perception 检查后仍被当作 perception 使用的路径。
- **设备动作确认**：`definition.confirm` 为真且没有确认入口或返回非 `true` 时，`perform` 不会执行，失败关闭；但错误文案把“未确认/被拒”说成“设备动作暂时用不了”，见下方发现。生产 `service-main.ts:1515` 本来就没接 `actions`/`perform`/`confirm`，符合计划“这一批不接设备动作”。
- **资源耗尽**：`perception_read` 新增扫描上限，`scanLimit` 最大为 `SCAN_PAGE=500`，满足 `listRecordsBetween` 的 1..500 限制；循环在 `examined >= readMaximumScanned` 时退出，正常不会传入 0 或负数。每页仍重复做一次 `COUNT(*)`，但这是原有实现，本次扫描上限反而限制了最坏扫描量。
- **不可逆操作**：导入写入在事务内；确认检查在 `perform` 之前；入口检查在确认之前。未发现新增的不可逆副作用。
- **文档与规则**：计划文档确实写明了“四种动作”的范围，代码 `ORIGIN_GATED_EFFECTS` 也正好四种；但详细设计的新值清单仍写着“所有有后果的工具入口”，见下方低严重度发现。提示词前缀/遮盖方面，旧文案和新文案都不含数字或敏感标记，没看到会改变旧对话已发字节的实质风险；manifest 的 sha256 未用允许的命令独立复算，标“未核实”。
- **基线提交**：`decision-ledger.ts` 的 `"told"` 和 `0095` 迁移里的 `'told'` 来自基线 `9398293db`，不在修改提交 `e327a0472` 内；仓库里暂未找到 `"told"` 的生产者，我未把它计入本 PR 的问题。

## 发现

### 中：dry-run 导入不执行新增的记忆出处校验

- 文件：`packages/persistence-sqlite/src/data-export/import.ts:323`、`packages/persistence-sqlite/src/data-export/import.ts:452-461`
- 问题：新增的“出处类型已登记、perception 编号格式正确”校验只在写库循环里执行。`dryRun` 在进入该循环前已经返回成功报告。
- 证据：
  ```ts
  // 323
  if (options.dryRun === true) return report(true);
  ...
  // 452-461
  for (const source of item.provenance) {
    if (
      !isKnownMemorySourceType(source.sourceType) ||
      (source.sourceType === "perception" &&
        !PERCEPTION_MEMORY_SOURCE_ID.test(source.sourceId))
    )
      throw new DataExportError(
        DATA_EXPORT_ERROR_CODES.LINE_INVALID,
        "记忆出处的类型或编号不合规",
      );
  ```
- 影响：`admin-cli` 的 `data import --dry-run` 会宣称校验通过，紧接着正式导入却在同一份文件上失败。现有 dry-run 用例只用了合法 fixture，没有覆盖新增的反向输入。
- 建议：把出处校验抽成写库前的纯校验步骤，在 `report(true)` 之前执行；同时增加一条“dry-run 也拒绝未知出处类型/坏 perception 编号”的用例。

### 低：需要确认的设备动作被说成“设备动作不可用”

- 文件：`apps/agent-service/src/production-perception-tools.ts:522-526`、`packages/prompt-catalog/src/perception.ts:300`
- 问题：确认入口缺失或返回 `false` 时，代码抛 `DEVICE_ACTION_UNAVAILABLE`，模型收到的是“设备动作暂时用不了”。这和计划里的“一律不执行并如实说明”不完全一致，也把“主人没确认/确认入口未接”混成了“设备坏了”。
- 证据：
  ```ts
  // production-perception-tools.ts:522-526
  if (definition.confirm && (await this.#options.confirm?.(request)) !== true)
    throw new PerceptionToolError(
      "DEVICE_ACTION_UNAVAILABLE",
      TOOL_RESULT_DEVICE_ACTION_UNAVAILABLE.text,
    );
  ```
  ```ts
  // prompt-catalog/src/perception.ts:300
  text: "设备动作暂时用不了，什么都没有做。照实告诉主人。"
  ```
- 影响：动作不会执行，安全上没问题；但模型可能告诉主人“设备暂时不可用”，而不是“这个动作需要确认，目前没有确认入口”。现有的 `TOOL_RESULT_DEVICE_ACTION_WAITING_OWNER` 也不能直接复用，因为它的文案说“确认卡已经发给主人”，在未接入口时是假的。
- 建议：给“需要确认但没有确认入口”增加独立的错误码和固定文案；如果将来确认返回 `false` 表示主人拒绝，也应有独立说明，而不是和设备故障共用一条。

### 低：新增检查的反向用例只覆盖了“记录完全不存在”

- 文件：`test/integration/perception-extraction.test.ts:641-644`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:904-909`
- 问题：实现同时校验 `status='active'`、`owner_id`、`agent_id`，但新增测试只有一个格式合法、数据库里完全不存在的 ghost 编号。取消 `status='active'` 条件，或把 owner/agent 条件改错，这条测试仍然会通过。
- 证据：
  ```ts
  const ghost = `perception:${"0".repeat(32)}`;
  await expect(
    copy("ghost", { sourceRefs: [ghost], sourceTypes: { [ghost]: "perception" } }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  ```
  ```ts
  // sqlite-memory-operations.ts:904-909
  if (
    sourceType === "perception" &&
    !recordedSource.get(input.memory.id, sourceType, sourceRef) &&
    !perceptionRecord.get(sourceRef, input.memory.ownerId, input.memory.agentId)
  )
    this.fail("PORT_INVALID_OPERATION", "Perception memory source does not exist");
  ```
- 建议：增加三条反向用例：感知记录存在但已删除；属于另一个 owner；属于另一个 agent。这样才能固定住“同一主人、同一 Agent、active”三个条件。

### 低：口头指令分批查询没有自动检查

- 文件：`packages/application/src/services/perception-extraction.ts:534-541`
- 问题：新增的 1000 个一批查询逻辑没有对应用例。现有 `commandUtterances` 相关测试只用了两个编号（`test/integration/device-api.test.ts:685-689`）。把批处理改回原来一次传全部（超过存储层 5000 上限会失败）时，现有测试不会失败。
- 证据：
  ```ts
  const distinct = [...new Set(utterances)].sort();
  const commands = new Set<string>();
  for (let start = 0; start < distinct.length; start += COMMAND_UTTERANCE_BATCH)
    for (const id of await store.commandUtterances({
      ...scope,
      utteranceIds: distinct.slice(start, start + COMMAND_UTTERANCE_BATCH),
    }))
      commands.add(id);
  ```
- 建议：增加一个纯单元测试，用超过存储层上限的 distinct 编号数量（或 spy 存储层每次收到的数组长度不超过 1000），验证分批且合并结果正确。

### 低：详细设计仍说入口检查覆盖“所有有后果的工具入口”

- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:739`
- 问题：计划文档已写明这一批只接四种动作（`docs/execution/plans/2026-11-11-apple-device-body-plan.md:102`），代码 `ORIGIN_GATED_EFFECTS` 也确实只有这四种；但详细设计的新值清单仍写“使用处：所有有后果的工具入口”。
- 证据：
  ```md
  | “这一轮读过‘其他’内容”的标记 | `perception_read` 执行端 | 所有有后果的工具入口 | 入口处统一检查 | ...
  ```
  计划文档则写：
  ```md
  - 入口检查这一批只管四种动作：建提醒、取消提醒、改规则、非读取的设备动作。
  ```
- 建议：把详细设计这一行改成“本批四种动作（建提醒、取消提醒、改规则、非读取设备动作）”，或明确注明其余入口由权限审批方案后续接替，避免读者按详细设计误以为写文件、跑命令也已被入口检查覆盖。

### 低（推测）：persistence 侧重复维护 perception 编号正则

- 文件：`packages/persistence-sqlite/src/memory-source-types.ts:9`、`packages/application/src/ports/perception.ts:37`
- 问题：两处正则目前完全一致，但 persistence 只能从 application 做类型导入，无法共享这个运行时值；以后编号格式若只改 application，`sqlite-memory-operations.ts` 和 `data-export/import.ts` 会静默拒绝合法的新编号。类型层面只能用 `Record<MemorySourceType, true>` 守住出处类型集合，守不住正则。
- 证据：
  ```ts
  // memory-source-types.ts:9
  export const PERCEPTION_MEMORY_SOURCE_ID = /^perception:[A-Za-z0-9_-]{16,64}$/u;
  ```
  ```ts
  // application/src/ports/perception.ts:37
  export const PERCEPTION_RECORD_ID_PATTERN = /^perception:[A-Za-z0-9_-]{16,64}$/u;
  ```
- 建议：增加一条契约测试，直接比较两处正则的 `source`/`flags`，或把编号格式放到允许共享的更低层包。当前代码两端一致，所以只是可维护性风险，不是现存缺陷。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

读代码未发现会改变已见前缀的改动。

- 工具定义没有变：`device_action`、`perception_read` 的 descriptor 文字和参数结构未改；新行为只影响工具结果。
- 系统提示没有变；新配置 `readMaximumScanned` 不进入提示词。
- 新行为都只追加在末尾：扫描上限和 `unexamined/remaining/hidden` 只出现在本次 `perception_read` 的工具结果里；确认失败也只生成一次工具错误结果；后台 deferred 文案只在本次工具结果中生成。
- 历史消息按实际发送内容保存，修改固定提示词文字不会改写旧历史里的字节。唯一需要留意的是 `.claude/rules/prompt-prefix.md` 第 11 条：固定文字清单变化会让旧对话里的旧固定文字不再享受“固定文字不遮盖”的豁免。我对照了旧文案和新文案，二者都不含数字或可触发敏感值点名的片段，未看到实际会改变旧对话遮盖字节的内容；manifest 的 sha256 未独立复算。
- 每轮会变的 `unexamined`、`remaining`、`hidden`、记录列表都在最后追加的工具结果中；记录顺序由 SQL `ORDER BY occurred_at_ms, id` 固定。

结论：仍是只在末尾追加，未发现每轮变化值被放进系统提示或工具定义。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

未发现新增的不确定字节来源。

- `toLocaleLowerCase()` 改为 `toLowerCase()` 反而降低了服务器语言环境的影响，使筛选结果更确定（`production-perception-tools.ts:314,347`）。
- 口头指令分批查询前先 `[...new Set(...)].sort()`，每批只用于集合成员判断，最终 `Set` 内容与批次顺序无关（`perception-extraction.ts:534-541`）。
- `readMaximumScanned` 的说明数字来自数据库计数和本次扫描进度，不含时间字段；模型只看到追加的工具结果。
- 导入时把 perception 出处标成 `source_deleted=1` 是确定值，不依赖遍历顺序。
- 没有新增无序集合、当前时间、随机值或依赖后续消息的遮盖。

唯一残留的并发问题是：扫描过程中数据库记录数变化可能让 `total - examined` 变化，但这是现有分页/计数方式的并发特性，不是同一段文字因上下文遮成不同字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有覆盖的部分：

- **出处存在性**：`perception-extraction.test.ts:641` 的 ghost 用例会失败于“完全去掉存在性检查”的实现。基于代码逻辑，这条反向用例是有效的。
- **waiting_budget 不加 attempts**：`perception-extraction.test.ts:498-511` 的用例在恢复旧公式后，三天等待会累加 attempts，最终断言 `attempts: 1` 会失败；作者说实际回退验证过，代码逻辑也能解释。
- **导入类型/编号校验**：`data-export.test.ts:660-697` 会失败于去掉新增校验的实现；perception 出处标 `source_deleted=1` 也有断言。
- **设备动作确认**：`perception-tools.test.ts:421-450` 覆盖了没有确认入口和返回 `false` 两种情况，去掉检查后 `performed` 会变成 1 条，用例失败。
- **扫描上限**：`perception-tools.test.ts:257-273` 在去掉上限后会读到第 4 条并返回 1 条记录，和期望的 `records: []` 冲突。
- **新配置键**：`startup-configuration.unit.test.ts:1450-1457` 自动遍历 `PERCEPTION_CONFIGURATION_DEFAULTS` 的所有键，覆盖默认值和上下界。
- **提示词文字**：`check:prompt-catalog`/manifest 是现成门槛；但本轮没有在允许的工具里复算 sha256，标“未核实”。

没有覆盖或不充分的部分：

- **dry-run 导入**：没有反向用例；当前实现下，带坏出处的文件在 dry-run 会通过，正式导入才失败。
- **口头指令分批**：没有任何超过 5000 个 distinct 编号的测试，回退分批实现不会失败。
- **语言环境**：`toLocaleLowerCase` → `toLowerCase` 没有专门用例，回退也不一定会被现有测试发现。
- **出处检查的细条件**：只测了“记录不存在”，没有测“记录已删除”“另一个 owner”“另一个 agent”。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **`readMaximumScanned`**：产生处是 `PERCEPTION_CONFIGURATION_DEFAULTS` 和 `parsePerception`；使用处只有 `production-perception-tools.ts`。解析端按所有默认键生成，范围 `[500, 200000]`，启动配置测试自动覆盖上下界；工具端传入 `listRecordsBetween` 的 limit 始终是 `min(500, 剩余数)`，满足存储层 1..500 校验。注意工具测试用了 `readMaximumScanned: 3`，低于声明范围；这只是测试直接构造配置，不影响生产解析，但若想验证合法范围，建议再补一条 500/默认值的用例。
- **`PERCEPTION_MEMORY_SOURCE_ID` / `KNOWN_MEMORY_SOURCE_TYPES`**：产生处是 `memory-source-types.ts`；使用处是 `sqlite-memory-operations.ts` 和 `data-export/import.ts`。编号正则与 application 的 `PERCEPTION_RECORD_ID_PATTERN` 和 platform 的设备入库校验一致；类型集合有 `Record<MemorySourceType, true>` 编译期约束。约束“persistence-sqlite 只能从 application 做类型导入”也满足：新文件只有 `import type`。
- **导入的 `source_deleted=1`**：SQLite 列约束接受 0/1，导出/快照/删除流程都按 0/1 读取；正式导入在事务内，失败会回滚。dry-run 不写库，这与“只读预览”一致，但也因此跳过了新增校验（见发现）。
- **`attempts` 的 waiting_budget 分支**：产生处 `beginExtraction`；使用处 `listEpisodesToExtract` 已明确 `x.status = 'waiting_budget'` 时不受最大次数限制，`settle` 的 `exhausted` 仍按累加后的 attempts 判断，两者与新算法一致。
- **`confirm` 布尔值**：产生处是动作登记表；`describe` 结果和 `#action` 共用同一个 `definition.confirm`。生产当前没接动作登记表/`perform`/`confirm`，所以确认路径只在测试和后续批次生效。
- **prompt manifest 条目**：键 `tools.result.origin-gate.deferred` 与固定提示的 id 一致，`changedIn` 仍保留 ADR 0230；sha256 需要由 `check:prompt-catalog` 验证，本次未独立复算。
- **`"told"`**：来自基线提交，不在 `e327a0472`；`DECISION_OUTCOMES.proposal` 和 `0095` 的 CHECK 已接受它，但当前仓库没有写入它的调用点。按作者说明，基线提交不属于本 PR，因此不作为本 PR 的缺陷。
