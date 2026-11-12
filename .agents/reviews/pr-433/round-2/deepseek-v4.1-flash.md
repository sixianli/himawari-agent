## 复核范围与限制

- 已看 `3086f38..23e6f8d` 全量 diff 和 `9fa963c..23e6f8d` 增量，并读了相关实现、契约、文档和测试。
- `.agents/reviews/pr-433/round-1/judgments.md` 在当前工作树里不存在（`.agents` 未检出），所以第 1 轮意见是否逐条落实，只能按代码判断，**未核实**。
- 按工具限制没有运行测试，下面“反向用例会失败”是读代码推断，不是执行结果。

## 读代码证实的问题（按严重度）

### 1. 中：崩溃恢复重做删除时丢失 `overlapped`，恢复出来的删除判断和第一次不同

- 文件:行：`apps/agent-service/src/production-coding-workflow.ts:573-580, 587-593, 620-636`；`apps/agent-service/src/production-thread-artifacts.ts:193-206`
- 问题：作者说“恢复时按存下的对比结果补做登记，重做是幂等的”。登记本身确实按 `(runId, toolCallId, path)` 去重（`sqlite-thread-artifact-operations.ts:121-129`），但删除分支不是：第一次是否去检查文件是否仍存在，取决于 `overlapped`；而 `overlapped` 每次调用现场计算，**没有**存进 `workspace-changes` 或 `workspace-artifacts`。重启后 `#running` 是空的，恢复时 `overlapped` 变成 `false`，`recordDeleted` 就会跳过 `#isMissing`，把第一次本来不会标删除的路径直接标成删除。
- 证据：
  - `production-coding-workflow.ts:578-580`：`overlapped = finishOverlap?.() ?? false;`
  - `production-coding-workflow.ts:587-593`：`identity` 只有 runId/toolCallId/threadId/grantId/command，没有 `overlapped`。
  - `production-coding-workflow.ts:635`：`ctx.save("workspace-artifacts", { dropped: droppedChanged || droppedDeleted })`，只存 `{dropped}`。
  - `production-thread-artifacts.ts:193-205`：只有 `input.overlapped` 为真时才调用 `#isMissing` 过滤。
- 影响：重启恰好落在“对比结果已存、登记未完成”之间，且原来与另一条命令重叠时，恢复可能多标删除；如果被标删除的行不是最新版本，文件夹视图多数时候会被别的线程更新版本盖住，但如果那个更新登记失败，视图就会显示错误状态。至少可以确定：恢复没有忠实复现第一次的删除判断，和“重做是幂等的”不完全一致。
- 建议：把 `overlapped` 连同 `workspace-changes` 或 `workspace-artifacts` 一起持久化，恢复时使用存下的值；或者更稳妥地，在恢复删除时一律先做 `#isMissing` 检查（把“查不出来”记为不完整），不要依赖当前进程的重叠状态。补一条“重叠删除 + 重启恢复”的用例。

