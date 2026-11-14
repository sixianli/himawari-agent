## 结论

第 4 轮增量（`46053c49`，即 `f86e982b..46053c49`）只改了 `production-login-devices-control.ts` 和它的单测。我逐行核对了仓库中的真实 `revokeDevice`/`listDevices` 实现，**未发现高、中严重度问题**；作者关于该增量的两条说法与代码一致。下面列低严重度观察与测试缺口，并区分「读代码证实」与「推测」。

## 低严重度问题

### 低-1　测试没有真正钉住「原样抛出原来的错误」
- 文件：`apps/agent-service/test/production-login-devices-control.unit.test.ts:198`
- 问题：作者说「原样抛出原来的错误」，但用例只断言 `code` 和 `message`。
- 证据：
  ```ts
  await expect(devices.execute(revokeOthers() as never)).rejects.toMatchObject({
    code: PORT_ERROR_CODES.CONFLICT,
    message: "disk headroom",
  });
  ```
  原错误还带有 `{ reason: "disk_headroom" }`（测试第 190-192 行构造），但未断言。若实现改成新建一个同 code、同 message 的 `ApplicationPortError`，这条用例仍会通过。
- 建议：补断言 `details`（或在 stub 中记录错误对象并断言 `toBe` 同一实例），才真正锁住「原样」。

### 低-2　重读列表失败会吞掉已捕获的冲突错误
- 文件：`apps/agent-service/src/production-login-devices-control.ts:127`
- 问题：`remaining = await listDevices(...)` 没有任何兜底；一旦重读本身失败，已记录在 `conflicts` 里的原始错误就丢失，客户端看到的是重读错误而不是原冲突。
- 证据：
  ```ts
  remaining = (await this.#options.state.listDevices(ownerId, false)).filter(
    (device) => device.id !== authentication.deviceId,
  );
  for (const device of remaining) {
    const conflict = conflicts.get(device.id);
    if (conflict && conflict.revision === device.revision) throw conflict.error;
  }
  ```
- 说明：重读是读操作，生产路径极少失败；这是错误路径上的信息保真问题，不是功能错误。
- 建议：把重读包在 `try/catch`，在重读失败且存在已记录冲突时抛出原冲突（或把重读错误作为 `cause`），避免掩盖。

### 低-3　SQLITE_BUSY 现在完全不重试
- 文件：`apps/agent-service/src/production-login-devices-control.ts:130`；`packages/persistence-sqlite/src/sqlite-worker.ts:990`
- 问题：本次修复把所有「修订号未变」的 `PORT_CONFLICT` 立即抛出。`SQLITE_BUSY` 也会被映射成 `PORT_CONFLICT`（`sqlite-worker.ts:990-996`），因此瞬时 busy 不再有任何重试。
- 证据：
  ```ts
  if (conflict && conflict.revision === device.revision) throw conflict.error;
  ```
  ```ts
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_FULL") {
    return { kind: "application", code: "PORT_CONFLICT", ... };
  ```
- 说明：这正是作者本轮想要的「存储冲突原样抛出」，不是回归；只是 busy 的瞬时恢复机会一并消失。属于设计取舍，建议在说明或 ADR 里写明。
- 建议（可选）：若要保留 busy 恢复，可在 `details.sqliteCode === "SQLITE_BUSY"` 时做少量有退避的重试，但绝不改报 `LOGIN_DEVICES_STILL_CHANGING`。

## 读代码证实的核对结果

1. **增量逻辑与作者说法一致**：冲突后重读（第 127-129 行），仅当同一设备仍在 `remaining` 且 `conflict.revision === device.revision` 时抛原错误（第 130-133 行）；修订号变了则不抛、进入下一轮；`REVOKE_OTHERS_ATTEMPTS = 3`（第 30、111-115 行）。
2. **「存储冲突」确实会产生 `PORT_CONFLICT` 且不改修订号**：磁盘余量见 `sqlite-worker.ts:643-652`（`PORT_CONFLICT` + `reason: "disk_headroom"`）；`revokeProductDevice` 在事务前就调用 `assertDiskHeadroom()`（`sqlite-durable-operations.ts:5062`），失败不会加修订号；busy 映射见 `sqlite-worker.ts:990-996`。
3. **真正的修订号冲突会改修订号**：`revokeProductDevice` 成功时 `revision = revision + 1`（`sqlite-durable-operations.ts:5069-5082`），所以「修订号变了＝设备被并发改动」的判据成立。
4. **单测确实钉住了两件事**：持续冲突时 laptop 恰好 3 次（测试第 179 行），存储冲突只尝试一次且原错误冒出（测试第 182-203 行）。去掉第 130-133 行的判断，该用例会因变成 `LOGIN_DEVICES_STILL_CHANGING` 且 attempts=3 而失败。
5. **作者「不改的」说明与代码一致**：文件列表 `threadTitle(...).catch(() => null)`（`production-files-control.ts:72`），审批卡片 `try/catch -> null`（`production-approval-display.ts:75-79`）；分类白名单同为 `public`/`private`（`classified-thread-title.ts:9`、`service-main.ts` 旧逻辑等价）。

## 推测（未经端到端验证）

