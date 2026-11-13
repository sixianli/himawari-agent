# 复核结论

**冲突解决没有丢东西、没有写错括号，也没有改变两边原有的行为**（读代码证实）。

- `7735305..6c57bf4c` 的增量确实只有 `.agents/reviews/pr-433/usage.jsonl`，之后就是合并提交 `5f4bcea1`。
- 合并提交的冲突文件与作者列出的完全一致：`production-approval-gateway.ts`、`production-http-composition.ts`、`contracts-v2.ts`、`gateway-v2.fixture.ts`、`production-http-composition.unit.test.ts`。
- 逐文件对照两个父提交（PR 侧 `6c57bf4c`、main 侧 `c44b8396`）后，两边的新增都保留了：
  - `production-approval-gateway.ts:130-164`：查询链是 main 的完整链，`workspace.changes./workspace.folders.` 分支加在最后的 `searchAuthorization.query` 之前；`307-314` 的操作清单同时保留 workspace、home、data.export、files、login。
  - `production-http-composition.ts:136-141` 的导入、`700-716` 的操作清单、`1248-1279` 的 `workspaceChangesControl` 构造都在，且构造内容与 PR 侧逐行一致；main 的 `home`、`dataExportJobs`、`filesControl`、`loginDevicesControl` 也都在。
  - `contracts-v2.ts` 的 `GATEWAY_V2_MESSAGE_TYPES` 与 `schemasByType` 两套条目都保留（workspace 四条 + main 的十条）。
  - `gateway-v2.fixture.ts` 两边的 fixture 都在；`production-http-composition.unit.test.ts` 既保留 main 的 home/data.export/files/login 用例，也保留 PR 的 workspace 查询用例和操作清单断言。
- `git diff --check` 只报 `clients/apple/README.md` 文件末尾空行（来自 main），无冲突标记，无括号错误。

---

# 发现的问题（按严重度）

## 1. 中：`workspace.folders.read` 会把过不了契约的“仍有效”授权目录静默丢掉，`truncated` 仍为 `false`

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:62-91`、`:120-129`
- 问题：`#folder` 对每条存储记录做契约校验，任何一项不合格（`hostId` 超长、`displayPath` 含控制字符、`operations` 含非字符串等）就直接 `return null` 只写日志；`#folders` 的 `truncated` 只根据“有效目录数 / 是否翻完页”计算，不包含“有记录被跳过”。界面会把它当作完整清单。
- 证据（读代码证实）：
  - `62-91`：`workspaceFolderSchema.parse(...)` 抛出后进入 `catch`，记录一条 `workspace.folders.record_skipped`，然后 `return null`。
  - `120-129`：`truncated: folders.length > WORKSPACE_FOLDER_LIST_LIMIT || !exhausted`，没有把被跳过的记录计入。
  - `test/integration/sqlite-workspace-changes.test.ts:536-548` 还明确断言：存在 `grant-no-path`、`grant-not-a-date` 等坏记录时，`payload.truncated` 仍是 `false`。
- 建议：给 `workspace.folders.snapshot` 增加 `incomplete`/`skipped` 字段（或把被跳过的记录并入 `truncated`），让调用方能显示“至少这些”；至少应在契约里明确“坏记录不保证列出”。

## 2. 低（I-73 类）：配置允许的 `grantId`/`hostId` 比网关契约宽，配置合法但契约不接受的授权目录会永远列不出来、也查询不到

- 文件:行：`packages/platform-node/src/strict-configuration.ts:112-118`、`:860-865`；`packages/gateway-contracts/src/validation.ts:49-60`；`packages/gateway-contracts/src/contracts-v2.ts:2405-2411`、`:2420-2427`
- 问题：配置侧 `safeReference` 允许 1-256 字符且允许 `/`、`@`；网关契约 `grantId`/`hostId` 用 `machineString`，只允许 1-128 字符和 `A-Za-z0-9._:-`。如果某个部署把 `runPolicy.coding.grantId` 或 `hostId` 配成含 `/`、`@` 或超过 128 字符的值：
  - `workspace.folders.read` 的 `workspaceFolderSchema.parse` 会把它跳过（即问题 1）；
  - `workspace.changes.read` 的请求 `payload.grantId` 本身过不了契约，客户端无法用这个目录号发起查询。
- 证据（读代码证实）：`safeReference` 的正则为 `/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/`；`machineString` 的正则为 `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/` 且长度上限 128；`parseFileReadRoute` 对 `grantId`、`hostId` 都调用 `safeReference`。
- 推测（需配置成越界值才会触发）：当前生产示例 `directory:himawari-prod-workspace-20261015` 能通过 `machineString`，生成式目录号 `directory-grant:<uuid>` 也能通过，所以现网大概率不触发；但这是配置侧与契约侧的真实不一致。
- 建议：把 `grantId`/`hostId` 的配置校验收紧到 `machineString` 同规则，或把契约字段换成与 `safeReference` 一致/专门的 grant id 校验；补一个“含 `/` 或 129 字符”的反向/正向用例。

