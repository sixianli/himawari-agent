# 复核报告

## 读代码证实的问题（按严重度）

### 1.【高】bodyPreview 可以携带网关合约禁止的控制字符，approval.detail 投影会抛错，并连锁弄坏整个待审批列表
- 文件：`packages/application/src/services/approval-display.ts:8-13`、`packages/gateway-contracts/src/contracts-v2.ts:2190-2206`、`packages/application/src/services/governance-gateway-adapter.ts:361`、`apps/control-center/src/run-approval.ts:126-129`
- 问题：这正是 I-73 的模式——生产端（producer）不执行消费端（consumer）的校验。
- 证据：
  - 生产端 `toolApprovalBodyText`（`apps/agent-service/src/production-approval-display.ts:17,24-25,30`）把工具实际参数原文取出，`approvalBodyPreview` 只做 `maskSensitiveText`（`packages/sensitive-capture/src/redaction.ts:542-544` → `redactForEgress`，纯正则替换敏感值）和截断，**不剔除任何控制字符**。
  - 消费端 `approvalDisplayText` 明确拒绝 tab/LF/CR 之外的一切 C0 控制字符和 DEL（contracts-v2.ts:2196-2201：`(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f`），且 `parseSnapshot` 对每个 approval.detail 都跑 `gatewayV2MessageSchema.parse`（governance-gateway-adapter.ts:144-145, 361）。
  - bash 命令、write 的 `content`、edit 的 old/newText 完全可能含 `\x1b`、`\x07`、`\x0c`、`\x00`。这样的审批一旦入库，`approval.detail` 永远投影失败。
  - 连锁：Control Center 的 `listPendingRunApprovals` 对**每个** pending 审批都拉 detail，任一失败整个函数抛错（run-approval.ts:126-129），主人看不到任何待审批项，直到该审批过期或经其它渠道决定。
- 建议：在 `approvalBodyPreview` 内按与合约相同的清单剔除/转义非法控制字符（合约规则抽成共享常量，两端用同一份），并在 gateway-contracts 或集成测试加反向用例：含 `\x1b` 的 bodyPreview 必须在入库前被清洗而不是在投影时被拒。

### 2.【中】缺少「非法值会失败」的自动反向用例；新配置键无解析测试
- 文件：`packages/gateway-contracts/test/gateway-v2.contract.test.ts:34-46`、`packages/platform-node/test/startup-configuration.unit.test.ts`
- 证据：合约层的 round-trip 测试只覆盖 fixture 里的 `display: null`；`test/integration/governance-control-center.test.ts:402-441` 的非空 display 用例用的是良性多行文本 `"rm -rf build\ncd .."`。没有任何测试证明「含控制字符的 bodyPreview 会被拒/被清洗」——即问题 1 没有守门。仓库全文检索 `approvalBodyPreviewCharacters` 只有 3 处 src 出现，`startup-configuration.unit.test.ts` 里其它 runPolicy 键（timeZone、automaticReview、mcpRead 等）都有 accept+拒绝两组用例，新键一组都没有。
- 建议：补两条——控制字符反向用例、`approvalBodyPreviewCharacters` 的 accept/越界用例（越界应抛 `configuration.runPolicy.approvalBodyPreviewCharacters`）。

### 3.【中低】普通流程中一段关键装配完全无测试：thread 标题读取与 file-read 工作流的 display 注入
- 文件：`apps/agent-service/src/service-main.ts:1584-1605`、`apps/agent-service/src/production-file-read-workflow.ts:263-273`
- 证据：`apps/agent-service/test` 中检索 `approvalDisplay|threadTitle` 只命中 `production-approval-display.unit.test.ts`（用假 `threadTitle` 直接喂 builder）。真实链路——`titleRepository().read` → `titleRef` → `episodePayloads.get` → `episodeProtector.unprotect` → `TextDecoder(fatal:true)`（service-main.ts:1586-1604）——没有任何测试经过；`ProductionFileReadWorkflow` 的 `authorize` 包装（tool:"read" 的 display 注入，production-file-read-workflow.ts:266-273）也没有。`episodeProtector` 不存在时静默降级为 null 标题这条分支同样未覆盖。
- 建议：加一条集成用例：真实 SQLite + 受保护标题 payload，走一次 `read` 工具审批，断言 `origin.threadTitle` 非空；标题 payload 损坏时断言展示为空且审批仍发起。

### 4.【低】thread 标题读取逻辑与 web-push 已有实现重复
- 文件：`apps/agent-service/src/service-main.ts:1586-1604` 与 `apps/agent-service/src/production-web-push.ts:542-544`、`service-main.ts:2447`
- 证据：service-main 里现在有两份独立的「threadId → 受保护标题 payload → 解码」实现（2447 行给 web push 用，1586 行给审批 display 用），仅 `approvalThreadTitle` 这份要求 `contentType === "text/plain"` 且 fatal 解码。两处将来容易漂移（例如一边加了 trim 另一边没加）。
- 建议：抽成一个共享的 threadTitle 查询函数，两处共用。

