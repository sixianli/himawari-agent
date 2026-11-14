## 结论

改动本身的核心长度计算是对的：key 压缩后为 103 字符，`memoryId` 119、`reminderId` 128、派生 `contentRef` 127，都在 `machineString` 的 1-128 范围内；`SHORTENED_KEY` 也补上了一个真实的别名碰撞。但存在一个已证实的测试回归，以及对旧数据的明显缺口。

## 问题（按严重度）

### 1. 高 — 现有集成测试会失败，作者“修后通过”的说法不完整
- 文件：`test/integration/memory-source-report.test.ts:55-57`
- 问题：该测试仍然断言 writer 源码里包含 `memory-content:reminder:${input.key}`，但 writer 已经改成用压缩后的 `${key}`。`ci/policy.json` 的 integration 项目包含 `test/integration/**/*.test.ts`，因此 CI 的 coverage 会跑到它。
- 证据：
  ```ts
  // test/integration/memory-source-report.test.ts:55-57
  expect(await read("apps/agent-service/src/production-reminder-writer.ts")).toContain(
    `\`${REMINDER_SOURCE_PREFIX}\${input.key}\``,
  );
  ```
  ```ts
  // apps/agent-service/src/production-reminder-writer.ts:210
  contentRef = `memory-content:reminder:${key}`;
  ```
  测试期望的字面量是 `${input.key}`，实际源码是 `${key}`，`toContain` 不会命中。
- 建议：把断言改为 `${key}`，更好的做法是改成行为断言（创建后检查 payload ref / `sourceRefs` 仍以 `memory-content:reminder:` 开头且长度合法）。作者列出的检查文件里没有这个测试，应重新跑完整 integration。

### 2. 中高（是否触发取决于生产已有数据，未核实）— 旧超长 ID 没有被修复，且重放会生成重复提醒
- 文件：`apps/agent-service/src/production-reminder-writer.ts:183-186`、`apps/agent-service/src/production-memory-control.ts:539-548`、`packages/gateway-contracts/src/contracts-v2.ts:753-754,1805`
- 问题：压缩只发生在新建时。部署前已经存在的超长 `reminderId`/`memoryId` 仍原样返回，`upcomingViews` 不做过滤或重映射，快照仍会校验失败；同时 `memory.reminder.respond` 的 `reminderId` 仍是 `machineString`，旧超长提醒仍然无法取消。部署后用同一个 key 重放时，新代码查的是压缩后的 ID，找不到旧记录，会新建第二条提醒（提醒通知不可撤销）。
- 证据：
  ```ts
  // production-reminder-writer.ts:183-186
  const key = reminderKey(input.key);
  const memoryId = `${MEMORY_ID_PREFIX}${key}` as MemoryId;
  const reminderId = `reminder:${memoryId}`;
  const existing = await this.#options.reminders.read(reminderId);
  ```
  ```ts
  // production-memory-control.ts:539-546
  upcoming.push({
    reminderId: reminder.id,
    memoryId: reminder.memoryId,
    ...
  });
  ```
  ```ts
  // contracts-v2.ts:753-754, 1805
  reminderId: machineString,
  memoryId: machineString,
  ...
  reminderId: machineString,
  ```
- 建议：上线前只读查一次是否已有 `length(id) > 128` 的提醒/记忆；若有可能存在，需要一次性迁移/重映射，或在读取时显式过滤并记录，不能让整页快照失败。作者“不迁移旧数据”的约束与“修复后记忆页可用”并不自动兼容。

### 3. 低 — “放得下原样用”已不完全成立；已有短 key 也可能换 ID
- 文件：`apps/agent-service/src/production-reminder-writer.ts:45-52`
- 问题：为防别名，任何以 `.` + 64 位十六进制结尾的 key（即使长度完全放得下）也会被重新哈希。作者说明里“放得下原样用；放不下才压缩”与代码不一致。若部署前已存在这种短 key 的提醒，部署后同样会查不到旧记录并可能重复创建。
- 证据：
  ```ts
  const SHORTENED_KEY = /\.[0-9a-f]{64}$/u;
  function reminderKey(key: string): string {
    if (
      REMINDER_ID_PREFIX.length + key.length <= MACHINE_STRING_MAX_LENGTH &&
      !SHORTENED_KEY.test(key)
    )
      return key;
  ```
- 建议：在说明里写清这个例外；上线前确认没有这种 key，或和上一条一起做兼容处理。这是有意的碰撞防护，不建议去掉。

### 4. 低 — “两个不能漂移”只覆盖了 gateway-contracts
- 文件：`packages/execution-contracts/src/validation.ts:47-54`
- 问题：`MACHINE_STRING_MAX_LENGTH` 只在 `gateway-contracts` 内统一，`execution-contracts` 仍硬编码 `128` 和 `1-128`。当前提醒 ID 不经过 execution-contracts，所以没有功能影响，但“两个不能漂移”的说法不成立于整个仓库。
- 证据：
  ```ts
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
  ) {
    fail(path, "expected a 1-128 character machine string");
  }
  ```
- 建议：若要把上限作为单一来源，两个合约包都改用它；至少不要让提交说明暗示所有合约包都已统一。

## 侧重检查

- 错误路径 / 不可信输入：页面的 key 来自 `owner:${idempotencyKey}`，`idempotencyKey` 受 `machineString` 限制（`contracts-v2.ts:184,1809-1816`）；工具 key 经过 `[^A-Za-z0-9:._-]` 替换（`production-reminder-writer.ts:430`）。因此进入压缩函数的 key 是 ASCII，`slice` 不会截断代理对，哈希和点号也都能通过 `machineString`。`create` 是内部方法，外部不可直接传入任意 Unicode key；未发现新的注入路径。
- 安全 / 碰撞：`SHORTENED_KEY` 防住了“攻击者把 key 写成另一条 key 的压缩形态”从而落到同一提醒 ID 的别名问题。我按分支检查过：原始 key 和压缩 key 若要相等，原始 key 必然以 `.` + 64 hex 结尾，从而会进入哈希分支，不会和压缩结果重合；摘要保留完整 64 位 hex，没有截断摘要。
- 资源耗尽：`runId:toolCallId` 仍然没有长度上限，压缩函数会对完整 key 做一次 SHA-256；这是线性开销，改动前也会把完整 key 写入 ID/数据库，所以不是本次新增的放大点。压缩后反而减小了数据库和快照里的字符串长度。
- 不可撤销操作：提醒会发出通知。旧超长记录重放后生成第二条提醒、以及短 key 恰好匹配 `.64hex` 时换 ID 生成重复提醒，都是不可撤销的重复通知风险，见问题 2、3。
- 规则 / 文档一致性：没有改到系统提示、工具定义、历史或遮盖。`prompt-prefix` 规则的要求仍然满足。`docs/adr/0186...` 提到的“页面、脚本、写入端三处一致”语义上仍成立，但对应测试的字面量已过期；作者的“放得下原样用”与代码不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只影响 writer 产生的 `memoryId`、`reminderId` 和派生 `contentRef`，没有触碰系统提示、工具定义、历史或遮盖。长度本来合格的 key（且不以 `.64hex` 结尾）产出的字节完全不变；需要压缩的 key 只会出现在新追加的工具结果或本轮内存/提醒快照里，不会回头改写已存历史。`owner-profile-service` 只用 `reminder.id` 作为排序的 tie-breaker，不把 ID 写进 agenda 文本。依据 `prompt-prefix.md#rules`，只在末尾追加这一条仍成立。我没有运行 `check:prompt-prefix`，这是按代码路径核对的结果。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。压缩只依赖 key：保留固定前 38 字符加完整 SHA-256 hex，不含时间、随机数或无序集合；这些 key 路径都是 ASCII，序列化字节确定。旧 ID 到新 ID 的变化是部署时的一次性变化，不是每轮变化。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，但不全绿。新 integration 用例覆盖了长页面 key、仅末尾不同的两个长 key、压缩形态的 lookalike、长 runId/toolCallId、真实快照校验和取消；其中 lookalike 用例在去掉 `SHORTENED_KEY` 后会真的失败，长 key 用例在旧 writer 下也会失败。问题是：现有 `memory-source-report.test.ts` 现在会失败（问题 1）；派生 `contentRef` 没有被直接断言；新用例只在 integration 项目里，`npm run check` 不会跑到，而作者列的 fast-mode 检查也漏了会失败的那个文件。
4. **每个新值的使用端都能接受吗？** 新产生的值可以：
   - `reminderId` 最大 128，快照 `upcoming.reminderId`（`contracts-v2.ts:753`）和 `memory.reminder.respond`（`contracts-v2.ts:1805`）都能接受；home key 为 `reminder:` + ID，长度不超过 160（`HOME_KEY_MAXIMUM`）。
   - `memoryId` 最大 119，快照 `memoryId`（`contracts-v2.ts:754`）和 home target 都能接受。
   - 派生 `contentRef` 最大 127，`sourceRefs` 用 `boundedString(512)`（`contracts-v2.ts:1638`），且仍以 `memory-content:reminder:` 开头，`memory-source-report.mjs` 的分类逻辑仍成立。
   - `MACHINE_STRING_MAX_LENGTH` 在 `gateway-contracts` 内由 `validation.ts` 和 writer 共用，值一致。

   但**旧值不能**：已经存在的超长 `reminderId` 仍过不了快照和 `memory.reminder.respond` 的 `machineString`（问题 2）；`execution-contracts` 自己的 `machineString` 仍是硬编码 128（问题 4，维护性）。
