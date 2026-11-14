## 复核意见

### 1. 高 — 原样载荷写入失败时仍可能把执行记成“成功”，之后永远无法撤销

**文件:行**：`apps/agent-service/src/production-proposals.ts:520-532`、`673-697`、`716-717`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:397-417`

**问题**：`#recordExecution` 在 `payloads.put/protector.protect` 失败时吞掉异常并返回 `undefined`。随后代码仍把执行推到 `executed_unverified`，`execution_ref` 因 `...(ref ? { executionRef: ref } : {})` 被省略，`#verifyAfterExecution` 又可以把状态改成 `succeeded`。而 `undo` 必须有执行载荷才能读回原样，否则直接报 `PROPOSAL_NOT_UNDOABLE`。结果是“动作已经执行、主人看到成功，但永远撤销不了”。

**证据（读代码证实）**：
- `#recordExecution`：`try { await this.#writeExecution(ref, execution); return ref; } catch { return undefined; }`
- 正常路径：`const ref = await this.#recordExecution(...)`，随后 `moveExecution({ from: "running", to: "executed_unverified", leaseId, ...(ref ? { executionRef: ref } : {}) })`
- `undo`：`const execution = await this.#readExecution(row.executionRef); if (!basis || !execution) throw new ProposalError("PROPOSAL_NOT_UNDOABLE");`
- `moveExecution` 对执行引用使用 `CASE WHEN ? = 1 THEN ? ELSE execution_ref END`，不传就保留空值。

**建议**：`ref` 为空时不要继续读回并记 `succeeded`；至少记 `unknown`，并在进入 `succeeded` 前强制要求 `execution_ref` 非空。补一条 `payloads.put` 抛错的反向用例。

### 2. 高 — 撤销没有租约或比较交换，两个并发撤销会让处理方执行两次

**文件:行**：`apps/agent-service/src/production-proposals.ts:701-733`；`apps/agent-service/src/production-proposal-control.ts:173-177`

**问题**：`undo` 先读行、确认 `exec_status === "succeeded"`，然后直接 `await handler.undo(...)`，最后才用 `moveExecution` 把状态改成 `undone`。在 `handler.undo` 之前没有领取、没有把状态 CAS 成“撤销中”。两个并发请求都能通过 `succeeded` 检查并各调用一次 `handler.undo`，第二次的 `moveExecution` 失败只会被当成 `replayed` 或 `PROPOSAL_NOT_UNDOABLE`，但副作用已经发生两次。撤销是终点且可能不可逆，这个重复执行不可接受。

**证据（读代码证实）**：
- `if (row.execStatus !== "succeeded") throw ...; ... await handler.undo(...); const moved = await store.moveExecution({ from: "succeeded", to: "undone", leaseId: null, ... });`
- 控制层 undo 分支没有传 `assertPresence`，也没有任何前置占用：`if (action === "undo") return { ... (await this.#options.box.undo(proposalId, expected)).replayed }`。
- 新测试只覆盖顺序撤销，没有并发撤销。

**建议**：增加 `undoing` 之类的中间状态或租约，先 CAS `succeeded → undoing`，成功后再调用 `handler.undo`，失败时回退并明确报错；并发用例必须验证 `handler.undo` 只调用一次。不可逆的撤销也应考虑要求本人在场。

### 3. 中 — `failed` / `unknown` 后没有出路，且执行结果根本不返回给主人

