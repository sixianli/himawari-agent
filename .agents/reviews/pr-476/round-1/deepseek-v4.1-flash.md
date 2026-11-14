## 一、读代码证实的发现（按严重度）

### 高：旧的长 ID 没有被修复，快照仍可能失败，重试还会重复创建

- 文件：`apps/agent-service/src/production-reminder-writer.ts:177-180`
- 文件：`packages/gateway-contracts/src/contracts-v2.ts:1628-1630`、`1701-1704`
- 文件：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:393-394`、`0085_memory_reminder_cancelled.sql:1-14`
- 文件：`apps/agent-service/src/production-memory-control.ts:983-989`、`1036-1043`

问题：这次只在写入时把新 key 压短；已经存在的长 `memoryId`/`reminderId` 没有被迁移或清理。`memory_records.id`、`memory_reminders.id` 都是普通 `TEXT PRIMARY KEY`，没有长度约束，写入端也没有校验，因此旧版本确实可以把长 ID 存进去并留下。查询快照时，`memories[].memoryId` 和 `upcoming[].reminderId/memoryId` 都用 `machineString` 校验，旧的长 ID 仍然会让整份 `memory.overview.snapshot` 失败。更进一步，旧长 key 的命令在新版本重试时，会按新算法算出另一个 `reminderId`，`read` 查不到旧提醒，于是再写一条 memory 和 reminder，造成重复。

证据：

```ts
// production-reminder-writer.ts
const key = reminderKey(input.key);
const memoryId = `${MEMORY_ID_PREFIX}${key}` as MemoryId;
const reminderId = `reminder:${memoryId}`;
const existing = await this.#options.reminders.read(reminderId);
```

```sql
-- 0001_initial_product_schema.sql
CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
```

```ts
// contracts-v2.ts
memoryId: machineString,
...
upcoming: array(
  object({
    reminderId: machineString,
    memoryId: machineString,
```

建议：上线前先审计现有库中 `memory_records.id`、`memory_reminders.id` 超过 128 的行；如果存在，做一次修复/迁移，或明确清理这些旧提醒及其 memory，不能只靠新写入路径。若确认生产没有这类行，也要把审计查询和结论写进交付材料。否则“已修复”只对新数据成立，事故中的旧数据仍会继续触发同一错误。

### 中：哈希后的 key 可以和原始短 key 撞在同一个命名空间

- 文件：`apps/agent-service/src/production-reminder-writer.ts:45-50`
- 文件：`apps/agent-service/src/production-reminder-writer.ts:177-180`
- 文件：`apps/agent-service/src/production-reminder-writer.ts:200-227`

问题：`reminderKey` 在能放下时直接返回原 key，放不下时返回 `前 38 字符 + "." + sha256(key)`。后者本身也是一个合法的、长度 103 的短 key。如果调用方把某个短 key 设成某个长 key 的哈希形式，两者会映射到同一个 `memoryId`/`reminderId`。这不只是理论上的 SHA-256 碰撞，而是编码空间重叠，可以按已知长 key 构造出来。后果是：

- 若短 key 的提醒已存在，长 key 的创建会被当成重放，直接返回旧提醒的 `dueAt`/`remindAt`，忽略新请求；
- 若长 key 先创建，后续同名的短 key 会复用已有 `contentRef`，而 `create` 在 `contentRef` 已存在时不会重写 payload，最终可能显示另一条提醒的文本。

证据：

```ts
function reminderKey(key: string): string {
  if (REMINDER_ID_PREFIX.length + key.length <= MACHINE_STRING_MAX_LENGTH) return key;
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const kept = MACHINE_STRING_MAX_LENGTH - REMINDER_ID_PREFIX.length - digest.length - 1;
  return `${key.slice(0, kept)}.${digest}`;
}
```

```ts
const existing = await this.#options.reminders.read(reminderId);
if (existing)
  return { reminderId, memoryId, ..., replayed: true };
...
if (input.contentRef === undefined && !(await this.#options.payloads.get(contentRef)))
  await this.#options.payloads.put(...);
const payload = await this.#options.payloads.get(contentRef);
```

建议：让压缩后的命名空间不可能和原始 key 重叠，例如给压缩形式加一个保留前缀，并且凡是原始 key 以该保留前缀开头的也强制走压缩；或者改为“所有 key 都走同一种可区分编码”。至少应补一个用例，证明长 key 的压缩结果不会和原始短 key 冲突。

### 低：作者说“runId 长度不受限”与代码不符

- 文件：`packages/domain/src/identifiers.ts:39-50`、`69-71`

问题：`createRunId` 和所有 `Identifier` 一样受 `MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` 限制，runId 最多 128 字符；真正没有统一上限的是模型给的 `toolCallId`。这会影响对问题的描述和测试边界的理解，但不影响“runId + toolCallId 的组合 key 可能超过 103 字符”这一结论。

证据：

```ts
const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
...
export function createRunId(value: string): RunId {
  return createIdentifier(value, "RunId");
}
```

建议：把说明改成“runId 最多 128，toolCallId 可能不受同一上限限制，二者拼接后仍可能超过 128”，并明确是否需要给 `toolCallId` 增加入口长度上限。

### 低：`machineString` 的报错文字仍然硬编码 128

- 文件：`packages/gateway-contracts/src/validation.ts:48-58`

问题：校验条件已经改成 `MACHINE_STRING_MAX_LENGTH`，但错误文字仍是 `"expected a 1-128 character machine string"`。当前常量就是 128，所以没有实际错误；以后改常量时诊断信息会对不上。

建议：用常量拼接错误文字。

---

## 二、推测 / 未核实

- “新集成用例在修前会失败”是按代码推断的，我未能实际运行测试。旧代码会生成超过 128 的 `memoryId`/`reminderId`，测试最后用 `gatewayV2MessageSchema.parse` 解析快照，按 `machineString` 规则应当失败，但执行结果未核实。
- 生产库中是否已经存在超长 ID 未核实：我没有数据库访问权限。如果存在，上面“高”这一条就是实际的残余故障；如果不存在，影响降为交付前审计问题。
- CI 是否实际执行这个集成用例：`scripts/ci/run.mjs:126` 和 `scripts/ci/check-coverage.mjs:73` 把 `integration` 放进覆盖范围，但具体流水线运行结果未核实。

---

## 三、侧重检查

- **不可信输入**：检查了页面路径的 `owner:${idempotencyKey}`（idempotencyKey 受 `machineString` 1-128 限制）和工具路径的 `${runId}:${toolCallId}`（toolCallId 没有统一长度限制）。压缩逻辑能处理任意长度，`key.slice` 和 SHA-256 都是线性开销，没有新增循环或外部 I/O；但压缩编码与原始 key 共用命名空间，存在上面“中”这一条的可构造冲突。
- **错误路径**：检查了 `create` 的“先查重、再写 memory、再写 reminder”顺序。新 key 下同一命令重试是确定性的；但旧长 key 在新版本重试会查不到旧记录，造成重复写入。
- **安全**：SHA-256 不暴露原文，截断保留的前缀也不是秘密；主要安全问题是可构造的 ID 冲突。没有新增日志泄露或密钥处理。
- **资源耗尽**：没有新增无界集合遍历；哈希长度取决于传入 key，但 key 本身已经在内存里，没有放大效应。新 ID 固定为最长 128/119/127，对 DB 和快照更安全。
- **不可撤销的操作**：创建提醒/记忆是写入操作。新 key 的写入是确定性的，但旧数据无法自动恢复，重试可能产生重复提醒，这是需要交付前处理的风险。
- **规则与文档一致性**：读了 `.claude/rules/prompt-prefix.md` 和 `docs/incidents-and-gates.md` 的 I-73。代码没有改动系统提示、工具定义、历史消息或遮盖逻辑；但作者“完全不改发给模型的内容”的说法对“长 key 的新工具结果”并不严格成立：长 key 现在返回的是哈希后的 `reminderId`，与旧代码不同，只是它作为新工具结果追加在末尾，不改写旧前缀。作者“runId 长度不受限”的说法也与 `packages/domain/src/identifiers.ts` 不符。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会改变已经发出的系统提示、工具定义、历史消息和遮盖结果。改动只影响新创建提醒时生成的 `memoryId`/`reminderId`/`contentRef`；工具结果按现有机制追加在末尾，没有改写历史。

但需要修正作者的说法：对于超过临界长度的 key，新的工具结果里的 `reminderId` 会和旧代码产生的不同。这是新增内容，不是请求开头变化，符合“只在末尾追加”。

### 2. 同一段文字在不同请求里会变成不同字节吗？

不会因为这次改动而变成非确定值。`sha256(key)`、截断长度、拼接顺序都是固定的，没有时间字段、无序集合或前后文相关处理。相同 key 每次都得到相同字节。不同请求本来就会因为 runId/toolCallId/idempotencyKey 不同而得到不同 ID，这是原有设计；这次没有引入新的不确定性。

### 3. 有没有自动检查，反向用例会失败吗？

有。新增 `test/integration/production-memory-capture.test.ts:1751-1804`，它用页面路径和工具路径各造一个长 key，然后对 `memory.overview.snapshot` 走 `gatewayV2MessageSchema.parse`。旧代码生成的超长 ID 会违反 `machineString`，所以这是有效的反向用例（按代码推断，未实际运行）。它由 integration/coverage 测试范围执行，ไม่是 `npm run check` 里的独立 gate。

不足：没有覆盖“旧库中已经存在的长 ID”，也没有覆盖“哈希形式与原始短 key 冲突”的情况。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对如下：

- `reminderId`：新值最长 128。快照 `reminders[].reminderId`/`upcoming[].reminderId` 用 `machineString`（`contracts-v2.ts:1692-1704`），`memory.reminder.respond` 也要求 `machineString`（`1802-1807`），home key 是 `reminder:${reminderId}` 且上限 160（`production-home.ts:235,533`，`contracts-v2.ts:646`），web push `sourceKey` 上限 256（`production-web-push.ts:327`，migration `0058_web_push.sql:25`），DB 是 `TEXT` 无长度约束。新值都能接受。
- `memoryId`：新值最长 119。快照 `memories[].memoryId` 和 `upcoming[].memoryId` 都是 `machineString`（`contracts-v2.ts:1628-1630,1701-1704`），home 的 `fitsMachineStrings` 也接受（`production-home.ts:593-595`），DB `TEXT` 无长度约束。新值都能接受。
- `contentRef`：新值最长 127。快照 `sourceRefs` 用 `boundedString(512)`（`contracts-v2.ts:1638`，`MEMORY_SOURCE_REF_MAX_LENGTH = 512`），`memorySourceState` 仍能靠 `memory-content:reminder:` 前缀识别（`memory-source.ts:1,35`），payload 表引用也无 128 限制。新值都能接受。
- `MACHINE_STRING_MAX_LENGTH`：已导出并被 `machineString` 和 writer 使用，依赖关系成立。
- 不接受的一端：已经存在的旧长 ID。它仍会被快照的 `machineString` 拒绝，而且在新代码下重试会生成重复记录。这是 I-73 所说的“只检查改动本身，没有检查已有数据和所有使用端”的残余风险。
