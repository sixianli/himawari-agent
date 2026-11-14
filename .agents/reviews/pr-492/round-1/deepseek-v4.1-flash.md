## 侧重检查

我重点看了错误路径与异常输入：

- 续期成功/失败、`start()` 失败回滚、`markLost()` 重复触发、`onLost` 同步抛错、`clock.now()` 返回非法值。
- 不可信/异常字段：`stableErrorCode` 的输入、`msSinceLastRenewal` 的取值、日志序列化。
- 安全：日志是否包含错误原文、租约/部署标识、密钥；`writeServiceDiagnostic` 是否遮盖。
- 资源与不可逆操作：`onLost` 是否可能重复写、是否有新增数据库/文件写入。
- 规则/文档一致性：`prompt-prefix.md`、运行手册中的日志说明。

结论：未发现高危问题；改动确实只增加诊断。发现 1 个错误路径风险、1 个 I-73 式的两端校验缺口、若干测试覆盖缺口。

## 问题清单（读代码证实；按严重度从高到低）

### 1. 低（错误路径，未复现）：`onLost` 内先写日志，同步抛错会阻断“授权已丢失”的传播

文件：`apps/agent-service/src/production-authority-lifecycle.ts:515-521`、`apps/agent-service/src/service-main.ts:912-928`

证据：

```ts
// lifecycle
const now = this.nowMs();
...
void Promise.resolve(this.#options.onLost?.(error, details)).catch(() => undefined);
```

```ts
// service-main
onLost: (error, details) => {
  writeServiceDiagnostic(errorOutput, { ... });
  health?.setAuthorityActive(false);
  authorityLost = true;
  authorityLossError = error;
  resolveAuthorityLoss?.();
  void stopReverseServices();
},
```

`Promise.resolve(callback(...)).catch(...)` 只捕获回调**返回 Promise 的拒绝**，不捕获回调体内的同步抛错；而新加的 `writeServiceDiagnostic` 是回调的第一条语句。若输出流/`toISOString()` 等同步抛错，后面的 `authorityLost = true`、`resolveAuthorityLoss()`、`stopReverseServices()` 都不会执行。此时 lifecycle 已经是 `lost`，服务却不会进入 draining，也不会被 supervisor 重启。生产时钟和 stderr 正常时不会发生，所以我标为“低、推测未复现”。

建议：先把状态与 promise 传播做完，再把日志写放在 `try/catch` 里；或让 `writeServiceDiagnostic` 的调用方保证不抛。

### 2. 低（I-73 式两端校验）：`msSinceLastRenewal` 可能产生 `NaN`，消费端只检查了 `null`

文件：`apps/agent-service/src/production-authority-lifecycle.ts:376`、`:458`、`:519`、`apps/agent-service/src/service-main.ts:917-919`

证据：

```ts
// 生产端：直接存 nowMs()，可能是 NaN
this.#lastRenewedAtMs = this.nowMs();
```

```ts
// markLost 只检查了“当前 now”是否为 NaN
msSinceLastRenewal:
  lastRenewedAtMs === null || Number.isNaN(now) ? null : Math.max(0, now - lastRenewedAtMs),
```

```ts
// 消费端只排除 null
...(details.msSinceLastRenewal === null ? {} : { msSinceLastRenewal: details.msSinceLastRenewal }),
```

若 `clock.now()` 在上一次 `start()`/`renew()` 时返回非法日期，`#lastRenewedAtMs` 会是 `NaN`；之后 `now` 有效时得到 `NaN`。消费端 `=== null` 判断放过它，`JSON.stringify({ msSinceLastRenewal: NaN })` 会输出 `"msSinceLastRenewal":null`，与“null 时省略字段”的意图不一致。类型上它仍算 `number`，但不是一个有意义的时长。生产 `productionClock()` 返回 `new Date().toISOString()`，正常不会触发；这是防御性校验缺口。

