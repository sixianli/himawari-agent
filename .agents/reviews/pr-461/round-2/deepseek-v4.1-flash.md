## 一、读代码证实的问题（按严重度从高到低）

### 1. 中：不同确认键在生成中会拿到同一个编号，随后该键重试又变成新编号，破坏“同一键同一结果”

文件：`apps/agent-service/src/production-data-export.ts:191-194`、`:205-206`

问题：生成中收到一个**不同的**确认键时，代码直接把当前任务的编号返回给这个新键，但没有把新键记为已接受。等当前任务完成后，用这个新键重试，会走“新键 → 新建任务 → 丢掉旧结果”的路径，于是同一个键先后返回两个编号。

证据：

```ts
if (this.#job?.idempotencyKey === idempotencyKey)
  return { exportId: this.#job.exportId, replayed: true };
if (this.#job?.state === "running") return { exportId: this.#job.exportId, replayed: false };
```

```ts
this.#discard();
this.#job = job;
```

`test/integration/data-export-http.test.ts:429-431` 还明确用一个新的随机键 `start()`，并断言它拿到的是旧任务的编号，说明这是当前有意行为，但没有覆盖“该新键之后重试”的路径。

建议：生成中遇到不同键时返回 409/429，不要把它伪装成已接受；或维护 `Map<idempotencyKey, exportId>`，让每个被接受过的键在保留期内都能重放到同一编号。补一条“新键在生成中返回 A，完成后用同一新键重试仍返回 A”的用例。

### 2. 中：失败任务没有过期时间也没有清理，同一确认键重试永远返回 failed

文件：`apps/agent-service/src/production-data-export.ts:191-192`、`:219-223`

问题：失败处理只写 `finishedAt`、`failureCode`、`state`，没有设置 `expiresAt`，也没有设置释放定时器。失败任务会一直留在 `#job` 里，同一确认键重试时第 191 行先命中，永远返回 `replayed: true` 和同一个 failed 编号，没有机会重新生成。

证据：

```ts
if (this.#job?.idempotencyKey === idempotencyKey)
  return { exportId: this.#job.exportId, replayed: true };
```

```ts
(error: unknown) => {
  job.finishedAt = this.#options.now();
  job.failureCode = exportFailureCode(error);
  job.state = "failed";
},
```

`test/integration/data-export-http.test.ts:404` 的“再开始一次可以成功”实际调用的 `start()` 默认生成新的随机键，所以绕开了“同一键重试失败任务”这条路径。

建议：明确失败后的幂等语义。若客户端必须换键重试，就在契约和测试里写清楚；若允许同键重试，需要给失败任务设置过期/清理并允许同键重新生成（但这会改变“同键同编号”的定义）。至少不要让失败任务无限期占着 `#job`。

### 3. 中：已过期但定时器还没清掉的任务，会在同键重放时返回 expired 编号

文件：`apps/agent-service/src/production-data-export.ts:191-192`、`:228-233`

问题：`start()` 先按确认键命中，再在 `view()` 里才用 `clock.now()` 判断 `expiresAt`。如果任务已经过期，但 `setTimeout` 还没来得及把 `#job` 置空（事件循环延迟、进程挂起、注入时钟推进等），同一确认键重发会先命中第 191 行，返回一个 expired 编号且 `replayed: true`，客户端无法开始新导出。

证据：

```ts
if (this.#job?.idempotencyKey === idempotencyKey)
  return { exportId: this.#job.exportId, replayed: true };
```

```ts
(job.expiresAt !== null && Date.parse(this.#options.now()) >= Date.parse(job.expiresAt))
```

建议：`start()` 在重放判断前先检查 `expiresAt`，过期就 `#discard()` 后再按新请求处理；补一条“推进时钟到过期、定时器尚未触发时，同键 start 应重新生成”的用例。

### 4. 低：作者说“网页直下与网关开始撞上时返回 429”，但网关开始一侧实际是 409

文件：`apps/agent-service/src/production-data-export.ts:194`、`:345-347`、`:381-386`

问题：网页直接下载撞上正在生成时确实返回 429（`:381`、`:385-386`）。但网页直接下载正在生成时，网关 `data.export.start` 收到的是 `DATA_EXPORT_BUSY`，随后被映射成 `ApplicationPortError(PORT_ERROR_CODES.CONFLICT, ...)`，不是 429。

证据：

```ts
if (this.#building) throw new Error(DATA_EXPORT_BUSY);
```

```ts
if (error instanceof Error && error.message === DATA_EXPORT_BUSY)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, DATA_EXPORT_BUSY);
```

```ts
if (options.jobs.busy) return reply.code(429).send();
```

建议：如果要求两边都返回 429，应改网关错误映射；否则把作者说明和测试名改成“网页直接下载返回 429，网关开始返回 409”，并补网关侧的状态码断言。

### 5. 低：契约样例里的 `downloadPath` 与同一个样例的 `exportId` 不一致，且契约不校验这一点

文件：`packages/gateway-contracts/test/gateway-v2.fixture.ts:442`、`:448`；`packages/gateway-contracts/src/contracts-v2.ts:693`

