以下结论只基于我读到的代码，未运行任何测试；严重度按“会不会出错 / 会不会埋坑”从高到低排。

## 读代码证实的问题

### 1. 中：待接入名单的退场条件与现有检查、计划、设计都对不上
- 文件：`ci/operations-pending.json:4-5`、`scripts/check-operations.mjs:10,119-126,140-164`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:45-56`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:231,665`、`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:47`
- 问题：新名单写“调用方是 iOS 第 11 批原生页……第 11 批合并后移出名单”，但：
  1. 当前 Apple 设备计划只列了第 1 到第 10 批，没有第 11 批；
  2. 设计里的 iOS 代码目录是 `clients/apple/`，而 `check-operations.mjs` 只扫 `apps/control-center/src`、`scripts`、`apps/admin-cli/src`，且只认 `.ts/.tsx/.mjs`，Swift 调用方永远不算“调用方”；
  3. 设计第 231 行明确写“设备接口里没有……导出数据，这些只在嵌入的网页里做，走网页会话”，与“iOS 原生设置页的导出”这个理由不一致。
- 证据：
  - `"data.export.start": "iOS 原生设置页的导出全部数据：……调用方是 iOS 第 11 批原生页……第 11 批合并后移出名单"`
  - `const FRONTEND_ROOT = "apps/control-center/src";`
  - `...walk(root, FRONTEND_ROOT, ...)`, `...walk(root, "scripts", ...)`, `...walk(root, "apps/admin-cli/src", ...)`
  - 计划表只有 `| 1 |` 到 `| 10 |`
  - `设备能做的就是这张表，不是网页能做的全部。比如设备接口里没有“改规则”“删记忆”“导出数据”，这些只在嵌入的网页里做，走网页会话`
  - `仓库里新目录 clients/apple/（不放在 apps/ 下……）`
- 建议：三选一并同步文档：把调用方放到会被扫描的 Web/TypeScript 入口并删除名单项；或把 `check:operations` 扩展到 `clients/apple` 的操作清单（Swift 不行就由服务端清单生成一份可扫描的 TypeScript 清单）；或明确把该功能改成原生接口并更新设计与计划。同时把“第 11 批”改成真实存在的批次或新增该批次。注意同样的问题已存在于 `device.*` 的历史名单项，不是本轮才出现，但本轮继续复制了它。

### 2. 低：契约只校验下载地址里的 `exportId`，不校验路径和来源；`split("?")` 与真实 URL 解析不一致
- 文件：`packages/gateway-contracts/src/contracts-v2.ts:693,713-718`
- 问题：`downloadPath` 只受 `boundedString(256)` 约束，新增检查只看 `?` 后面的 `exportId`。因此 `https://evil.example/x?exportId=<正确 id>`、`//evil.example/...` 都能通过；`/api/data-export/v1/archive#?exportId=<正确 id>` 也能通过，因为 `split("?")[1]` 找到了片段，而真实 URL 解析里查询串是空的。iOS 会按这个值去取完整数据包（消费方不在仓库里，未核实），这是一个信任边界上的缺口。
- 证据：
  - `downloadPath: boundedString(256),`
  - `const query = result.downloadPath.split("?")[1] ?? "";`
  - `if (new URLSearchParams(query).getAll("exportId").join("\n") !== snapshot.payload.exportId)`
- 建议：用标准 URL 解析，并同时约束路径和主机，例如以 `new URL(downloadPath, "http://localhost")` 解析后要求 `origin === "http://localhost"`、`pathname === DATA_EXPORT_PATH`、`searchParams.getAll("exportId")` 恰好一个且等于 `payload.exportId`；或者要求它必须是 `/api/data-export/v1/archive?...` 的相对路径。当前后端生成的值是正确的，所以这是加固项，不是现在就会失败。

### 3. 低：复用旧压缩包会把“这 10 分钟内被删除/修改的旧内容”继续导出，作者说法只提了“不含新改动”
- 文件：`apps/agent-service/src/production-data-export.ts:174-183`
- 问题：保留期内网页直接下载直接返回 `held.built`，不会重新读库。若主人在网关生成之后删除了某条敏感记忆，网页导出仍会带上删除前的旧内容。“不含这段时间的新改动”同时也意味着“包含这段时间已删除的旧内容”，这对“导出后分享出去”的场景是隐私相关差异，需要产品/ADR 明确接受，而不只是写成“旧了 10 分钟”。
- 证据：
  - `if (held?.state === "ready" && held.built && held.expiresAt !== null && Date.parse(this.#options.now()) < Date.parse(held.expiresAt)) return held.built;`