**文件:行**：`apps/agent-service/src/production-proposals.ts:562-589`、`600-607`、`711-712`、`823-825`、`873-887`；`apps/agent-service/src/production-proposal-control.ts:154-181`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:159`、`278-280`

**问题**：租约恢复只把过期执行改成 `succeeded/failed/unknown`，`unknown` 之后没有任何再核实或人工解决路径；`failed` 也一样。此时：
- `adopt` 报 `PROPOSAL_ACCEPTED`；
- `undo` 报 `PROPOSAL_NOT_UNDOABLE`；
- `reject` 报 `PROPOSAL_ACCEPTED`；
- `proposals.read` 只列 `status = 'pending'`，这条提议从列表消失；
- 控制层只把 `resultRef` 返回给客户端，`ProposalExecutionOutcome.execution` 被丢掉。

所以主人在界面上看到的是“提议消失了”，既不知道执行成功还是失败，也没有重试、撤销或人工确认的入口。文档说“要提议方换内容重提”，但同一编号重提在 `exec_status != 'not_started'` 时直接 `closed`，不会重新打开。

**证据（读代码证实）**：
- `listPending` 的 SQL 只有 `status = 'pending'`。
- `settledError` 对 `unknown` 落到 `PROPOSAL_ACCEPTED`。
- `undo` 只接受 `succeeded`。
- `reject` 对 `accepted` 抛 `PROPOSAL_ACCEPTED`。
- `propose`：`if (existing && existing.execStatus !== "not_started") return "closed";`
- 控制层返回：`return { resultRef: (...).resultRef, replayed: false };`

**建议**：在 `proposal.respond` 的结果里返回执行状态，或在 `proposals.snapshot` 里提供“已执行/结果不明”的列表；给 `unknown` 一个明确的复核入口。至少要在文档和界面文案上说明“消失”代表什么。

### 4. 中 — 状态机允许 `unknown → succeeded/failed`，且 `leaseId: null` 会跳过租约检查

**文件:行**：`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:26-37`、`397-424`

**问题**：`EXECUTION_STEPS` 明确允许 `unknown → succeeded` 和 `unknown → failed`。`unknown` 在进入时已经因为 `finished` 集合清空了租约，之后调用 `moveExecution` 只要传 `leaseId: null`，WHERE 里的 `(? IS NULL OR lease_id = ?)` 就整体为真，不做租约校验。当前业务代码没有使用这两个转换，但端口和 durable adapter 已经暴露出去，任何内部调用方都能在没有读回证据、没有租约的情况下把“结果不明”改成“成功”。这与“`moveExecution` 带租约条件”的说法不完全一致。

**证据（读代码证实）**：
- `["unknown", "succeeded"], ["unknown", "failed"]`
- `const finished = ["succeeded", "failed", "unknown", "undone"].includes(input.to);`
- `AND (? IS NULL OR lease_id = ?)`
- 全部 `moveExecution` 调用点中，没有一处以 `unknown` 作为 `from`（`from` 只来自 `running`、`executed_unverified`、`succeeded`）。

**建议**：除非有明确的“人工复核”设计，否则删掉 `unknown → *`。若保留，另设显式的复核接口，要求证据并禁止 `leaseId: null`；对非终态的 `from` 强制传租约。

### 5. 中 — 网关和客户端没有端到端对齐：`undo`、`open`、`recentAuthenticationRef`、`fullReadToken` 实际不可用

**文件:行**：`apps/control-center/src/memory.ts:33`、`62-65`、`188`、`322-330`；`packages/gateway-contracts/src/contracts-v2.ts:2201`、`2244-2310`；`packages/application/src/services/recent-authentication-service.ts:58-63`

**问题**：合约新增了动作 `undo`、查询字段 `open`、命令字段 `recentAuthenticationRef`、`fullReadToken`，但控制中心：
- `ProposalAction` 仍然是 `"adopt" | "reject"`，类型层面发不出 `undo`；
- `respondProposal` 永远发送 `recentAuthenticationRef: null`、`fullReadToken: null`；
- 整个仓库没有生产代码用非空 `open` 调用 `proposals.read`。

而 `RecentAuthenticationGuard` 对 `expectedAuthenticationRef` 为 `null` 直接拒绝。也就是说，一旦登记了第一个 `requiresPresence` 或 `requiresFullRead` 的确定动作，网页端永远无法采纳；`undo` 也无法从网页端发出。这正是 I-73 说的“清单里的 id 能通过后端校验吗”一类两端不一致。

**证据（读代码证实）**：
- `export type ProposalAction = "adopt" | "reject";`
- `respondProposal: (...) => send("proposal.respond", () => ({ ..., recentAuthenticationRef: null, fullReadToken: null }))`
- `queryMessage(configuration, "proposals.read", { open: null })`
- `if (!expectedAuthenticationRef || expectedAuthenticationRef !== authentication.authenticationRef) this.#reject("authentication_ref_mismatch");`

**建议**：在客户端补上 `undo` 类型、`open` 调用和 token/认证引用透传，并加端到端用例；如果本轮不打算做界面，至少不要把 `requiresPresence/requiresFullRead` 描述成已经可用，或用合约能力位把未接通的路径隐藏起来。

