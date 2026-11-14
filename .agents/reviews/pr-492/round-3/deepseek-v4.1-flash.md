## 结论

未发现高严重度问题。改动主要是诊断日志，模型的请求前缀没有受影响。但新增的时间戳赋值让诊断代码进入了授权状态机的错误路径，严格说不满足“只加诊断、不改授权逻辑”。

## 问题（按严重度）

### 【中】新增的时钟调用会在时钟抛错时改变启动/续期的结果

- 位置：`apps/agent-service/src/production-authority-lifecycle.ts:376`、`:458`、`:460-466`、`:534-536`
- 问题：`start()` 和 `renew()` 在原有授权流程中新增了 `this.nowMs()`。`nowMs()` 直接调用外部 `ClockPort`，一旦抛错：
  - `start()` 在 `#state = "active"` 之前抛错，进入 catch，释放刚领取的租约并把状态改回 `stopped`，启动失败。
  - `renew()` 在 `this.#record = renewed; this.#authority = authority;` 之后抛错。此时 catch 里 `this.#record !== record` 为真，代码直接 rethrow，**不会调用 `markLost`**，于是租约实际上续期成功、状态仍是 `active`，但 `renew()` 返回 rejected，`#lastRenewedAtMs` 也没有更新。
- 证据：

```ts
374:      this.#record = record;
375:      this.#authority = authority;
376:      this.#lastRenewedAtMs = this.nowMs();
377:      this.#state = "active";
...
379:    } catch (error) {
380:      if (claimedRecord) {
381:        try {
382:          await this.#options.leases.release(claimedRecord.lease.id);
...
385:      if (generation === this.#generation) {
386:        this.#state = "stopped";
```

```ts
456:      this.#record = renewed;
457:      this.#authority = authority;
458:      this.#lastRenewedAtMs = this.nowMs();
...
460:    } catch (error) {
461:      if (generation !== this.#generation || this.#state !== "active" || this.#record !== record) {
462:        throw error;
463:      }
464:      this.markLost(error);
```

```ts
534:  private nowMs(): number {
535:    return new Date(this.#options.clock.now()).valueOf();
536:  }
```

- 说明：生产路径的 `productionClock()` 是 `new Date().toISOString()`（`apps/agent-service/src/service-main.ts:252-253`），正常系统时钟下不会抛错，所以实际生产触发概率低；但这确实改变了 `ClockPort` 契约下的启动/续期语义，与作者“只加诊断”的说法不一致。原实现只在 `lossDetails()` 里做了时钟异常隔离，而这里没有。
- 建议：增加一个同样吞掉异常的安全时间函数（失败返回 `null`），用于 `start`/`renew` 记录时间；或把记录时间放到不会影响授权结果的位置。补一条“成功续期时时钟抛错，`renew()` 仍应成功”的测试。

### 【低】`service.draining.code` 不保证来自授权租约丢失

- 位置：`apps/agent-service/src/service-main.ts:641-648`、`:712-723`、`:1433-1443`
- 问题：`authorityLoss` 不只在 `authorityLifecycle.onLost` 时 resolve，`failRuntime` 和 Memory consumer 的 `onFailure` 也会 resolve。现在所有非信号退出都会用 `lossCode(lossError)` 写 `code`，因此 Memory consumer 失败时也会出现 `signal:"AUTHORITY_LOST"` + `code:<memory error>`，但不会写 `authority.lost` 事件。日志字段的语义不完全对应。
- 证据：

```ts
641:    const termination = await waitForTerminationOrAuthorityLoss(authorityLoss);
642:    const signal = termination.kind === "signal" ? termination.signal : "AUTHORITY_LOST";
...
647:      ...(termination.kind === "signal" ? {} : { code: lossCode(lossError) }),
```

```ts
1433:        onFailure: (error) => {
...
1440:          authorityLost = true;
1441:          authorityLossError = error;
1442:          resolveAuthorityLoss?.();
1443:        },
```

- 建议：明确 `service.draining.code` 表示“导致退出的稳定错误码”，或在这些非生命周期路径也写一条对应原因事件；至少不要让它看起来只表示租约丢失。

### 【低】反向用例覆盖不足

- 位置：`apps/agent-service/test/production-authority-lifecycle.unit.test.ts:223-255`、`:257-267`，`apps/agent-service/test/service-orchestration.unit.test.ts:530-554`
- 问题：新增的“时钟抛错”用例只覆盖了 `lossDetails()` 里的时钟异常（先让租约丢失，再让时钟抛错）。没有覆盖“续期成功之后记录时间时时钟抛错”或“启动成功之后记录时间时时钟抛错”，而这两条路径正是上面【中】问题的来源。另外，“续期持续成功不报告丢失”和“信号退出不带 code”在旧代码上也会通过，属于回归保护，不是能证明新增逻辑的反向用例。
- 建议：补充上述时钟异常用例；在未运行测试的情况下，作者所说“96 例通过、tsc、biome 通过”未核实。

