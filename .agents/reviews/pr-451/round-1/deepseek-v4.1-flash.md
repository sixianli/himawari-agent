## 读代码证实的发现（按严重度从高到低）

### 1. 中高：来历入口检查只覆盖提醒/规则/设备动作，其他有后果的工具完全不经过它
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:659-663,712-718,1190-1205`
- 问题：`#originGate` 只在 `#ownerRule`、`#reminder` 和 `ProductionPerceptionTools.#action` 里被调用。`bash`、`write`、`edit`、`save_copy`、`execution.task.start`、受管任务等走到 `#executeCanonical`，没有经过来历检查。设计文档的 I-73 表写的是“所有有后果的工具入口 / 入口处统一检查”，代码只覆盖了作者说法里列出的四种效果。
- 证据：
  ```ts
  if (this.#isPerception(invocation)) return this.#perception(invocation);
  if (this.#background && this.#codingTool(invocation) === "bash") { ... }
  return this.#executeCanonical(invocation, signal);
  ```
  以及 `production-perception-tools.ts:498-502` 只在 `!definition.reads` 时调用 gate。
- 建议：在统一的工具执行入口按“有副作用”统一判断并调用同样检查（至少 `bash`、`write`、`edit`、`save_copy`、任务启动），或在规格里明确把检查范围收窄。条件：仅在启用 coding/文件工具的运行里可复现；如果这些工具在生产里有开，这会是一条真实绕过路径。

