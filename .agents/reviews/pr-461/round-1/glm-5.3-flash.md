# PR 461 复核报告

## 侧重检查

我走的流程：iOS 原生页「导出全部数据」→ `POST /api/gateway/v2/commands`（`packages/platform-node/src/http-gateway-server.ts:1084`，CSRF + idempotency 头核对 + `parseV2BusinessMessage` 合约校验，354-356 行）→ `AgentGatewayV2Service` → 网关 controlPlane 委派（`apps/agent-service/src/production-approval-gateway.ts:214-244`）→ `ProductionDataExportControl.execute`（`production-data-export.ts:318-338`，核对 actor/scope）→ `DataExportJobs.start`（182-216 行）→ `#build`（237-264 行，与网页同一条 `buildPortableExport` + `createStoredZip`）→ `data.export.status.read` 查询（`production-approval-gateway.ts:133-134` 委派，`production-data-export.ts:285-316` 出快照）→ `GET /api/data-export/v1/archive?exportId=…`（352-385 行）。

结论：主流程每一跳都有测试（composition 单测走真实 HTTP 端点 + 合约解析；integration 4 条含正反向）。**没被测试覆盖的路径**：
- 网页正在现场生成（`#building=true`）时经网关 `start()` → 409 `DATA_EXPORT_BUSY`（`production-data-export.ts:184、334-335`）——锁的反方向无用例（integration 第 4 条只测了反方向：网关生成中网页 GET 得 429）。
- 任务 `ready` 后再 `start()` 替换旧任务（194 行清掉旧 release 定时器）无用例；只有 failed→重试→旧编号变 expired 被测到。
- 合约层的反向：`gateway-v2.contract.test.ts` 的 fail-closed 列表（58-228 行）没有任何 `data.export.*` 反例（如 exportId 不合格、state 非法、sha256 非 64 位十六进制）。

文档一致性：读代码证实——新增两个网关操作在 `docs/` 里没有任何记录；ADR 0200（数据导出的接口行为文档，62 行只写了网页 GET 行为）没有更新提到 `exportId` 参数、网关消息和 10 分钟保留期。推测：本仓库惯例是功能 PR 配 ADR（0233、0246 均为数据导出后续功能的先例），建议补一条或至少更新 ADR 0200。

## 发现的问题（按严重度从高到低）

**低｜`ci/operations-pending.json:3-4`** 台账写「第 11 批合并后移出名单」，但 `scripts/check-operations.mjs:140-148` 的调用方扫描只查 `apps/control-center/src`、`scripts`、`apps/admin-cli/src`——iOS 原生页不在本仓库（`apps/` 下只有 agent-service、control-center、execution-worker、admin-cli）。证据：`FRONTEND_ROOT = "apps/control-center/src"`。第 11 批合并后若调用方落在 iOS 仓库，「移出名单」会让 `OPERATION_INCOMPLETE` 报红，不移出则台账承诺落空（`device.list.read` 是同一先例，属既有模式）。建议：移出时同步放宽或说明 iOS 调用方在哪条路径里能被查到。

**低｜`packages/gateway-contracts/test/gateway-v2.contract.test.ts:58-228`** 三条新消息类型只有正向夹具（`gateway-v2.fixture.ts:439-460` 经 `compatibilityMessages:1269` 参与 round-trip），没有反向用例进 fail-closed 列表。其他类型（GitHub、checkup、external proposal）都有。建议：补 2-3 条反例（exportId 不合格、state 非法、snapshot 带多余字段），确认去掉校验后会失败。

**低｜`apps/agent-service/src/production-data-export.ts:172-180`** `buildNow()` 没有超时。推测：如果 `buildPortableExport` 或 `protector.unprotect` 永久挂起（数据库损坏、加密负载异常），`#building` 永远为 true，网页 429、网关 `start()` CONFLICT，只能重启进程。改前网页通道行为相同（局部 `running` 标志同样无超时），但现在这把锁同时挡住两条通道，爆炸半径变大。建议：至少在文档写明，或给任务加最长运行时间。

**信息｜`production-data-export.ts:198-207`** ready 任务被下一次 `start()` 替换时（194 行 clearTimeout），旧压缩包从内存丢弃，正拿着旧 `exportId` 下载的人会得 404；任务被替换本身没有测试。512 MB 压缩包驻留内存最长 10 分钟，brief 已声明，行为可接受。