建议：两端都用 `Number.isFinite`，生产端检查 `lastRenewedAtMs` 和 `now`，消费端也不要只信 `null`；补一条非法时钟用例。

### 3. 低（自动检查缺口）：反向用例没有覆盖新增分支

文件：`apps/agent-service/test/production-authority-lifecycle.unit.test.ts:161-205`、`apps/agent-service/test/service-orchestration.unit.test.ts:511-527`

已证实的正向覆盖：

- `production-authority-lifecycle.unit.test.ts:161-193` 会因去掉 `start`/`renew` 中的 `#lastRenewedAtMs` 赋值而失败。
- `service-orchestration.unit.test.ts:521-524` 会因去掉 `service.draining.code` 或 `authority.lost` 而失败。

缺失的反向覆盖：

- 没有用例断言 **信号退出时不得出现 `code`**。`service-main.ts:642` 的 `termination.kind === "signal" ? {} : ...` 若被改成无条件加 `code`，现有测试仍通过。
- 没有用例断言 **`msSinceLastRenewal === null` 时应省略字段**；测试在 `:524` 只检查“包含 `msSinceLastRenewal`”，即使输出 `null` 也会通过。
- 没有用例断言 **正常 SIGINT/SIGTERM 不写 `authority.lost`**。
- 第二个新用例 `:195-205` 只断言“没有误报 onLost”，完全没有覆盖新的 `details`，同名反向意义有限。

建议补上这三条反向断言，并让第二个用例真正覆盖“成功的续期不产生 loss”。

### 4. 低（诊断语义）：非 lifecycle 的非信号退出，`code` 可能退化成 `SERVICE_STARTUP_FAILED`

文件：`apps/agent-service/src/service-main.ts:642`、`packages/platform-node/src/service-runtime.ts:55-58`

证据：

```ts
...(termination.kind === "signal" ? {} : { code: stableErrorCode(lossError) }),
```

```ts
if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)) {
  return error.message;
}
return SERVICE_RUNTIME_ERROR_CODES.STARTUP_FAILED;
```

`service.draining` 的 `code` 对**所有**非信号退出生效，不只 lifecycle 的 onLost。若 `lossError` 是不带大写 code 的普通 `Error`（运行循环、memory worker 等路径可能传入），日志会写成 `service.draining ... code: SERVICE_STARTUP_FAILED`，但这不是启动失败，容易误导事后排查。作者目标里的租约错误本身有 `PRODUCTION_AUTHORITY_LOST`，不受影响。

建议：`service.draining` 复用 `failureReasonField(lossError)`（`service-main.ts:483-486`）或使用独立的 `AUTHORITY_LOSS_REASON_UNKNOWN`，不要把“未知原因”混成“启动失败”。

### 5. 信息（文档一致性）：新增 `authority.lost` 未在运行手册的日志说明中出现

文件：`docs/runbooks/install-start-stop-runbook.md:723`

证据：运行手册只写了等待 `service.draining` 与 `service.stopped`。仓库里没有发现统一的诊断事件清单或解析器，所以这不是代码错误；但运维按手册排查时不会知道新增的 `authority.lost`。

建议：在相关运行手册/故障排查说明里补一行事件含义和字段（`code`、`msSinceLastRenewal`、`leaseDurationMs`、`renewalIntervalMs`）。

## 作者说法核对

