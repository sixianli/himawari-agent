## 结论摘要

改动主体方向正确：新命令的契约、网关分派、生命周期、控制中心、文件读写都已接通；重新启用确实不恢复句柄和定时任务，四项要求中的 (a)(b)(c) 三项在代码中都有对应实现。但发现 1 个与同族命令不一致的认证/收据路径问题，以及若干生产装配、文档与测试覆盖问题。

## 读代码证实的问题（按严重度）

### 1. 中：`capability.reactivate` 漏掉了“认证失败不留收据”的前置检查

`packages/application/src/services/governance-gateway-adapter.ts:626`

```ts
if (command.type !== "capability.disable" && command.type !== "capability.rollback") return;
```

`execute` 的顺序是 `#assertCommand` → `#authenticateBeforeFirstReceipt` → `#begin`（建收据）→ `#mutate`：

```ts
// :600-604
await this.#authenticateBeforeFirstReceipt(input.authentication, input.command);
const attempt = await this.#begin(input.command);
...
const resultRef = await this.#mutate(input.authentication, input.command, attempt.recovering);
```

而 `reaction.reactivate` 的最近认证是在 `#begin` 之后才做的：

```ts
// :1043
await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
```

问题：`capability.disable`/`capability.rollback` 在最近认证失败时不会留下幂等收据（提交 `9ad87ea8` 的说明原话是“认证失败不留收据，补上正确的认证引用后同一个幂等键可以成功”）。`capability.reactivate` 是同样要求最近认证的“改”类命令，却没有被加进这个名单；因此一次没有面容/最近认证的调用会先写下一行 `phase: "executing"` 的治理收据并占用该幂等键，然后才被拒。能力记录确实不变（测试 `production-capability-reactivation.test.ts:304-311` 也验证了这一点），但“认证失败不留收据”这条同族不变式被破坏，且该测试没有检查收据。

建议：把 `capability.reactivate` 加进 `#authenticateBeforeFirstReceipt` 的类型判断，并补一条“失败后同一幂等键不会留下收据”的测试。

### 2. 中：生产入口无条件装配核验器，导致 `capability.reactivate` 在没有部署快照时也会进已安装清单

`apps/agent-service/src/service-main.ts:2791-2796`

```ts
http = await createProductionHttpComposition({
  capabilityReactivation: createProductionCapabilityReactivationVerifier({
    configuration,
    layout,
    trustedPeerBinding: () => peerBinding,
  }),
```

`apps/agent-service/src/production-http-composition.ts:1152` 与 `:698`、`apps/agent-service/src/production-approval-gateway.ts:286` 都以“核验器对象是否存在”作为安装条件：

```ts
capabilityReactivationAvailable: options.capabilityReactivation !== undefined,
...
...(capabilityReactivationAvailable ? PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS : []),
```

但 `configuration.capabilityDeployment` 是可选字段（`packages/application/src/ports/configuration.ts:342`），而核验器本身会处理它缺失的情况：

```ts
// production-capability-reactivation.ts:29-30
const deployment = options.configuration.capabilityDeployment;
if (!deployment) return refuse(CAPABILITY_REACTIVATION_REASONS.NO_DEPLOYMENT);
```

因此在没有配置部署快照的生产部署上，命令仍会出现在 `installedGatewayV2Operations` 里，控制中心也会给已停用能力显示“重新启用”按钮，点下去必然得到 `capability_deployment_not_configured`。这偏离了 ADR 0254 决定第 8 条和作者“只在核验入口装配后才进已安装清单”的说法。测试 `production-capability-reactivation.test.ts:381-386` 只覆盖“调用方完全没传核验器”的 `withVerifier:false`，而生产入口永远会传，所以这条测试没有覆盖真正的生产装配分支。

建议：在 `service-main.ts` 里按 `configuration.capabilityDeployment` 是否存在来决定是否传核验器（或让 `capabilityReactivationAvailable` 同时要求 `capabilityDeployment !== undefined`），并补一条对应测试。

### 3. 低：执行进程在“完整启动成功”之前就写出资格记录，ADR 的“启动失败时没有记录”表述过宽

`apps/execution-worker/src/service-main.ts:175-181`

```ts
await writeWorkerQualifiedDeployment(layout, { ... });
composition = await createProductionWorkerComposition(...);
```

