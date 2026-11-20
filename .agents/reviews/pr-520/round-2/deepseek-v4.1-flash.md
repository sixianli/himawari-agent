## 结论与意见

本轮范围：`7c11a03..b6233e0` 增量。除增量文件外，沿证据追到 `sqlite-owner-proposal-operations.ts`、`production-proposal-control.ts`、`contracts-v2.ts`、`apps/control-center/src/memory.ts`、迁移及 `.meta.json`。未运行测试和 typecheck（工具限制），也未读 `.agents` 复核记录（稀疏检出）。

### 1. 中高 — 租约过期恢复仍能在没有原样载荷时记成功，之后永远撤销不了

文件：`apps/agent-service/src/production-proposals.ts:585`（另见 `:545-560`、`:748-749`）

问题：上一轮的“载荷写失败也记成功”只修了同步路径。恢复路径仍会在 `execution_ref`/原样为空时，把租约过期的执行标成 `succeeded`；随后 `undo` 又因为没有原样而拒绝，形成“成功但不可撤销”的终点。

证据：
```ts
// 585-588
const execution = await this.#readExecution(row.executionRef);
await this.#verifyAfterExecution(row, handler, basis.data, execution?.original)...
```
`#verifyAfterExecution` 只要 `readBack` 返回 `matches` 就选 `succeeded`，然后按 `row.execStatus` 迁移，完全不检查 `execution_ref`：
```ts
// 545-559
verdict = (await handler.readBack(...)) === "matches" ? "succeeded" : "failed";
...
from: row.execStatus,
to: verdict,
```
而撤销要求原样存在：
```ts
// 748-749
const execution = await this.#readExecution(row.executionRef);
if (!basis || !execution) throw new ProposalError("PROPOSAL_NOT_UNDOABLE");
```
测试 `test/integration/owner-proposal-execution.test.ts:270-293` 甚至明确构造了“直接 `claim`、从未 `execute`”的行，并期待恢复后为 `succeeded`，等于把这个问题固化了。

证实：进程在 `execute` 成功后、`moveExecution(running→executed_unverified)` 或 `#recordExecution` 完成前崩溃，租约过期后恢复可以记成功且没有原样；此时 `undo` 必然 `PROPOSAL_NOT_UNDOABLE`。文档 `docs/architecture-v0.1.md:430` 既说“没有原样就撤销不了”，又说恢复“按结果记成功”，两者矛盾。

建议：恢复时若 `executionRef` 或原样读不到，只能记 `unknown`；`moveExecution` 进入 `succeeded` 时应要求 `execution_ref` 非空，或把“写原样 + 记 executed_unverified”做成不可分割的一步。补一条反向用例：恢复时无原样必须得到 `unknown`，不能得到 `succeeded`。

### 2. 中高 — 执行超过租约时恢复可抢先定终态，已执行的动作可能报“执行中”且失去原样

文件：`apps/agent-service/src/production-proposals.ts:674-688`（另见 `:563-589`）

问题：`execute` 返回后先写载荷、再把 `running` 改成 `executed_unverified`。如果执行时间超过 `leaseSeconds`（默认 120 秒），另一个 `list/adopt/undo` 会先跑 `#recover`，调用 `readBack` 并迁移状态。随后本进程的 `moveExecution(running→executed_unverified)` 会失败：

```ts
const pending = await store.moveExecution({
  ...,
  from: "running",
  to: "executed_unverified",
  leaseId,
  ...
});
if (!pending) throw new ProposalError("PROPOSAL_EXECUTING");
```

此时外部副作用已经发生，但 `execution_ref` 没写进行里；本进程向调用方报 `PROPOSAL_EXECUTING`，而恢复方可能已经把行记成 `succeeded`（无原样，见第 1 条）、`failed` 或 `unknown`。另外，恢复可能在 `execute` 仍在进行时读回，提前给出不成立的 `failed`/`unknown`。

