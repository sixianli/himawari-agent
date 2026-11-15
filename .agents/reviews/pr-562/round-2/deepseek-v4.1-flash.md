### 1. 低 — 架构文档仍把同一个 `maxAttempts` 叫“最多重试次数”，与本次改后的名称/单位/语义不一致
- 文件:行：`docs/architecture-v0.1.md:436`；`docs/adr/0274-new-things-go-through-one-think-entrance.md:59`
- 问题：本轮把 `maxAttempts` 的名称改成“最多尝试次数”、单位改成 `times`（次/times/回），语义改成只有“卡住”的才会重新排队；但第 436 行和 ADR 0274 第 59 行仍写“最多重试次数”。第 436 行就在同一份架构文档、同一组 `runPolicy.thinkInbox` 配置清单里，读者会以为存在另一个“重试次数”配置，或以为任何失败都会重试。
- 证据（读代码证实）：第 436 行：“……‘在想’卡住多久算卡住（默认 30 分钟）、**最多重试次数（默认 3）**、摘要长度（默认 1000 字）都是 `runPolicy.thinkInbox` 的可选配置”。第 438 行：“……**最多尝试次数（只有卡住的事会重新排队再想）**……”。ADR 0274:59：“……‘在想’卡住多久算卡住、**最多重试次数**、摘要长度都是 `runPolicy.thinkInbox` 的可选配置”。代码里 `recoverStalled` 只把 `thinking` 且过期的条目重新排队，次数到 `maxAttempts` 后记失败；普通失败由 `finish` 直接记 `failed`，没有重试路径（`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:278-293`、`apps/agent-service/src/production-think-worker.ts:76-116`）。
- 建议：至少把 `docs/architecture-v0.1.md:436` 改成“最多尝试次数（默认 3，只有卡住的会重新排队）”；ADR 0274 若作为历史记录不改，也应加注说明现行名称和语义，避免与 `THINK_SETTING_DEFINITIONS` 冲突。
- 推测：这两处不会造成运行错误，只会误导维护者和后续写 App 文案的人。

### 2. 低 — 新增的 `maxAttempts` 说明文案没有反向断言，改回旧文案测试不会失败
- 文件:行：`test/integration/think-settings.test.ts:250-266`
- 问题：新增测试对 `maxAttempts` 只断言了 `unit`、`label`、`unitLabel`，对被修改的 `description` 只检查三种语言的键存在且为非空（`boundedString` 只要求非空）。如果以后把说明改回“最多重试次数”或“任何失败都会再想”，这条测试仍然通过。上一轮的实质问题是文案与实际行为不一致，这部分没有被自动检查锁住。
- 证据（读代码证实）：`test/integration/think-settings.test.ts:250-256` 只遍历 `label`、`description`、`unitLabel` 并断言 `Object.keys(text).sort()`；`:261-266` 的 `toMatchObject` 包含 `key`、`unit`、`label`、`unitLabel`，没有 `description`。`packages/gateway-contracts/src/contracts-v2.ts:878-882` 的 `thinkSettingTextSchema` 只要求三个非空、≤400 字符的字符串。
- 建议：若要把这段文案作为回归门槛，增加对 `items[6].description` 至少关键措辞的断言（例如中文含“只有卡住”或英文含“fail for other reasons”）。若不想锁死整段文案，也应在测试或评审批注里明确“文案语义靠人工核对”。
- 推测：完整断言整段三语描述会增加文案维护成本；是否值得由项目取舍。

**读代码证实的（本轮范围与上一轮意见）**
- 本轮增量只改了：`production-think-settings.ts` 的 `maxAttempts` 名称/说明与 `times` 单位文案、`configuration.ts` 的单位和 `maxAttempts` 定义、`architecture-v0.1.md:438`、以及 `think-settings.test.ts` 的合法 v2 查询头和快照 schema 解析/断言。
- 上一轮第 2 条的代码部分已改好：`maxAttempts` 的单位是 `times`，`THINK_SETTING_UNIT_TEXT` 有 `次/times/回`；`recoverStalled` 只重排卡住的条目，次数用完才 `failed`，其他失败不会重排；`parseThinkInbox` 仍按定义范围接受 `maxAttempts`（1–20），单位没有白名单，只过滤 `permille`，所以 `times` 不影响配置解析。
- 测试的查询头现在带 `schemaVersion`、`correlationId`、`causationId`、`dataClassification`、`risk`、`authorizationRef`、`authority`；新增的 `gatewayV2MessageSchema.parse(...)` 会真正检查快照的 `schemaVersion/kind/type/authority/items.label/description/unitLabel` 等必填字段。
- 文档同步不完整：`docs/architecture-v0.1.md:436` 和 ADR 0274:59 仍是旧叫法。

