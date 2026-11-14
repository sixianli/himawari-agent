## 结论

未发现高或中严重度的阻断性问题。这个改动的净效果是诊断增强，我认为可以合入；下面几条低严重度问题和一处“作者说法与代码的细微差异”需要在合并前知悉。

---

## 发现（按严重度从高到低）

### 1. 低：`msSinceLastRenewal` 使用可变墙钟，回拨会被钳成 0，可能误导事后诊断

- 文件:行：`apps/agent-service/src/production-authority-lifecycle.ts:521-527`
- 问题：时间差来自 `nowMs()`（`new Date(clock.now()).valueOf()`），生产中 `clock` 是 `new Date().toISOString()` 的墙钟（`apps/agent-service/src/service-main.ts:252-254`）。如果系统时钟回拨，`now - lastRenewedAtMs` 为负，代码用 `Math.max(0, ...)` 把它变成 0，日志会显示“刚续期就丢了”，而不是暴露时钟异常。
- 证据：
  ```ts
  const now = this.nowMs();
  return Object.freeze({
    msSinceLastRenewal:
      lastRenewedAtMs === null || !Number.isFinite(lastRenewedAtMs) || !Number.isFinite(now)
        ? null
        : Math.max(0, now - lastRenewedAtMs),
  });
  ```
- 建议：诊断值可以保留负值或另加 `clockWentBackwards`/`elapsedKnown` 标记；如果租约本身依赖墙钟，也应把“时钟异常”作为独立线索写出来，而不是静默钳成 0。

### 2. 低：新字段的自动检查只覆盖了 `renew()` 丢失路径，没有覆盖 `assertActive()` 丢失路径

- 文件:行：`apps/agent-service/src/production-authority-lifecycle.ts:324`、`:464`；测试 `apps/agent-service/test/production-authority-lifecycle.unit.test.ts:161-255`
- 问题：`markLost()` 有两个调用点——`checkActive()` 和 `renewInternal()`。新增测试全部通过 `service.renew()` 触发丢失，没有一条在 `service.assertActive()` 路径上断言 `details.msSinceLastRenewal`。代码上两条路径共用同一个 `markLost()`，风险低，但“所有 onLost 路径都带字段”缺少直接的反向保护。
- 证据：`checkActive()` 的 catch 调用 `this.markLost(error)`（`:322-325`）；新增测试用例都走 `await expect(service.renew())...`（如 `:187-189`、`:219`、`:253`）。
- 建议：补一条用例：启动后让 `leases.currentRecord` 失效，再调用 `service.assertActive()`，断言 onLost 收到 `{ msSinceLastRenewal: ... }`。另外，`starts and renews even when the clock throws...` 使用的 `LeaseFixture` 不经过真实 `clock`；生产中的 `authorityLeasePort(clock)` 在 `claim/current/renew` 里就调用 `clock.now()`（`packages/persistence-sqlite/src/product-state-repository.ts:379-400`），所以该用例只能证明“新增的诊断读取不会额外失败”，不能证明“时钟坏了生产仍能启动/续期”。建议在测试名或注释里写清这个边界。

### 3. 低：`msSinceLastRenewal` 为 `null` 时直接从日志里省略，无法区分“时钟失败/未知”和“尚未取到时间”

- 文件:行：`apps/agent-service/src/service-main.ts:928-930`
- 问题：`authority.lost` 日志在 `details?.msSinceLastRenewal == null` 时连字段都不写。事后看日志，无法判断是“没有可用的续期时间戳”（时钟异常、启动后尚未续期），还是根本没有采集该字段。
- 证据：
  ```ts
  ...(details?.msSinceLastRenewal == null
    ? {}
    : { msSinceLastRenewal: details.msSinceLastRenewal }),
  ```
- 建议：显式写一个可区分状态的字段，例如 `msSinceLastRenewalKnown: false`，或让日志写 `"msSinceLastRenewal":null`（需要放宽 `writeServiceDiagnostic` 的字段类型，`packages/platform-node/src/service-runtime.ts:81-84` 目前只接受 string/number/boolean/string[]）。

---

## 读代码证实的

