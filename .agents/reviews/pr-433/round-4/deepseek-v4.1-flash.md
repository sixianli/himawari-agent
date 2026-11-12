## 读代码证实的

### 中 — 改动列表的续页循环没有任何上限，且每轮都重做一次全表计数
- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:159-193`；`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:305-330`
- 问题：只要存储返回的页里一条合格项都没有、`nextAfterPath` 又非空，服务端就在同一个请求里不断调用 `changedFiles`。而 `changedFiles` 每次调用都会先执行 `SELECT count(DISTINCT path) … FROM thread_artifacts`（第 305-313 行）再取一页（第 320-330 行）。当库里有大量过不了契约的旧记录（例如带控制字符的历史路径）而客户端用 `limit: 1` 翻页时，一次请求可能发出接近“坏记录条数”次数据库调用，每次又全表计数，代价接近 O(N²)，并伴随每个坏记录一行日志。文件夹查询有 10 页上限（`production-workspace-changes-control.ts:28-29,101-118`），这里没有对应的保护。
- 证据：
  ```ts
  while (matched) {
    page = await this.#options.changes.changedFiles({ ownerId, agentId, threadId, afterPath: from, limit });
    items = page.items.flatMap(/* 逐条 parse */);
    if (items.length > 0 || page.nextAfterPath === null) break;
    from = page.nextAfterPath;
  }
  ```
  ```ts
  const fileCount = (
    this.database.prepare(
      `SELECT count(DISTINCT path) AS n FROM thread_artifacts
       WHERE owner_id = ? AND agent_id = ? AND source != 'upload'${thread}`,
    ).get(...scope) as { readonly n: number }
  ).n;
  ```
- 建议：给这个循环加页数/扫描行数上限（可沿用 `WORKSPACE_FOLDER_SCAN_PAGES` 的做法）；`fileCount` 只算一次（给端口加参数或单独方法），或内部用最大页长读取后再按客户端 `limit` 返回；达到上限时返回 `incomplete: true` 并给出合法的续页位置（只能是合格路径或 `null`），同时在文档里写明。补一条“坏记录远多于上限”的反向用例。

### 低 — 作者说“nextAfterPath 用存储给的最后一页续页位置”，代码在末行不合格时会改用最后一条合格路径
- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:210-213`
- 问题：这不是功能错误（反而避免把契约不接受的控制字符路径回给客户端），但与“用存储给的最后一页续页位置”的说法不一致；副作用是末页尾部的不合格项会在下一次请求里被重新扫一遍，进一步放大上一条的资源问题。文档也应写明真实规则。
- 证据：
  ```ts
  nextAfterPath:
    page.nextAfterPath === null || items.at(-1)?.path === page.nextAfterPath
      ? page.nextAfterPath
      : (items.at(-1)?.path ?? null),
  ```
- 建议：把作者说明和 `docs/architecture-v0.1.md` 改成“最后一条合格路径；没有合格项且存储已读完时为 null”，并明确这是为了满足 `afterPath` 的契约。

### 低 — “控制字符”过滤只覆盖 C0 和 DEL，C1/格式控制符仍可通过
- 文件:行：`apps/agent-service/src/production-thread-artifacts.ts:117-123,199-201`；`packages/gateway-contracts/src/validation.ts:89-106`
- 问题：`hasControlCharacter` 只判断 `code < 0x20 || code === 0x7f`，`boundedString` 用的是同一集合。生成端和契约端确实一致（这一点是对的），但 `U+0080–U+009F`（含 C1 CSI）和 bidi/格式控制符既不会被删除登记过滤，也能通过契约进入响应。若目标是“文件名里的控制字符不登记、不展示”，这个集合偏窄；若只是防 C0 换行，应把名称和文档写窄。
- 证据：
  ```ts
  if (code < 0x20 || code === 0x7f) return true;
  ```
  ```ts
  [...input].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })
  ```
- 建议：两端统一定义为 `\p{Cc}`（必要时加 `\p{Cf}`），或在常量、函数名和文档里明确只处理 C0+DEL，避免“控制字符”这个说法与实现不一致。

### 低 — 新增的反向用例没有覆盖最容易出错的边界
- 文件:行：`test/integration/sqlite-workspace-changes.test.ts:313-332,666-676`
- 问题：循环用例覆盖的是“连续多页全不合格”，但没有覆盖“一页里既有合格项、末尾又有不合格项，且存储续页位置正好是那条不合格路径”的分支（对应上面第二条的 fallback）；`recordDeleted` 用例只断言返回 `true`，没有断言带控制字符的路径没有传给 `markDeleted`，也没有覆盖“同一批里既有合格路径又有控制字符路径”时合格路径仍被登记。当前代码读起来是对的，但这两个分支没有测试兜住。
- 证据：新增用例只收集 `walked`/`sawIncomplete`，删除用例只做：
  ```ts
  pathas: ["gone\nfile.txt"],
  ...
  ).toBe(true);
  ```