证实：代码没有续租、没有 fencing token 校验、也没有在执行前后以租约作比较交换；`#recover` 只按 `exec_status IN ('running','executed_unverified')` 和过期时间选取，无法分辨“执行者还活着”。

建议：在执行期间续租，或让 `moveExecution` 带 `attempts`/fencing 条件，使恢复不能越过仍在执行的租约；执行结果写载荷和状态迁移应尽量原子化；迁移失败时重新读行并返回真实状态，而不是直接抛 `PROPOSAL_EXECUTING`。补“execute 比租约慢，同时读列表”的用例。

### 3. 中 — `moveExecution` 用 `leaseId: null` 可跳过租约条件，状态机没有限制这一点

文件：`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:397`（状态表在 `:26-37`）

问题：状态表允许 `running → succeeded/failed/unknown`，而 SQL 的租约条件是：

```sql
WHERE ... exec_status = ?
  AND (? IS NULL OR lease_id = ?)
```

传入 `leaseId: null` 时租约条件整体失效。当前唯一传 `null` 的调用是撤销（`production-proposals.ts:751-757`），而撤销只允许 `from: "succeeded"`，该状态在进入终态时已清掉租约，所以目前没有可执行的绕过路径。但存储层本身没有“只有终态才能用 null”的校验；任何未来调用方都可以用 `leaseId: null` 把一条仍被租用的 `running` 行直接改成 `succeeded`/`unknown`，与“带租约条件”的设计相违背。

证实：`EXECUTION_STEPS` 含 `running→succeeded`、`running→unknown`；SQL 对 `null` 放行。推测：目前没有生产调用方这么做，因此是潜在问题而非已发生的故障。

建议：`from` 为 `running`/`executed_unverified` 时强制要求非空 `leaseId`；`null` 只允许用于 `succeeded→undone` 等已无租约的迁移。补存储层测试：`running→succeeded` 带 `leaseId: null` 必须失败。

### 4. 低中 — 撤销只在单个提议箱实例内排队，跨进程仍可能让处理方 `undo` 执行两次

文件：`apps/agent-service/src/production-proposals.ts:719-731`

问题：增量用 `#undoing` Map 把同一 `proposalId` 的撤销串行化，这解决了同一实例内的并发。但 `#undoOnce` 仍是“先读 `succeeded`，再调用 `handler.undo`，最后迁移 `succeeded→undone`”，没有数据库层的撤销租约或比较交换。两个进程（或同一进程里的两个独立 `ProductionProposalBox` 实例）都能在任一迁移前读到 `succeeded`，于是各调用一次外部 `undo`；后一个的迁移失败后返回 `replayed: true`，但副作用已经执行两次。

证据：
```ts
const queued = (this.#undoing.get(proposalId) ?? Promise.resolve()).catch(...)
const running = queued.then(() => this.#undoOnce(proposalId, expected));
...
await handler.undo({ proposalId, data: basis.data, original: execution.original });
const moved = await store.moveExecution({ from: "succeeded", to: "undone", leaseId: null, ... });
```
文档 `docs/architecture-v0.1.md:430` 也限定为“在服务进程里排队”。推测：生产是否只有一个进程/一个箱子实例决定了这条的实际影响；多进程部署或 worker 各自持有实例时仍会重复执行。

建议：像 `claim` 一样给撤销加数据库层的原子领取（例如 `succeeded → undoing` 带租约），只有领取成功者调用 `handler.undo`。

### 5. 低 — `requiresPresence` 的存储值可被提议方传 `false` 降低，列表显示与实际采纳要求不一致

文件：`apps/agent-service/src/production-proposals.ts:379-381`（另见 `:610`、`:933-934`）

问题：写入时 `requiresPresence` 允许提议方用 `false` 覆盖处理方登记的要求；采纳时又会用处理方的值兜底：