**推测/未核实**
- 仓库内没有 App 端消费 `think.settings.snapshot` 的代码（`clients` 只有 `think.settings.read/change` 的能力登记，没有 `unit`/`unitLabel` 的解码或枚举），所以“真实 App 渲染能接受 `times`”未核实；能核实的是 `packages/gateway-contracts` 的快照 schema 用 `machineString` 接受 `times`。
- 本轮没有运行测试，只读了代码；无法确认 CI 上实际通过情况。测试里的 `change` 命令仍缺 `idempotencyKey`，但它不经过网关、直接调用 `control.execute`，因此不影响本次单位改动，也不能当作命令侧的 v2 契约覆盖。

**侧重检查**
- 错误路径：配置解析仍按 `THINK_SETTING_DEFINITIONS` 的 1–20 范围校验 `maxAttempts`；卡住恢复按 `attempts >= maxAttempts` 记失败，未发现新的越界或漏判。
- 不合规范/不可信输入：`think.settings.change` 的 `key/value` 仍走定义查找和范围校验；`times` 只由服务端生成，未新增外部输入面。快照文案由代码常量生成，不拼接用户输入。
- 安全：没有新增秘密、日志或外部数据；文案是固定常量，长度远低于契约的 400 字符。
- 资源耗尽：没有新增循环、队列或重复调用；只是常量字符串和一次已有快照字段的序列化。
- 不可撤销操作：本次只影响设置快照展示和设置说明；改设置仍可用 `value: null` 恢复默认，没有新增不可撤销操作。
- 规则/文档/代码一致性：发现第 1 条的文档残留；代码和 gateway 契约两端一致。
- 模型请求：没有改动系统提示、工具定义、历史或遮盖逻辑，不涉及 prompt-prefix 路径。

**必答问题**
1. 不会。本增量没有触碰任何模型请求组装、系统提示、工具定义、历史消息或遮盖；只改了设置 API 的文案/单位、文档和集成测试。也没有把每轮变化的值放进请求开头的问题。依据的“只追加”规则不涉及本次改动。
2. 不会。新增的 `times`、`label`、`description`、`unitLabel` 都是冻结或只读的固定常量，同一语言每次序列化字节相同；顺序仍由 `THINK_SETTING_DEFINITIONS` 固定。没有引入依赖前后文的遮盖、带时间的文案或无序集合。快照原有的 `generatedAt` 不是模型请求内容。
3. 有部分自动检查。`think-settings.test.ts` 新增了合法 v2 查询头和 `gatewayV2MessageSchema.parse` 快照校验，并断言 `maxAttempts` 的 `unit: "times"`、`label`、`unitLabel`；若把单位改回 `count` 或删掉文案字段，测试会失败。反向用例的缺口是 `description` 的具体语义没有被断言（见第 2 条）。本轮未实际运行测试。
4. 逐个核对了直接使用端：产生处是 `packages/application/src/ports/configuration.ts:422`（`maxAttempts` → `times`）和 `apps/agent-service/src/production-think-settings.ts:123-132`（`times` → 次/times/回）。使用端：`production-think-settings.ts:204-206` 取 `THINK_SETTING_UNIT_TEXT[definition.unit]`，有 `times`；`strict-configuration.ts:1395` 只排除 `permille`，`times` 仍进入 `parseThinkInbox` 且范围不变；`contracts-v2.ts:890-899` 的 `unit` 是 `machineString`，接受 `times`；`gateway-v2.fixture.ts` 的契约夹具仍可解析；存储只按 key 存数字，不持久化单位。故后端配置解析和 gateway 快照契约两端都能接受。真实 App 端没有消费代码可读，标记未核实。
