## 读代码证实的问题

### 中：`revoke_others` 把存储/事务类 `PORT_CONFLICT` 当成修订号冲突，违背作者“其他错误原样抛出”的说法

- 文件：`apps/agent-service/src/production-login-devices-control.ts:116-130`
- 证据：

```ts
for (const device of remaining)
  await this.#options.state
    .revokeDevice(device.id, device.revision, revokedAt)
    .catch((error: unknown) => {
      if (
        !(error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT)
      )
        throw error;
    });
...
if (remaining.length > 0)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "LOGIN_DEVICES_STILL_CHANGING");
```

`revokeDevice` 的 `PORT_CONFLICT` 不只表示修订号过期：

- `packages/persistence-sqlite/src/sqlite-durable-operations.ts:5062-5068`：`revokeProductDevice` 先调用 `assertDiskHeadroom()`，随后修订号不符或设备已非 `active` 时都报 `PORT_CONFLICT`。
- `packages/persistence-sqlite/src/sqlite-worker.ts:643-652`：磁盘余量不足时抛 `applicationFailure("PORT_CONFLICT", ..., { reason: "disk_headroom" })`。
- `packages/persistence-sqlite/src/sqlite-worker.ts:990-996`：`SQLITE_BUSY` / `SQLITE_FULL` 也被映射成 `code: "PORT_CONFLICT"`。

因此磁盘满、SQLite busy/full、事务作用域冲突等都会被这个 `.catch` 吞掉并重试三次，最后错误地报成 `LOGIN_DEVICES_STILL_CHANGING`，而不是作者说的“存储故障原样抛出”。

- 建议：在 `revokeProductDevice` 的修订号冲突上附带独立的原因码（例如 `details.reason = "stale_revision"`），这里只重试该原因码；`disk_headroom`、`sqliteCode`、事务作用域类冲突立即抛出。并补一条“存储冲突不得重试、必须原样抛出”的反向用例。

### 低：文件列表标题读取的 `catch` 范围大于作者说法，会静默吞掉存储/鉴权错误

- 文件：`apps/agent-service/src/production-files-control.ts:70-74`
- 证据：

```ts
for (const threadId of new Set(page.items.map((artifact) => artifact.threadId))) {
  const title = await this.#options.threadTitle(threadId).catch(() => null);
  titles.set(threadId, title === null ? null : displayText(title));
}
```

作者只说明“荷载缺失、解密失败时该行 `threadTitle` 为 null”，但这里连 `threads.read` / `payloads.get` / `unprotect` 的存储故障、鉴权错误、程序错误都一并吞掉，整页仍返回且所有标题变 null，排障时看不到任何异常。

- 建议：只捕获明确的“标题不可读”错误（荷载不存在、非 `text/plain`、解密失败等）；存储/鉴权错误应向上抛，或至少写一条诊断日志。相应补一个“存储错误不被吞掉”的反向用例。

### 低：冲突重试用例没有钉住“最多三轮”和“非修订号冲突原样抛出”

- 文件：`apps/agent-service/test/production-login-devices-control.unit.test.ts:133-177`
- 证据：用例名写 “gives up after three rounds”，但只断言最终 `active` 集合和最终错误；没有统计 `revokeDevice` 调用次数，也没有构造“存储类 CONFLICT”用例。即使实现重试 100 次，或者错误地把磁盘满也当成修订号冲突，这个用例仍会通过。

```ts
const always = build(99);
await expect(always.devices.execute(revokeOthers() as never)).rejects.toMatchObject({
  code: PORT_ERROR_CODES.CONFLICT,
  message: "LOGIN_DEVICES_STILL_CHANGING",
});
```

- 建议：用计数器断言每台设备的尝试轮数恰为 3；加一条 `details.reason = "disk_headroom"` 的冲突，断言立即抛出且不再重试。

## 推测/未核实

- `clients/apple` 里没有 `files.list`、`data.export.*`、`login.devices.revoke_others` 的 Swift 调用方，因此外部 iOS 端是否能接受“新增必填 `threadTitle`”“删除 `progress.stage`”“新增 `cancelled` 状态”未核实。`ci/operations-pending.json` 也写明这些调用方属于尚未合并的 iOS 第 11 批。
- `.agents/reviews/pr-477/round-2/` 在当前离线工作区中不存在，`git show` 读取该路径也被限制，作者“判断记在 round-2”的说法未核实。
- 受工具限制未运行测试；“反向用例会失败”是基于读代码的判断，不是实际执行结果。

## 侧重检查