随后还有 `server.start()`、`connectAgentServices()`（`:204-205`）。`catch` 分支只停 server/composition 并写诊断，不删除刚写出的记录：

```ts
// :227-235
} catch (error) {
  await server?.stop().catch(() => undefined);
  await composition?.close().catch(() => undefined);
  ...
  return 1;
}
```

作者说法“只在 bindingThenQualification 成功后才写记录，启动时先删旧记录”本身是对的。但 ADR 0254 已知问题里写“启动失败时没有记录”并不成立：在 `writeWorkerQualifiedDeployment` 之后、`server.start()/connectAgentServices()` 之前失败（例如 `createProductionWorkerComposition` 抛错），记录会留下。由于成对重启和 agent-service 连接重试，实际可被利用的窗口很小，但“记录=这次启动的现场检查已通过”在失败启动后可能与事实不符。

建议：要么把写记录移到 `connectAgentServices()` 成功之后，要么在 `catch` 中 `clearWorkerQualifiedDeployment`，并把 ADR 第 120 行的表述改准确。

### 4. 低：架构文档仍说生产网关只装 `capability.list/detail/disable`

`docs/architecture-v0.1.md:364` 原文：

> 生产网关安装 `capability.list/detail/disable`：……退回（`capability.rollback`）……生产网关没有安装它

而同一文件 `:554` 已写成“核验入口装配后另有 `capability.reactivate`”。两处自相矛盾，第 364 行没有随本 PR 更新。

建议：同步第 364 行，至少写明 `capability.reactivate` 在核验入口装配后的安装条件。

### 5. 低：新的资格记录读取沿用了启动绑定的 `lstat` + `readFile` 检查，存在 TOCTOU 且没有大小上限

`packages/platform-node/src/state-root-layout.ts:398-399, 413`

```ts
const info = await lstat(file).catch(() => undefined);
if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) { ... }
...
value = JSON.parse(await readFile(file, "utf8"));
```

检查后到 `readFile` 之间文件可被替换（符号链接/替换），且 `readFile` 没有上限。部署快照读取用的是更严格的 `open(O_NOFOLLOW)` + `fstat` + 字节上限（`capability-deployment.ts:1298-1356`）。这份新文件现在被用于授权决策（重新启用），与快照文件同级敏感。ADR 说“沿用启动绑定的安全做法”，所以这是有意复用，但启动绑定原有的弱点是既存事实，不能因为复用就视为安全。

建议：至少给 `readWorkerQualifiedDeployment` 设置大小上限；更稳妥的是复用快照读取的 `O_NOFOLLOW` + `fstat` 方式。

## 推测 / 未核实

- 生产部署是否真的会出现“有已停用能力却没有 `capabilityDeployment`”的租户，未能从配置约束完全确认；代码上该配置是可选，核验器也专门处理了缺失，因此问题 2 的新增可达路径是存在的。
- 旧资格记录在 worker 崩溃后残留、而 agent-service 仍能服务时是否可被利用：成对重启和 `connectWorkerWithRetry` 应会阻止 agent 正常启动，未能构造出可行时序，故只作为风险提示，不列为确认缺陷。
- 移动端是否需要在另一仓库登记 `capability.reactivate`：ADR 0254 第 130 行已写明由后续线程做，本仓库无对应代码，未核实。

## 侧重检查

