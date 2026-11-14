## 读代码证实的发现（按严重度）

### 中-1 文档/设计与本次行为冲突，且没有随提交更新
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:231`；`.agents/instructions/document-governance.md:55`
- 问题：设计文档明确说设备接口不包含“导出数据”，导出只在嵌入网页里做；本 PR 却为 iOS 原生页新增 `data.export.start` / `data.export.status.read`。`git diff --stat` 显示本次只改了代码、测试和 CI，没有任何 `docs/` 或 ADR 更新。
- 证据：
  - 设计文档原文：“比如设备接口里没有“改规则”“删记忆”“导出数据”，这些只在嵌入的网页里做，走网页会话”。
  - 文档治理规则：“每个改变行为、接口、配置、测试所需环境或操作步骤的提交，都要在同一个提交里更新受影响的文档：规格、计划、架构文档、Runbook、Backlog 条目，以及 ADR”。
- 建议：要么在设计/ADR 里明确改成“原生设置页也允许导出”，并把 `exportId`、`downloadPath`、`status.snapshot` 等新值补进“新值清单”；要么撤回该网关接口，继续让原生页走嵌入网页。

### 中-2 压缩包在内存中保留 10 分钟，且网页直下可在已有结果上再生成一份，可能同时占约两份 512 MB
- 文件:行：`apps/agent-service/src/production-data-export.ts:197-207`、`:172-180`、`:368-371`
- 问题：`DataExportJobs` 把生成好的 `Buffer` 挂在 `job.built` 上保留 10 分钟；`busy` 只表示“正在生成”，不表示“已有结果占着内存”。因此当某个任务已 `ready` 时，网页直接 `GET /api/data-export/v1/archive`（不带 `exportId`）仍会再生成一份，旧结果继续留在内存里。
- 证据：
  - `job.built = built; job.state = "ready";`，随后 `this.#release = setTimeout(...)`（`:202-207`）。
  - 网页直下只检查 `if (options.jobs.busy) return reply.code(429).send();`，然后 `built = await options.jobs.buildNow();`（`:369-371`）。
  - `MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024`（`:35`）。
- 建议：把结果落到每人目录下的临时文件（权限 0600，TTL 后删除）并流式返回；或者在没有 `exportId` 且已有 ready 任务时直接复用该结果，避免同时存在两份大内存对象。至少给内存占用加一条预算检查。

### 中-3 `data.export.start` 忽略 `idempotencyKey`，重试会替换掉已就绪的导出
- 文件:行：`apps/agent-service/src/production-data-export.ts:182-196`、`:332`；`packages/application/src/services/governance-gateway-adapter.ts:77-85`、`:595`
- 问题：`start()` 只在任务仍为 `running` 时返回同一个编号；任务一旦 `ready`，同一个幂等键再发一次会新建任务、清掉旧任务的释放定时器并替换 `#job`。旧 `exportId` 立即变成 `expired`，已拿到的下载链接作废。`data.export.start` 不在 `GOVERNANCE_COMMAND_TYPES` 里，所以也不会有 receipt 层的幂等重放。
- 证据：
  - `if (this.#job?.state === "running") return this.#job.exportId;`（`:183`）之后直接创建新任务并 `this.#job = job;`（`:196`）。
  - `return { resultRef: this.#options.jobs.start(), replayed: false };`（`:332`）。
  - `if (!isGovernanceCommand(input.command)) return this.#dependencies.delegate.execute(input);`（`governance-gateway-adapter.ts:595`）。
- 建议：按 `idempotencyKey` 保存任务/结果；同一键在 ready 阶段重试时返回原 `exportId` 和 `replayed: true`（或明确要求客户端不要重试），不要因为一次网络重试把旧下载链接作废。

### 低-1 网页直下与网关开始之间的竞态会被报成 500，而不是 429
- 文件:行：`apps/agent-service/src/production-data-export.ts:369-375`、`:172-179`
- 问题：先检查 `jobs.busy`，再 `await buildNow()`。若检查后、`buildNow` 设置 `#building` 前有另一条路径开始生成（当前同步代码下窗口很小，但语义上依赖调用顺序），`buildNow` 会抛 `DATA_EXPORT_BUSY`，路由的通用 catch 返回 500。
- 证据：
  - `if (options.jobs.busy) return reply.code(429).send();`
  - `built = await options.jobs.buildNow();` / `return reply.code(500).send();`
  - `buildNow()`：`if (this.#building) throw new Error(DATA_EXPORT_BUSY);`