- `onLost` 只有一个生产调用点：`production-authority-lifecycle.ts:516`，传入 `details`；`markLost()` 只在 `state === "active"` 时执行一次（`:509-517`）。
- `start()` 和 `renewInternal()` 成功后分别写入 `#lastRenewedAtMs`（`:376`、`:458`）；`safeNowMs()` 捕获异常返回 `null`（`:534-540`）；`lossDetails()` 捕获异常并处理非有限值（`:519-532`）。
- `stableErrorCode()` 对 `Error("AGENT_AUTHORITY_LOST")` 这类大写消息会返回消息本身；对普通小写消息返回 `SERVICE_STARTUP_FAILED`（`packages/platform-node/src/service-runtime.ts:45-59`）。`lossCode()` 因此把后者映射为 `AUTHORITY_LOSS_CODE_UNKNOWN`（`service-main.ts:483-486`）。
- `service.draining` 只在非 signal 终止时附加 `code`（`service-main.ts:643-648`）；`authority.lost` 写入 `errorOutput`（`:923-934`）。
- `writeServiceDiagnostic()` 会对整行 JSON 调用 `redactMachineSecrets()`，并自动加 `timestamp`（`packages/platform-node/src/service-runtime.ts:81-87`）。
- 生产 systemd 模板把 stdout 和 stderr 都送到 journal（`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:29-30`），所以新增在 stderr 的 `authority.lost` 理论上可被采集。
- 本次改动的源码文件只有 authority lifecycle、service-main 和测试；没有触碰 `packages/prompt-catalog`、`runtime-pi`、消息组装或遮盖逻辑。

## 推测或未核实

- 作者说“两个测试文件 96 例通过，tsc 和 biome 通过”未核实；我没有运行测试或编译。
- “外部日志/监控系统能接受新增 `code` 字段”未核实；仓库内未找到对 `service.draining` 做严格字段校验的消费者，runbook 只按事件名等待（`docs/runbooks/install-start-stop-runbook.md:723`）。
- 若生产日志采集只保留 stdout 而丢弃 stderr，则 `authority.lost` 不会出现在现有日志里；根据 systemd 模板看不应发生，但实际部署配置未现场核实。

---

## 侧重检查

**错误路径和异常输入**
- `markLost()` 有 `state !== "active"` 保护，`checkActive()`/`renewInternal()` 的 catch 都会先检查 generation/state，正常停止时不会误报 `authority.lost`。signal 测试也覆盖了“正常停止不写 authority.lost”。
- 时钟抛错、返回非法日期两种异常都在 `safeNowMs()`/`lossDetails()` 中被吸收；不会阻断 `onLost` 通知，也不会阻断退出。
- `onLost` 的回调是 fire-and-forget（`void Promise.resolve(...).catch(() => undefined)`），日志异常被 `try/catch` 吞掉，不会改变退出码或授权结果。

**不合规范或不可信输入**
- `details` 完全由生命周期内部构造，没有外部输入。
- 新增的 `code` 来自 `stableErrorCode()`；该函数只接受匹配 `/^[A-Z][A-Z0-9_]{0,127}$/` 的 `error.code` 或 `error.message`，不会把自由文本、堆栈或任意消息写进日志。

**安全**
- `authority.lost` 只包含事件名、受限错误码、有限数值和两个常量，没有错误消息、堆栈、请求内容或密钥。
- 整行仍经过 `redactMachineSecrets()`；未发现新增敏感字段。

**资源耗尽**
- 每次丢失只写一行诊断，没有循环、重试或额外 I/O；`markLost()` 一次丢失只触发一次。

**不可撤销操作**
- 相对基准提交，`start()/renew()` 没有新增授权失败路径；`safeNowMs()` 是对本 PR 新增的诊断时钟读取做异常隔离，避免让新增诊断反过来改变授权结果。没有修改 lease release、fence、状态迁移或退出码。

