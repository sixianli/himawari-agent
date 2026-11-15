## 复核结论（PR 437 capability.reactivate，0051b2dc vs 6a0d786）

### 侧重检查

我走的普通流程：主人在控制中心打开已停用能力详情 → `detailActions` 给出 reactivate 动作（governance-control-center.tsx:244-245）→ 按 `installedGatewayV2Operations` 过滤按钮（governance-control-center.tsx:841-849）→ 组装 `capability.reactivate` 命令，带 `expectedRevision`、固定 `reasonCode`、`recentAuthenticationRef`（governance-control-center.tsx:783-795）→ 网关 schema 校验（contracts-v2.ts:1928-1935）→ `execute` 建收据 → `#reactivateCapability`（governance-gateway-adapter.ts:1030-1049）→ `require` 期望版本号 + `lifecycle !== "disabled"` 检查（capability-lifecycle-service.ts:628-631）→ 三项核对（production-capability-reactivation.ts:27-52）→ `save` 只改状态、修订号+1、保留 `lastInvalidation`（capability-lifecycle-service.ts:739-749）→ 审计（governance-gateway-adapter.ts:1089-1099，动作名=命令类型）。

**无测试覆盖的路径（读代码证实）：**
1. `production-http-composition.ts` 的装配条件（routeOptions 的 `capabilityReactivationAvailable` 参数、第 1147-1150 行把 verifier 传进 lifecycle、第 1205-1208 行公布到已安装清单）——新集成测试直接构造 `createProductionApprovalGateway`，没有走 HTTP 组合层，公布条件无任何测试。
2. 浏览器 e2e 只改了夹具（control-center-browser-server.mjs:1725、1742、1846、2231），仓库里没有任何 e2e 场景驱动 reactivate 按钮；且夹具把该操作**无条件**放进已安装清单（2231 行），所以「真实后端条件公布」这一层连间接覆盖都没有。
3. 执行进程完整启动成功后写出记录（service-main.ts:175-180）——作者已声明，与 ADR 0254 已知问题一致，属实。

### 按严重度排列的问题

**中｜test/e2e/fixtures/control-center-browser-server.mjs:2231 — 夹具无条件公布 reactivate，掩盖了真实装配逻辑的缺口**
证据：夹具 2228-2231 行把 `"capability.reactivate"` 直接加进已安装操作清单；真实条件在 apps/agent-service/src/production-http-composition.ts:1205-1208（`options.capabilityReactivation !== undefined`）和 production-approval-gateway.ts:286-288（`capabilityLifecycle && capabilityReactivationAvailable`）。没有任何测试让真实条件为 false 时浏览器看不到按钮（读代码证实；「因此上线回归会漏」是推测）。
建议：给 e2e 夹具加一个不公布该操作的部署档位，或给 production-http-composition 加一条断言「无 verifier 时 installedGatewayV2Operations 不含 reactivate」。

**低｜packages/application/src/services/governance-gateway-adapter.ts:622-634 — `#authenticateBeforeFirstReceipt` 没纳入 capability.reactivate，行为与 disable/rollback 不一致**
证据：626 行 `if (command.type !== "capability.disable" && command.type !== "capability.rollback") return;`——这两类在建收据**前**先验最近认证；reactivate 不在列，最近认证失败（1043 行）发生在收据已建之后，收据停在 executing 相（读代码证实）。安全影响有限（推测但依据充分）：复用同一 key 重试时 replay 条件（1038-1039 行：active 且 revision=expected+1）不满足，仍会重新验认证；而满足 replay 条件的状态只能由已授权的转变产生，replay 只返回结果引用、不改状态。差异只是：认证失败也会占掉一个 idempotency key、留下一条永久 executing 收据。
建议：把 `capability.reactivate` 加进 626 行的条件，对齐 disable/rollback。

**低｜packages/platform-node/src/state-root-layout.ts:414-421 等共用错误码 — qualified 记录复用 `BOOT_BINDING_INVALID`**
证据：`readWorkerRuntimeRecord` 对两种文件抛同一个 `STATE_ROOT_BOOT_BINDING_INVALID`；integration 测试第 436-437、461-462 行也按这个码断言 qualified 记录缺失（读代码证实）。运维排查日志时区分不了是 `execution-worker.boot.json` 还是 `execution-worker.qualified.json` 出问题（推测）。
建议：给 qualified 记录单独的错误码，或在错误 details 里带文件路径。

**低｜test/e2e/fixtures/control-center-browser-server.mjs:1846-1852 — 夹具把 healthStatus 置为 "healthy"，与真实实现不一致**
证据：真实 `reactivate` 经 `save` 只改 `lifecycle/revision/updatedAt`（capability-lifecycle-service.ts:739-749），不动 health；夹具却设 `target.healthStatus = "healthy"`（读代码证实）。浏览器测试渲染的健康状态可能与生产不同（推测）。
建议：夹具保持 healthStatus 不变，与真实行为一致。