- 建议：在 ADR/界面文案写明“保留期内可能包含最近 10 分钟内已删除的内容”，或提供一个明确“重新生成最新导出”的入口；若不能接受，保留期只用于 iOS 的 `exportId` 下载，网页无 `exportId` 时仍重新生成。

### 4. 低：过期后由网页触发的重新生成不会进入保留期，之后每次网页下载都整份重算
- 文件：`apps/agent-service/src/production-data-export.ts:174-190,250-268,402-405`
- 问题：过期时 `buildNow()` 会 `#discard()` 旧任务并直接构建，但成功后不设置新的 `#job`。因此这次新构建的压缩包没有 `expiresAt`，下一次网页直接下载仍会再次全量读库、解密、打包。并发仍被 `busy` 限成一份，但连续请求会反复消耗资源。
- 证据：
  - `this.#building = true; if (held && held.state !== "running") this.#discard();`
  - `view()` 只从 `this.#job` 取数据；构建成功后没有 `this.#job = ...`
  - 网页路由无 `exportId` 时 `built = await options.jobs.buildNow();`
- 建议：如果网页端可能重复下载，给网页触发的构建也建立一份带保留期的任务（可以是独立于网关 `exportId` 的缓存），或明确这是可接受的一次性行为并在测试里固定“每次都会重算”。

### 5. 低：所谓“网关忙返回冲突”的用例没有走 HTTP 网关，HTTP 409 映射没被这个操作覆盖
- 文件：`test/integration/data-export-http.test.ts:514-550`（`startWith` 在 `:84-85`）、`packages/platform-node/src/http-gateway-server.ts:883-892`
- 问题：测试里 `startWith` 直接调用 `ProductionDataExportControl.execute`，只验证抛出的 `ApplicationPortError` 和 `PORT_ERROR_CODES.CONFLICT`，没有验证 `/api/gateway/v2/commands` 真的返回 409。HTTP 映射是通用的、已有代码，但这条具体操作的正向/反向 HTTP 路径没有覆盖。作者说“补了网关忙返回冲突的用例”，严格说是“控制层冲突用例”。
- 证据：
  - `const conflict = await startWith("key-a").catch((error: unknown) => error);`
  - `const startWith = (key: string) => control.execute(message("command", "data.export.start", {}, "owner", key) as never);`
  - `error.code === PORT_ERROR_CODES.OPERATION_NOT_INSTALLED ? 501 : 409;`
- 建议：再加一条 composition/HTTP 注入用例，启动一个被阻塞的网页构建，然后 POST `data.export.start`，断言 409 和错误码；同时保留现在的控制层用例。

## 推测 / 未核实

- **未核实 iOS 消费方**：仓库里没有 `clients/apple/`。iOS 是否能拿到网页路由需要的 `himawari_session`/`cf-access-jwt-assertion`、如何解析 `downloadPath`（相对还是绝对）、是否会把网关凭据附到任意主机，都无法从当前代码判断。
- **推测的窄竞态**：`buildNow()` 在构建失败时，`finally` 先把 `#building` 置回 `false`，之后 `.then` 的失败回调才把 `job.state` 改成 `failed`。在这两者之间的微任务窗口里，`#job` 仍是 `running` 而 `#building` 为 `false`；理论上此时网页下载可能再启动一次构建、或网关开始可能把新键加进一个即将失败的任务。实际事件循环里窗口极窄，我没有构造出可复现路径，故列为推测。
- **测试稳定性**：新增冲突用例用 `setTimeout(20)` 等网页请求进入构建；机器很慢时可能等不到，导致用例误判。未运行，无法确认是否偶发。

## 侧重检查