```ts
const requiresPresence =
  input.requiresPresence ??
  (handler !== undefined && isAction(handler) && handler.requiresPresence === true);
...
if (row.requiresPresence || handler.requiresPresence === true) { ... }
```

结果可能是：处理方要求本人在场，但快照里 `requiresPresence` 为 `false`；客户端据此不取 `recentAuthenticationRef`，采纳时才报 `PROPOSAL_PRESENCE_REQUIRED`。这不是安全绕过（服务端仍强制），但“列表值”和“实际要求”两端不一致。

证据：提交路径用 `??`，采纳路径用逻辑或，列表直接回显 `row.requiresPresence`。

建议：存储值只允许提高，例如 `input.requiresPresence === true || (isAction(handler) && handler.requiresPresence === true)`；或者列表返回实时计算后的有效要求。

### 6. 低 — `openFull` 每个提议只留最新凭据，两台设备同时打开会让先打开的一台采纳失败

文件：`apps/agent-service/src/production-proposals.ts:470-482`

问题：
```ts
for (const [token, issued] of this.#fullReads)
  if (this.#fullReads.size >= FULL_READ_TOKEN_CEILING) this.#fullReads.delete(token);
  else if (issued.proposalId === proposalId) this.#fullReads.delete(token);
```
同一提议第二次 `open` 会删掉第一次的未过期凭据。两台设备同时打开全文时，先打开的设备拿到的 `fullReadToken` 会被后打开的设备作废，采纳时得到 `PROPOSAL_FULL_READ_REQUIRED`。另外凭据只存在进程内存：多进程部署时，`open` 和 `adopt` 落到不同进程也会失败。容量清理循环本身有界（最多约 1000 条），不会无限增长。

证实：删除逻辑和内存 Map 都在代码里。推测：当前只有一个服务进程且一次只打开一次时不会触发；属于可用性问题，不是越权。

建议：允许同一提议保留多个未过期凭据（配合总量上限），或只清理同提议中最旧的凭据。

### 7. 低 — 网关和界面没有消费 `undo`、凭据和执行状态，`unknown` 之后主人在界面上看不到也退不出去

文件：`apps/control-center/src/memory.ts:33`（另见 `:188`、`:322-330`；`production-proposal-control.ts:156-171`）

问题：
- 界面类型仍只有 `adopt | reject`，不会发送 `undo`；凭据字段固定为 `null`，所以任何 `requiresFullRead`/`requiresPresence` 的提议都无法从当前唯一客户端采纳。作者已声明本 PR 不做网页界面，但这是消费者未对齐的事实。
- `ProductionProposalControl.execute` 只读取 `resultRef`，丢弃了 `execution`。
- `listPending` 只查 `status = 'pending'`，快照也没有 `execStatus`。因此领取后卡片直接消失；若读回出错进入 `unknown`，界面既看不到，也不能撤销（`undo` 只接受 `succeeded`）。

证据：`sqlite-owner-proposal-operations.ts:278-280` 的 `WHERE ... status = 'pending'`；`production-proposals.ts:743-744` 的 `if (row.execStatus !== "succeeded") throw PROPOSAL_NOT_UNDOABLE`。

证实：当前没有生产处理方登记为 action，也没有生产调用方传 `externalContentSeen`，所以这些缺口暂时不会出现在真实用户面前。建议：后续接界面时同时接 `open`/`fullReadToken`、`recentAuthenticationRef`、`undo` 和一个能显示非待采纳执行状态的视图；在此之前文档应明确“本 PR 只有后端，执行结果在界面上不可见”。

## 侧重检查