- **错误路径**：`CapabilityLifecycleService.reactivate` 在非 `disabled`、缺少 review 信息、核验失败时都抛错且不写库；`#reactivateCapability` 在核验失败时 `#mutate` 抛错，`#appendAudit` 不会执行。已核对 `capability-lifecycle-service.ts:624-643`、`governance-gateway-adapter.ts:1030-1049`。
- **不可信输入**：新命令载荷由 `reactivateCapabilityCommandSchema` 校验（`contracts-v2.ts:1928-1936`），`capabilityRef`/`reasonCode` 为 `machineString`，`expectedRevision` 为 `integer(1)`，`recentAuthenticationRef` 可空但服务端拒绝空值。已核对。
- **安全**：重新启用要求最近认证、期望修订号、`disabled` 状态、封存快照摘要、快照成员、worker boot 绑定、worker 快照摘要全部通过；拒绝路径返回的 reason 均为固定枚举，不泄露路径。已核对。
- **资源耗尽**：快照读取有 `CAPABILITY_DEPLOYMENT_MAX_BYTES` 上限；新资格记录读取无上限（见问题 5）。未发现用户可控的无限循环。
- **不可撤销操作**：重新启用只把 `lifecycle` 改为 `active` 并递增修订号，不改 `declaration`/`runtimeQualification`/`lastInvalidation`，不恢复句柄和任务（`capability-lifecycle-service.ts:642`）。测试验证了句柄仍 `revoked`、任务仍 `revoked`。已核对。
- **规则/文档一致性**：发现 4 的架构文档矛盾；ADR 0254 的 `启动失败时没有记录` 与问题 3 不一致；其余“不改发给模型的内容”“不改表/迁移号”“不恢复句柄和任务”与代码一致。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本 PR 没有改系统提示、工具定义、历史消息或遮盖的组装代码；新增的 `capability.reactivate` 只进入控制中心的 `installedGatewayV2Operations` 和治理通道，不进入发给模型的内容。能力重新启用后虽然生命周期回到 `active`，但执行句柄在停用时已被撤销、重新启用不恢复，因此依赖执行句柄才出现的工具不会因此增减。依据 `.claude/rules/prompt-prefix.md` 第 4、6、7 条；已核对 `production-runtime-tools.ts:1413-1432` 以句柄和生命周期共同校验，且 `production-capability-lifecycle` 的重新启用不创建句柄。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会（就模型请求而言）。本 PR 新增的资格记录字段顺序固定、没有时间戳，`JSON.stringify` 输出确定；快照成员检查用 `.some`，与顺序无关。审计记录的 `occurredAt` 不属于模型请求。未发现新增依赖前后文的遮盖、带时间字段或无序集合进入提示内容。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有。`test/integration/production-capability-reactivation.test.ts` 覆盖了：无/错最近认证、陈旧修订号、快照摘要不符、快照不可读、能力不在快照、worker 未公布、文件权限不安全、worker boot 不符、worker 快照不符、未装配核验器、已停用直接激活仍被拒、重新启用不恢复句柄/任务且可重放。`apps/execution-worker/test/service-main.unit.test.ts:193-217` 覆盖启动失败时旧记录被清除。

缺口：
- 没有“对处于 `active` 的能力调用 `reactivate` 必须被拒”的反向用例；
- 没有“最近认证失败不留下治理收据”的检查（问题 1 因此未被测试捕获）；
- 没有“资格检查通过但后续 `createProductionWorkerComposition`/`server.start()` 失败时记录是否清除”的用例（问题 3）；
- “未安装”用例只覆盖调用方不传核验器，不覆盖生产入口“没有 `capabilityDeployment` 却仍装配核验器”的情况（问题 2）；
- 快照成员校验只测了 `integrity` 不一致，没有测 `version` 不一致（代码会拒，但无反向用例）。
- 作者已声明“执行进程完整启动成功后写出记录”没有自动测试；核对属实，现有测试是直接调用 `writeWorkerQualifiedDeployment`，不是进程级启动路径。

### 4. 每个新值的产生处和使用处两端是否都能接受？

逐个核对：
- `capability.reactivate`：`contracts-v2.ts:95/1928/2672` 登记类型与 schema；`governance-gateway-adapter.ts:65/86/746` 接受并分派；`production-approval-gateway.ts:74` 进入生产操作清单；控制中心 `control-center-inventory.ts:227`、`governance-control-center.tsx` 产生命令；e2e fixture 也接受。后端校验链完整。
- `PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS`：`production-approval-gateway.ts:286` 与 `production-http-composition.ts:698` 两处使用，条件一致；但条件本身在生产入口恒真（问题 2）。
- 新文件 `execution-worker.qualified.json`：写端 `state-root-layout.ts:529-551` 与读端 `:554-566` 字段/格式互相校验；唯一读端是 `production-capability-reactivation.ts:39`，比较 `workerInstanceId`、`workerBootId`、`deploymentId`、`snapshotDigest`，与写端字段一致。没有发现第二个消费方需要同步。
- 新原因码：只在 `production-capability-reactivation.ts` 产生、在错误 `details.reasons` 中消费，测试使用了相同字符串。
- 新 i18n id：`message-ids.ts` 与 en/ja/zh-CN 三份资源都补齐，类型和资源一致。

总体上，后端两侧校验是闭合的；I-73 式的“清单 id 能否通过后端校验”问题未发现，真正的问题在生产装配条件而不是值本身。