## 3. 低：`workspace.changes.read` 的 `incomplete` 是本页内的，跨页需要调用方自己累积，契约没有强制

- 文件:行：`apps/agent-service/src/production-workspace-changes-control.ts:155-197`、`:211`
- 问题：`skipped` 只在本请求读到的页内累积；调用方先读第 1 页看到 `incomplete:true`、再读第 2 页看到 `incomplete:false` 是可能的。文档 `docs/architecture-v0.1.md` 已写明“翻页时任何一页是 `true` 都要当作不全”，所以这不是代码与文档冲突，但契约层没有强制，未来调用方很容易漏。
- 证据（读代码证实）：`skipped` 在 `while (matched)` 外层，但每次请求重新初始化为 `false`；`incomplete: incomplete || skipped` 只反映当前响应。
- 建议：把“该目录/对话曾经跳过记录”做成持久标记（与 `workspace-ledger-incomplete` 类似），或让 `incomplete` 在后续页也保持为真；否则至少应在契约注释/字段说明里写死“必须 OR 所有页”。

---

# 读代码证实 vs 推测

**读代码证实：**
- 五个文件的合并结果都能同时看到两个父提交的语义；无冲突标记、无括号错误。
- `workspace.changes.read` 的 `grantId` 只与 `runPolicy.coding.grantId` 比较，不等则返回空并 `grantMatched:false`（`production-workspace-changes-control.ts:137-153`）。
- `workspace.folders.read` 按存储键排序、过滤撤销/过期、最多 10 页、最多 200 条（`94-131`）。
- `thread_artifacts` 查询用 `source != 'upload'` 排除上传，按路径排序并去重计数（`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:291-330`）。
- 不完整标记键的生成与读取使用同一组 helper（`production-workspace-change-marks.ts:11-17` 与 `production-workspace-changes-control.ts:146-152`）。
- 被跳过目录清单只有一份：`THREAD_ARTIFACT_SKIPPED_DIRECTORIES`（`production-thread-artifacts.ts:19-33`），控制层直接引用。
- 文档与实现基本一致：`docs/architecture-v0.1.md` 对文件夹排序/截断/坏记录跳过、改动列表去重/续页/`incomplete`/`grantMatched`/`grantActive` 的描述与代码吻合；`ci/operations-pending.json` 中登记了两项，符合 `scripts/check-operations.mjs` 的规则。

**推测（未运行验证）：**
- 上述 I-73 不一致只有在配置值超出 `machineString` 时才触发。
- 没有运行测试/typecheck（工具限制只能读文件和执行有限 git 命令），所以“反向用例真的会失败”只能按代码判断，不能给出实际执行结果。
- 没有核实生产实际 `hostId` 字符串长度和字符集。
- 没有完整追踪 HTTP 层是否对“发出的 snapshot”再做契约校验；问题 2 的请求侧无法发起已足以成立。

---

# 侧重检查

- **错误路径**：坏授权记录 → 跳过并写 `workspace.folders.record_skipped`；坏改动项 → 跳过、`incomplete:true`、写 `workspace.changes.item_skipped`；`markIncomplete` 写失败 → 命令直接失败（测试 `[WC-7] ... never treats a failed mark as complete` 覆盖）；`changedFiles` 的 `limit` 越界 → `PORT_INVALID_OPERATION`；`listScopedState` 的前缀为空或 `limit` 越界 → `PORT_INVALID_OPERATION`。
- **不可信/不合规输入**：`grantId`、`threadId`、`afterPath`、`limit` 都过网关契约；SQL 全部参数化；`grantId` 必须等于配置值，否则不返回改动数据；授权目录列表按 owner+agent 过滤。
- **安全**：只返回当前 owner/agent 的授权目录和改动记录；返回 `hostId` 而不是主机显示名；`workspace.changes.read` 不按请求的任意目录读数据，只认配置的 grantId；网关访问策略要求 owner 会话。
- **资源耗尽**：文件夹最多读 10 页 × 201 条、返回最多 200 条；改动列表最多连读 10 页、每页最多 200 条。但 `fileCount` 的 `count(DISTINCT path)` 和窗口函数在该 agent 的全部 `thread_artifacts` 上扫描，且没有按路径的索引；文档已明确承认，记录量大时会慢。这是已登记的局限，不是本次合并回归。
- **不可撤销操作**：两个操作都是只读；新写入只有 append-only 的不完整标记，写后不清除，没有删除/提交/改表。
- **规则/文档一致性**：`prompt-prefix.md` 与本次改动无冲突；`docs/architecture-v0.1.md` 的实现描述基本准确；`docs/runbooks/install-start-stop-runbook.md` 仍保留“当前正式部署只开放对话、审批和依赖健康检查”的旧句，但同段已补充“另有没对应页面的操作是正常的”，措辞略矛盾、不影响行为；`ci/operations-pending.json` 与 `check-operations` 的规则一致。