- **claim / moveExecution 状态机**：当前调用方用到的转换没有缺失；`running→succeeded/failed` 被恢复路径用来跳过 `executed_unverified`，因此绕过了“先存原样”的保护（第 1 条）。`unknown→succeeded/failed` 目前没有调用方（`listExpiredLeases` 不选 `unknown`，`adopt` 从 `executed_unverified` 开始），属于多余且可通过 `leaseId: null` 调用的宽松转换（第 3 条）。
- **#adoptAction 错误分支**：`verify` 失败会标 `superseded` 且不执行；`claim` 失败会重读并按 `changed`/`EXECUTING` 报错；`execute` 抛错会尝试记 `failed`。但 `execute` 成功后 `running→executed_unverified` 迁移失败时直接抛 `PROPOSAL_EXECUTING`，外部副作用已发生而原样引用丢失（第 2 条）。凭据或本人在场校验失败发生在 `claim` 之前，目标行不会被改；不过 `adopt`/`undo`/`list` 开头的 `#recover` 会顺带修改其他租约过期行。
- **读回出错后的出路**：只会进入 `unknown`；不能再次采纳（状态已是 `accepted`），不能撤销（要求 `succeeded`），列表又只列 `pending`，界面没有执行状态字段，所以主人在界面上看不到，也没有应用内出路（第 7 条）。
- **openFull**：内存态凭据在重启、多进程、换实例时失效；同一提议后打开的凭据会作废先打开的（第 6 条）。容量清理循环有界，未发现死循环或超过上限的路径。
- **propose 的默认值**：处理方尚未登记时，`origin === "external_content"` 且不是 action 会得到 `requiresFullRead = true`；不是外部内容则为 `false`，后续登记 action 时 `requiresFullRead` 仍为 `false`（确定动作本来就不要求）。`requiresPresence` 存在第 5 条的“显示值可被降低”问题。
- **网关字段对齐**：仓内 `proposals.read` 生产者只有 `control-center/src/memory.ts`，已补 `open: null`；`proposal.respond` 生产者只有 memory.ts 和测试夹具，已补两个凭据字段；`proposals.snapshot` 夹具已补新字段。`client-capabilities.ts` 只列操作名，无需改。旧的外部客户端如果仍发送 `payload: {}`，会因新字段必填而被网关拒绝（推测，仓内无此客户端）。
- **安全 / 不可撤销**：`requiresFullRead` 的“只能提高”已修好；本人在场在没有 guard 时是 fail-closed（没有 `assertPresence` 就报 `PROPOSAL_PRESENCE_REQUIRED`）。`failed`、`unknown`、`undone` 都不可重试/不可再提议，符合“撤销是终点”。撤销本身不要求本人在场，这是策略选择，未发现绕过。
- **资源**：`#fullReads` 上限 1000；`#recover` 每轮最多 50 条；但 `listExpiredLeases` 的查询没有对应索引，且执行原样载荷在成功/撤销后没有清理，历史行会一直增长，后续需要补索引和清理。
- **迁移**：`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 常量 CHECK` 对已有行是合法的（默认值满足 CHECK；SQLite 不会对旧行重新验证 CHECK），`owner_proposals` 是 STRICT 表，新增 TEXT/INTEGER 列没有类型冲突。`.meta.json` 的 `{"alters":["owner_proposals"]}` 已满足仓库的 `migration-conflicts` 检查；运行时迁移引擎只校验 SQL 摘要，不读 `alters`，所以不会因缺少额外声明而失败。此项依据 SQLite 规则判断，未在本机执行迁移。

## 上一轮意见与作者说法核对

**上一轮意见**

1. **“原样载荷写入失败仍记成功”**：同步路径已改好并有反向用例；但恢复/崩溃窗口仍能在没有原样时记成功（第 1 条），不算完全改好。
2. **“撤销没有租约或比较交换”**：同实例内已用 `#undoing` 排队并有并发用例；跨进程/跨实例仍可重复执行 `undo`（第 4 条），只算部分改好。
3. **“`requiresFullRead` 可由提议方传 false 覆盖”**：已改好。`:376-378` 使用 `input.requiresFullRead === true || (external_content && 非 action)`，新增用例 `owner-proposal-execution.test.ts:479-488` 会验证外部内容传 `false` 仍记 1。反向改回 `??` 时该用例会失败。
4. **“文档与代码不一致”**：本次文档已同步 undo、领取时两列同改、凭据只对确定动作作废、`closed` 是存储层结果、被撤回是预留值。剩余不一致是 `docs/architecture-v0.1.md:430` 既说“没有原样就撤销不了”，又说恢复可按读回记成功（第 1 条）。