### 6. 中 — `requiresFullRead` 可由提议方传 `false` 覆盖，外部内容的全读保护可被绕过

**文件:行**：`apps/agent-service/src/production-proposals.ts:372-380`、`440-457`

**问题**：默认值逻辑是 `input.requiresFullRead ?? (origin === "external_content" && !isAction(handler))`。只要调用方显式传 `requiresFullRead: false`，即使来源被服务器标成 `external_content`，也不会要求全读。`requiresPresence` 因为采纳时还会再看 `handler.requiresPresence`，不能被 `false` 绕过；但 `requiresFullRead` 只信数据库里的行标志，因此可以被降级。

**证据（读代码证实）**：
- `const requiresFullRead = input.requiresFullRead ?? (origin === "external_content" && !(handler !== undefined && isAction(handler)));`
- `#requireFullRead` 只检查 `row.requiresFullRead`，不重新推导。

**建议**：让服务器策略只允许“提高”要求，例如 `input.requiresFullRead || (external_content && !isAction)`；如果提议方输入不可信，不应允许它把全读要求调低。另注意 `externalContentSeen` 本身仍是调用方提供的布尔值，只能在内部信任边界内使用。

### 7. 低 — `propose` 遇到 `closed` 静默返回，调用方仍会报告“已提议”

**文件:行**：`apps/agent-service/src/production-proposals.ts:424-427`；`apps/agent-service/src/production-owner-rules.ts:1000-1027`

**问题**：存储层返回 `"closed"` 后，`ProductionProposalBox.propose` 只是删掉刚写好的依据并 `return`，它的公开签名是 `Promise<void>`，调用方无法知道没有入箱。`ProductionOwnerRuleWriter` 随后仍返回 `status: "proposed"` 和旧的 `proposalId`。文档说“入箱结果 `closed`”，但实际结果没有出到调用方。

**证据（读代码证实）**：
- `if (outcome === "closed") { await drop(); return; }`
- 规则写入方：`return Object.freeze({ status: "proposed", ..., proposalId, ... });`
- 文档：`入箱结果 closed，不新建、不改动`。

**建议**：让 `propose` 返回 `OwnerProposalOutcome`，或对 `closed` 抛一个明确的错误；调用方据此告诉提议方“该编号已执行完毕，不能重提”。

### 8. 低 — 文档与代码不一致

**文件:行**：`docs/architecture-v0.1.md:428-432`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:358`；`apps/agent-service/src/production-proposals.ts:751`

**问题**：
- 文档说“每次只改一列”，但 `claim` 在同一条 UPDATE 里同时把 `status` 改成 `accepted`、`exec_status` 改成 `running`。
- 文档第 428 行仍写 `proposal.respond` 的动作是 `adopt` 和 `reject`，而合约和代码已经加了 `undo`。
- 文档说“入箱结果 `closed`”，但 `box.propose` 不返回结果。
- 文档说“领取成功后凭据作废”，但非 `action` 处理方的采纳路径只调用 `this.#requireFullRead(row, responder)`，没有删除 token。
- `withdrawn` / `PROPOSAL_WITHDRAWN` 只有类型和拒绝分支，没有任何产生 `withdrawn` 的代码路径。

**证据（读代码证实）**：上述行。
**建议**：要么改文档描述现状，要么补上对应行为；尤其“每次只改一列”应改成“通常只改一列，领取时原子地同时改两列”。

### 9. 低 — 执行原样载荷没有清理路径，异常时还会留下孤儿载荷

**文件:行**：`apps/agent-service/src/production-proposals.ts:485-532`、`858-870`

**问题**：`#sweep` 只删除 `settledEvidence` 返回的 `evidenceRef`，从不删除 `executionRef` 指向的“执行前原样”载荷。`#recordExecution` 写成功但随后 `moveExecution` 失败时，载荷也不会回滚。执行原样可能包含敏感值，且作者已说明清除/导出/导入留给后续 PR，但在此之前这些 ref 不在任何清理或导出清单里。

**证据（读代码证实）**：
- `#sweep` 只遍历 `settledEvidence` 并 `payloads.delete(evidenceRef)`。
- `#writeExecution` / `#recordExecution` 写 `ref = "${proposalId}:x..."`，没有任何对应的删除调用。

**建议**：把 `execution_ref` 纳入删除/导出/导入的枚举；记录写入后若状态迁移失败要清理孤儿载荷，或至少让保留策略显式覆盖它。

