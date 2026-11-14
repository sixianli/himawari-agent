## 读代码后确认的问题（按严重度从高到低）

没有发现高或中高严重度的问题。这个改动的主体确实只增加诊断信息。以下是值得注意的低严重度问题，以及两处需要区分“事实”与“推测”的地方。

### 1. 低：`markLost` 新增的 clock 读取可能抛错，从而改变授权丢失路径的行为
文件：`apps/agent-service/src/production-authority-lifecycle.ts:516`、`:526-528`

问题：`markLost` 先把状态设为 `lost`，再同步调用 `this.nowMs()`，然后才调用 `onLost`。`nowMs()` 会调用 `clock.now()` 并构造 `Date`。如果 clock 抛错，异常会从 `markLost` 抛出；在 `renewInternal` / `checkActive` 的 `catch` 中，结构是 `this.markLost(error); throw error;`，因此 `markLost` 抛出的异常会替换原始的授权错误，并且 `onLost` 永远不会执行，导致 `authorityLoss` 不会 resolve。这与作者“只加诊断，不改授权逻辑”的说法并不严格一致。

证据：
```ts
// production-authority-lifecycle.ts:515-528
const lastRenewedAtMs = this.#lastRenewedAtMs;
const now = this.nowMs();
const details: ProductionAuthorityLossDetails = Object.freeze({ ... });
void Promise.resolve(this.#options.onLost?.(error, details)).catch(() => undefined);
...
private nowMs(): number {
  return new Date(this.#options.clock.now()).valueOf();
}
```

建议：把 time 计算包进 `try/catch`，失败时用 `{ msSinceLastRenewal: null }`，保证 `onLost` 一定被调用；或者先安排 `onLost`，再计算诊断值。

触发前提（推测）：生产环境传入的是 `productionClock()`（`service-main.ts:252-254`，`new Date().toISOString()`），正常不会抛。因此这是防御性问题，不是当前生产的必然故障；但它是本次唯一实质改变丢失路径控制流的点。

### 2. 低：`msSinceLastRenewal` 的采样点与含义可能误导诊断
文件：`apps/agent-service/src/production-authority-lifecycle.ts:376`、`:458`、`:516`

问题：`#lastRenewedAtMs` 是在整个 `start()` / `renew()` 成功返回之后才写入的，而不是在底层 `leases.renew()` 返回或 lease 实际续期的那一刻。如果 lease 已续期成功、但后续 `deployment.read` / `assertCurrent` / `mirror.write` 失败或很慢，日志会按“上一次成功返回”计算，和实际租约生命周期不完全对应。另外 `checkActive()` 因部署或 fence 不匹配而丢失授权时，也会带上这个值，但原因并不是租约到期；单看 `msSinceLastRenewal` 容易被读成“续期超时”。

证据：
```ts
// start()
this.#record = record;
this.#authority = authority;
this.#lastRenewedAtMs = this.nowMs();
this.#state = "active";
// renewInternal()
this.#record = renewed;
this.#authority = authority;
this.#lastRenewedAtMs = this.nowMs();
```

建议：在 `leases.renew()` 成功后立即采样；或在 `authority.lost` 里增加 `phase`/`source`（renew、check-active、deployment 等），并说明该字段表示“距上次成功 start/renew 的时间”，不是“租约到期倒计时”。

### 3. 低：`authority.lost` 写失败被完全静默吞掉，诊断可能无声丢失
文件：`apps/agent-service/src/service-main.ts:923-934`

问题：整个 `writeServiceDiagnostic`（包括读取 `details.msSinceLastRenewal`）都包在空的 `catch {}` 里。类型上 `details` 是必填，但运行时没有兜底；若上游实现或未来调用方只传 `error`，`details.msSinceLastRenewal` 会抛 `TypeError`，然后被静默吞掉，既没有 `authority.lost` 也没有任何“写日志失败”的痕迹。直接拒绝服务不是问题，但诊断丢失与本次 PR 的目标相反。

证据：
```ts
try {
  writeServiceDiagnostic(errorOutput, {
    component: "agent-service",
    event: "authority.lost",
    code: lossCode(error),
    ...(details.msSinceLastRenewal === null ? {} : { msSinceLastRenewal: details.msSinceLastRenewal }),
    ...
  });
} catch {}
```

