## 结论

增量改动的核心方向正确：恢复时的删除判断、控制字符过滤、出口逐条契约校验、到期按时刻比较、目录扫描上限都有对应代码和测试。但有 1 个本轮新引入的翻页回归（会少返回后面的合格文件），另有几处文档/代码不一致和资源风险。

## 问题（按严重度）

### 1. 中 —— `nextAfterPath` 回退到 `null` 会让后续合格文件永远翻不到（本轮新引入）
- 位置：`apps/agent-service/src/production-workspace-changes-control.ts:195`
- 问题：当存储返回的一页里**没有一条**能过 `workspaceChangeItemSchema` 的项时，代码把 `nextAfterPath` 设为 `null` 结束翻页；但这一页之后可能还有合格文件。典型触发：`limit=1` 且当前行是坏路径；或一页前若干行全是坏路径。上一轮（`23e6f8d1`）是直接用 `page.nextAfterPath`，不会这样提前收尾，所以这是本轮新引入的回归。
- 证据：
  ```ts
  nextAfterPath:
    page.nextAfterPath === null || items.at(-1)?.path === page.nextAfterPath
      ? page.nextAfterPath
      : (items.at(-1)?.path ?? null),
  ```
  当 `items` 为空且 `page.nextAfterPath` 非空时，走 `?? null`，返回 `null`。而 `sqlite-thread-artifact-operations.ts:330` 的 `page.nextAfterPath` 是坏路径本身（`rows.length > limit && last ? last.path : null`）。
- 影响：返回 `incomplete: true` 会说“不全”，不会谎称完整；但合法记录被自己的翻页逻辑挡住，`fileCount` 与实际返回条目严重不一致。
- 建议：不要把“本页无合格项”当作结束条件。服务端用 `page.nextAfterPath`（只在内部使用，不必过 `boundedString`）继续向后扫描，直到取到至少一条合格项或真正耗尽；对外仍只暴露合格路径或 `null`。这样既保持响应契约合法，又不丢后续文件。

### 2. 低 —— 新增的 `revokedAt` 必填校验会让记录静默消失，而列表仍显示 `truncated: false`
- 位置：`apps/agent-service/src/production-workspace-changes-control.ts:68`、`:82`、`:125`
- 问题：`revokedAt` 缺失（如 `undefined`）时整条记录被跳过，只写服务端日志；`workspace.folders.read` 的响应只有 `truncated`（只表示 200 条上限/10 页上限），没有“有坏记录被跳过”的客户端可见信号。与目标里“记录可能不全时必须说出来”的精神不一致，且这是本轮新增的跳过原因。
- 证据：
  ```ts
  (grant.revokedAt !== null && typeof grant.revokedAt !== "string")
  ...
  } catch (error) { this.#warn({ event: "workspace.folders.record_skipped", ... }); return null; }
  ...
  truncated: folders.length > WORKSPACE_FOLDER_LIST_LIMIT || !exhausted,
  ```
- 建议：要么把缺失的 `revokedAt` 当成 `null`（更宽容，避免误伤历史/手写记录），要么在响应里加“被跳过条数/不完整”信息。若坚持跳过，至少让文档明确这是“客户端会看成完整列表”的既有取舍。

### 3. 低 —— `recordDeleted` 没有做控制字符过滤，和文档“带控制字符不登记并标不完整”不一致
- 位置：`apps/agent-service/src/production-thread-artifacts.ts:199`
- 问题：本轮只在 `record()` 里加了 `hasControlCharacter` 检查（`:293`），`recordDeleted` 仍然只用 `skipsThreadArtifact` 过滤：
  ```ts
  let paths = input.paths.filter((path) => !skipsThreadArtifact(path));
  ```
  删除路径带控制字符时不会 `onIncomplete`，`markDeleted` 也不会因控制字符报错（它只做 `UPDATE ... WHERE path = ?`），于是“删除登记”既不报不完整也不计数。文档 `docs/architecture-v0.1.md` 写的是一律不登记并标不完整。