### 2. 中：`workspace.changes.read` 没有按出口契约校验存储里的路径，控制字符文件名会让整个响应违反契约

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:157-165`；`packages/gateway-contracts/src/contracts-v2.ts:2166-2177`；`packages/gateway-contracts/src/validation.ts:89-105`；`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:107-117`
- 问题：`folders.read` 会逐条用 `workspaceFolderSchema` 校验，但 `changes.read` 直接把 `changedFiles()` 的 `path/threadId/source/changedAt/deletedAt` 原样塞进 snapshot。契约要求 `path: boundedString(1024)`，而 `boundedString` 明确拒绝控制字符；存储端对 `path` 只检查长度 1 到 1024（迁移里也是 `CHECK (length(path) BETWEEN 1 AND 1024)`），没有拒绝换行、制表符等。模型通过 `bash` 创建一个带换行的文件名，就能登记出这种路径。
- 证据：
  - `contracts-v2.ts:2168`：`path: boundedString(1024),`
  - `validation.ts:96-99`：含 `code < 0x20 || code === 0x7f` 即失败。
  - `sqlite-thread-artifact-operations.ts:114-115`：只检查 `artifact.path.length === 0 || artifact.path.length > 1024`。
  - `production-workspace-changes-control.ts:157-165`：`items: page.items.map(...)`，没有 `parse`/跳过/转义。
- 影响：HTTP 路由直接 `sendJson`，不校验出站 snapshot；客户端 `gateway-client.ts:268-271` 会用 `gatewayV2MessageSchema.parse` 解析。只要该授权目录下有一条控制字符路径，整个 `workspace.changes.read` 响应就会在客户端抛错，页面无法显示该目录的改动，且这条坏记录会持续存在。这是 I-73 说的“一个值只在产生端认、使用端没认”的同类问题。
- 建议：出站前用契约 schema 校验每条 item；不合格的记录记日志并让本次响应 `incomplete: true`（或过滤掉并标记不完整），不要返回违反契约的整个快照。也可在登记入口拒绝控制字符路径并把登记失败折算成不完整标记。补一条“路径含换行”的反向用例。

### 3. 低：`grantActive` 用未规范化的字符串比较过期时间，和 `folders.read` 的行为不一致

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:150`；`apps/agent-service/src/production-run-policy.ts:254-264`；`apps/admin-cli/src/workspace-command.ts:43-55, 141-152`；`apps/agent-service/src/production-workspace-changes-control.ts:64-66`
- 问题：新增的 `grantActive = displayPath !== null`，而 `configuredWorkspaceRoot` 判断过期用的是 `grant.expiresAt <= clock.now()` 原始字符串比较。`workspace grant` CLI 只要求 `Number.isFinite(Date.parse(expiresAt))`，不要求规范 UTC，也不做归一化，然后原样存进状态。带时区偏移的过期时间在字符串比较下可能被判成“未过期”。同一个授权目录在 `workspace.folders.read` 里已经先做了 `new Date(...).toISOString()` 归一化，两处结论可能相反。
- 证据：
  - `production-run-policy.ts:260`：`grant.expiresAt <= clock.now() ||`
  - `production-workspace-changes-control.ts:65-66`：`const expiresAt = new Date(grant.expiresAt).toISOString(); if (expiresAt <= new Date(now).toISOString()) return null;`
  - `workspace-command.ts:53`：`!Number.isFinite(Date.parse(expiresAt))`；`:150`：`expiresAt,` 原样传入。
- 影响：新字段的唯一语义是“这个授权目录现在是否有效”，在非规范存储值下可能给出错误答案；`workspace.folders.read` 和 `workspace.changes.read` 对同一个授权可能一个不列、一个说 active。
- 建议：`configuredWorkspaceRoot` 同样用 `Date.parse`/`toISOString` 比较；CLI 侧拒绝非规范时间（`new Date(expiresAt).toISOString() !== expiresAt`），或在写入时归一化。补一条带 `+09:00` 偏移、已过期的用例。

### 4. 低：缺少 `revokedAt` 的损坏授权记录会被当成“未撤销”列出来

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:64`
- 问题：`if ((grant.revokedAt ?? null) !== null) return null;` 会把 `undefined` 和 `null` 都当成未撤销。正常写入会写 `revokedAt: null`，但如果存储记录损坏、字段缺失，这条记录会被当成有效目录返回，而不是像其他坏记录一样跳过。
- 证据：`production-workspace-changes-control.ts:64` 的 `?? null` 合并；同文件 57-63 的坏记录检查没有涵盖 `revokedAt` 缺失。
- 建议：对损坏输入用显式条件 `grant.revokedAt === null`；如果要求“缺字段即坏记录”，在 57-63 的预检查里一并要求 `revokedAt` 是 string 或 null。补一条缺 `revokedAt` 的用例。

### 5. 低：`workspace.folders.read` 对失效/损坏记录做无页数上限的全量扫描

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:90-104`
- 问题：为了“跳过失效记录、继续找有效目录”，循环会一直分页，直到有效目录超过 200 或读完整个前缀。如果主人/agent 的授权记录里积累了大量已撤销、已过期或损坏记录，每次 `workspace.folders.read` 都要扫完它们；返回最多 200 条，但数据库工作量没有上限。这个读操作已对已登录会话开放，授权记录数量又长期只增不减。
- 证据：`while (!exhausted && folders.length <= WORKSPACE_FOLDER_LIST_LIMIT)`，`afterKey = records.at(-1)?.key ?? null;`，`exhausted = records.length <= WORKSPACE_FOLDER_LIST_LIMIT;`，没有最大页数。
- 建议：加最大扫描页数/最大记录数上限，超过就返回 `truncated: true` 并记日志；或者维护“有效授权目录”的索引/投影，而不是每次全量翻状态表。文档里最好写明这个上限。