**作者说法**

1. “两台设备同时点同一个提议，只有一个能领取并执行”：**属实**。`claim` 是带 `status='pending' AND exec_status='not_started'` 和版本/指纹条件的单条 UPDATE，测试 `:256-268` 覆盖。
2. “租约过期的执行永远不会被再执行一遍，只读回核实”：**前半属实**，`#recover` 不调用 `execute`；但读回可能把没有原样的执行记成功（第 1 条），也可能与仍在执行的执行者竞争（第 2 条）。
3. “同一编号撤销后再提议不会重新打开”：**属实**。存储层在 `execStatus !== 'not_started'` 时返回 `closed`，提议箱删除新载荷并直接返回；测试 `:176-204` 覆盖。
4. “凭据对不上或过期时，什么状态都不改”：对目标提议**属实**，全文凭据和本人在场检查都在 `claim` 之前；不过 `adopt/undo/list` 开头的 `#recover` 会顺带处理其他过期租约。
5. “规则类提议行为没变”：**属实**。规则处理方不是 action，`exec_status` 保持 `not_started`，`closed` 分支不会触发；`requiresFullRead`/`requiresPresence` 对规则提议默认都是 false。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本 PR 没有改模型请求组装、系统提示、工具定义、历史、遮盖或压缩；新增的指纹、网关快照、执行状态都不进入模型请求。仍然只有末尾追加，每轮会变的值没有进入前缀。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型内容。新增的 `fingerprint` 用 `canonicalJson`（键排序）计算，但只用于提议版本/幂等；网关快照的 `generatedAt`、`expiresAt` 会变，但那是界面协议，不是模型请求。没有发现新的前后文相关遮盖或无序集合进入模型。
3. **有没有自动检查，反向用例真的会失败？** 增量有三条新用例，反向推理成立：改回 `??` 会让全读用例失败；去掉 `#undoing` 会让并发撤销用例的 `undone` 变成 2；去掉 `ref === undefined` 分支会让载荷失败用例得到 `succeeded` 而不是 `unknown`。但覆盖不完整：没有“恢复时无原样不得记成功”“`running→succeeded` 带 null 租约必须拒绝”“执行超过租约 + 并发读列表”“跨进程撤销”“两台设备同时 open 同一提议”的反向用例。本环境不能运行测试，结论仅来自读代码。
4. **每个新值的使用端都能接受吗？** `exec_status`、`lease_id`、`lease_expires_at`、`attempts`、`requires_full_read`、`requires_presence`、`executed_at`、`execution_ref` 的存储校验与读取端类型已逐项核对，长度/格式匹配；`external_content` 已加入网关枚举和存储校验；`closed` 已加入端口联合类型且提议箱处理；`undo` 已加入动作枚举并由控制层分派；`open`、`recentAuthenticationRef`、`fullReadToken`、`opened`、`requiresFullRead`、`requiresPresence` 已更新仓内唯一的 control-center 生产者和测试夹具。遗留的是：界面始终传 `null` 凭据且不发 `undo`（第 7 条）；`requiresPresence` 快照值可能与实际要求不一致（第 5 条）；`requiresFullRead`/`requiresPresence` 没有进入指纹，刷新可以只改这两个值而不升版本（未发现由此产生的越权，因为外部内容的全读下限仍在服务端强制）；另外新字段在合约里是必填的，旧的外部客户端会被拒绝（推测，仓内无此客户端）。

未核实：未运行测试、typecheck、迁移和 SQLite 实验；未读取 `.agents/reviews` 的上一轮记录（稀疏检出不包含该目录）。
