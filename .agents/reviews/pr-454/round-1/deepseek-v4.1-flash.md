说明：本轮已达到最大步骤，因此没有继续调用工具；以下结论全部基于此前读到的代码，未重新验证，未运行测试或类型检查。未核实之处已标注。

## 一、读代码证实的问题

### 1）高：动作指纹没有规范化 `string_list` 的顺序，结果未知时换个顺序就能重做

- 严重度：高
- 文件:行：`packages/application/src/services/device-action-registry.ts:118-130`、`:148`、`:153-158`；`packages/application/src/services/device-action-service.ts:399`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:132-141`
- 问题：`string_list` 已按集合语义校验（重复项直接拒绝），但校验结果和指纹都保留原数组顺序。`deviceActionFingerprint` 只排序了对象键，没有排序数组值。于是同一组 `attendees` 只要顺序不同，就会得到不同指纹；`insert` 查不到原来“结果未知”的动作，会新建第二条并再次 `perform`，违反“结果不确定的动作绝不能重做”。
- 证据：
  - `device-action-registry.ts:148`：`result[name] = field.type === "string_list" ? Object.freeze([...(value as string[])]) : value;`
  - `device-action-registry.ts:153-158`：`JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]))`
  - `sqlite-device-action-operations.ts:136-141`：按 `fingerprint = ? AND state IN (...)` 查 open duplicate。
  - `calendar.create/update` 的 `attendees` 是无序参与者列表（`device-action-registry.ts:383-401`），但顺序进入指纹。
- 建议：在 `deviceActionFingerprint` 中对声明为集合语义的列表排序（至少 `attendees`），或给字段增加 `unordered`/`set` 标记；补反向用例：动作处于 `result_unknown` 时把 `attendees` 顺序调换后再调用，必须不产生第二条 `perform`。

### 2）中：先解析设备镜像、后查重放，目标被删除后同一工具调用重放会返回 `invalid`

- 严重度：中
- 文件:行：`packages/application/src/services/device-action-service.ts:315-320`、`:392-421`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:125-131`
- 问题：`request` 在调用 `store.insert`（内部才做 `run_id + tool_call_id` 重放查询）之前，先执行 `#context`。对于 `calendar.delete`、`calendar.update`、`contact.update`、`reminder.complete`、`home.*` 等带目标的动作，如果目标已从镜像删除，`#context` 直接返回 `invalid`，到不了重放分支。作者说法 2“同一次工具调用重放返回原记录”在这种情况下不成立。
- 证据：
  - `device-action-service.ts:317-320`：`const context = await this.#context(...); if (!context) return { kind: "invalid", note: DEVICE_ACTION_TARGET_UNKNOWN_NOTE };`
  - `sqlite-device-action-operations.ts:125-131`：重放查询在 `insert` 内部。
  - `device-action-service.ts:392`：`store.insert` 在 `#context` 之后才调用。
- 建议：把重放判断提前到目标解析之前（例如给 store 增加 `findByInvocation(runId, toolCallId)`），或在 `#context` 失败时先检查同一工具调用/同一指纹是否已有记录；补“删除镜像项后重放同一工具调用”的用例。

### 3）中低：先写受保护载荷、后写数据库，失败会留下无主载荷

- 严重度：中低
- 文件:行：`packages/application/src/services/device-action-service.ts:386-416`、`:585-607`
- 问题：`request` 先 `content.save(argumentsRef)` 再 `store.insert`；`report` 先 `content.save(resultRef)` 再 `store.report`。如果 `insert`/`report` 抛错（设备刚好被吊销、磁盘空间不足、数据库错误等），受保护的参数或结果载荷会留在库里，但没有 `device_actions` 行引用它，也不会出现在导出、清理或删除路径中。
- 证据：
  - `device-action-service.ts:386-391`：`argumentsRef = ...; await this.#options.content.save(...)`
  - `device-action-service.ts:392`：之后才 `store.insert(...)`
  - `device-action-service.ts:585-597`：先保存结果，`:598` 才 `store.report(...)`
- 建议：失败路径用 `try/catch` 调 `content.discard`，或把载荷写入和行写入做成可补偿操作；为 `insert` 抛错补测试并断言没有孤儿载荷。

### 4）低：`DEVICE_ACTION_TRANSITIONS` 和 `deviceActionTransitionAllowed` 是死代码，作者说法 3 的机制没有落地

- 严重度：低
- 文件:行：`packages/application/src/ports/device-actions.ts:19-45`
- 问题：作者说“状态只能按 `DEVICE_ACTION_TRANSITIONS` 走”，但该表和函数在全仓库没有被调用；实际转换由各 SQL 的 `WHERE state = ...` 硬编码。当前 SQL 与表内容暂时一致，但以后改表不会影响行为，也没有测试能发现两边分叉。
- 证据：
  - `device-actions.ts:19-45` 定义 `DEVICE_ACTION_TRANSITIONS`/`deviceActionTransitionAllowed`。
  - 全仓库使用点只有 `device-api-routes.ts:612` 的 `DEVICE_ACTION_OPEN_STATES`，没有 `DEVICE_ACTION_TRANSITIONS`。