问题：样例 `exportId` 是 `data-export:` 加 22 个字符，但 `downloadPath` 里的 `%3A` 后面是另一串长度不一致的 A。`downloadPath` 只受 `boundedString(256)` 约束，不校验能否解析回同一个 `exportId`，所以这个不一致不会被测试发现。

建议：从同一个 `exportId` 生成样例的 `downloadPath`；契约或测试至少校验 `downloadPath` 里的 `exportId` 能通过 `DATA_EXPORT_ID_PATTERN` 并与快照的 `exportId` 一致。

### 6. 低：内存明文压缩包保留 10 分钟是新出现的数据驻留面，文档未写

文件：`apps/agent-service/src/production-data-export.ts:33`、`:207-217`

问题：旧的网页直接下载是生成后立刻发送；现在网关任务会把压缩包放在 `job.built` 里保留 `DATA_EXPORT_RETENTION_MS`（10 分钟）。这是包含主人数据（机密已替换为占位符）的明文压缩包在进程内存中的新增保留窗口。当前测试覆盖了过期后不可下载，但没有文档说明这个保留面。

建议：在设计文档/ADR 里写明保留时长和原因；如果不需要跨请求取结果，考虑更短的保留期或立即消费后丢弃。

## 二、推测或未核实的问题

### 1. 低：`data.export.start` 的幂等记录只在进程内，重启后同键会生成新编号

文件：`apps/agent-service/src/production-data-export.ts:159-163`、`:190-226`；`packages/application/src/services/governance-gateway-adapter.ts:77-85`、`:594-595`

读代码可以确认：`data.export.start` 不在 `GOVERNANCE_COMMAND_TYPES` 里，控制面直接 `delegate.execute`，不写 `Go` mutation receipt；幂等状态只在 `DataExportJobs` 的内存字段里。因此进程重启后，同一个确认键会生成新的 `exportId`。

这是否算问题取决于需求。如果 iOS 把 HTTP 幂等键当作跨重启保证，就会失败。建议在文档里写明“仅进程内、保留期内有效”，或改用现有的 receipt 存储。此项中“重启后的具体客户端行为”未核实。

### 2. 低：作者“不改文档”的说法只对“设备签名接口没变”成立，新增的网关操作没有文档

文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:231`；本 PR 没有 docs 改动

文档原文是：“设备接口里没有‘改规则’‘删记忆’‘导出数据’，这些只在嵌入的网页里做，走网页会话。”这句话确实说明设备签名接口不包含导出，作者的这一半说法成立。

但本 PR 新增的是网关 v2 的 `data.export.start` / `data.export.status.read`，以及 `running/ready/failed/expired` 状态、10 分钟保留、同键重放、409/429 语义。这些在 ADR 0200 或苹果设备设计文档里没有对应描述。建议至少补一段网关导出的接口和错误语义，或指出本 PR 使用的是哪份未在仓库里的设计文档。

## 三、侧重检查

- **未认证、错主人、跨站输入**：`production-data-export.ts:366-371` 在生成前检查 `Sec-Fetch-Site`、认证和 `ownerId`；`test/integration/data-export-http.test.ts:201-220` 覆盖 401/403。未发现可绕过点。
- **不合格或未知 exportId**：`production-data-export.ts:374-378` 先做 `DATA_EXPORT_ID_PATTERN` 校验，不合格 400，未知/过期 404；测试 `:337-360` 覆盖。不会因为编号不合格读到文件。
- **开始导出的授权**：`production-data-export.ts:331-339` 要求 `actorType === "owner"` 且 scope 匹配。`actorType` 是客户端字段，真正的身份绑定依赖 `AgentGatewayV2Service.authorize` 和 `ProductionThreadGatewayAccessPolicy`；这与现有治理命令的做法一致，未发现本 PR 引入新的越权路径。
- **并发和资源耗尽**：`buildNow()` 用 `#building` 串行化（`:173-181`）；新任务开始前 `#discard()` 丢掉旧任务（`:176`、`:205-206`）；ZIP 有 512 MiB 上限（`:35`、`:94-97`）。读代码可确认同时最多一份生成中的压缩包；但失败任务没有清理、过期任务在定时器前仍占内存，见上文问题 2、3、6。
- **不可撤销操作**：导出只读数据库（`openReadOnlyDatabase`，`:249`），不写产品库；没有不可撤销副作用。
- **不可信输入和注入**：`idempotencyKey` 由命令契约 `machineString` 校验；`exportId` 由严格正则限制；`fileName` 来自清单时间戳的前 10 个字符，正常情况下没有换行/引号注入面。若注入的时钟可产生任意字符串，`Content-Disposition` 的拼接会变危险，但生产时钟是 `toISOString()`，见 `production-http-composition.ts:746`。
- **规则文件、说明文档和代码一致**：`prompt-prefix` 规则不受影响；`ci/operations-pending.json` 的两条新增项与 `scripts/check-operations.mjs` 的判定一致（后端实现和测试有，前端/scripts/admin-cli 没有调用方，所以必须留在 pending）。文档方面见“推测”第 2 条。

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。本次 diff 只改了数据导出、网关契约、装配和测试，没有改系统提示、工具定义、历史消息、模型出口遮盖或模型请求组装。`ProductionDataExportControl` 只产生网关快照，不进入模型消息。因此发给模型的内容仍然只在末尾追加，每轮变化的值（导出编号、时间、状态）不在模型请求里。依据：`.claude/rules/prompt-prefix.md` 第 4 条“只能追加”及本次 diff 的文件范围。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