### 6. 低：标记写失败会让已经成功的 `write`/`edit` 调用报错，存在重复写的风险

- 文件:行：`apps/agent-service/src/production-coding-workflow.ts:638-644, 671-676`；`apps/agent-service/src/production-workspace-change-marks.ts:60-62`
- 问题：作者明确说“写标记失败仍让这次工具调用抛错”是有意保留。对 `bash` 来说，重试通常复用已保存的 phase；但 `write`/`edit` 在文件已经成功修改之后才调用 `markIncomplete`，标记写失败会把这次工具调用变成失败。模型看到失败可能重试同一个写操作；如果执行层没有按 handle 幂等复用，就可能重复写。即使重复写是幂等的，把“文件已写成功、只是完整性标记失败”报成工具失败也不准确。
- 证据：`production-coding-workflow.ts:671-676` 在 `recordThreadArtifacts` 返回不完整时直接 `await markIncomplete(...)`；`production-workspace-change-marks.ts:60-62` 在重读也失败时 `throw error`。
- 建议：把“完整性标记写失败”和“工具执行失败”分开记录：工具结果照常返回，另写一条可重试的待办/日志，并在下次读时按“未知即不完整”处理。若坚持抛错，至少确认执行层对 `write`/`edit` 的 phase 有幂等复用，并补一条“标记失败后重试不重复写”的用例。

## 侧重检查

- 错误路径：`recordDeleted` 的 `markDeleted` 失败、`#isMissing` 失败、`overlapped` 分支都看了；`markDeleted` 失败会返回 `true`，`overlapped` 且查不出存在性也会返回 `true`，调用处会写不完整标记，符合作者说法。恢复路径的 `overlapped` 丢失是实际缺口（问题 1）。
- 不合规范/不可信输入：授权记录坏 JSON、坏时间、错误 id、缺 `revokedAt` 都走 `#folder`；坏时间、键不匹配、字段过不了 schema 会跳过并记日志，符合说法；缺 `revokedAt` 不会跳过（问题 4）；`thread_artifacts.path` 只限长度，控制字符能进入新读接口（问题 2）。
- 安全：`workspace.folders.read`/`workspace.changes.read` 只使用配置的 `ownerId`/`agentId`，HTTP 层已有 owner/agent scope、session 和 authorization 校验；没有发现跨 owner/agent 读取。`grantId` 只影响是否匹配路由，不参与 SQL 拼接；SQL 参数化，没发现注入。
- 资源耗尽：`folders.read` 有全量扫描无上限（问题 5）；`changes.read` 每次对 `thread_artifacts` 做 `count(DISTINCT path)` 和窗口扫描，表上只有按 thread/recent 的索引，没有按 path 的索引，记录多时是明确的全量开销。文档已承认“以后要加索引”，但这是每次请求的成本，调用方增多时值得单独设限。
- 不可撤销操作：本次新增的两个网关操作本身只读；但编码工作流新增了持久化标记写入。没有发现新的删除/提交主机文件操作。
- 规则/文档一致性：`docs/architecture-v0.1.md` 关于“先剔除撤销/过期再取 200、到期时间统一转 UTC、坏记录只跳过并记日志、标记键带 grantId 长度、两步保存”的描述与代码基本一致；`grantActive` 的描述在非规范时间下会与 `folders.read` 不一致。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。新增的是 Gateway v2 的只读查询、契约字段和 SQL，以及编码工作流里的 trace/state 保存；没有改系统提示、工具定义、历史消息或遮盖规则。发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息里，例如 `production-coding-workflow.ts:645-651` 仍然只是把 `changes.summary` 追加到工具结果后面。证据：本 PR 没有修改 `packages/prompt-catalog`、运行时提示组装或工具定义的代码；`workspace-artifacts` 只是 `ctx.save` 的 trace 键（`production-runtime-tools.ts:1270-1288`），不是发给模型的消息。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
对模型可见的内容：不会。对这两个 API 的响应：
- `workspace.folders.read` 按存储键排序，跳过的目录清单来自固定常量，顺序固定；到期时间统一 `toISOString()`（`production-workspace-changes-control.ts:65,98-103,111`）。
- 但非规范存储时间仍有非确定性：`new Date("2027-01-01T00:00:00")` 这种无时区写法按运行主机时区解释，`folders.read` 返回的 `expiresAt` 会随主机时区变；`grantActive` 又用原始字符串比较（问题 3）。这不影响模型请求字节。
- `generatedAt` 每次请求不同，是响应本身的“本次生成时间”，不是模型内容；如果以后把 snapshot 缓存或复用，要注意它和 `grantActive` 都不能进入固定前缀。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有：
- `packages/gateway-contracts/test/workspace-changes.contract.test.ts` 删掉 `grantActive` 后要求抛出 `ContractValidationError`，反向用例成立。
- `test/integration/sqlite-workspace-changes.test.ts` 的 `[WC-4]` 冒号编号用例在旧键格式下会撞键；`[WC-9]` 的 201 条失效记录 + 后续有效记录用例在旧“只读一页”实现下会漏；`[WC-9]` 的 200 多条有效记录用例检查 `truncated`。
- `apps/agent-service/test/production-coding-workflow.unit.test.ts` 的 `[WC-7]` 覆盖了重启补登记、删除登记失败、`write`/`edit` 不完整标记；旧实现里 `ledgerCandidates(recorded)` 在重启后 `recorded` 为 `undefined` 会抛错/漏记，反向用例成立。
- `test/integration/sqlite-workspace-changes.test.ts` 的 `[WC-6]` 覆盖单次 50 条上限。
未覆盖/未核实：
- 没有“重叠命令 + 重启恢复删除”的用例，问题 1 不会被现有测试抓到。
- `grantActive` 的测试用 `control(GRANT, null)` 直接桩掉 `displayPath`，没有覆盖真实 `configuredWorkspaceRoot` 的时间比较，问题 3 不会被抓到。
- 没有控制字符路径的反向用例，问题 2 不会被抓到。
- 作者已承认“经 HTTP 入口、目录匹配且有数据的用例没补”，现有 HTTP 用例只覆盖 `grantMatched: false` 和空目录。
- 我按工具限制没有运行测试；“反向会失败”是按代码推断。