- 建议：在路由里单独捕获 `DATA_EXPORT_BUSY` 并返回 429，或让 `buildNow` 返回可区分的 busy 结果。

### 低-2 测试声称“和网页直接下载是同一份内容”，但只在冻结时钟下成立
- 文件:行：`test/integration/data-export-http.test.ts:292`、`:319-323`；`apps/agent-service/src/production-data-export.ts:246-252`
- 问题：测试用固定的 `now`，所以网关任务和网页直下生成的 manifest `exportedAt`、ZIP 时间戳相同，字节才相等。真实服务里网页直下会重新生成压缩包，时间不同，字节和 `sha256` 都会不同。
- 证据：
  - `expect(Buffer.compare(direct.rawPayload, prepared.rawPayload)).toBe(0);`
  - `#build()` 使用 `result.manifest.exportedAt` 生成文件名和 ZIP；`buildPortableExport({ ..., now: this.#options.now })`。
- 建议：把断言改成“解析后的文件集合/计数一致”，或在测试名里写明“冻结时钟下一致”；如果产品要求同一份字节，网页直下应复用 ready 任务。

### 低-3 新契约只有正向 fixture，没有反向契约用例
- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:665-705`；`packages/gateway-contracts/test/gateway-v2.fixture.ts:439-455`；对比 `packages/gateway-contracts/test/device-gateway.contract.test.ts:142-180`
- 问题：`data.export.status.read` / `data.export.status.snapshot` 新增了 `exportId` 正则、`state` 枚举、`sha256` 正则、`result` 结构，但只有 fixture 中的正向样例；没有类似 `server.status.snapshot` 的 `it.each("rejects %s", ...)` 反向用例。去掉 `dataExportIdSchema` 或 `DATA_EXPORT_STATES` 时，现有测试不会失败。
- 证据：fixture 只新增了 `fixture("query", "data.export.status.read", ...)` 和 `fixture("snapshot", "data.export.status.snapshot", ...)`；`device-gateway.contract.test.ts` 对 `server.status.snapshot` 明确有“unknown overall status / unknown dependency status / missing live”等拒绝用例。
- 建议：补契约反向用例：不合格的 `exportId`、未知 `state`、大写/短 `sha256`、负数计数、多余字段、`result` 缺字段等，最好覆盖 `data.export.start` 的 payload 多字段拒绝。

## 推测/未核实

- **推测**：如果 `clock.now()` 返回不可解析的时间，`new Date(Date.parse(job.finishedAt) + retentionMs).toISOString()` 会抛错；这个异常发生在 `start()` 的 success 回调里，`#job` 会永远停在 `running`，并产生未处理的 Promise rejection。依据：`production-data-export.ts:200-203`。生产 clock 正常情况下不会这样，故只列为推测。
- **未核实**：本 PR 的内存任务只存在进程内。ADR 0234 当前是“一套程序、每人一个数据库文件”，看起来同一人的请求会落到同一进程；但若以后按 ADR 0234 第 15 条改成多进程或加负载均衡，状态查询/下载可能落到没有该任务的进程，表现为永远 `expired`。当前部署是否可能这样，我没有核实。
- **未核实**：作者说“9 个 Layer-0 测试文件 242 项通过”“format、lint、tsc、check:operations 通过”，以及“新增 4 条导出网关用例”；我没有运行测试，无法证实这些数字，只核对了测试代码内容。
- **未核实**：iOS 端如何使用 `resultRef` 和 `downloadPath`（仓库里没有客户端代码），所以只能确认服务端格式；客户端是否接受 `data-export:` 前缀和相对路径，未核实。

## 侧重检查