- **“只加诊断，不改授权逻辑”**：属实。`markLost` 的 `state === "active"` 判断、置 `lost`、清 timer 均未改；改动是新增字段、日志和回调参数。
- **“lifecycle 的 markLost 只在 state==active 时触发一次”**：属实（`production-authority-lifecycle.ts:509-512`）。并发 `checkActive`/`renew` 也只有第一个能进入。
- **“onLost 多带 msSinceLastRenewal”**：属实。lifecycle 的 `onLost` 只有 `markLost` 一个调用点，所有路径都带该字段（`production-authority-lifecycle.ts:517-521`）。
- **“service-main 写 authority.lost 行”**：属实，但范围是 `ProductionAuthorityLifecycle` 的 onLost（`service-main.ts:912-928`）。`failRuntime`、memory worker、运行循环的非信号退出仍没有 `authority.lost`，只有 `service.draining.code`。如果事故实际来自这些路径，新事件不会出现。
- **“service.draining 非信号退出时带 code”**：属实（`service-main.ts:642`）。
- **“改动前的 onLost 不写日志”**：属实；改动前该回调只更新 health/标志/promise。
- **“两个测试文件 96 例通过、tsc 和 biome 通过”**：未核实。我不能运行测试和 lint。
- **敏感信息**：读代码确认不会泄露。日志只写 `code`（`stableErrorCode` 限制为 `[A-Z][A-Z0-9_]{0,127}`）和数值时长，不写错误原文；`writeServiceDiagnostic` 还会做机器密钥遮盖（`packages/platform-node/src/service-runtime.ts:81-87`）。
- **是否改变已有行为**：授权判定无变化；可观察行为有三处变化，均为本 PR 目的：新增 `authority.lost` 日志、`service.draining` 新增 `code`、lifecycle `onLost` 回调新增第二参数（仓库内唯一实现已更新，一参数实现按 TS 规则仍可赋值）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次四个被改文件都是 authority lifecycle、service 编排和对应测试；没有触碰系统提示、工具定义、历史消息、遮盖或请求组装代码。新增值只写入 stdout/stderr 诊断（`writeServiceDiagnostic`），不进入模型请求。因此仍满足“只在末尾追加、每轮变化的值在最后一条消息里”的约束，依据 `.claude/rules/prompt-prefix.md` 第 4、10 条（本次改动本身未涉及该规则，不能据此反推全系统）。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型请求。日志中确实有每次不同的 `timestamp` 和 `msSinceLastRenewal`，但日志不是模型输入；诊断对象的字段顺序是固定字面量，不含无序集合。模型侧的确定性没有变化。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有新增正向检查，且正向检查是有效的：去掉 `#lastRenewedAtMs` 的赋值、去掉 `service.draining.code`、去掉 `authority.lost` 都会让现有新用例失败。但反向覆盖不足：信号退出不带 `code`、`msSinceLastRenewal` 为 `null` 时省略、正常停止不写 `authority.lost` 都没有用例；如果实现把条件写反，现有测试不会失败。详见问题 3。

4. **每个新值的产生处和使用处都能接受吗？**
   - `msSinceLastRenewal`：生产处 `production-authority-lifecycle.ts:517-520`，使用处 `service-main.ts:917-919`；两端都按 `number | null` 设计，但生产端可能产生 `NaN`，使用端只检查 `null`，存在缺口（问题 2）。
   - `authority.lost`、`code`、`leaseDurationMs`、`renewalIntervalMs`：都由 `writeServiceDiagnostic` 消费，其类型接受 `string | number`，`code` 由 `stableErrorCode` 保证是受限字符串；仓库内没有发现对这些事件的额外 schema 校验或解析器。
   - `service.draining.code`：仅日志消费，仓库内未发现校验器；外部日志采集/告警是否接受新增字段未核实。
   - `ProductionAuthorityLossDetails` 类型：唯一生产实现已更新；测试里的旧一参数 `onLost` 实现按 TypeScript 规则仍可赋值，不会编译失败。

**更好的方案建议**：保留当前字段，同时把 `onLost` 日志改为“先传播丢失状态，再在 `try/catch` 中写日志”；`msSinceLastRenewal` 两端统一用 `Number.isFinite`；为信号退出/no-null/正常停止补反向断言；若目标是“所有非信号退出都能知道原因”，可在 `failRuntime` 和 memory worker 的 authority-loss 路径也写统一的 `authority.lost` 事件，或把 `service.draining` 的未知原因明确标成独立 code，而不是 `SERVICE_STARTUP_FAILED`。
