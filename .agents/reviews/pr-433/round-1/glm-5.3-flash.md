现在让我来核实一下关键的跨端问题：`commandType` 验证、状态键前缀、运行策略结构、授权结构，以及 `boundedString`/`machineString` 的语义。
# 代码复核：PR 433（workspace.folders.read / workspace.changes.read）

## 按严重度排列的发现

**1. 中低 — apps/agent-service/src/production-workspace-changes-control.ts:88 / packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:291-346**
问题：`workspace.changes.read` 的“按授权目录”归属是假的——`thread_artifacts` 表没有授权目录列，查询只按 `(owner_id, agent_id)` 过滤，`grantMatched` 只对比“请求的 grantId == 当前配置的 coding.grantId"。一旦授权目录轮换（grant 过期后重新授权，`file-operation-service.ts:52` 用 `ids.next("directory-grant")` 生成新 id），旧目录下登记的全部改动会算到新目录头上，界面会把 A 目录的改动显示成 B 目录的。
证据：`const matched = runPolicy?.coding?.grantId === grantId;`（control 第 88 行）；`changedFiles` 的 SQL 里只有 `owner_id/agent_id/source != 'upload'` 和可选 thread 过滤，没有任何目录过滤；文档 docs/architecture-v0.1.md:556 写“返回某个授权目录下被记录到改动过的文件”，与存储能力不符。作者说法里承认了“没有授权目录列”，但文档没有写清历史归属这一层。
建议：至少在文档和快照里明示“目录归属以当前配置为准、历史记录不区分目录”；更好的做法是给登记写入时的 grantId 留痕（哪怕放到 source 之外的扩展列或登记键前缀），或在新 grant 首次配置时明确声明旧数据不计入。

**2. 低 — apps/agent-service/src/production-workspace-change-marks.ts:64-70**
问题：`markIncomplete` 先写对话级键、再写目录级键，两次独立提交不是原子的。第二次写失败时按设计抛错（工具调用失败），但此时对话级标记已在、目录级标记缺失；若该工具调用不再重试，`threadId=null` 的目录级查询会返回 `incomplete:false`，而对话级查询返回 `true`，界面口径不一致。
证据：`await write(workspaceIncompleteThreadKey(...)); await write(workspaceIncompleteFolderKey(...));`（第 68-70 行），每个键独立走 `commitStateAndEvents`。
建议：可接受，但建议目录级写失败时至少先写对话级失败也照样抛错的前提下，把“两键都写成功才返回”的顺序反过来（先目录级，再对话级），使“目录级已标”蕴含“对话级已标”的概率更高；或在文档里写明这个不一致窗口。

**3. 低 — apps/agent-service/test/production-coding-workflow.unit.test.ts（全文件）**
问题：write/edit 分支的标记逻辑没有测试覆盖。`[WC-7]` 两条用例都只跑 `executeProductionCodingRequest(call, "bash", ...)`；write/edit 路径（production-coding-workflow.ts:643-664，`recordThreadArtifacts` 返回 true 时写标记）没有对应用例。
证据：该测试文件中 `workspaceChangeMarks`/`markIncomplete` 的引用全部在 "bash" 用例里（第 1207-1260 行）。
建议：补一条 write/edit 用例（例如 saveCopy 缺失时断言 markIncomplete 被调用一次）。

