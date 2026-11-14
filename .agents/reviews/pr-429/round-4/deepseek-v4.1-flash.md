## 结论摘要

增量提交 `cc05bc2a` 的两处修复与作者说明基本一致：`lastUsed.decisionId` 的正则和网关 `machineString` 等价，`quote` 对 `deletion_pending` / `deleted_verified` / `trashed` / 分级不可见返回 `null`。没有发现会改变模型已见请求开头、或破坏已发历史的高严重度问题。主要遗留是旧客户端严格解析、反向用例覆盖不全，以及新查询的性能和产生端校验。

## 问题（按严重度）

### 1. 中低：旧版控制中心会拒绝新增字段，作者「网页暂无消费者」的说法不完整

- 文件：`apps/control-center/src/gateway-client.ts:269`、`packages/gateway-contracts/src/validation.ts:161-189`、`packages/gateway-contracts/src/contracts-v2.ts:1615-1635`
- 问题：新增的 `quote`、`changes`、`lastUsed` 是 `memory.rules.snapshot` 的必填字段。UI 确实还没有渲染它们，但控制中心的客户端仍会用严格的 `gatewayV2MessageSchema.parse` 解析整个快照；`object()` 对未知字段直接 `unknown field` 失败。因此新服务端配旧页面时，规则列表会整体报 `RULES_INVALID`，不是「没有消费者」就无影响。
- 证据：
  - `gateway-client.ts:268-271`：`function parsedResponseBody(value: unknown): GatewayV2Snapshot { const parsed = gatewayV2MessageSchema.parse(value); ... }`
  - `validation.ts:174-176`：`for (const key of Object.keys(record)) { if (!expectedKeySet.has(key)) fail(... "unknown field"); }`
  - `contracts-v2.ts:1626-1630` 新增了必填的 `quote`、`changes`、`lastUsed`。
- 建议：如果要求新旧页面混跑，让客户端忽略未知字段，或把新字段做成可选并另起 schema 版本；至少明确「更新后未刷新的旧标签页」的处理方式。作者已声明不改，但应把它作为已知不兼容点记录，而不是按「无消费者」处理。

### 2. 中低：`quote` 的「回收站 / 永久删除 / 分级不可见」分支没有自动检查

- 文件：`test/integration/production-memory-capture.test.ts:2192-2200`、`apps/agent-service/src/production-memory-control.ts:491-497`
- 问题：新增代码检查了 `deletion_pending`、`deleted_verified`、`trashed` 和 `reviewMemoryVisible` 四个条件，但测试只通过 `context.memory.delete` 覆盖了 `deletion_pending`。如果以后有人只保留 `deletion_pending`、删掉 `trashed`/`deleted_verified`/分级判断，现有测试仍会通过，作者说明里的「在回收站或分级不可见」没有得到反向用例保护。
- 证据：
  - 测试：`await context.memory.delete(...)` 后只断言 `toMatchObject({ status: "needs_review", quote: null })`。
  - 代码：`record.status === "deletion_pending" || record.status === "deleted_verified" || record.status === "trashed" || !reviewMemoryVisible(record.dataClassification)`。
  - 搜索本文件未发现按 `trashed`、`deleted_verified`、`restricted` 检查规则 `quote` 的用例。
- 建议：按状态参数化 `trashed`、`deletion_pending`、`deleted_verified` 三个用例，再加一条来源记忆为 `restricted` 的 `quote: null` 用例；并逐一确认删掉对应分支后测试会红。

### 3. 低：新端口只有 `decisionId` 在消费端按网关契约过滤，`at` / `kind` 未在产生端校验，且规则是重复实现

- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:783-815`、`apps/agent-service/src/production-memory-control.ts:524`、`packages/gateway-contracts/src/contracts-v2.ts:1628-1630`
- 问题：`lastRuleUses` 直接把数据库里的 `checked_at`、`kind` 原样返回；`#ruleLastUsed` 只过滤 `decisionId`。正常生产写入会经 `valid()` / `timestamp` 校验，所以当前数据大概率安全，但端口本身仍可能返回不符合网关契约的值。另外 `machineString` 的规则被复制成一处正则，未来契约改动容易再次出现 I-73 那种两端校验不一致。
- 证据：
  - `sqlite-decision-ledger-operations.ts:791-810` 的 SQL 直接 `SELECT id, kind, checked_at AS decidedAt` 并原样 `found.push({ decisionId: row.id, kind: row.kind as ..., decidedAt: row.decidedAt })`。
  - `production-memory-control.ts:524` 只对 `use.decisionId` 做 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u` 检查。
  - `validation.ts:49-60` 的 `machineString` 是另一份同样的规则。
- 建议：在 `lastRuleUses` 产生端统一按网关契约过滤/校验 `at`、`kind`、`decisionId`；把 `machineString` 导出成可复用的 predicate，避免两处维护。这样能直接落实 I-73 的教训：「清单里的 id 能通过后端校验吗」。

### 4. 低：无 UI 消费者时，新查询已经在每次刷新做逐规则数据库扫描和记忆解密

- 文件：`apps/agent-service/src/production-memory-control.ts:538-554`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:791-797`、`apps/control-center/src/memory.ts:22,104-109`
- 问题：`#rules` 对每条规则调用一次 `lastRuleUses`，SQL 里对每个候选决策做 `json_each(inputs, '$.ruleIds')` 的 `EXISTS`；同时对每条规则 `Promise.all` 读取并解密来源记忆。控制中心每 5 分钟刷新一次，而页面目前并不显示这些字段，所以这些 I/O 暂时没有产品收益。作者已说明性能不改，但这是一项真实的资源开销。
- 证据：
  - `#rules`：`const rules = await Promise.all(listed.map(async (rule) => { ... quote: await this.#ruleQuote(...), ... }));`
  - SQL：`... AND EXISTS (SELECT 1 FROM json_each(decision_ledger.inputs, '$.ruleIds') AS ref WHERE ...)`
  - `memory.ts:22`：`const REMINDER_REFRESH_MS = 300_000;`
- 建议：用一条 SQL 把输入规则 id 一次性 `json_each` 展开并 `GROUP BY ruleId` 取最新，或先把 `lastUsed` 与 `quote` 做成按需加载；在网页消费者上线前不要无条件放开。这样也能覆盖超过 64 条规则时的分批成本。

### 5. 低 / 待产品确认：`archived` / `superseded` 来源记忆仍返回原话，`changes` 统计包含状态变化

- 文件：`apps/agent-service/src/production-memory-control.ts:491-502,551`、`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301-400`
- 问题：`#ruleQuote` 只排除了 `deletion_pending`、`deleted_verified`、`trashed` 和分级不可见，没有看 `record.attributes.supersededBy` / `validTo`，所以被取代或已归档的来源记忆仍会显示原话。`changes = Math.max(0, rule.revision - 1)` 也会把「来源记忆归档/改分类」导致的进入 `needs_review` 计入修改次数，而不只是主人修改规则。
- 证据：
  - `#ruleQuote` 的状态判断只有三个 status 和分类检查。
  - 迁移触发器在记忆编辑、归档、被取代、改分类时都会 `revision = revision + 1` 并置 `needs_review`。
  - `production-memory-control.ts:551`：`changes: Math.max(0, rule.revision - 1)`。
- 说明：作者明确说 `changes` 定义不改，所以这不是本次实现错误；是否让 `superseded`/`archived` 也隐藏原话，需要产品确认。
- 建议：若要「原话只在来源记忆仍有效时显示」，把 `supersededBy` / `validTo` 一并纳入；在 ADR 或接口说明里写清 `changes` 的口径（是否包含状态变化）。

## 侧重检查