- 建议：要么让 store/service 真正使用该表校验转换，要么删掉它并把说法改成“各 SQL 语句限制转换”；补一个表驱动测试。

### 5）中低：终态动作没有清理路径；`result_unknown` 永不过期，被拒动作也不去重

- 严重度：中低
- 文件:行：`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:132-141`、`:220-256`、`:258-288`
- 问题：
  - `insert` 只对 `waiting_owner/queued/delivered/result_unknown` 做指纹去重，`rejected` 不去重。模型反复尝试策略关掉的动作时，每次不同 `tool_call_id` 都会新增一条 `rejected` 行和一份参数载荷。
  - `settleDue` 只处理 `waiting_owner/queued/delivered`，`result_unknown` 永不进入终态。
  - `claim` 每次都返回所有 `result_unknown` 做 `verify`，没有最终期限。
  - 没有终态记录的保留/清理机制。
- 证据：
  - `:132-141`：`if (input.state !== "rejected") { ... open duplicate ... }`
  - `:225-228`：`state IN ('waiting_owner', 'queued', 'delivered')`
  - `:270-271`：`OR device_actions.state = 'result_unknown'`
- 建议：为终态动作和结果载荷定义保留期/清理任务；对短时间内重复的 `rejected` 指纹考虑合并或限流；给 `result_unknown` 定义可观测的最终处置。

### 6）低：`describe` 的“按名字排序”不完整，`availableActions` 也不看设备策略

- 严重度：低
- 文件:行：`apps/agent-service/src/production-perception-tools.ts:445-447`、`:483-490`
- 问题：动作名确实按 `registry.names()` 排序，但设备列表按设备 `id` 排序，不是按名字；未知动作返回的 `availableActions` 用的是 `target.supportedActions`，没有用 `allowed`，所以会把策略关掉的动作也列给模型，诱导模型再试一次并生成新的 `rejected` 记录。
- 证据：
  - `:445-447`：`devices.sort((left, right) => left.id < right.id ? -1 : ...)`
  - `:486-490`：`devices.some((target) => target.supportedActions.includes(name))`
- 建议：如果说法 9 指全部输出，按设备名排序；`availableActions` 改用 `allowed` 映射，并补反向用例。

### 7）低：策略变更不会撤销已送达的动作，设备仍可能执行

- 严重度：低
- 文件:行：`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:452-470`
- 问题：`changePolicy` 只把 `waiting_owner/queued` 改成 `rejected`，`delivered` 不动。设备如果在策略关闭前已经 claim 了动作，仍可能继续执行。作者已承认“设备端自己再查策略”没做，所以这是已知残留风险，但服务器侧也没有把 `delivered` 标成不可执行。
- 证据：
  - `:458`：`AND state IN ('waiting_owner', 'queued')`
  - `:462-466`：只拒绝 `waiting_owner/queued`。
- 建议：在文档和 UI 中明确“已送达的动作无法由服务器撤销”；若要更强保证，需要在设备 claim 后执行前再校验策略版本（设备端实现）。

## 二、推测 / 未核实

- 未运行任何测试或类型检查（环境只允许读代码与 git 命令），因此 `prompt-manifest.json` 新增条目的 `sha256` 是否正确未核实。
- `changePolicy` 不限制 `blockedActions` 长度；`sqlite-device-action-operations.ts:99-107` 超过 500 会抛 `PORT_INVALID_OPERATION`。该错误最终映射成 400 还是 500 未读到网关错误处理，未核实。
- `withDeviceActionSignals` 产生的 `device.actions` 帧确实没有 `id:`（`device-action-hub.ts:5-7`），但 iOS 端是否把它当游标事件处理未核实。
- 设备回报的 `reason`/`evidence` 会原样进入模型工具结果；这里把已配对设备视为可信输入。若设备被攻破，它可能向模型注入文本，未在服务端做来源门禁或额外分类提升。属于安全判断，未在规则中看到明确要求。
- `report` 不调用 `settle()`，已送达但刚过期的动作仍可在被 settle 前直接回报成功。对 `readBack: "none"` 的 `home.read` 可能不要求读回。是否符合预期未核实。
- 设备动作的 `request/result` 在 `withEvidence: false` 时仍导出（`device-actions.test.ts:886-924` 明确这样断言）；这与“证据默认不导出”的其他数据不同，是否是有意的隐私取舍需产品确认。
- 未使用字段：`DeviceActionRegistration.untrustedOriginAllowed`、`DeviceActionRegistration.resultOrigin`、`DeviceActionServiceOptions.devices` 在生产路径中基本没有被读取；是预留还是遗漏，未核实。

## 三、侧重检查