**4. 低 — apps/agent-service/src/production-workspace-changes-control.ts:60-63 + packages/gateway-contracts/src/validation.ts:115-125**
问题：`workspace.folders.read` 直接把存储里的 grant 值塞进快照，契约要求 `expiresAt` 是毫秒级 canonical RFC3339（`timestamp.parse` 要求 `new Date(x).toISOString() === input`）、`displayPath ≤ 4096` 且无控制字符。授权创建端 `file-operation-service.ts:41-48` 对 `expiresAt` 只做字符串大小比较，不校验格式。若存量/新写入的 grant 值格式不符（例如秒级精度 `...T00:00:00Z`），整个 `workspace.folders.read` 快照会在出口 schema 校验处失败。
证据：`grant.expiresAt <= this.#clock.now()`（file-operation-service.ts:45，仅字符串比较）；`timestamp` 定义（validation.ts:115-125）。
未核实：生产里实际创建 grant 的入口传的 `expiresAt` 精度（未追到创建调用方）。既有 `hostDirectorySnapshotSchema`（contracts-v2.ts:2466）已有同样要求，所以这不是本次新增的风险，但新操作把“一个坏值打挂整个列表”的暴露面扩大了。
建议：在 `#folders` 里对单条记录做防御性过滤（解析失败跳过而不是让整个快照失败），或核实/收紧创建端格式。

**5. 低（覆盖缺口）— test/integration/sqlite-workspace-changes.test.ts:1 + apps/agent-service/test/production-http-composition.unit.test.ts:1147-1188**
问题：HTTP 入口只测了 `grantMatched:false`（grant-not-configured）和空库的 folders；“请求的 grantId 等于配置值、库里有真实登记数据”这条路径只在 control 层（WC-1..3）测过，没有经 HTTP 组合的用例。runbook（docs/runbooks/install-start-stop-runbook.md:369）把这条留给上线后人工验收。
建议：在 composition 测试里补一条 matched + 有数据的查询（fixture 已有对应快照样本，成本不大）。

**6. 备注（读代码证实，无缺陷）— packages/persistence-sqlite/src/sqlite-worker.ts:569-600**
`listScopedState` 用 `key >= prefix AND key < prefix + U+10FFFF` 实现前缀语义：因为上界是前缀加最大码点，任何在上界之内但不以 prefix 开头的键必然在 prefix 内部某字符处大于 prefix，从而大于上界，所以范围恰好等价于“以 prefix 开头”（ASCII 键下成立）。作者说法准确。

## 侧重检查

**走的流程**（一条最普通的使用路径：已登录会话查询改动列表）：
1. POST `/api/gateway/v2/queries` → `buildHttpGatewayServer`（authentication/csrf/recentAuthentication）——**有测试**（production-http-composition.unit.test.ts:1147-1188，含无会话 401）。
2. 消息 schema 校验 `schemasByType["workspace.changes.read"/"workspace.folders.snapshot"]` ——**有测试**（workspace-changes.contract.test.ts 反向用例；gateway-v2.contract.test.ts:36-40 逐类型校验 fixture 顺序，新 fixture 已加入）。
3. 未安装操作 501 → 新操作已加入 `installedGatewayV2Operations`（production-http-composition.ts:696）和 `PRODUCTION_WORKSPACE_CHANGES_OPERATIONS`（production-approval-gateway.ts:279），两端一致，**有测试**（composition 测试断言清单）。
4. reads 委派分支（production-approval-gateway.ts:133-136）——**经 HTTP 只测了未匹配 grant**（发现 5）。
5. `ProductionWorkspaceChangesControl.query` → `repository.threadArtifacts().changedFiles` → durable 适配器 `context.read("threadArtifact.changedFiles")` → worker 默认分支 `durableOperations.execute`（sqlite-worker.ts:1144-1145）→ `startsWith("threadArtifact.")`（sqlite-durable-operations.ts:621）→ `SqliteThreadArtifactOperations.changedFiles`；`listScopedState` 走专用 case（sqlite-worker.ts:1051）——**有测试**：integration 测试虽标 "direct"，fixture（sqlite-contract-execution.fixture.ts:22-40）把这两个操作路由到真实 worker dispatcher，真实 SQL 被执行。SQL 参数位序我逐位核对过（versions 子查询用 `v.thread_id = a.thread_id` 关联、不含占位符；7 个占位符与 7 个实参对齐）。
6. 标记写入路径：ledger.record 失败/complete:false/登记被丢弃 → `markIncomplete` 两次 `commitStateAndEvents`；`commandType:"workspace.ledger.incomplete"` 无命令类型白名单（sqlite-worker.ts:763-802 只校验 authority fence、revision 冲突、run: 键冲突），**能通过后端校验**——这是对必答问题 4 的关键核对，通过。**有测试**（WC-7 两条、WC-4）。缺口见发现 3。
7. `ci/operations-pending.json` 登记由 `scripts/check-operations.mjs` 强制（缺理由/名单外缺项报红、补齐后必须移出），两条新操作已登记且理由超过最短长度——**有自动检查**（test/tooling/operations-check.test.mjs）。