**规则、说明文档和代码一致性**
- `.claude/rules/prompt-prefix.md` 关注模型请求开头；本改动不触碰模型请求、工具定义、历史或遮盖，因此不违反该规则。
- `docs/runbooks/install-start-stop-runbook.md:723` 仍以 `service.draining`/`service.stopped` 为正常停止标志；新增字段是附加的，不改变该流程。
- 仓库内没有引用 `onLost` 签名或 `msSinceLastRenewal` 的文档需要同步；未发现文档与代码冲突。
- I-73 的教训（值的生产端和使用端都要核对）已按下面第 4 条逐项检查，未发现两端校验不一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。

本次改动只涉及 `apps/agent-service/src/production-authority-lifecycle.ts`、`apps/agent-service/src/service-main.ts` 及其测试；没有改动系统提示、工具定义、历史消息、资料块、压缩或遮盖逻辑。新增的 `authority.lost`、`service.draining.code`、`msSinceLastRenewal` 都只写入服务诊断流，不进入模型请求。

发给模型的内容仍然只在末尾追加；每轮会变的值仍然只应放在最后一条用户消息里。依据 `.claude/rules/prompt-prefix.md:6`、`:28`、`:84`。本次没有任何代码路径把新增诊断值放进请求头或消息体。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

对模型请求不会。

模型请求的字节没有变化，新增字段不参与请求序列化。诊断日志本身确实每次不同：`writeServiceDiagnostic()` 自动写当前 `timestamp`（`packages/platform-node/src/service-runtime.ts:85`），`msSinceLastRenewal` 也会随续期时间变化；但这些变化只发生在日志流里，不进入模型请求，也不改变出口遮盖结果。

新增对象的键顺序在代码字面量里固定（`service-main.ts:924-933`），没有无序集合或依赖遍历顺序的列表。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且从测试意图看反向用例是有效的：

- 删除 `details` 或算错时间：`production-authority-lifecycle.unit.test.ts:190-192` 会失败。
- 去掉非有限值检查：`:220` 会从 `null` 变成 `NaN`，失败。
- 去掉 `lossDetails()` 的异常捕获：`:254` 拿不到 `{ msSinceLastRenewal: null }`，失败。
- 去掉 `safeNowMs()`：`:257-297` 的 start/renew 会因时钟抛错而失败。
- 非信号退出不带 `code`：`service-orchestration.unit.test.ts:521` 会失败。
- signal 退出误带 `code`：`:538-539` 会失败。
- 未知原因不映射：`:551-552` 会失败。

覆盖缺口：没有 `assertActive()` 路径的 `details` 反向用例；`clock throws` 用例使用的 `LeaseFixture` 不经过真实 lease 端口的同一个时钟，因此不能代表生产中 lease 端口自身也调用时钟的场景。测试是否实际运行、96 例是否通过，我未核实。

### 4. 每个新值，产生处和使用处的校验是否匹配？

- `msSinceLastRenewal`：产生于 `production-authority-lifecycle.ts:519-532`，类型 `number | null`；`onLost` 接口声明接受 `ProductionAuthorityLossDetails`（`:69-77`），唯一调用点传入 `details`（`:516`）；`service-main.ts:928-930` 只把非 null 的 number 传给日志。`writeServiceDiagnostic` 接受 number，匹配。
- `authority.lost` 事件名：生产于 `service-main.ts:926`；仓库内消费方主要是测试和 journal，没有发现严格的 schema/注册表拒绝新事件名。
- `service.draining` 新增 `code`：产生于 `service-main.ts:647`，值为 `lossCode(lossError)`；`stableErrorCode()` 保证是受限字符串，`writeServiceDiagnostic` 接受 string。runbook 只匹配事件名，不要求字段集合，附加字段安全。
- `AUTHORITY_LOSS_CODE_UNKNOWN`：由 `lossCode()` 对 `SERVICE_STARTUP_FAILED` 的映射产生（`service-main.ts:483-486`），测试 `service-orchestration.unit.test.ts:546-552` 使用同一字面量，两端一致。
- `leaseDurationMs`、`renewalIntervalMs`：来源是常量 `AUTHORITY_LEASE_DURATION_MS`/`AUTHORITY_RENEWAL_INTERVAL_MS`（`service-main.ts:209-210`），使用处是 `writeServiceDiagnostic` 的 number 字段，匹配。

结论：未发现“生产端能产生、使用端不接受”的值；外部日志系统的实际校验未核实。