- 建议：补一条末行不合格 + 仍有后续合格项的翻页用例；给 `recordDeleted` 的 store 加 spy，断言 `markDeleted` 收到的路径里没有控制字符路径，且同批其余路径照常登记。

## 推测 / 未核实

- 上述 O(N²) 的实际影响取决于生产库里到底有多少过不了契约的旧记录（新写入已被 `record()`/`recordDeleted()` 挡住，但 `store.register` 本身仍只校验路径长度，直接调用仍可写入控制字符路径）。这一点属于推断，未查生产库，也未实际运行压测。
- 我没有执行测试；反向用例“改前会失败”是根据改前代码推断的：改前 `nextAfterPath` 在 `items` 为空时会落到 `items.at(-1)?.path ?? null`（返回 `null`，提前结束翻页），且 `recordDeleted` 的 `unknown` 不会因控制字符路径变 `true`。
- `.agents/reviews/pr-433/round-1..3/judgments.md` 在这个稀疏检出里不存在，`git show …:.agents/...` 被规则拒绝（`REVIEW_GIT_REFUSED`），所以“前几轮已判断过”无法核对；下面只针对增量判断。
- 运行环境块的追加位置来自 ADR 0164 和 `context-formation-service.ts` 的引用字段，我没有逐个复读运行时追加实现。

## 侧重检查

- 错误路径：`changedFiles` 抛错会让整个查询失败（循环中途也一样，但此前各页都没有合格项，不会丢数据）；`markDeleted` 抛错被 `recordDeleted` 捕获、写日志并返回 `true`（`production-thread-artifacts.ts:224-233`），上层据此写不完整标记；`markIncomplete` 失败没有 try/catch（`production-coding-workflow.ts:640-646`），会让工具调用失败，符合“不把失败的标记当完整”的要求；控制字符路径在调用存储前就被过滤（`production-thread-artifacts.ts:199-201`）。
- 不可信输入：`grantId`、`afterPath`、`limit` 先过契约（`machineString`、`boundedString(1024)`、`integer(1,200)`）；SQL 全部参数化；`grantId` 只在等于生产路由配置时才用于构造不完整标记的键，否则不读也不写该前缀，未发现跨授权目录读状态的问题。
- 安全与披露：两个查询都只读、按 owner/agent 作用域读取；`workspace.folders.read` 返回 `displayPath` 和 `hostId` 但不返回主机显示名；`workspace.changes.read` 只在授权目录号等于路由配置时返回改动；两者都不进入模型请求。
- 资源耗尽：新增循环无上限（见第一条）；`reconcileDeleted` 仍然遍历全部 artifact、逐条 `inspectEntry`，没有页数或并发上限（`production-thread-artifacts.ts:251-289`，作者列为“没改的”，属实）；文件夹查询有 10 页上限。
- 不可撤销操作：本次增量没有新增写操作；`markDeleted` 只更新 `deleted_at` 元数据，`markIncomplete` 只写状态标记，没有删除文件或提交代码。
- 规则与文档一致性：`.claude/rules/prompt-prefix.md` 的“只追加、变化值在最后一条消息”没有被本次增量触碰；架构文档已补上“服务端继续往后读”和“删除路径带控制字符也标不完整”，但没有提扫描上限；`ci/operations-pending.json` 两个操作都有待调用方说明；`check:operations` 会要求清单/实现/测试三方一致。

## 作者说法核对