**文档 vs 代码**：architecture-v0.1.md:556 的键格式、200 上限、排序、`grantMatched`、`skippedDirectories` 单一来源、标记不自动清除、写标记失败按失败处理——逐条与代码一致；唯一不符是发现 1 里“某个授权目录下”的归属表述。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。改动全部是控制面（两个只读网关操作）和工具执行后的持久化记账；本 PR 触及的唯一模型可见内容是 production-coding-workflow.ts:636-638 的 `changes.summary` 追加，该行未改、来源（ledger）未改。没有新增任何每轮变化的值进入请求；标记写入失败只会让本次工具结果变成失败（发生在发送之前，属末尾追加语义），不改已发历史。符合 prompt-prefix.md 第 4 条（只追加）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。未触碰遮盖；快照输出各列表顺序固定（folders 按存储键 `ORDER BY key`、items 按路径 `ORDER BY path`、`skippedDirectories` 来自冻结 Set 的固定展开）；SQL 去重子查询带 `b.id DESC` 平局裁决，确定性成立。时间字段（`generatedAt`、过期过滤）是快照固有的每次响应元数据，不进模型内容；`incomplete` 可能随状态由 false 变 true，属状态变化而非同一文本的字节漂移。
3. **有没有对应的自动检查、反向用例会不会真的失败？** 有且分层：契约层 WC-8 反向用例（未知 state、versions:0、未知 recording、负数 fileCount 断言 `toThrow(ContractValidationError)`，按 validation.ts 的实现确实会失败）；真实 SQLite 集成 WC-1..6、WC-9（经真实 worker dispatcher）；工作流 WC-7（含“标记写失败必须抛错”的反向断言）；HTTP 入口两条 + 401；operations 清单由 check-operations.mjs 强制。缺口：write/edit 分支标记（发现 3）、HTTP matched+有数据路径（发现 5）。
4. **每个新值两端都核对了吗？** 逐个核对：4 个新消息类型（contracts 清单/schemasByType/check-operations/installed 清单四端一致）；`workspace-ledger-incomplete:*` 键（无碰撞，仅 marks 写、control 读）；`commandType:"workspace.ledger.incomplete"` 和 `workspace-incomplete:<sha256>` 幂等键（后端无类型白名单、幂等重放逻辑只比对指纹，能通过）；`listScopedState`（repository→worker case→fixture 三处齐全，索引扫描成立，上限 500 与调用方 201 匹配）；`changedFiles`（durable-adapters→durable-operations 前缀分发→操作类 case 齐全；limit 1..200 与 schema `integer(1,200)` 一致；path ≤1024 与 register 写入端校验一致）；`THREAD_ARTIFACT_SKIPPED_DIRECTORIES`（单一来源，control 与测试共用）；`workspaceChangeMarks` 服务位（file-read-services 产生、coding-workflow 可选消费，authority 取法与既有 `PublicSearchAuthorization` 相同）。唯一“两端语义不一致”的就是发现 1 的 grantId 归属：契约宣称按目录，存储端没有目录维度。

**作者说法核对结果**：除发现 1 所指的“按授权目录返回”在历史数据归属上比说法暗示的更弱之外，其余说法（不完整标记的四个触发源、两键不自动清除、写标记失败抛错、已知崩溃窗口、listScopedState 前缀扫描上限 500、四组测试的存在与形态、pending 登记）均与代码一致。