- **错误路径**：`report` 对未知字段、非法 outcome、非布尔 readBack、evidence 大小、reason 长度都有校验（`device-action-service.ts:555-573`）；策略变更要求 confirm key，web 路由 404（`device-actions.test.ts:704-774`）。发现目标解析早于重放、载荷与数据库写入非原子、`report` 未 `settle`。
- **不合规范/不可信输入**：模型参数由登记表校验，未知字段、NFC、范围、类型都会拒绝；设备回报和策略 body 也有白名单。镜像来源的 `category` 用于安全等级，缺失或认不出会升级为 `PHYSICAL_SAFETY`，这是安全的默认值。
- **安全**：生产授权只放行 `READ + LOW + 不需要本人在场`（`device-action-service.ts:169-175`）；策略写必须 confirm key（`device-api-routes.ts:670-687`）；吊销后认证直接 403（`paired-device-service.ts:315-318`）；`claim` 要求设备 active（`sqlite-device-action-operations.ts:267-271`）。设备策略关闭动作时已排队项会作废，但已送达项不会。
- **资源耗尽**：没有终态清理、`result_unknown` 无期限、被拒动作不去重、每次重放还会先写再删一份参数载荷。多次被拒或多次重试会让 `device_actions` 和 `payloads` 持续增长。
- **不可撤销操作**：`home.control` 非日常类别、`calendar.delete` 都要求本人在场；生产默认 ReadOnly 授权会拒绝它们。策略/吊销不会回滚已送达动作，设备端执行前复查策略未实现。
- **规则/文档一致性**：固定工具定义没有改，`perceptionToolDescriptors()` 未改；但 `DEVICE_ACTION_TRANSITIONS`、`untrustedOriginAllowed`、`resultOrigin`、`DeviceActionServiceOptions.devices` 目前基本是死字段/死代码；设计文档 §12 还列了 `mac.open`/`mac.app`，本次登记表没有，若本批只做 iPhone 需要明确文档范围。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**否（在已读代码范围内）。** 系统提示和 `device_action`/`perception_read` 工具定义没有改；`perceptionToolDescriptors()` 仍是固定对象（`production-perception-tools.ts:98-143`），集成测试也断言其字节不变（`device-actions.test.ts:275-321`）。新增的 reason 文字只在工具结果里通过 `MODEL_REASONS` 返回（`device-action-service.ts:53-65`、`:289-303`），`describe` 也是工具结果。发给模型的内容仍然只在末尾追加。

### 2. 同一段文字会不会在不同请求里变成不同字节？

新增固定文字是常量；`deviceActionFingerprint` 排序对象键；`blockedActions` 经 `names()` 排序去重（`sqlite-device-action-operations.ts:99-107`）；导出按 `created_at/id`、`device_id` 排序；动作详情在创建时生成并存入受保护载荷，后续 `#outcome`/`views` 读同一个存储值，不会按当前镜像重算。**但**指纹对 `string_list` 的顺序不规范化（问题 1），这不是提示词字节变化，却会让同一逻辑动作被当成不同动作。

### 3. 有没有对应的自动检查，反向用例真会失败？

有，且反向断言大多有实质意义：

- `test/integration/device-actions.test.ts:243-273`：未知动作、多余字段、镜像里找不到目标都不建记录。
- `:395-427`：默认授权拒绝非读取动作，记录 `approval_not_connected`。
- `:429-469`：别的设备不能回报、未送达不能回报、成功不读回被拒 400。
- `:473-531`：结果未知时只发 `verify`，换工具调用也不新建，必须读回才能成功。
- `:605-669`：本人在场未证明被拒，`decide` 也检查。
- `:704-817`：策略必须 confirm key，web 404，策略关闭时排队项作废。
- `:819-854`：吊销后队列拿不到，触发器把 queued 作废、delivered 转 unknown。
- `:886-937`：导出文件、计数和 schema 校验。
- `consolidation-hold-migration.contract.test.ts`：重建 `decision_ledger` 及依赖表时逐表比较数据，覆盖迁移不丢行。

缺口：没有覆盖“带目标动作在镜像目标删除后重放”、没有覆盖“列表参数换序后的指纹去重”、没有覆盖 `device.actions` 帧无 `id` 时设备游标行为、没有覆盖超长 `blockedActions` 的 HTTP 状态。提示词 manifest 新条目 hash 未在本环境验证。

### 4. 新产生的每个值，使用方都能接受吗？

逐项对照后，以下都一致：`dact_` 编号（生成、服务校验、DB、导出、回报 body）、8 个状态、11 个 reason code、11 个 action kind、4 个风险档、4 个数据分级、`device_action` 决策种类及 9 个 outcome、`device_actions`/`device_policies` 的导出 schema 与 manifest 计数、4 个新配置键（默认值/范围/启动解析）、3 个语言的新 i18n 文本。

例外或需要注意的：
- **指纹中的 `string_list` 顺序**没有在产生端规范化，却被 store 当成去重键（问题 1）。
- **`DEVICE_ACTION_TRANSITIONS`** 是产生出来的“允许转换表”，但使用方（SQL）完全不读它（问题 4）。
- `device_actions` 导出没有 `runId`/`toolCallId`/`fingerprint`，所以导出文件无法反查是哪一个工具调用产生的；如果数据导出承诺“可审计到调用”，这是缺口。
- 策略 body 的 `blockedActions` 在服务层只校验 `registry.get(name)`，不校验该设备当前是否支持；store 可接受，属于宽松但安全的校验。