- **取消导出后立刻重新开始可能返回 BUSY**：`cancel` 只改状态并 abort（`production-data-export.ts:273-292`），`#building` 要等 `buildNow` 的 `finally` 才复位（第 196-202 行）。若构建卡在不可中断的 zip 打包阶段，紧接着 `start` 会命中 `DATA_EXPORT_BUSY`。属整轮 PR 的既有新逻辑，不是本轮增量；建议 UI 侧或测试明确这一时序，或让 `cancel` 在 busy 期间对同 owner 的 start 排队。
- **新增 `files.list.snapshot.threadTitle` 的分类降级**：字段只允许 public/private 标题，但快照的 `dataClassification` 是 `...query` 带来的。若客户端可把查询声明为 public 而拿到 private 标题，则是分类标注问题；但文件 `name` 也有同样形态，是否为既有约定我未核实，故不列为成立问题。

## 侧重检查

- **错误路径**：冲突捕获/重抛、修订号比较、重读失败（低-2）、非 `ApplicationPortError` 直接透传（第 121-124 行）均核对。结论：非冲突错误仍会中断整批，属既有行为。
- **不合规范/不可信输入**：`login.devices.revoke_others` 的 `recentAuthenticationRef` 为 `nullable(machineString)`（`contracts-v2.ts:949-952`），带空格的 ref 在契约测试中被拒绝；`exportId` 由 `DATA_EXPORT_ID_PATTERN` 校验（`contracts-v2.ts:802、809`），与生成格式 `data-export:` + 16 字节 base64url（22 字符，`production-data-export.ts:231`）一致。
- **安全**：新增 `threadTitle` 走 owner/agent 作用域读取，分类只放行 public/private（`classified-thread-title.ts:15-30`），sensitive/restricted 返回 null；HTTP 网关错误只回 `error.code`，不泄露内部 message（`http-gateway-server.ts:883-893`）。
- **资源耗尽**：文件列表每个不同 `threadId` 串行读标题，页上限 `FILE_LIST_PAGE_LIMIT = 100`，有界；导出进度/取消未引入无界缓存。`revoke_others` 最多三轮，有界。
- **不可撤销操作**：`revoke_others` 可能部分成功后再抛错（先撤销的设备不会回滚），重试会继续撤销剩余设备；这是多设备操作固有的部分完成语义，建议在客户端提示「部分设备已退出」。
- **规则/文档与代码一致性**：`ci/operations-pending.json` 对 `data.export.cancel` 与 `login.devices.revoke_others` 的描述（已实现、有测试、缺调用方；无其他设备时 replayed；取消作废已生成结果）与代码一致；`check-operations.mjs` 要求「有实现、有测试、缺调用方」才允许留名单，这两项满足。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本轮增量只改网关控制命令（设备撤销），不组装系统提示、工具定义或历史；`classifiedThreadTitleReader` 只接到审批展示（`production-file-read-workflow.ts:267`）和文件列表网关快照（`production-http-composition.ts:1251`），不是模型输入，且其语义与旧内联实现逐行等价。因此「只在末尾追加」的约束未被触碰；每轮变化值也没有被放进请求头。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会影响模型输入。标题读取只做 `trim()` 与确定性分类过滤，`displayText` 对同一输入确定性截断/替换；`progress`、`generatedAt` 等时间相关值只出现在网关状态/文件列表响应里，不在请求前缀。
3. **有没有对应的自动检查，反向用例会失败吗？** 有：`production-login-devices-control.unit.test.ts` 新增两条用例，`production-http-composition.unit.test.ts` 有端到端 `revoke_others`/`cancel` 用例，契约测试覆盖新消息与字段。反向：删掉「修订号未变就抛出」，存储冲突用例会失败（变为 `LOGIN_DEVICES_STILL_CHANGING` 且尝试 3 次）；把判断改成「任何冲突都抛」，持续修订冲突用例会失败（不再重试成功）。唯一没锁住的是「原样」的错误细节（低-1）。
4. **新增/修改值的生产端与使用端是否都能接受？** 已逐个核对：
   - `data-export:<22>`：生成端 `production-data-export.ts:231` 与契约 `DATA_EXPORT_ID_PATTERN`、`data.export.cancel`/`status.read`/下载路由一致。
   - `cancelled` 状态：`DATA_EXPORT_STATES`（`contracts-v2.ts:794`）、`DataExportJob.state`、`view`、控制层、HTTP 路由（非 ready→404）一致。
   - `progress`：生产端 `export.ts:99-122` 每段最多加到 total，控制层仅 running 时输出（`production-data-export.ts:382`），契约要求 running 且 `textsRead <= textsTotal`（`contracts-v2.ts:850-860`），测试覆盖。
   - `threadTitle`：生产端唯一在 `production-files-control.ts:84`，契约为 `nullable(boundedString(256))`，`displayText` 上限 256，fixture/契约测试已更新；构造 `ProductionFilesControl` 的 4 处都传了该依赖。
   - `login.devices.revoke_others`：类型表、schema、`installedOperations`、网关 `login.` 路由、`operations-pending` 均一致，payload 的 nullable ref 有正反契约用例。
   - 未发现「清单里的 id/字段能通过生产端却过不了使用端校验」的 I-73 类缺口。