**4. 每个新值/修改值的两端是否都能接受？**
逐个核对：
- `grantActive`：产生端只有 `production-workspace-changes-control.ts:150`，消费端是 contracts-v2 的必填字段和两个 fixture/测试；所有生产者和 fixture 都补了，HTTP 出口也能过契约。问题只在于该值的计算来源（问题 3）。
- `workspaceFolderSchema` 导出的字段：产生端是 `#folder`，先做键/id/时间/schema 校验，`displayPath`、`operations`、`hostId`、`grantId` 都过契约；消费端 `workspaceFoldersSnapshotSchema` 使用同一 schema，接受。
- `listScopedState(afterKey)`：产生端 `production-http-composition.ts:1183-1190` 和测试都传了，消费端 `sqlite-worker.ts:572-601` 用 `afterKey ?? ""` 接住；`product-state-repository.ts:319-328` 有默认值，旧调用不会断。
- `workspaceIncompleteFolderPrefix`/`workspaceIncompleteThreadKey`：写标记和读标记共用同一组函数，前缀带 `grantId.length`；读按对话用精确键、按目录用前缀，长度 design 能避免冒号撞键。消费端 `production-workspace-changes-control.ts:134-140` 与产生端 `production-workspace-change-marks.ts:65-77` 一致。
- `workspace-artifacts` trace 键：只有 `production-coding-workflow.ts` 读写，内容 `{dropped?}`，没有别的消费者。
- `recordDeleted(): boolean`：产生端 `production-thread-artifacts.ts:181-226`，生产调用端 `production-coding-workflow.ts:623-635` 按布尔值决定 `dropped`；现有测试调用不依赖返回类型，不会被破坏。
- `ChangedFilesPage.items`：产生端 SQL 返回 `path/threadId/source/changedAt/deletedAt/versions`，消费端 `workspaceChangesSnapshotSchema` 对 `path` 的控制字符要求比存储端更严，两端校验不一致（问题 2）；`source`/`threadId` 依赖数据库约束，目前看安全。
- `ci/operations-pending.json` 和安装操作清单：两个读操作都加了条目，`production-http-composition.unit.test.ts:353-372` 的安装清单也同步了；没有发现只改一端。
- `docs/architecture-v0.1.md`、runbook：描述与代码主体一致，但 `grantActive` 的“现在是否有效”在非规范时间下和 `folders.read` 不一致（问题 3）。