### 5.【低/备注】其它产生审批的路径不带 display（符合声明但值得知道）
- 文件：`apps/agent-service/src/owner-policy-authorization.ts:73-92`、`packages/application/src/services/permission-service.ts:204-219`
- 证据：这两处也调 `store.createApproval`，不带 display，投影为 null（合约 nullable，能通过）。`owner-policy-authorization` 是 `queued_no_ui`（无 UI，合理）；permission-service 是否在生产装配我未核实到调用点（**未核实**）。若在生产，手机端这些审批将永远没有展示字段。

## 对作者说法的逐条核对（读代码证实）

| 说法 | 结论 |
|---|---|
| 存 record_json、不改表 | ✅ `sqlite-durable-operations.ts:1908-1930` 整份 `JSON.stringify(request)` 入 `approval_requests.record_json`，diff 无迁移 |
| 老审批投影 null | ✅ governance-gateway-adapter.ts:381-395；集成测试 legacy 用例验证 |
| bodyPreview 按工具名取实际参数、只对列明工具、其余 null | ✅ production-approval-display.ts:30-67，默认 `return null`；工具名与 `production-coding-workflow.ts:41-45,159` 的真实清单一致，`edit` 两种参数形（flat/`edits[]`）都覆盖 |
| 先遮盖后截断，默认 300 上限 2000 | ✅ approval-display.ts:3-13（mask 全段→trim 判空→按码点截断加 `…`）；截断后 2001、标题 121 与合约 `APPROVAL_DISPLAY_BODY_MAX_CHARACTERS`/121 精确对齐 |
| askedBecause 统一 `no_rule_allows`；审批只在无授权无允许规则时发起 | ✅ action-policy-service.ts:549-556；evaluateCurrent 中 ASK 只在 grants 循环耗尽且无 safeReadRule 后创建（331-421） |
| displayTitle 固定 null，不用机器码拼标题 | ✅ production-approval-display.ts:78 |
| 不改发给模型的请求 | ✅（见必答 1） |
| 只有 ActionPolicyService.evaluate 调 display 构造；抛错→空展示、不影响授权 | ✅ action-policy-service.ts:497-501、538-548（try/catch 吞掉，包括 `approvalBodyPreview` 的 RangeError）；display 不参与任何 DENY/ALLOW 分支 |
| 49152 参数上限 | ✅ production-coding-workflow.ts:184,192 |
| 无新增 ADR | ✅ diff 无 docs 文件 |

## 侧重检查

**走过的流程**：模型发起 bash/write/edit 工具调用 → `executeProductionCodingRequest`（production-coding-workflow.ts:408-415）→ `approvalDisplay` builder（production-approval-display.ts，此刻不执行）→ `authorize`（production-file-read-services.ts:311-320）→ `ActionPolicyService.evaluate` → ASK 时一次性构建 display 并冻结（action-policy-service.ts:497-518）→ `createApproval` 存 record_json（sqlite-durable-operations.ts:1929）→ 主人端 `approval.list` → `listPendingRunApprovals` 逐个拉 `approval.detail` → `parseSnapshot` 过合约 schema → Control Center 渲染。

**结论**：
- 有测试覆盖：builder 纯函数（4 个用例，含遮盖、截断、列明工具清单、标题失败）、policy 冻结语义（2 个集成用例，含构造抛错→空展示）、gateway 投影（良性值 + legacy null）、合约 fixture round-trip。
- 无测试覆盖的路径（上面问题 2/3）：service-main 的标题读取装配、file-read 工作流的 display 注入、`approvalBodyPreviewCharacters` 配置解析、以及任何「非法 bodyPreview」反向用例。流程末端（合约拒绝控制字符）恰好是没有测试守着的一段，而它正是会把主人审批页整体打断的地方。

## 必答问题

1. **不会改变。** diff 未触及任何发给模型的组装（系统提示、工具定义、历史、遮盖均未动）；display 只进审批记录和 gateway 投影。ASK 时回给模型的 `runtimeToolAuthorizationResult` 仍只含 id/hash/expiresAt（runtime-tool-authorization.ts:8-19）。没有引入新的每轮变值，「只追加」现状不被打破；`check:prompt-prefix` 门槛无需新用例。
2. **不依赖前后文、确定性成立。** `maskSensitiveText` 无 tag/known/table 状态，遮法只取决于输入文本本身（redaction.ts:317：`tag === undefined` 时不记值）；无时间字段；截断按码点固定。display 在发起时冻结，之后改名不改字节。模型请求侧不涉及。
3. **部分有，关键反向用例缺失。** 新增的 3 组测试 + fixture round-trip 会验证良性值的全链路；但「非法 bodyPreview 会被拒/清洗」没有任何测试——问题 1 的故障今天就能发生而不被 `npm run check` 拦住。配置键解析也无测试。
4. **逐值核对结果**：`display`（产：ActionPolicyService；用：record_json、approval.detail 投影、合约 schema）——**两端校验不对称，即问题 1**；`runPolicy.approvalBodyPreviewCharacters`（产：strict-configuration 1..2000；用：builder maximumCharacters）一致，RangeError 兜底存在但不可达；`askedBecause.kind:"rule"` 生产不产生、消费端和合约都接受（死代码，与声明一致）；2001/121/300 边界两端一致；`origin.threadId` 用 machineString，与既有 `intent.threadId` 同值同规，无新风险。**未核实**：data-export/restore 对 record_json 里 display 的处理、permission-service 的生产装配范围、Control Center 客户端是否二次校验该 schema。