- **错误路径**：`#ruleQuote` 对 `readText` 有 `.catch(() => null)`，但 `this.options.state.read` 本身没有 catch；正常 SQLite 读取不会因找不到记录抛错，坏数据导致整张规则快照失败的风险较低。`lastRuleUses` 对输入不是数组、超过 64 条、元素非字符串或长度不在 1..128 时用 `PORT_INVALID_OPERATION` 拒绝。未发现新增的不可撤销写操作，整个改动以读为主。
- **不合规范 / 不可信输入**：`decision_ledger.inputs` 有 `json_valid` / `json_type = object` 约束；SQL 全部参数化，没有拼接规则 id；`lastRuleUses` 的输入长度有限制。`#ruleQuote` 会检查 `ownerId` 和来源记忆分类，但没有检查 `agentId`（`state.read` 本身不按 agent 过滤）。来源记忆 id 正常由 writer 在同一个 `ownerId`/`agentId` 下写入，是否存在跨 agent 的历史/导入数据未能证实，属于低风险待确认点。
- **安全**：`quote` 会进入控制中心快照，但控制中心本来就能读取记忆正文；`restricted` 分类被隐藏，`sensitive` 仍可见，和现有 `reviewMemoryVisible`/记忆页口径一致。`lastUsed.decisionId` 已按 `machineString` 同规则过滤，不会把合同不允许的编号发给页面。
- **资源耗尽**：主要风险是上面第 4 条，逐规则 SQL 扫描 + 逐规则读取/解密来源记忆；没有无界循环或写入放大。
- **不可撤销操作**：本增量没有新增写操作或删除操作；`lastRuleUses`、`#ruleQuote`、`#rules` 都是只读。
- **规则文件 / 文档 / 代码一致**：`.claude/rules/prompt-prefix.md` 的第 1、2、4、10、11 条没有被本改动触碰；网关快照不是模型输入。代码层面新增了 `memory.rules.snapshot` 必填字段，但 ADR 0213 只写了「新增查询 `memory.rules.read`」，没有记录 `quote`/`changes`/`lastUsed` 的语义，文档与实现存在说明缺口。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会（对模型请求而言）。改动只影响网关 `memory.rules.read` 返回给控制中心的快照；模型侧可见的 `rule.list` / `rule.undo` 输出仍由 `modelVisibleRule` 去掉 `revision`、`sourceMemoryId`，返回字段和顺序与改动前相同。代码中没有把 `quote`、`changes`、`lastUsed` 放进系统提示、工具定义、历史或遮盖结果。唯一需要警惕的是 `lastUsed.at` 和 `generatedAt` 是会变的值——它们目前只在网关快照里，不在模型请求的最后一条消息里；如果以后有人把整个 `memory.rules.snapshot` 塞进模型输入，就会违反「每轮会变的值只能放最后一条消息」。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求不会。`quote` 由来源记忆文本经确定性的 `singleLine` 处理得到；`rule.list` 的字段顺序和内容不变；`#rules` 的规则顺序来自确定的 `ORDER BY updated_at DESC, rule_id`，`Promise.all` 保持输入顺序；`lastRuleUses` 用 `ORDER BY checked_at DESC, id DESC`，没有把无序集合直接序列化。网关快照里的 `lastUsed` 会随时间变化，但那是快照语义，不是模型缓存前缀。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：
   - `test/integration/decision-ledger.test.ts` 覆盖 `lastRuleUses` 的 worker/direct 两条路径、精确 id、带 `@revision`、`rule_review` 不算使用、其他 owner 返回空。
   - `test/integration/production-memory-capture.test.ts` 覆盖以 `-` 开头的非法 decision id、删除来源记忆后 `quote: null`、`rule.list`/`rule.undo` 不暴露 `revision`/`sourceMemoryId`、多行原话折叠、以及 `gatewayV2MessageSchema.parse` 校验快照。
   - 反向用例确实有效：去掉 decision id 过滤会让 `-1` 在 schema 解析时直接失败；去掉删除状态判断会让 `quote` 非空；去掉 `modelVisibleRule` 会让内部字段出现在工具结果里。
   - 缺口：`trashed`、`deleted_verified`、`restricted` 三个 `quote` 分支没有测试；超过 128 字符或其他非法字符的 decision id、超过 64 条规则的分批、旧客户端解析都没有对应自动检查。这些测试在 integration/browser 项目里，不在 `npm run check` 的快速步骤中，需要完整测试/CI 执行。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `quote`：产生端 `#ruleQuote` 用 `singleLine` 去掉控制字符并保证长度 ≤500；消费端 `boundedString(500)` 接受。已验证。
   - `changes`：`Math.max(0, rule.revision - 1)`，`revision` 在数据库中为 ≥1 的整数；消费端 `integer(0)` 接受。已验证。
   - `lastUsed.at`：正常 proactive 写入经 `valid()` 校验为规范 UTC 时间；消费端 `timestamp` 接受。`lastRuleUses` 本身没有再次校验，历史/导入坏数据仍可能在客户端解析失败，属第 3 条的低风险点。
   - `lastUsed.kind`：SQL 固定过滤 `kind = 'proactive'`；`machineString` 接受。
   - `lastUsed.decisionId`：`#ruleLastUsed` 的正则与 `machineString` 等价（首字符字母数字、最多 128、允许 `._:-`），`-1` 会被过滤。
   - 新端口 `decisionLedger.lastRuleUses`：`durable-adapters.ts` 已加入读通道，`sqlite-durable-operations.ts` 按 `decisionLedger.` 前缀路由，`sqlite-decision-ledger-operations.ts` 已有 case；两端已接上。
   - 旧客户端：不满足。`gatewayV2MessageSchema` 的 `object()` 拒绝未知字段，旧版控制中心会拒绝新增的 `quote`/`changes`/`lastUsed`；作者已明确不改，这是当前未解决的一处兼容性问题。