---

# 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（读代码证实）。这个 PR 只新增两个只读网关查询和内部不完整标记；没有改系统提示、工具定义、历史消息或遮盖逻辑。合并提交的冲突解决也没有碰任何提示词/工具文件。`production-coding-workflow.ts` 对模型可见的 `changes.summary` 拼接是 main 上已有的上下文，不是本 PR 新增；本次只增加了“写标记失败就让这条命令失败”的错误路径。`configuredWorkspaceRoot` 的到期比较改成按时刻比较，只影响已过期/非法到期值，且该值属于运行环境/末尾消息而非请求开头。每轮会变的 `generatedAt` 等只出现在网关响应里，不在模型请求里。未运行 `check:prompt-prefix`，结论来自读代码。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对发给模型的内容：不会。新增的网关快照虽含 `generatedAt`（每次不同），但它们是查询响应，不是请求头；列表顺序固定（授权目录 `ORDER BY key`，改动文件 `ORDER BY path`，跳过目录清单来自固定插入顺序的 `Set`）。内部标记里的 `at` 时间字段会变，但只存状态库，不发给模型。对网关响应本身：`generatedAt`、`recording`（取决于该对话是否在副本里）会随请求变化，这是快照语义，不影响模型 KV 前缀。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：
   - `packages/gateway-contracts/test/workspace-changes.contract.test.ts`：拒绝未知 state、`versions:0`、未知 recording、负 fileCount、缺 `grantActive`，并区分 `grantMatched:false` 与“改动为 0”。
   - `test/integration/sqlite-workspace-changes.test.ts`：去重计数、删除状态、排除 upload、坏记录 `incomplete`、分页、撤销/过期/换 agent 隔离、不完整标记幂等、副本 `recording:"copy"`、坏目录记录跳过、200 条截断、10 页上限、被跳过目录不登记等。
   - `apps/agent-service/test/production-coding-workflow.unit.test.ts` 的 `[WC-7]`：扫描不完整、记录失败、删除登记失败、write/edit 登记失败、重启补登记、标记写失败都要求 `markIncomplete` 正确调用。
   - `apps/agent-service/test/production-http-composition.unit.test.ts`：包含 workspace 两个查询的路由、401、操作清单。
   按代码看这些反向用例会失败（例如 `state:"created"` 不通过枚举、`versions:0` 不通过 `integer(1)`、`grantActive` 缺失不通过对象校验）；但**没有实际运行测试**（工具受限），所以“会失败”是读代码判断，不是执行结果。合并提交本身只更新了操作清单断言，没有新增反向用例。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   逐个核对如下（读代码证实）：
   - `workspace.changes.read` / `workspace.folders.read` 字符串：同时出现在 `contracts-v2.ts` 的 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_WORKSPACE_CHANGES_OPERATIONS`、`browserConfiguration.installedGatewayV2Operations`、`ci/operations-pending.json`，`check-operations` 能接受。
   - `ChangedFilesQuery.limit`：契约 `integer(1, 200)`，SQL 侧 `CHANGED_FILE_LIST_LIMIT = 200`，两端一致。
   - 改动项 `path`：`thread_artifacts` 写入时校验 `path.length <= 1024`（`sqlite-thread-artifact-operations.ts:114-117`），契约 `boundedString(1024)`，一致；旧数据超长时被跳过并标 `incomplete`。
   - `source`：存储 CHECK 只认 `write/edit/bash/upload`，契约是 `machineString`，能接受，且查询已排除 `upload`。
   - `threadId`：domain 的 machine identifier 正则与 `machineString` 相同（1-128、`._:-`），一致。
   - `changedAt/deletedAt`：存储的 `clock.now()` 是 `toISOString()` 规范 UTC，契约 `timestamp` 要求规范 UTC 毫秒，一致。
   - 不完整标记键：产生和读取都用 `workspaceIncompleteFolderPrefix/workspaceIncompleteThreadKey`，`listScopedState` 对前缀/limit 的校验能接受（prefix 非空、limit 1-500，实际用 1 和 201）。
   - `workspace-copy-selection:<threadId>`：写入方 `production-workspace-copies.ts:198` 与读取方 `production-workspace-changes-control.ts:142` 一致。
   - **不一致的一处**：配置侧 `grantId`/`hostId` 用 `safeReference`（1-256、允许 `/@`），契约侧用 `machineString`（1-128、不允许 `/@`）；见“发现的问题 2”。现网生成的 `directory-grant:<uuid>` 和示例 `directory:himawari-prod-workspace-20261015` 能通过，但配置允许的域比消费端宽，属于 I-73 类型的潜在失配。