### 作者说法逐条核对

- 「新文件读写和启动绑定共用同一对函数，启动绑定行为不变」——**属实**。重构后 `writeWorkerServiceBootBinding`/`readWorkerServiceBootBinding` 调用 `commitWorkerRuntimeRecord`/`readWorkerRuntimeRecord`（state-root-layout.ts:391-487）；逐项校验（lstat、符号链接、0o077、属主、JSON、schemaVersion、字段白名单）和错误文案（label=原文案）与旧代码相同，临时文件名模式相同。
- 「执行进程只在 bindingThenQualification 成功后才写记录，启动时先删旧记录」——**属实**（execution-worker/src/service-main.ts:163 清除；165-180 等两路都 resolve 后才写；`bindingThenQualification` 用 Promise.allSettled 且任一 reject 即抛，127-135 行）。
- 「capability.reactivate 只在核验入口装配后才进已安装清单」——**基本属实，有一处例外**：生产网关两处都是条件装配（production-approval-gateway.ts:286-288、production-http-composition.ts routeOptions）；但 `apps/control-center/src/app/control-center-inventory.ts:227` 是**无条件**加入静态清单的——按 architecture-v0.1.md:554 该清单仅表示协议已定义、不是授权来源，且 UI 按真实公布清单过滤按钮，所以最终行为符合说法，但「无条件进静态清单」这点作者没提。
- 「已知没有自动测试的一条：完整启动成功后写出记录」——**属实但少算了一条**：除这条外，HTTP 组合层的装配/公布条件（见侧重检查第 1 条）同样没有自动测试，e2e 也只有夹具没有场景。
- 其余目标性说法（三项核对、失败不动记录、不恢复句柄/定时任务、写审计、已停用直接激活仍被拒、不走 5 分钟新鲜度和 qualify）——**全部与代码一致**：`activate` 仍只接受 `installation_approved`（capability-lifecycle-service.ts:411-429，集成测试 388-394 行反向验证）；reactivate 不调 `qualify`、不调快照加载器的新鲜度规则；句柄/任务测试（integration 396-429 行）验证 revokedAt 和两个 job 仍 revoked、审计恰好 1 条。

### 必答问题逐条回答

1. **不会改变模型已见过的请求开头。**改动文件全部在治理网关、控制中心 UI、执行进程侧；没有任何会组装系统提示、工具定义、历史或遮盖的代码被触碰（据 diff 文件清单逐个核对）。发给模型的内容既没有追加也没有修改，不存在「每轮变化的值」被引入。（推测部分：未实际运行 `check:prompt-prefix`，但依据代码路径该改动不可能影响它。）
2. **不会产生前后文相关的字节。**新值逐一核对：命令 payload 字段顺序由 schema 固定；`execution-worker.qualified.json` 用固定字面量键序 `JSON.stringify`、无时间戳（state-root-layout.ts:509-531）；`installedGatewayV2Operations` 由冻结常量按固定顺序拼接；`checkSealedCapabilityMembership` 的结果是布尔值，与快照条目顺序无关（capability-deployment.ts:1516-1527）；审计 id 由 idempotencyKey 决定。
3. **有自动检查，反向用例会真失败。**test/integration/production-capability-reactivation.test.ts 共 13 个用例：认证缺失、版本号过期、摘要不符、快照读不出、不在快照、未公布记录、记录不安全、旧启动编号、另一份快照、未装配核验入口、直接激活仍被拒、正常路径（含幂等重放、审计、句柄/任务不恢复）、记录读写清——反向用例全部是 `rejects` 断言；另有 control-center 单测绑定 payload、execution-worker 单测验证「启动失败→无记录」。缺口：完整启动成功写记录、HTTP 组合层装配条件、e2e 场景（见侧重检查）。
4. **两端校验核对过，均能接受。**`capability.reactivate` 类型：contracts schema ↔ adapter ↔ 两个 operations 清单 ↔ UI inventory/e2e 夹具/fixture 测试全链一致；qualified 记录文件：写端（execution-worker.ts:175-180）与读端（production-capability-reactivation.ts:40-51）共享同一对函数和同一字段白名单、digest 正则、0600/属主/符号链接校验；读失败一律 fail-closed（WORKER_NOT_QUALIFIED）；原因码的产生与消费（测试）一致。未核实：`configuration.capabilityDeployment.sha256` 在配置解析层是否有格式校验（读到的只是 `string`，configuration.ts:166-169），但即使格式不符也是摘要比较失败、拒绝重新启用，不会放行。