- **错误路径**：已检查 400（不合格 `exportId`）、401（未登录/换主人）、403（跨站）、404（未知/失败/过期）、429（生成中网页并发）、500（生成失败）。发现 429/500 的竞态问题（低-1）。
- **不合规范/不可信输入**：`exportId` 在契约层和路由层都使用同一个 `DATA_EXPORT_ID_PATTERN`；`exportId` 重复参数、非字符串都走 400；没有路径拼接或 SQL 拼接。未发现注入类问题。
- **安全**：接口要求主人会话且校验 `ownerId`；`exportId` 是 `randomBytes(16)` 的 128 位随机值，不可枚举；下载仍走原导出策略，机密文字按原占位符逻辑处理。未发现新的越权读取。
- **资源耗尽**：发现内存保留和网页直下可再生成一份的问题（中-2）；512 MB 是单份压缩包上限，实际堆内存还会更高。
- **不可撤销的操作**：开始新导出会立即让旧的 ready 结果失效（中-3）；这是“一次一份任务”设计的副作用，建议至少保证同一幂等键不会误伤。
- **规则/文档/代码一致性**：`prompt-prefix` 规则没有被违反（本次不改模型请求）；但设计文档与新增接口冲突（中-1），`document-governance` 要求的文档同步也未做。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`git diff --stat` 里没有 `packages/prompt-catalog`、runtime/Pi、模型请求组装、历史或遮盖相关文件；新增的是网关控制面消息和导出任务，不是模型工具或系统提示。本次改动没有引入“修改已发内容”或“把每轮变化值放进开头”的路径，符合[只追加规则](../../.claude/rules/prompt-prefix.md#rules)第 4 条。`generatedAt`、`startedAt`、`exportId`、ZIP 时间等变化值只出现在网关响应和导出产物里，不进入模型请求。**无法从本 PR 证明整个模型路径仍然只在末尾追加，但本 PR 没有改变它。**

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求：不会，本次没有新增依赖前后文的遮盖、时间戳或无序集合进入模型内容。对导出产物：会，而且应该如此——`exportId` 是随机的，manifest 的 `exportedAt` 和 ZIP DOS 时间取决于生成时刻，所以同一份数据在不同时间导出的字节和 `sha256` 不同。这不是模型缓存问题；但如果验收要求“网页直下和网关导出字节一致”，该假设只在测试冻结时钟时成立（低-2）。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`check:operations` 检查新操作的后端/调用方/测试和 pending 名单；`check:data-export` 会跑 `[P1-6]` 的集成测试，新加的 4 条就在这个 describe 里；契约 fixture 的“每种消息类型都能往返”会覆盖新三种消息；组合层单测覆盖了网关开始/查进度/下载。
   反向用例从断言看是有意义的：不合格 `exportId` 期望 400、未知编号 404、非主人 `start` 抛错、生成中再开始返回同一编号、网页直下 429、过期后 404、失败后重试成功、旧编号变 expired；删掉对应逻辑时这些断言会失败。但要说明：我只读了测试，没有运行。覆盖缺口是：新契约没有反向用例（低-3），没有测试“网页直下正在生成时网关开始”的方向，也没有幂等键重试用例。

4. **每个新值的产生处和使用处两端都能接受吗？**
   已逐个核对：
   - `exportId`：`production-data-export.ts:186` 用 `randomBytes(16).toString("base64url")` 产生，固定 22 个 `[A-Za-z0-9_-]`；契约 `DATA_EXPORT_ID_PATTERN`（`contracts-v2.ts:673`）和路由（`production-data-export.ts:363`）用的是同一个常量；`machineString` 允许冒号（`validation.ts:54`），长度 34 < 128；fixture 也使用同样格式。两端一致。
   - `resultRef`：返回给客户端的是同一个 `exportId`，能通过 `machineString`；但命令结果没有后端 schema 校验，并且 `data.export.start` 不走 receipt 幂等（中-3）。iOS 端是否接受未核实。
   - `state` / `failureCode` / `startedAt` / `finishedAt` / `expiresAt`：`state` 在 `DATA_EXPORT_STATES` 内；失败码由 `^[A-Z][A-Z0-9_]{2,63}$` 产生，能被 `machineString` 接受；时间由同一 clock 产生，契约用 `timestamp`。一致。
   - `downloadPath`：用 `encodeURIComponent` 产生，长度远小于 `boundedString(256)`；路由用同一正则解析；测试实际走通。一致。
   - `fileName` / `sizeBytes` / `sha256` / `memories` / `rules` / `withheld`：文件名为固定格式且远小于 128；`sizeBytes` 来自 ZIP 长度且至少 22 字节；`sha256` 是小写十六进制 64 位；三个计数来自原 manifest，非负整数。两端一致。
   - 操作清单：`PRODUCTION_DATA_EXPORT_OPERATIONS` 与契约 `GATEWAY_V2_MESSAGE_TYPES` 一致，并已加入网关安装名单、网页配置和 `ci/operations-pending.json`；`data.export.status.snapshot` 只作为响应类型，不当作 operation，符合 `check-operations` 的读法。
   - 唯一两端不完整的是命令的 `idempotencyKey`：契约和 HTTP 层都要求它，但任务存储没有用它，导致同一键重试会新建任务（中-3）。