## 作者说法核对

1. **“两台设备同时点同一个提议，只有一个能领取并执行”**：`claim` 的 UPDATE 带 `status='pending' AND exec_status='not_started' AND version=? AND fingerprint=?`，SQLite 单条更新原子，读代码成立。但这只对 `ProposalActionHandler` 成立；非 `action` 且 `repeatable: true` 的处理方仍可重复采纳。
2. **“租约过期的执行永远不会被再执行一遍，只读回核实”**：`#recover` 只调用 `handler.readBack`，不调用 `execute`，成立。但要注意：如果进程在 `claim` 后、`execute` 前崩溃，恢复会用 `original: undefined` 读回，可能把从未执行的动作记成 `failed`（或取决于处理方实现记成 `succeeded`），这不会重做，但也不代表“执行过”。
3. **“同一编号撤销后再提议不会重新打开”**：`undo` 置 `exec_status='undone'`，`propose` 看到 `execStatus !== 'not_started'` 返回 `closed`，成立；但调用方看不到 `closed`，见第 7 条。
4. **“凭据对不上或过期时，什么状态都不改”**：全读 token 校验、`assertPresence`、`changed` 检查都在写状态之前，成立。但 `openFull` 本身只在内存发 token，不改库，也不改变提议状态。
5. **“规则类提议（有 adopt 的旧处理方）的行为没变”**：`ProductionOwnerRuleWriter` 登记的是非 `action` 处理方，`requiresFullRead/requiresPresence` 默认 false；`adopt` 走旧的 `decide` 路径。读代码成立；唯一新增的是每次 `adopt/list/undo` 前的 `#recover` 查询和 `list` 里跳过 action 处理方，未影响规则处理方。`production-memory-capture` 里对 `MEMORY_RULE_ACTION_UNSUPPORTED` 的期望来自本 PR 提交，但与本 PR 主体功能无关。
6. **“`withdrawn` 加进决定状态”**：只加了类型和拒绝映射，没有产生 `withdrawn` 的代码，属于未实现值。
7. **“`moveExecution` 带租约条件”**：只在调用方传非空 `leaseId` 时成立；`null` 会绕过，见第 4 条。

## 侧重检查