**信息｜`production-data-export.ts:303`** `downloadPath` 内嵌的 exportId 与 `payload.exportId` 无交叉校验（合约对 `downloadPath` 只查 `boundedString(256)`，contracts-v2.ts:688 附近），夹具也因此测不出不一致；生产代码两端同源构造，无实际问题。

## 作者说法逐条核对

- 「一次一份任务、压缩包放内存、保留 10 分钟」：证实（`DATA_EXPORT_RETENTION_MS = 10*60*1000`，`#job` 单个，`built` 是 Buffer）。
- 「start 返回导出编号、status.read 返回状态和下载信息」：证实（`execute` 返回 `resultRef = jobs.start()`；`query` 出 snapshot 含 `downloadPath`）。
- 「取结果沿用 GET，加可选 exportId，不带时和以前一样现场生成」：证实（`production-data-export.ts:360-376`）；响应头、文件名格式、403/401/429/500 语义均与改前一致；差别只有共享锁（brief 已声明）。
- 「共用同一把锁」：证实（`#building`，`buildNow:173-174`）。
- 「不改表、不改发给模型的内容」：证实（diff 只触及导出、网关注册、合约、台账）。
- 「新增 4 条导出网关用例（含正反向）」：证实（`test/integration/data-export-http.test.ts` 4 条 `[iOS]` 用例，含 unknown id/401/404/400/failed/429/过期反向）。
- 「真实服务里的开始、查进度、下载用例」：证实（`production-http-composition.unit.test.ts:1155-1206`，经真实 HTTP 端点并 `parseJson` 过合约）。
- 「9 个 Layer-0 文件 242 项通过；format、lint、tsc、check:operations 通过」：**未核实**（我不能运行命令）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。证实：diff 全部落在网关消息（客户端↔服务端治理消息）、合约包、导出路由和组装，没有触及 `packages/prompt-catalog`、`packages/runtime-pi`、遮盖、历史存储或任何模型请求组装代码；`installedOperations`/健康清单是网关元数据，不进模型请求。发给模型的内容既没有追加也没有修改，规则 [prompt-prefix.md](../../.claude/rules/prompt-prefix.md) 的「只追加」约束没有被触碰。
2. **同一段文字会不会在不同请求里变成不同字节？** 不违反。新增的会变值（随机 `exportId`、`startedAt`/`finishedAt`/`expiresAt`/`generatedAt`）只出现在发给客户端的网关快照里，不进模型请求；无遮盖逻辑改动；没有引入无序集合或依赖前后文的序列化进模型请求。
3. **有没有对应的自动检查，反向用例会不会真失败？** 部分有：合约夹具 round-trip（正向）、integration 4 条含反向（unknown id→expired、未登录 401、坏编号 400、未知编号 404、非 owner start 拒绝、失败码、429、过期后 404——这些断言在反转行为时会失败）、composition 真实服务用例、`check:operations` 台账带反向机制。缺口：合约 fail-closed 列表无 `data.export.*` 反例；网关 409 CONFLICT 方向无用例。
4. **每个新值的两端校验（I-73）？** 逐个核对均一致：`exportId`——产生于 `randomBytes(16).toString("base64url")`（16 字节恰为 22 个 base64url 字符、无填充），两端用同一条 `DATA_EXPORT_ID_PATTERN`（合约 `dataExportIdSchema`、路由 363 行、下载路径 `encodeURIComponent` 后 Fastify 解码还原）；`failureCode`——产生端限 `^[A-Z][A-Z0-9_]{2,63}$` 或固定值，是合约 `machineString` 的子集；`state` 四值 ⊂ 合约 `DATA_EXPORT_STATES`；时间戳来自与全部现有 control 相同的 `clock.now()` 模式，满足 `timestamp` 的 canonical 要求；`fileName`/`sha256`/`sizeBytes`/计数与 `boundedString(128)`/64 位十六进制/`integer(1)`/`integer(0)` 相符；`PRODUCTION_DATA_EXPORT_OPERATIONS` 两个名字都在 `GATEWAY_V2_MESSAGE_TYPES` 里（`check-operations.mjs:220-227` 会核对安装名单）。唯一没有交叉校验的是 `downloadPath` 内嵌编号与 `exportId` 字段的一致性（见信息条），生产代码两端同源，无实际风险。