### 2. 中：`perception` 类型出处没有检查“记录是否存在”，与作者说法第 5 条和计划不符
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:892-898`
- 问题：写入记忆出处时只校验了 `source_type` 是否登记、`perception` 类型的编号正则，没有查询 `perception_records` 是否存在。作者说法和计划任务第 3 条都写“指向不存在的出处，写入时拒绝”。
- 证据：
  ```ts
  if (!Object.hasOwn(KNOWN_SOURCE_TYPES, sourceType))
    this.fail("PORT_INVALID_OPERATION", "Memory source type is not registered");
  if (sourceType === "perception" && !PERCEPTION_SOURCE_ID.test(sourceRef))
    this.fail("PORT_INVALID_OPERATION", "Perception memory source id is invalid");
  insertSource.run(input.memory.id, sourceType, sourceRef);
  ```
  测试也只覆盖了格式错误、未知类型和不属于 `sourceRefs` 的类型，没有覆盖“格式正确但不存在的记录”：`test/integration/perception-extraction.test.ts:584-601` 用的是 `not-a-record`。
- 建议：在 `save` 的同一事务里按 owner/agent 查询该感知记录是否存在且为 active；补一条反向用例。若本批有意不做，应改说法和计划，不要保留“写入时拒绝”的承诺。

### 3. 中：重抽/重试会把同一条提议重复交给提议入口（作者说法第 3 条后半不成立）
- 文件:行：`packages/application/src/services/perception-extraction.ts:647`
- 问题：记忆有去重（`if (await this.#options.memories.read(memoryId)) return;`，第 754 行），提议没有。记录条数变化重抽、预算重试、或同一批里模型重复给出同一 `quote + recordIds` 时，每次都会再次调用 `proposals.receive`，传入相同 `proposal:${key}`。作者说法“同一条提议不会因为重抽而重复写入”在代码里没有对应实现，也没有重抽测试。
- 证据：
  ```ts
  if (verified.length > 0) await this.#options.proposals?.receive(verified);
  ```
  `#proposal`/`#doneHint` 只计算了 key，没有读取已有提议或按 id 去重。
- 建议：在入口侧按 `proposal.id` 做幂等（或先查已有提议再投递），并补“记录条数变化后重抽”和“预算重试”的集成测试。当前生产没有入口，影响暂时有限；一旦接上入口就会显形。

### 4. 中：生产里后台被拦下的“想做的事”其实被丢弃，账本里也恢复不出来
- 文件:行：`apps/agent-service/src/service-main.ts:1528-1533`、`packages/application/src/services/perception-origin-gate.ts:87-118`
- 问题：gate 只在存在 `proposals` 端口时才把动作交出去；生产构造 gate 时没有传入 `proposals`，而账本写入只有 `subjectRef: runId`、空的 `memoryIds/ruleIds`、`contentRef: null`，没有 `capabilityRef`/`arguments`。因此作者说法第 1 条的“写一条 proposal 决策记录并把想做的事交给提议入口”在生产里只完成了前半句，动作本身不可恢复。
- 证据：
  ```ts
  await this.#options.ledger.append({
    ...
    subjectRef: runId,
    inputs: { memoryIds: [], ruleIds: [] },
    ...
  });
  await this.#options.proposals?.receive([... action: { capabilityRef, arguments } ...]);
  ```
  `service-main.ts` 的 gate 只传 `scope/store/ledger/now`。
- 建议：至少在账本 `inputs`/`contentRef` 里保存动作名和参数（或先建待处理表），再接后台入口；“没有入口”不应等于“悄悄丢掉”。

### 5. 中低：等待预算的日子会消耗重试次数，长期卡预算后一次普通模型错误就直接判 failed
- 文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1137`、`packages/application/src/services/perception-extraction.ts:660`
- 问题：`beginExtraction` 每次进入都把 `attempts` 加一，包括 `waiting_budget` 的次日重入；而失败时用 `begun.attempts >= extractMaximumAttempts` 判断是否放弃。连续多天预算不足后，`attempts` 已到上限，某天恢复预算后第一次模型错误就会直接 `failed`。这与“第二天补”的预期矛盾。
- 证据：
  ```ts
  attempts: fresh ? 1 : (current?.attempts ?? 0) + 1,
  ```
  ```ts
  const exhausted = begun.attempts >= configuration.extractMaximumAttempts;
  ```
  `listEpisodesToExtract` 特意让 `waiting_budget` 不受 attempts 限制（`sqlite-perception-operations.ts:1080-1083`），说明这里应该区分“预算等待”和“失败重试”。
- 建议：`waiting_budget` 重入不增加 attempts，或单独记录预算等待次数；补“卡预算数天后模型报错”的测试。

### 6. 低：`device_action` 的 `confirm` 标记只展示、不执行，和固定工具文字“会先请主人确认”不一致
- 文件:行：`apps/agent-service/src/production-perception-tools.ts:466-468,498-513`
- 问题：`describe` 把 `confirm` 返回给模型，固定工具描述也写了删除、对外发送、花钱、门锁动作会先请主人确认；但执行路径只检查 `!definition.reads`，完全没有使用 `definition.confirm`，拿到 `perform` 后直接执行。当前生产没有接 `perform`，所以现在不会真的执行；第 9 批接上下发时会变成“承诺确认但没有确认”。
- 证据：
  ```ts
  .map(({ name, confirm, parameters: shape }) => ({ name, confirm, parameters: shape })),
  ...
  if (!definition.reads) { const decision = await this.gate(invocation, "device_action"); ... }
  ...
  const outcome = await this.#options.perform({ invocation, device: target, action: definition, ... });
  ```
- 建议：对 `confirm: true` 的动作在服务端强制走审批/确认，或者在本批把工具文字改成不承诺确认。

### 7. 低：数据导入路径不校验 `memory_provenance.source_type`，可以重新引入未登记类型和指向不存在感知记录的出处
- 文件:行：`packages/persistence-sqlite/src/data-export/import.ts:451-452`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:518-525`
- 问题：导出 schema 对 `sourceType` 只要求 `text(1,512)`，导入直接 `INSERT`；读取时把任何非 `reference` 的类型都当成 `MemorySourceType` 放进 `sourceTypes`。这与“只认登记过的类型”的承诺不一致；导入的感知出处还会指向未恢复的感知记录（测试明确导入不恢复感知数据）。
- 证据：
  ```ts
  for (const source of item.provenance)
    provenance.run(item.id, source.sourceType, source.sourceId, source.sourceDeleted ? 1 : 0);
  ```
  ```ts
  const typed = rows.filter(({ type }) => type !== "reference");
  ... type as MemorySourceType ...
  ```
- 建议：导入时按写路径同样的规则校验/拒绝，或把未知类型归一为 `reference`；对感知出处检查目标记录是否存在，或在导入时把 `source_deleted` 置真。

### 8. 低（边界情况，部分推测）：超大经历会让 `commandUtterances` 超过 5000 上限，整段抽取失败
- 文件:行：`packages/application/src/services/perception-extraction.ts:529-534`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1203`
- 问题：`#sources` 把一段经历里的所有 `utteranceId` 一次性交给 `commandUtterances`，而后者用 `this.ids(..., 5000)`，超过 5000 个会 `PORT_INVALID_OPERATION`。这会使该段进入重试并最终 `failed`。是否现实取决于单段经历的时长和每日记录上限，我没有看到对单段记录数的硬约束。
- 建议：分批查询或超过上限时降级为“不做口头指令过滤”，并补大段经历用例。

### 9. 低（推测）：`perception_read` 在无 query 时即使已满额也会扫完整个时间范围；抽取则把整段记录和全文一次读入内存
- 文件:行：`apps/agent-service/src/production-perception-tools.ts:366-381`、`packages/application/src/services/perception-extraction.ts:515-542`
- 问题：`perception_read` 一旦 `full=true` 且 `needle===null`，仍会继续翻完所有页来统计剩余条数；范围上限默认 31 天、可到 366 天，记录每天上限 2 万。抽取侧 `records.push(...)` 收集整段所有记录，再逐条读取/解密全文，然后才分块。对超大范围/超大经历存在 CPU、数据库和内存放大风险。是否构成实际资源耗尽取决于单段规模和并发，未实测。
- 建议：为扫描设置页数/记录数硬上限，剩余条数用 SQL 统计；抽取分页读取后分批处理，避免整段驻留内存。

## 推测/未核实（明确不是从代码直接证实的缺陷）

- **生产未注入 `ownerVoiceQualified`**：`apps/agent-service/src/production-http-composition.ts:1186-1206` 构造 `PerceptionService` 时没有传该选项；`packages/platform-node/src/perception-service.ts:425` 默认 `false`；`resolvePerceptionOrigin` 因此把所有记录都定为 `other`。这意味着作者说法第 2 条里的 `owner` 信任提议、以及“直接存成正式记忆”的路径在生产当前配置下不会发生，入口检查也会对主人自己说的话生效。规格里写了“达标前所有听到的话都是 other”，所以可能是本批有意为之，但需要确认这是预期状态。
- **作者说法第 2 条“引用必须在遮盖后或原文里逐字出现”与代码不一致**：`perception-extraction.ts:327-334` 要求 `source.masked.includes(quote)` **且** `source.text.includes(quote)`，是“并且”不是“或”。这更严格，通常更安全，但与说法文字不一致。
- **测试位置和规格不一致**：设计文档验收表写 `test/integration/perception-origin-gate.test.ts`，实际用例在 `test/integration/perception-tools.test.ts`；只是命名/文档对不上，不是行为缺陷。
- **`perception-source-prompts.ts` 的五个来源检查和看图函数在生产没有调用点**：只有单元测试和提示词清单使用它们。若本批只是登记提示词，这是预期的；若期望“来源检查”已上线，则没有接。

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致）

- **不可信外部内容 → 有后果动作**：`perception_read` 只对 `origin === "other"` 的记录写 `perception_run_reads`（`production-perception-tools.ts:403-410`），gate 再按 run 标记拦截；这条主路径逻辑成立，且集成测试真正会让“去掉检查后拒绝调用变成功”。但覆盖面不足，见发现 1。
- **出口遮盖**：`perception_read` 的文本不在工具内直接遮盖，而是依赖 `ModelEgress` 对 `role: "tool"` 的请求体重新遮盖（`model-egress.ts:329-331,467-483`）；抽取侧自己调用 `redactForEgress`（`perception-extraction.ts:134`）并已登记进 `scripts/check-egress-redaction.mjs` 的允许列表。两条路径都存在，没有发现明文直出。
- **口头指令抑制**：`/messages` 在 `threadGateway.request` 成功之后才 `recordCommandUtterance`（`device-api-routes.ts:853-858`）。如果这一步抛错，命令已被接受却返回失败；重试因 `messageId` 幂等不会重复执行，但该语音记录可能没被抑制。未发现越权或数据破坏，只是错误路径不够干净。
- **输入校验**：`perception_read` 的 from/to、天数、kinds、query、detail 都有边界；`localInstant` 在极端时区/DST 情况下可能返回 `NaN`，最终表现为 `PERCEPTION_READ_UNAVAILABLE` 而不是“参数不对”，属于小错误码不准确，未构成安全边界绕过。
- **不可逆操作**：设备动作本批没有 `perform`，不会真正下发；但 `confirm` 没有被使用，见发现 6。
- **资源**：主要风险是全域扫描和整段抽取全量载入，见发现 9。
- **规则/说明与代码一致**：系统提示未改；两个工具定义确实来自固定提示词目录，不随设备状态变化；`perception_read` 结果作为工具结果追加；抽取提示词的固定说明在前、记录按时间和 id 排序、待办按 id 排序、日历和当前时间在后；记忆出处类型写入路径只认 `reference/perception`。不一致点集中在发现 2、3、6，以及 `ownerVoiceQualified` 的可达性。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮变化的值是否都在最后一条消息？

- **同一对话稳定后：不会。** 两个工具的定义是 `packages/prompt-catalog/src/perception.ts` 的固定文字，`perceptionToolDescriptors()` 只返回静态 schema，不包含设备列表、动作列表或当前时间（`production-perception-tools.ts:99-140`）；设备能力通过 `device_action` 的 `describe` 工具结果告诉模型。感知内容只作为 `perception_read` 的工具结果追加在末尾（`perception-origin-gate` 的固定说明也确认了这一点）。历史消息、系统提示未被改写。`perception_read` 工具结果里的 `timeZone` 是配置常量，`at` 来自记录时间，没有“当前时间”字段。
- **上线那一次：会改变老对话的开头一次。** 新增两个工具会改变工具集合，按既有冻结机制老对话会按“工具集合变了”重建一次；`docs/kv-cache-guide.md` 第 7 条和 `.claude/rules/prompt-prefix.md` 第 7 条都明确写了这个一次性代价。之后工具集合和定义保持稳定。
- **每轮会变的值**：`device_action` 的 `describe` 结果、`perception_read` 的记录、设备状态等都在最后追加的工具结果里；固定定义和系统提示内没有会变的值。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- **主对话的 `perception_read` 结果：不会依赖“当前时间”。** 记录按 `occurred_at_ms, id` 排序（`sqlite-perception-operations.ts:1007-1011`），`evidence` 键排序（`production-perception-tools.ts:176-184`），`kinds` 顺序来自固定数组，相关结果稳定。遮盖仍由统一出口遮盖完成，和历史一样依赖同一对话的遮盖密钥与历史；在历史不变、密钥不轮换时字节稳定。
- **感知抽取是后台一次性调用**：同一批记录、同一时钟、同一待办和日历下是确定的，单元测试也验证了打乱输入顺序后提示词相同（`perception-extraction.test.ts`/`perception-extraction.unit.test.ts`）。但不同重抽之间，`now`、未完成待办、日历表、以及 `redactForEgress` 的 `known` 上下文都可能不同，因此同一段记录所在提示词可以不同；变化内容位于记录之后的数据段/尾部（或作为数据行），符合“固定在前、变化在后”的方向，且这不是同一对话的缓存请求。
- **一个小的跨环境不确定性**：`perception_read` 的 query 过滤用了 `toLocaleLowerCase()`（`production-perception-tools.ts:317,345`），命中集合可能随 Node 默认 locale 不同而变化；它不会改变已返回文字的字节，但会改变“哪些记录被返回/被标记”。建议显式固定 locale 或改用 `toLowerCase()`。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

- **有，而且多数反向用例是有效的：**
  - 请求开头/位置：`test/integration/production-runtime-tools.unit.test.ts` 与 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 4 条 `[iOS-5]`；`scripts/check-prompt-prefix.mjs` 把 `REQUIRED` 从 8 提到 12，且这 4 条位于 `[I-66]` describe 内，会被计数。把感知内容放进系统提示、工具定义、更早位置或错误角色后，helper 会返回对应 break，测试确实会失败。
  - 来历入口：`test/integration/perception-tools.test.ts` 先执行一次动作成功，读外部内容后同一动作被拒；后台运行改为投递提议。若去掉 gate，被拒调用会成功，测试会失败。
  - 抽取：引用不逐字、卡片号被遮盖、可信标记、完成提示、预算、重试上限、分片、口头指令跳过、出处类型非法都有测试。
  - 导出：新增 `[P1-6][reverse]` 检查 `perception_extractions` 和 `perception_command_utterances` 不出现在任何导出文件。
- **缺口：**
  - 没有“格式正确但不存在的 `perception:` 记录”反向用例（发现 2），因此这条反向用例即使存在也会失败。
  - 没有“记录条数变化后重抽”“预算重试”以及“同一提议不会重复投递”的测试（发现 3）。
  - `perception_run_reads` 没有被反向测试插入并检查不出现在导出文件里。
  - `[iOS-5]` 的结构测试使用的是测试里手写的假工具定义和假 `modelContent`，不是真实的 `perceptionToolDescriptors()`；真实定义的稳定性另有单元测试，但不在 `check:prompt-prefix` 这一步里。
  - 我没有运行测试，只读了测试代码。

### 4. 每个新产生/修改的值，两端都能接受吗？

逐项核对结果：

- **工具 capability ref / 工具名**：`device.action`、`perception.read` 与 `device_action`、`perception_read` 在描述符、`#isPerception`、`preflight`、提示词清单中一致；✓。
- **配置键**：新键都加入 `PERCEPTION_CONFIGURATION_DEFAULTS/RANGES`，`parsePerception` 用 defaults 的键自动解析并套用范围，消费端（工具、抽取、定时器、上限）一致；✓。
- **迁移状态/字段**：`perception_extractions.status`、`next_attempt_at`、`attempts` 的 CHECK 与写入逻辑一致；✓。
- **账本 kind/outcome**：`proposal/proposed/not_proposed`、`memory_candidate/kept/discarded` 都在 `DECISION_OUTCOMES` 和 0095 表 CHECK 内；导出 schema 的 `kind` 使用 `DECISION_KINDS`；✓。
- **感知记录 id（记忆出处）**：生产端来自 `readEpisode` 的真实记录，格式能过正则；但后端**没有验证存在**，见发现 2，✗。
- **`source_type = perception`**：写路径认识并校验格式；读路径能还原；数据导入路径不校验，见发现 7，⚠。
- **口头指令 `utteranceId`**：设备消息接口、`PerceptionService`、DB 列长度、抽取按 `evidence.utteranceId` 匹配，长度/字符集基本一致；✓（只是错误路径上“命令已接受、标记失败”会返回失败，见侧重检查）。
- **`gated_action` 提议**：`sourceKind/sourceId/sourceVersion/kind/action` 只有可选的 `PerceptionProposalPort` 消费；生产没有实现，见发现 4，⚠。
- **提示词编号**：全部登记在 `prompt-manifest.json` 和 `TRUSTED_PROMPT_TEXTS`；抽取文件也登记进出口遮盖允许列表；✓。
- **设备动作状态/说明**：`DEVICE_ACTION_STATES` 与 `DEVICE_ACTION_NOTES` 一一对应；✓；但 `confirm` 没有强制，见发现 6。

**结论：** 主要的“两端不一致”是记忆出处的存在性校验（作者说法/计划明确承诺但代码没有），其次是导入路径的 `source_type` 校验缺失，以及生产没有提议入口导致 gate 产物丢失。其余值和配置键的两端核对基本一致。