- **错误路径**：核对了取消不存在的导出（404）、取消已失败导出（409）、取消生成中/已生成导出、标题读取失败、`revoke_others` 冲突重试。发现上述 `PORT_CONFLICT` 分类过宽问题。
- **不可信输入**：`exportId` 受 `DATA_EXPORT_ID_PATTERN` 约束；`recentAuthenticationRef` 受 `machineString` 约束且 `null` 会被最近验证守卫拒绝；标题经 `displayText` 替换控制字符/双向控制符并按 256 截断。未发现新的注入或越界路径。
- **安全**：文件标题只显示 `public`/`private`；`revoke_others` 用会话所属 owner/agent 取设备并排除当前设备，且要求最近验证；导出取消仍要求 owner actor 和匹配 scope。未发现越权读取/退出当前设备。
- **资源耗尽**：文件页标题最多按页内唯一对话数读取（页上限 100）且串行；`revoke_others` 最多 3 轮；导出取消会触发 `AbortSignal`，但取消接口在后台构建真正退出前就返回，紧接着 `start()` 仍可能因 `#building` 报 `DATA_EXPORT_BUSY`（`production-data-export.ts:228`），测试里是等 `jobs.busy` 变 false 后才重新开始。这是可接受但值得告知客户端的行为。
- **不可撤销操作**：`revoke_others` 在部分设备已成功退出、后续仍冲突时会返回 `CONFLICT`，响应里没有说明哪些设备已被退出；重试可以继续，但调用方无法从这一次响应判断部分成功。建议在错误 `details` 中附带已退出/剩余设备，或明确文档化。
- **规则/文档与代码一致**：本改动不涉及模型请求组装；`docs/adr/0183` 的“文件页标题显示原文”与代码一致；未发现文档仍引用 `DATA_EXPORT_STAGES` 或 `progress.stage`。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本改动只涉及网关响应、导出任务和登录设备控制；唯一接近模型链路的 `classifiedThreadTitleReader` 是对原 `approvalThreadTitle` 内联逻辑的原样抽取（`apps/agent-service/src/classified-thread-title.ts:17-34`），且只被审批展示和文件列表使用（`apps/agent-service/src/production-file-read-services.ts:59-60`、`production-http-composition.ts:1251-1256`），不进入系统提示、工具定义或历史。发给模型的内容仍是只追加，变化值仍在最后一条消息，符合 `.claude/rules/prompt-prefix.md#rules` 第 2、4 条。

2. **不会让同一段模型相关文字在不同请求里变成不同字节。** 标题读取、`displayText` 截断和分类过滤都是确定性的；文件列表里的 `threadTitle` 也不是模型输入。导出进度 `textsRead/textsTotal` 随时间变化，但只出现在网关状态快照，不进入模型请求；导出文件本身的排序沿用既有逻辑。

3. **有自动检查，但覆盖不完整。** 文件标题：`production-files-control.unit.test.ts` 覆盖“抛错→null”和“每对话只读一次”，去掉 `.catch` 或去重都会失败；`sqlite-thread-artifacts.test.ts` 覆盖 restricted/blank/非 `text/plain`/缺失。重试：`production-login-devices-control.unit.test.ts` 的 `build(1)` 在旧的无重试实现下会失败，持续冲突的错误文案也会失败；但它没有真正验证“恰好三轮”和“存储类冲突不重试”。进度：契约测试已去掉 `stage`，`object()` 会拒绝未知字段（`packages/gateway-contracts/src/validation.ts:174-176`），旧 `stage` 重新出现会导致契约失败。未实际运行测试。

4. **逐项核对结果：**
   - `exportId`：产生处 `randomBytes(16).toString("base64url")`，匹配 `DATA_EXPORT_ID_PATTERN` 的 22 位限制；取消命令、状态查询、HTTP 下载路由三处同用该模式，能够接受。
   - `cancelled` 状态：由 `DataExportJobs.cancel/view` 产生，`DATA_EXPORT_STATES` 和下载路由都能接受；仓库内没有其他消费者。
   - `progress.textsRead/textsTotal`：由 `buildPortableExport` 的 `onProgress` 产生，契约要求非负整数且 `textsRead <= textsTotal`，`ProductionDataExportControl.query` 只在 `running` 时下发，能够通过校验。
   - `files.list.snapshot.threadTitle`：由 `ProductionFilesControl` 经 `displayText` 产生（UTF-16 长度上限 256、控制字符替换为 U+FFFD），契约 `nullable(boundedString(256))` 用 `.length` 且拒绝控制字符，两端一致；仓库内没有调用方，未来 iOS 端未核实。
   - `login.devices.revoke_others`：payload 的 `recentAuthenticationRef` 契约允许 `null` 或 `machineString`，控制层把它交给最近验证守卫，`null` 会被拒绝；测试覆盖了字符串和 `null`。
   - `ci/operations-pending.json`：`scripts/check-operations.mjs` 允许“后端实现 + 测试存在、仅缺调用方”的操作留在清单；两个新操作符合该条件，理由长度也满足要求。
   - `LOGIN_DEVICES_STILL_CHANGING`：大写字母加下划线，满足 `machineString`，映射为 `PORT_CONFLICT`；但如“中”级问题所述，它会在一些存储故障场景被误用。