## 侧重检查

- **错误路径**：检查了 `start`/`renew` 的 catch、`markLost` 的 `state === "active"` 守卫、`lossDetails` 的兜底、`onLost` 的异步调用和 service-main 的退出路径。`markLost` 确实只会通知一次；`lossDetails` 抛错不会阻断通知。发现并报告了成功续期/启动时的新时钟依赖。
- **不可信/不合规范输入**：`stableErrorCode` 用正则限制 `code`/`message` 为机器码格式（`packages/platform-node/src/service-runtime.ts:45-59`），不会把任意错误正文写进日志。推测：如果错误对象是带抛异常 `code` getter 的 Proxy，`stableErrorCode` 仍可能抛错；`runAgentService` 主路径会落到外层 catch 写成 `service.failed`，`onLost` 内层 try 会吞掉，属于低风险内部错误对象，不是本次的主要问题。
- **安全/敏感信息**：`authority.lost` 只写 `code`、`msSinceLastRenewal`、`leaseDurationMs`、`renewalIntervalMs`，不写错误 message/stack；`writeServiceDiagnostic` 还会调用 `redactMachineSecrets`（`packages/platform-node/src/service-runtime.ts:81-87`）。未发现新增泄露面。
- **资源耗尽**：每次丢失只额外生成一个小的 frozen 对象并写一行日志，没有循环或大对象；`msSinceLastRenewal` 经过有限性检查。
- **不可撤销操作**：本改动不涉及删除、迁移、写授权状态等不可逆操作。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 约束的是模型请求内容，本改动不涉及；`docs/runbooks/install-start-stop-runbook.md:723` 只提到等待 `service.draining`/`service.stopped`，没有约定字段集合，因此新增 `code` 不构成文档冲突。未发现需要同步修改的日志字段说明。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。当前 diff 只改了 `production-authority-lifecycle.ts`、`service-main.ts`、测试和 `.agents/reviews` 记录，没有触碰系统提示、工具定义、历史消息或遮盖逻辑；新增的值只进入诊断日志，不进入模型请求。按 `prompt-prefix.md` 的要求，“发给模型的内容”仍然只应追加，本改动没有新增模型可见内容。未核实：未运行 `check:prompt-prefix`，但改动文件不在该请求组装路径上。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响模型请求字节。新日志每次会带 `timestamp`、`msSinceLastRenewal` 等变化值，但日志不是模型输入；`stableErrorCode` 的取值规则是确定的，写日志也没有无序集合。未发现本改动涉及模型请求序列化。

3. **有没有对应自动检查，反向用例是否真的会失败？**
   有新增单元测试：生命周期侧覆盖 `msSinceLastRenewal`、无效时钟、时钟抛错、续期成功不误报；服务侧覆盖 `service.draining` 带 code、信号退出不带 code、未知原因码。未知原因码和 `msSinceLastRenewal` 用例在旧代码上应当失败，因此能守住新行为。但缺少“成功启动/续期时时钟抛错”的用例；且“续期成功不误报”“信号退出不带 code”在旧代码上也会通过，不能单独证明新逻辑。未运行测试，“96 例通过、tsc、biome 通过”未核实。

4. **每个新值的使用端都能接受吗？**
   - `ProductionAuthorityLossDetails.msSinceLastRenewal`：只在 `production-authority-lifecycle.ts:519-531` 产生，经 `onLost` 传给 `service-main.ts:917-935`；使用端只在 `:928-930` 判断是否非空并写入 `writeServiceDiagnostic`（接受 number）。仓库内没有其它 `onLost` 实现者，两端类型一致。
   - `service.draining.code`：在 `service-main.ts:483-486` 由 `lossCode` 产生，只在 `:647` 写入日志；仓库内没有解析/校验该字段的代码，新增字段对 JSON 消费方是向后兼容的。注意它也可能来自 Memory consumer 等非租约丢失路径（见上面【低】）。
   - `authority.lost` 事件：只在 `service-main.ts:924-933` 产生，仓库内只有测试断言和文档提及，没有格式校验。
   - `AUTHORITY_LOSS_CODE_UNKNOWN`：只在 `lossCode` 和测试中使用，值完全一致；它不是集中定义的错误码常量，属于可维护性小问题，不是功能错误。
   - `leaseDurationMs`/`renewalIntervalMs`：值与 `service-main.ts:209-210` 的实际配置一致，使用端是日志序列化，能接受。

**未核实项**：作者声称的两个测试文件 96 例通过、`tsc`、`biome` 未实际运行；本轮只做了静态代码核对。