- 建议：在 `recordDeleted` 复用 `hasControlCharacter` 并在命中时返回 `true`（或增加 `onIncomplete` 回调），让删、改两条入口一致。

### 4. 低 —— 资源/并发：恢复时的 `Promise.all` 无上限；`changedFiles` 每页全表窗口扫描
- 位置：`apps/agent-service/src/production-thread-artifacts.ts:201`；`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:313`
- 问题：恢复/重叠时对每个删除路径并发 `inspectEntry`，路径数来自一次命令的 ledger 变化，最大可到快照上限（数万），可能打满文件描述符/内存。`changedFiles` 每次请求都对整表做 `count(DISTINCT path)` + 窗口函数，翻页时是 O(页数 × 全表)，会长时间占用单线程 SQLite worker。
- 证据：
  ```ts
  await Promise.all(paths.map(async (path) => (await this.#isMissing(...)) ... ))
  ...
  count(*) OVER (PARTITION BY path) AS versions,
  row_number() OVER (PARTITION BY path ORDER BY created_at DESC, id DESC) AS position
  ```
- 建议：`inspectEntry` 加并发上限（如分批 16/32）；`changedFiles` 至少给出并守住一个 scan 上限，或后续加索引/物化计数（作者已在文档承认需要改表，属于已知取舍，但应作为资源边界写清）。

### 5. 低 —— `configuredWorkspaceRoot` 的说法不准确，而且它确实会改到模型可见的运行环境说明
- 位置：`apps/agent-service/src/production-run-policy.ts:260`、`:82`、`:213`
- 问题：作者说“只影响到期时间写法不规范的记录”。实际上 `Date.parse` 修正也影响**合法的带时区偏移时间戳**，以及 `"someday"` 这类旧写法（旧字符串比较会把它当成未过期而返回工作目录）。这个值经 `createProductionRunPolicy` → `runtimeEnvironmentNotice` 进入模型运行环境说明，属于非末尾的模型可见内容。
- 证据：
  ```ts
  !(Date.parse(grant.expiresAt) > Date.parse(clock.now())) ||
  ...
  workspaceRoot: policy.coding && options.workspaceRoot ? await options.workspaceRoot() : null,
  ...
  input.workspaceRoot ? renderPrompt(CHAT_RUNTIME_ENVIRONMENT_WORKSPACE, ...) : CHAT_RUNTIME_ENVIRONMENT_NO_WORKSPACE.text,
  ```
- 影响：这是正确性修复，不会引入每轮变化的值；但对上述记录，部署后（或到期时）模型看到的运行环境说明会从“有工作目录”变成“无工作目录”，是一次非追加的上下文变化。
- 建议：修正说法；如果在意前缀缓存，可在文档/门槛里明确“只在授权目录到期这一刻变化”，并补一个跨越到期边界的测试或说明。

### 6. 提示（非缺陷）—— `fileCount` 包含被跳过的坏路径
- 位置：`test/integration/sqlite-workspace-changes.test.ts:305`
- 现象：坏路径 `b\nbroken.py` 被跳过，但 `fileCount` 仍为 4，`items` 只有可表示项。这与“至少 N”语义一致，但界面若把 `fileCount` 当成可见条目数会对不上；应只用 `incomplete` 提示“至少”。

## 侧重检查