对模型请求：不会，本 PR 没有模型请求内容。

对导出和网关快照：会存在按设计变化的值。`generatedAt` 每次查询都会变（`production-data-export.ts:324`）；不同次生成压缩包时，清单的 `exportedAt` 和 ZIP 的 DOS 时间会进入字节（`:257-263`），所以网页直接下载重新生成时字节可能不同。但同一 `exportId` 在保留期内重放的是同一份 `job.built`（`:212`），字节不变。这些都不属于模型请求前缀，也不是本 PR 引入的非确定性。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且反向用例在代码逻辑上会失败：

- 契约反向用例在 `packages/gateway-contracts/test/data-export-gateway.contract.test.ts`：无前缀、过短、非法字符的 exportId；非法 state、大写/过短 sha256、sizeBytes 0、负计数、缺 expiresAt、额外字段、start 带 payload 字段。`validation.ts:161-190` 的 `object` 会拒绝未知字段，`patternString` 会拒绝不匹配正则，`integer(1)` 会拒绝 0，`nullable`/`timestamp` 会拒绝 undefined。未执行测试，只按代码核对。
- 行为反向用例在 `test/integration/data-export-http.test.ts`：网页侧生成中 429、过期后 404、未知编号 expired、未登录 401、错主人 401、非法编号 400、失败新键重试成功、同键重放。`production-http-composition.unit.test.ts` 还走了真实组合的 start/status/download。
- **覆盖缺口**：没有覆盖“生成中收到不同键后，该键再重试”的路径；没有覆盖“失败后用同一键重试”；没有覆盖“已过期但定时器未清理时同键 start”；没有断言网关 start 撞上网页构建时是 409 还是 429。上述问题 1、2、3 因此不会被现有测试抓住。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对结果：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `exportId` | `production-data-export.ts:197`，16 字节 base64url = 22 字符 | 契约 `contracts-v2.ts:673`、`:686`；路由 `:375`；`resultRef` 作为 machine string | 两端一致 |
| `idempotencyKey` | 命令契约 `machineString` | 只用于比较，未进入快照（`view()` 已剔除） | 长度/字符集一致 |
| `failureCode` | `:154-157`，3-64 位大写/下划线 | 快照 `machineString` | 合法 |
| `sha256` | `:264`，`createHash(...).digest("hex")` | 契约 `:696` 要求 64 位小写十六进制 | 合法 |
| `sizeBytes` / `memories` / `rules` / `withheld` | `:265-270` | `integer(1)` / `integer(0)` | 合法 |
| `startedAt` / `finishedAt` / `expiresAt` | 生产时钟 `toISOString()`，`:211` | `timestamp` | 合法 |
| `fileName` / `downloadPath` | `:263`、`:314` | `boundedString(128/256)` | 合法；样例 `downloadPath` 自身不一致，见问题 5 |
| 操作名 | `:278-281` | `installedGatewayV2Operations`、契约、pending 清单 | 一致 |

没有发现 I-73 那种“清单里的 id 过不了后端校验”的硬性不匹配。真正的不匹配在**语义**上：确认键与编号的映射不完整（问题 1），以及失败/过期状态没有覆盖所有重放路径（问题 2、3）。

## 五、作者说法逐条核对

- “同一确认键重发返回同一编号且 `replayed` 为 true，不作废已生成结果”：**部分成立**。同一键对应的任务还在内存时成立；但不同键在生成中会拿到别的编号、该键再重试会变成新编号；失败任务同键重试永远失败；重启后同键不再成立。
- “任何新的生成开始前先丢掉已完成的那份，内存里同时最多一份压缩包”：**成立**。`buildNow()` 在 `:176` 丢弃非 running 任务，`start()` 在 `:205-206` 丢弃旧任务。
- “网页直下与网关开始撞上时返回 429”：**只对网页请求成立**；网关 start 一侧返回 409 CONFLICT，见问题 4。
- “新增契约反向用例”：**成立**，且按 `validation.ts` 的实现，这些反向用例确实会失败。
- “测试名改为‘同一套生成逻辑’”：**成立**，`test/integration/data-export-http.test.ts:295`。
- “设计文档那句说的是设备签名接口，本 PR 没改设备接口，导出仍走网页会话”：**对设备接口部分成立**，但新增的网关操作和状态机没有文档，见“推测”第 2 条。
- “生成没有超时是改前就有的行为”：**成立**，旧网页路径同样直接 `await buildPortableExport`，没有超时；本 PR 也没有新增超时。