- **错误路径**：网页路由覆盖 400（非法 `exportId`）、401、403、404、429、500；`#build` 在 `finally` 关闭数据库；失败任务有 `failureCode`，快照取不到结果。结论：主要错误路径齐全。
- **不合规范/不可信输入**：`exportId` 用共享的 `DATA_EXPORT_ID_PATTERN` 校验；`Sec-Fetch-Site` 只允许同源/无；认证后还核对 owner。`downloadPath` 是服务端输出，但契约没有校验路径/来源（见问题 2）。
- **安全**：导出只读，没有新增不可逆操作；新增的下载入口需要登录且随机 `exportId` 不可枚举。真实风险是保留期内复用旧包可能包含已删除内容（见问题 3），以及 iOS 对 `downloadPath` 的信任边界（未核实）。
- **资源耗尽**：归档上限 512 MiB、同一时间只允许一份构建、生成中确认键上限 64、任务过期后清内存；但过期后网页重建不缓存，连续下载会反复全量构建（见问题 4）。
- **规则/文档一致性**：`prompt-prefix` 规则不涉及本改动；I-73 的双端核对大体做了（`exportId`、`state`、`failureCode`、`sha256`、时间戳、计数都在集成测试里经过 `gatewayV2MessageSchema.parse`）。发现的不一致是待接入名单的调用方/批次/设计与 `check:operations` 的扫描范围对不上（见问题 1）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 `production-data-export.ts`、`production-approval-gateway.ts`、`production-http-composition.ts`、`gateway-contracts`、集成/契约测试和待接入名单；没有触碰系统提示、工具定义、历史消息或遮盖流程。发给模型的内容仍然只在末尾追加，本轮会变的值仍只在最后一条消息里。该结论是读改动文件列表和代码得到的；我没有运行 `check:prompt-prefix`，因为本改动不经过提示词组装。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求没有影响。对导出文件本身：保留期内现在反而复用了同一份 Buffer，字节完全相同；超过保留期或换确认键重新生成时，zip 的 `exportedAt` 和 DOS 时间戳会变，字节不同，但这是下载文件、不会进入模型上下文。快照里的 `generatedAt` 每次查询都变，也是网关字段，不进模型。`idempotencyKeys` 是 `Set`，但从不序列化，不构成“无序集合进入输出”。

3. **有没有自动检查，反向用例是否真的会失败？**
   有：新增 `packages/gateway-contracts/test/data-export-gateway.contract.test.ts`、`test/integration/data-export-http.test.ts` 的两条新用例、`production-http-composition.unit.test.ts` 的新网关往返用例。
   从代码路径推断，去掉对应修复后这些反向用例会失败：
   - 去掉 `buildNow` 的 ready 复用分支，网页请求会丢弃任务并重新构建；测试里此时 `failures = 1`，会返回 500，`expect(direct.statusCode).toBe(200)` 和后续 `state: "ready"` 会失败。
   - 去掉 64 键上限，`key-full` 会返回结果对象而不是 `ApplicationPortError`，`toMatchObject({ code: CONFLICT })` 会失败。
   - 去掉 `downloadPath` 的 `exportId` 校验，契约测试的“另一个 exportId/没有 exportId”两条会不再抛 `ContractValidationError`。
   缺口：HTTP 层 409 没有被新用例覆盖（见问题 5）；我没有实际运行测试，以上是读代码得出的推断。

4. **新增/修改的每个值，两端都能接受吗？**
   已核对的值：
   - `exportId`：生产端 `randomBytes(16).toString("base64url")` 固定 22 个 base64url 字符；契约和网页路由共用 `DATA_EXPORT_ID_PATTERN = /^data-export:[A-Za-z0-9_-]{22}$/u`，两端一致。
   - `state`：生产端四种字面量与 `DATA_EXPORT_STATES` 一致；集成测试覆盖 running/ready/failed/expired 且都过契约。
   - `startedAt`/`finishedAt`/`expiresAt`：生产端用 `now().toISOString()`（组合层 `const clock = () => now().toISOString()`），契约 `timestamp` 要求规范 UTC 毫秒，能接受。
   - `failureCode`：生产端限制为 `^[A-Z][A-Z0-9_]{2,63}$` 或 `DATA_EXPORT_FAILED`，是契约 `machineString` 的子集。
   - `sha256`：`createHash(...).digest("hex")` 小写 64 位，契约正则一致。
   - `sizeBytes`/`memories`/`rules`/`withheld`：整数且非负，契约 `integer(1)`/`integer(0)` 接受。
   - `downloadPath`：生产端生成的值能通过新增检查，且集成测试用真实生成值请求路由成功；但它只校验了查询参数，路径和来源没有校验（见问题 2），iOS 消费方也未核实。
   - 待接入名单键：`data.export.start`、`data.export.status.read` 都在契约的查询/命令集合里，`check:operations` 会认为它们缺“调用方”，与名单理由一致；但退场条件本身有问题（见问题 1）。
   - `PRODUCTION_DATA_EXPORT_OPERATIONS` 与 `installedGatewayV2Operations`：新增的两项都在契约里，且生产和组合测试的安装列表一致；没有发现会让现有清单检查报红的项。
   残余风险：契约允许 `state: "ready"` 且 `result: null`（测试明确接受），也允许非 ready 状态带 result；当前生产端不会产生，但消费方不能假设“ready 必有 result”。