- **错误路径**：`execute` 抛错会记 `failed` 并清租约，这一点正确；但 `#recordExecution` 失败、`moveExecution` 失败、`decide(superseded)` 失败都被 `.catch` 吞掉，分别留下“成功但不可撤销”（第 1 条）、“暂时卡在 running 后靠租约恢复”和“仍为 pending 但对外报 superseded”的路径。最后一种会导致再次采纳时重复 `verify`。
- **不合规范/不可信输入**：`open`、`fullReadToken`、`recentAuthenticationRef` 都经过网关 schema；`claim` 校验编号、时间、租约长度；`moveExecution` 不校验 `leaseId` 类型和长度（只做比较），但不落库，风险较低。`requiresFullRead` 和 `externalContentSeen` 是调用方输入，存在降级/说谎空间（第 6 条）。
- **安全**：`undo` 不要求本人在场，且并发无锁（第 2 条）；全读 token 不绑会话/设备，只绑编号、版本、指纹，泄露后任何有 owner 权限的进程都能用；`openFull` 可给任意 pending 提议签发 token，容量满时淘汰别的提议的有效 token，若 `proposals.read` 对非 owner 也可用，会形成轻量 DoS（此项取决于读权限模型，未核实）。
- **资源耗尽**：`FULL_READ_TOKEN_CEILING=1000`、`LEASE_RECOVERY_BATCH=50`、待采纳上限 200 都有界；`openFull` 清理循环在容量满时删 Map 迭代顺序最早的 token，逻辑上能保证不超过上限，未发现死循环。执行原样载荷会积累（第 9 条）。
- **不可撤销操作**：`undo` 的副作用在状态迁移之前发生，迁移失败时会出现“已撤销但系统仍显示成功，重试再撤销一次”的情况（第 2 条）。
- **规则/文档一致性**：见第 8 条；另外 `docs/architecture-v0.1.md:431` 把“领取成功后凭据作废”写得比非 action 路径的实际行为更宽。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。变更集中在数据库迁移、提议箱服务、网关合约、控制中心和测试，没有修改系统提示、工具定义、历史消息、遮盖逻辑或任何模型请求组装代码；`git diff` 里没有 `runtime-pi`、`prompt-catalog` 或 prompt 相关文件。新增的 token、租约、随机 `execution_ref`、`executed_at` 都只存在于提议箱/网关响应中，不进入模型消息。因此“只在末尾追加、每轮变化值在最后一条消息里”的约束未被触碰。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
对发给模型的内容：不会，原因同上。对新子系统本身：会存在非确定值——`openFull` 的 token、`executed_at`、`lease_id`、`execution_ref` 都是随机或带时间的；`#recordExecution` 用 `JSON.stringify` 原样序列化处理方返回的 `original`，对象键序取决于处理方。这些目前都不进入模型请求；如果以后要把执行详情、提议快照放进提示或历史，必须改成规范序列化并放在末尾。`requiresFullRead/requiresPresence` 还依赖提议入箱时处理方是否已登记，因此同一输入在不同进程状态下可能落成不同标志——不是模型字节问题，但会影响可复现性。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有：`test/integration/owner-proposal-execution.test.ts` 覆盖了单次执行、双设备竞争、租约过期只读回、租约过期三种读回结果、撤销是终点、`undo` 前失败、前提不成立、全读 token 错误/过期/版本变化、`presence` 缺失、来源标记和默认全读，集成项目 `test/integration/**/*.test.ts` 会跑到。反向用例中 token 错误、过期、版本变化、缺 presence、双竞争确实都会失败。缺口：没有覆盖 `payloads.put` 失败导致“成功但不可撤销”、并发两次 `undo`、`unknown → succeeded/failed`、`leaseId: null` 绕过、网关对新增必填字段的反向校验、客户端 `undo/open` 的端到端用例、多进程 token；也没有覆盖 `decide(superseded)` 失败时仍报 `PROPOSAL_SUPERSEDED` 的分支。未运行测试/typecheck，故“这些用例真的通过”未核实。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐个核对的结果：
- `external_content`：DB 只查长度，网关 `PROPOSAL_ORIGINS` 已加，控制中心类型经合约同步，能够接受。
- `requiresFullRead/requiresPresence`：DB 用 `IN (0,1)`，网关用 `booleanValue`，`StoredOwnerProposal` 映射 0/1，控制快照包含，能接受。
- `opened`（`proposalId/fullReadToken/expiresAt`）：网关 `machineString/timestamp` 与控制层返回的 32 位十六进制 token、ISO 时间相符，能接受。
- `undo`：网关 `PROPOSAL_ACTIONS` 能接受，控制层能执行，但 `apps/control-center/src/memory.ts:33` 的 `ProposalAction` 不接受，客户端也无法发送，见第 5 条。
- `recentAuthenticationRef/fullReadToken`：网关接受 nullable，但唯一客户端永远传 `null`，`RecentAuthenticationGuard` 拒绝 `null`，需要 presence 的路径两端不接受，见第 5 条。
- `execution_ref`：长度上限 82（`proposalId` 最长 65 + `:x` + 15）小于 DB 的 256，能接受；但没有删除/导出路径，见第 9 条。
- `exec_status`：DB 只查长度，代码用 `EXECUTION_STATUSES` / `EXECUTION_STEPS` 校验；`unknown` 的额外转换如第 4 条所述放宽了状态机。
- 迁移：`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ... CHECK` 对已有行使用的默认值 `'not_started'`、`0` 都满足 CHECK，SQLite 允许；`.meta.json` 的 `"alters":["owner_proposals"]` 与迁移分析脚本的声明格式一致，未发现声明缺失。

## 未核实 / 推测

- 生产环境是否单进程、网关读写是否会被路由到不同实例：未核实。如果存在多进程/多实例，`#fullReads` 只在一个进程内存里，打开全文的 token 在另一个进程会被判 `PROPOSAL_FULL_READ_REQUIRED`。
- `requiresFullRead` / `externalContentSeen` 是否真会跨信任边界传入：未核实。当前唯一生产调用方 `ProductionOwnerRuleWriter` 不传这两个参数。
- `proposals.read` 是否允许非 owner 调用并签发 `open` token：未核实，取决于读模型的 capability/actor 规则。
- 测试与 typecheck 是否全部通过：未运行，只做了代码静态核对。