- **错误路径**：`record` 的读取失败/超上限/登记异常都走 `onIncomplete`（`production-thread-artifacts.ts:304-317`）；`recordDeleted` 的 `inspectEntry` 失败置 `unknown=true` 并返回 `true`（`:205-214`、`:231-233`）；`markDeleted` 失败返回 `true`（`:223-232`）；`markIncomplete` 失败向上抛，工具调用报失败（`production-coding-workflow.ts:639-645`）。读出口解析失败跳过并标本页 `incomplete`（`control.ts:156-178,192`）。
- **不合规范/不可信输入**：`grantId/threadId/afterPath/limit` 都过契约（`machineString`、`boundedString`、`integer(1,200)`）；SQL 全参数化（`sqlite-thread-artifact-operations.ts:299-325`）；`grantId` 只用于与配置比较和标记前缀，`ownerId/agentId` 来自配置而非请求，未发现跨租户读取。域层的机器标识正则与 `machineString` 一致（`packages/domain/src/identifiers.ts:39`），没有 I-73 式“产生的 id 过不了后端校验”。
- **控制字符**：登记侧用 UTF-16 code unit 判断（`hasControlCharacter`），与 `boundedString` 的控制字符集合（`<0x20 || 0x7f`）一致；C1 控制符两者都放行，行为一致。
- **不可撤销**：`markIncomplete` 一旦写入永不清除；一个带换行的文件名就会让该对话永久显示不完整，即使文件后来删除。这是保守设计，但属于不可逆的用户可见状态，建议文档明确。
- **文档一致性**：目录扫描上限、到期比较、出口逐条校验、恢复时先确认删除都与代码一致；不一致的是上面第 3 条（`recordDeleted` 未过滤控制字符）和第 5 条（`configuredWorkspaceRoot` 影响范围说法）。

## 必答问题

1. **是否改变模型已见过的请求开头？** 没有新增模型可见内容，改动仍在末尾追加：bash 的改动摘要仍拼在 `modelContent` 末尾（`production-coding-workflow.ts:647-652`），系统提示/工具定义/历史未动。唯一会让模型可见内容变化的是 `configuredWorkspaceRoot` 的到期判断，它影响运行环境说明中的工作目录路径；对正常未过期的 UTC 记录无变化，只对带偏移/不可解析的 `expiresAt` 在到期时变化（正确性修复，非每轮变化值）。本轮新增的 `generatedAt` 只在 UI 响应里，不在模型消息里。

2. **同一段文字会不会在不同请求变成不同字节？** 目录清单按存储键排序、`skippedDirectories` 来自固定顺序的冻结数组、改动项按路径排序，同一 DB 状态下输出确定；时间戳由 `now()` 写成规范 UTC，`workspaceChangeItemSchema` 只接受规范时间戳。唯一按请求变化的是响应的 `generatedAt`（以及标记里的 `at`），它们是响应元数据/日志，不是模型输入，也不影响文件文本。未发现依赖前后文的遮盖或无序列集合。

3. **自动检查是否覆盖、反向用例是否真会失败？** 覆盖较全：恢复时 `overlapped: true`（WC-7）、`recordDeleted` 查不出返回 true（WC-6 直接用例）、登记侧控制字符跳过后不读文件且 `fileCount=0`（WC-6）、出口坏项跳过且响应仍能过 `gatewayV2MessageSchema`（WC-2）、目录 10 页上限（WC-9）、缺 `revokedAt`（WC-9）、带偏移的已过期时间（model composition）。**但**新的 `nextAfterPath` 回退分支没有测试：唯一的坏路径用例 `b\nbroken.py` 排在合格项之前，最终 `items.at(-1).path` 恰好等于 `page.nextAfterPath`，走不到 `?? null` 分支；把这段回退改掉现有测试仍会通过。作者承认的“HTTP 入口、目录匹配且有数据”用例也确实没补。

4. **每个产生/修改的值两端都能接受吗？** 已核对：`workspaceChangeItemSchema` 由 `index.ts` 的 `export *` 导出，契约与出口用法一致；`WORKSPACE_FOLDER_SCAN_PAGES` 用在循环与测试；`listScopedState` 同时加在 repository、worker 和测试 fixture 的 `workerOwned`；`changedFiles` 的 1..200 与 `CHANGED_FILE_LIST_LIMIT`、契约 `integer(1,200)` 一致；`listScopedState` 请求 201 条小于 worker 上限 500；`grantId/threadId` 与域层机器标识正则一致。唯一需要警惕的是新增的 `revokedAt` 必填：代码里能看到的写入方（admin-cli、sandbox recovery）都写 `revokedAt: null`，因此现有记录应能通过；**推测**：若存在更早版本写入、没有该字段的旧记录，它们会被静默跳过且客户端看不到不完整信号（见第 2 条）。