建议：用 `details?.msSinceLastRenewal ?? null` 做运行时兜底；`catch` 至少不要空着，可写一行不含 details 的最小 `authority.lost`，或在有 fallback 输出时记录写失败。

### 4. 信息/低：新事件、字段和未知 code 没有文档说明
文件：`docs/runbooks/install-start-stop-runbook.md:723`

问题：运行手册只提到等待 `service.draining` / `service.stopped`，没有事件清单解释新增的 `authority.lost`、`code`、`msSinceLastRenewal`、`AUTHORITY_LOSS_CODE_UNKNOWN`。仓库内没有发现事件清单或严格 schema 校验，所以不是代码不一致；但运维人员不会知道这些新字段的含义。

建议：在运行手册或诊断事件说明中补一行，明确 `authority.lost` 只在 lifecycle 的 `onLost` 路径发出，`msSinceLastRenewal` 为 `null` 表示时钟无效。

### 5. 信息：PR 中包含 `.agents/reviews` 复核产物
文件：`.agents/reviews/pr-492/round-1/*`、`.agents/reviews/pr-492/usage.jsonl`

问题：`git diff --stat` 显示这三个文件作为二进制新增。它们被 `biome.json` 的 `!!.agents/reviews` 排除，不影响构建；但如果不是有意保留的复核记录，建议不要混入产品改动提交。是否为有意提交：未核实。

---

## 侧重检查

- **错误路径**：检查了 `markLost`、`renewInternal`、`checkActive`、`start()` 的错误分支，以及 `service-main` 的 `failRuntime`、`startTenantRuntime` 的 `onLost`。确认 `onLost` 在生产代码里只有 `markLost` 一个调用点（`production-authority-lifecycle.ts:523`），且总会传 `details`。发现上述 clock 抛错风险与空 `catch` 静默风险。
- **不合规范/不可信输入**：`details` 来自内部 lifecycle，不是外部输入；`error` 可能任意，`stableErrorCode` 用 `/^[A-Z][A-Z0-9_]{0,127}$/` 限制后才当 `code`，不会把整个 `error.message` 原样写入。
- **安全/泄露**：新增字段只有 `code`（短字符串）、`msSinceLastRenewal`/`leaseDurationMs`/`renewalIntervalMs`（数字）。没有记录 `error` 对象或 `error.message`；`writeServiceDiagnostic` 还会对整行做 `redactMachineSecrets`（`packages/platform-node/src/service-runtime.ts:85-86`）。`stableErrorCode` 在消息本身符合大写 code 形式时会返回消息内容，这是既有行为，本次只是把它写进新的 `authority.lost` 和 `service.draining`，风险低。
- **资源耗尽**：每次丢失只同步写一行日志；`markLost` 有 `state !== "active"` 的保护，不会重复写；没有新增循环或大对象。
- **不可撤销操作**：本次改动没有新增任何写库、删文件、发送外部请求等不可撤销操作。
- **规则/文档一致性**：`prompt-prefix.md` 的规则针对模型请求组装，本次没有触碰；文档里没有新增事件与代码的矛盾，只是缺少说明。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 改动只涉及 `production-authority-lifecycle.ts` 的本地状态与 `service-main.ts` 的 stdout/stderr 诊断；没有修改系统提示、工具定义、历史消息、遮盖、压缩或任何模型请求组装代码。发给模型的内容仍然只在末尾追加，本改动没有改变追加机制。依据规则“已经发给过模型的内容不得改动、重排或删除，只能在末尾追加”。`npm run check:prompt-prefix` 未运行（本次只允许读代码），但从改动范围看它不涉及该门禁。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**不会影响发给模型的内容。** 模型请求的字节没有变化。差异只出现在日志里：`writeServiceDiagnostic` 会加当前 `timestamp`，`msSinceLastRenewal` 也因事件不同而不同，但这是 stderr/stdout 日志，不是模型输入。因此不涉及“同一段模型文字在不同请求里变成不同字节”。