- “一页全不合格时用存储续页位置继续读，直到读到合格项或读完”：属实（`production-workspace-changes-control.ts:159-193`）。
- “对外只给合格项”：属实（`items` 只来自 `workspaceChangeItemSchema.parse` 成功的项，且每轮替换为当前页结果；前面的页必然没有合格项才会继续）。
- “nextAfterPath 用存储给的最后一页续页位置”：不准确，末行不合格时会回退到最后一条合格路径（上面第二条）。
- “skipped 在任何一页出现过不合格项就为 true，incomplete 随之为 true”：属实（第 181、207 行）。
- “recordDeleted 路径带控制字符不登记，返回 true”：属实（第 199-201、215 行），上层 `droppedDeleted` → `artifacts.dropped` → `markIncomplete` 链路也对。
- “写标记失败让工具调用报失败”：属实（`production-coding-workflow.ts:640-646` 未捕获，单测用 `rejects.toThrow` 断言）。
- “文件夹清单跳过坏记录时客户端看不出”：属实（`#folder` 只写 `workspace.folders.record_skipped` 日志并返回 `null`，响应只有 `truncated`，没有逐条跳过信息/完整性标志）。
- “恢复时并发检查删除路径没有上限”：属实（`reconcileDeleted` 逐页遍历、逐文件 `inspectEntry`，无页数上限）。
- “thread_artifacts 没有授权目录列”：属实（`sqlite-thread-artifact-operations.ts` 的列和建表插入都没有 grant 列；`changedFiles` 只按 owner/agent/thread/path 过滤）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本次增量不会。`workspace.changes.read`/`workspace.folders.read` 的循环、`skipped`、`nextAfterPath` 和 `recordDeleted` 的返回值都只影响 Gateway v2 响应或登记副作用，不进入系统提示、工具定义、历史或遮盖逻辑。PR 里唯一进入模型内容的是 `configuredWorkspaceRoot` 产出的运行环境块（由 `production-run-policy.ts:82-101,153` 生成），它按 ADR 0164 属于最后一条用户消息里的资料块，且只在变化时发送；而且那是 `a7e6` 之前的修改，不在本次增量。因此发给模型的内容仍然是只在末尾追加，每轮会变的值仍放在最后一条消息。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求不会：本增量没有新增依赖时间、前后文或无序集合的模型文本；`skippedDirectories` 来自冻结数组，顺序固定。对客户端响应，`generatedAt`、`grantActive` 会随时间和授权状态变化，这是该查询的语义，不是模型输入；相同数据库状态下同一查询的结果（包括跳过哪些坏路径、`nextAfterPath`）是确定的。需要注意：如果以后把原始存储续页位置直接作为 `nextAfterPath` 回给客户端，控制字符路径会导致契约失败——当前代码的回退逻辑避免了这一点。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：`test/integration/sqlite-workspace-changes.test.ts:313-332` 覆盖“连续多页不合格仍能读到后续合格文件”，`:666-676` 覆盖控制字符删除路径返回 `true`；`packages/gateway-contracts/test/workspace-changes.contract.test.ts` 覆盖新快照字段；`production-http-composition.unit.test.ts` 断言两个操作已安装、无会话返回 401。按改前代码推断，前两条在本次修复前都会失败：改前 `items` 为空时 `nextAfterPath` 变成 `null` 导致只读到 `a.py`；改前 `recordDeleted` 对控制字符路径的 `unknown` 仍是 `false`。我没有实际运行测试，且测试尚未覆盖“末尾不合格 + 续页位置恰为坏路径”的分支和“同批好坏路径混合登记”的断言，这属于上面的低严重度缺口。

4. **改动产生或修改的每个值，两端都接受吗？**
   - `nextAfterPath`：只取合格项的 `path`（或 `page.nextAfterPath`，而该值等于最后一条合格项路径时才使用），合格项已通过 `boundedString(1024)`，所以回填为 `afterPath: boundedString(1024)` 可通过；控制字符路径不会成为续页位置。
   - `incomplete`：内部布尔值 → 契约 `booleanValue`，两端一致。
   - `skipped`：不对外，只并入 `incomplete`，无契约端。
   - `recordDeleted` 返回值：布尔值 → `droppedDeleted` → `artifacts.dropped` → `markIncomplete` 条件，两端只做布尔判断，一致。
   - 过滤后的 `paths`：比存储端更严格（去掉 C0/DEL 路径），`markDeleted` 本身不校验路径，不会拒绝；其他合法路径仍按原样传入。
   - `item.path/source/threadId/versions/changedAt/deletedAt`：产生端是 `thread_artifacts`；`source` 在登记时被限定为 `write/edit/bash/upload`（都满足 `machineString`），`path` 登记时只限长度 0–1024，因此仍要依赖返回时的逐条 `workspaceChangeItemSchema.parse`；这正是本次 `skipped` 分支存在的原因。
   - `grantId`：查询端是 `machineString`，与配置值字符串比较；只在相等时才用于 `workspaceIncompleteThreadKey`，所以不会拿客户端任意字符串去读状态。
   - `fileCount`：SQLite `count(DISTINCT path)` 非负，契约 `integer(0)`；`generatedAt` 来自 `clock.now()`，契约要求 UTC 毫秒时间戳。
   - `skippedDirectories`：冻结常量逐项满足 `boundedString(256)`。
   结论：当前增量产出的字段在两端都能接住；最有风险的是把原始存储续页位置直接外露，但代码没有这样做。