### 3. 有没有对应的自动检查，反向用例是否真会失败？
有新增单测：
- `production-authority-lifecycle.unit.test.ts:161-193` 检查损失时带 `error` 和 `msSinceLastRenewal: 41_000`。
- `production-authority-lifecycle.unit.test.ts:195-220` 检查时钟无效时 `msSinceLastRenewal: null`。
- `production-authority-lifecycle.unit.test.ts:222-231` 检查持续续期成功时不报损失。
- `service-orchestration.unit.test.ts:511-527` 检查 `authority.lost` 与 `service.draining` 的 code/字段。
- `service-orchestration.unit.test.ts:530-554` 检查信号退出不带 code、未知错误映射为 `AUTHORITY_LOSS_CODE_UNKNOWN`。

反向用例核对（未执行，仅按代码推断）：
- “时钟无效”用例在旧代码上会得到 `NaN`，`toEqual({ msSinceLastRenewal: null })` 会失败，是真反向用例。
- “未知 code”用例在基线或上一轮会得到 `SERVICE_STARTUP_FAILED`，在期望 `AUTHORITY_LOSS_CODE_UNKNOWN` 时会失败，是真反向用例。
- “信号退出”用例在旧代码上也能通过，只是回归保护，不是反向用例。
- 缺少“clock 抛错时 `onLost` 仍被调用”和“`details` 缺失时不崩溃”的用例。

作者说的“96 例通过、tsc 和 biome 通过”**未核实**（当前工具不允许运行测试/编译）。

### 4. 改动产生或修改的每个值，两端是否都能接受？
逐个核对：
- `msSinceLastRenewal: number | null`：产生于 `production-authority-lifecycle.ts:517-521`；消费于 `service-main.ts:928-930`。`writeServiceDiagnostic` 的参数类型是 `string | number | boolean | readonly string[]`（`packages/platform-node/src/service-runtime.ts:81-84`），number 合法；`null` 时字段被省略，不会序列化。没有发现其他消费者。
- `ProductionAuthorityLossDetails`：从 lifecycle 导出并经 `src/index.ts` 的 `export *` 暴露；只有 `markLost` 产生。单参数 `onLost` 实现仍可赋给新签名（TS 允许少参数），未发现不兼容调用点。
- `lossCode()` 返回值：产生于 `service-main.ts:483-486`；用于 `service.draining` 的 `code`（`:647`）和 `authority.lost` 的 `code`（`:927`）。都是字符串，`writeServiceDiagnostic` 接受。仓库内未发现按 code 白名单校验的消费者或后端 schema，因此 `AUTHORITY_LOSS_CODE_UNKNOWN` 不会被仓库内校验拒绝；外部日志管线若有严格枚举，未核实。
- `leaseDurationMs` / `renewalIntervalMs`：数字，来自常量 `30_000` / `10_000`，`writeServiceDiagnostic` 接受。
- `authority.lost` 事件名：仓库内没有结构化事件注册表或校验器；未发现冲突的消费者。

结论：两端类型与现有消费方式可接受；唯一缺口是 `details` 缺少运行时兜底，异常会被空 `catch` 静默吞掉。

---

## 作者说法核对

- “只加诊断，不改授权逻辑”：大体成立，但 `markLost` 新增的 `clock.now()` 调用位于授权丢失路径，clock 抛错会改变错误传播和 `onLost` 是否执行，严格说不完全成立（问题 1）。
- “`onLost` 多带 `msSinceLastRenewal`”：成立；生产代码唯一调用点 `markLost` 总会传 `details`。
- “`service-main` 写 `authority.lost` 行”：成立，但只覆盖 lifecycle 的 `onLost` 路径；`service-main` 自己的 `failRuntime`（`service-main.ts:712-723`）不走 `onLost`，不会写 `authority.lost`，只写 `runtime.failed`。该路径的 `service.draining` 仍会带 code。
- “`service.draining` 非信号退出时带 code”：成立（`service-main.ts:647`）。
- “`markLost` 只在 `state === active` 时触发一次”：成立（`:510` 的提前返回）。
- “两个测试文件 96 例通过，tsc 和 biome 通过”：未核实。
- “日志是否可能泄露敏感信息”：未发现本次新增敏感值；没有记录 `error` 对象或正文，code 仍经过既有 `stableErrorCode` 白名单式正则和 `redactMachineSecrets`。
- “是否改变已有行为”：预期只增加诊断；实际新增了丢失路径上的 clock 读取、日志写入顺序变化（改为在停止反向服务之后写）和空 `catch`，其中 clock 抛错是唯一的实质控制流风险（问题 1）。
