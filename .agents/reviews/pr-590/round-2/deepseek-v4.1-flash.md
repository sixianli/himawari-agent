## 复核范围

这一轮查看了两段 diff：

- `ccb2bd69..4e4d1cb`（本轮增量）：只改了 `packages/platform-node/test/protected-runtime.unit.test.ts`，另加了 `.agents/reviews/pr-590/*` 复核记录；产品源码、交付脚本都没有改。
- `5834935d..4e4d1cb`（整段）：同样只有这个测试文件和复核记录，没有 `packages/*/src`、`scripts/` 改动。

因此本轮把重点放在测试用例本身，以及它引用的生产代码/交付脚本。读了：`protected-runtime.ts`（`verifyProtectedRuntime`、构造函数、`begin`、`#complete`、`#bounded`、`auditProtectedRuntime`）、`protected-runtime-audit-worker.ts`、`S7-startup-readback.mjs`、`verify-startup-readiness-fixtures.mjs`、`S7-switch-start-readback.py`、`test_make_packet.py`、`vitest.workspace.ts`、`ci/policy.json`、`package.json`。上一轮判断记录被工具拒绝读取，未带入；只按作者说法和代码核对。

上一轮意见落实情况（按作者说法核对代码）：

- “新增行为用例，让 `verifyProtectedRuntime` 真实产出失败事件再交给读回判断”：存在，`protected-runtime.unit.test.ts:576-594`。
- “正则按正文/标志分开取”：已做，`:557-565`。
- “核对 nonFatal 名单、保留原三条断言”：`:569-573` 的三条 `isFailure` 断言等价保留；`nonFatal` 不含 `content_audit_failed`/`content_audit_retryable` 由 `isFailure` 的 `!nonFatal.has(event)` 隐式覆盖（`ccb2` 里两条显式 `not.toContain` 被删掉，但语义仍在）。
- 新增的行为用例存在一个环境依赖问题，见下面意见 1。

## 侧重检查

- **错误路径**：检查了 `verifyProtectedRuntime` 的失败事件映射（`protected-runtime.ts:430-470`）、瞬时错误重试（`:244-248`）、安装审计真实 worker（`:52-88`、`protected-runtime-audit-worker.ts:10-19`）以及读回脚本的失败判定（`S7-startup-readback.mjs:64-67,215`）。发现新行为用例的失败不是由可控的假审计产生的，见意见 1。
- **不合规范/不可信输入**：新测试读取的是仓库内 `S7-startup-readback.mjs`，用正则抽取正则正文/标志和 `nonFatal` 数组再 `JSON.parse`。输入不是外部不可信数据；格式变化会导致测试显式失败，不会静默通过。当前脚本格式与抽取规则一致（读文件逐项核对过）。
- **安全**：只改测试；`console.error` spy 只截获 `{component,event,pid,durationMs}` 这类 JSON，没有新增密钥或敏感数据输出；没有网络访问。
- **资源耗尽**：新用例调用默认 `auditProtectedRuntime`，会在真实文件系统上启动 worker 并可能遍历 `/data/himawari/releases/v1`（见意见 1）。该文件其余用例都注入 `fixture.audit`，只有这一条走真实 worker。
- **规则/文档与代码一致性**：本改动不涉及提示前缀规则（`prompt-prefix.md`）覆盖的请求组装代码；读回脚本的清单与 Python 切换脚本的同类清单是否同步，见意见 3。

## 意见

### 1. 中：新行为用例靠真实 worker 在真实主机路径上失败来产生事件，可能测不到宣称的摘要不一致路径，也会受环境/瞬时错误影响

文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:54,580-590`；`packages/platform-node/src/capabilities/protected-runtime.ts:127-128,427,52-88`；`packages/platform-node/src/capabilities/protected-runtime-audit-worker.ts:10-19`

问题：用例想让 `verifyProtectedRuntime` 在 `deferContentAudit` 下因内容摘要不一致而失败，但它用的是未注入审计的默认验证器；实际失败来自真实 worker 读取真实路径 `/data/himawari/releases/v1`。

证据（读代码证实）：

- 测试里 root 是真实风格路径：`:54 const root = "/data/himawari/releases/v1";`
- 行为用例调用：`:580 await verifyProtectedRuntime(root, digest, async () => "c".repeat(64), [], { deferContentAudit: true });`
- `verifyProtectedRuntime` 用默认构造器：`protected-runtime.ts:427 verifier = new ProtectedRuntimeVerifier(filename);`
- 构造器默认审计是真实 worker：`protected-runtime.ts:127-128 auditInstallation = (root, signal) => auditProtectedRuntime(root, 0, signal)`
- worker 对真实路径做 `lstatSync`/递归：`protected-runtime-audit-worker.ts:12 const info = lstatSync(filename);`、`:16 for (const entry of readdirSync(filename)) visit(...)`
- 摘要比较在安装审计之后：`protected-runtime.ts:372-373 await this.#auditInstallation(...); if ((await digest(runtimeRoot, signal)) !== runtimeDigest) throw failure();`

推测（基于上述代码路径）：在 CI/开发机上该路径通常不存在，worker 抛 `ENOENT`，`ENOENT` 不属于 `TRANSIENT_CODES`（`:92-100`），于是仍被映射为 `content_audit_failed`，用例通过，但根本没有执行到摘要比较。若主机恰好存在该路径，worker 会遍历真实目录；若遇到 `EIO`/`EMFILE`/`ENOMEM` 等瞬时错误，或 worker 以退出码结束，`begin` 会重试一次（`:244-248`），最后事件变成 `content_audit_retryable`，于是 `:589 expect(settledEvent()).toBe("sandbox_runtime.content_audit_failed")` 失败——同一份代码在不同环境下结论不同。

建议：给行为用例注入可控的失败审计，而不是走真实 worker。最小改动是在本测试文件 mock `node:worker_threads` 的 `Worker`，让它异步 post `{protected:true}`，这样安装审计通过、随后 `digest()` 返回错误摘要，稳定走到 `:373` 的真实内容不一致路径；或给 `verifyProtectedRuntime` 增加一个测试可注入的验证器/审计工厂。这样既不需要真实 `/data` 路径，也不会因瞬时文件系统错误把事件变成 `retryable`。

### 2. 低：行为用例把 manifestPath 的验证器写进模块级缓存并留下 refused 状态，测试间隔离依赖“它恰好是最后一个用例”

文件:行：`packages/platform-node/src/capabilities/protected-runtime.ts:411,425-428,235-239`；`packages/platform-node/test/protected-runtime.unit.test.ts:576-594`

问题：`verifyProtectedRuntime` 的验证器缓存是模块级的，按文件名复用；新用例用 `manifestPath` 跑失败审计后，验证器会保留在缓存里，并且失败路径会把错误写进 `#refused`。

证据（读代码证实）：

- `protected-runtime.ts:411 const verifiers = new Map<string, ProtectedRuntimeVerifier>();`
- `:425-428` 按 `filename` 取出或创建并缓存
- `:235-239` 非瞬时失败执行 `this.#refused.set(key, error)`
- 测试 `beforeEach` 每次把 `ino` 重置、清单内容固定（`:58-82`），因此同一 `manifestPath` 的 key 在不同用例间可重复；新用例目前是文件最后一个（`:576-594`），后面没有用例再调 `verifyProtectedRuntime`。

推测：如果以后新增一个用例（或执行顺序变化）在它之后用同一个 `manifestPath` 调 `verifyProtectedRuntime` 期待成功，`#complete` 的 `if (this.#refused.has(key)) throw ...`（`:361`）会直接抛出上次留下的错误，导致与该用例无关的失败。

建议：给测试暴露并调用一个重置验证器缓存/refused 状态的函数，或让新用例使用一个其他用例不用的 manifest 路径并在结束后清理；至少不要让测试状态依赖“当前它是最后一个用例”。

### 3. 低：新用例只把生产事件名对到 JS 读回，没覆盖 Python 切换脚本里同一份重复的失败清单

文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:557-566,576-590`；`scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:64-67`；`scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:46-50,312`

问题：启动失败事件判定有两份重复实现：JS 读回和实际执行切换的 Python 脚本。新用例只从 JS 读回抽取匹配规则来对照生产事件名，Python 那份仍只用字面量事件名测试。

证据（读代码证实）：

- JS：`S7-startup-readback.mjs:65 const nonFatal = new Set(["memory.embedding_catch_up_failed"]);`、`:66 ... /(?:failed|...|retryable)/i.test(...)`
- Python 同一份清单：`S7-switch-start-readback.py:46 STARTUP_FAILURE_TERMS = (...)`、`:47 STARTUP_NON_FATAL_EVENTS = frozenset({'memory.embedding_catch_up_failed'})`，并在 `:312 failure_events = startup_failure_events(messages)` 处真正决定是否让切换失败
- 现有 Python 测试 `test_make_packet.py:1826-1836` 用的是字面量事件名，不会跟着生产端改名失败；新 TS 用例也只解析 JS 文件。

推测：若生产端把事件改名并只更新 JS 读回的匹配规则（或用例只迫使更新 JS），新用例会通过，但 Python 切换脚本仍不认识新名字，上线时该失败事件不会触发 `SWITCH_STARTUP_FAILURE_EVENT`。

建议：把同一组事件名也交给 Python 清单做一次核对（例如从 `S7-switch-start-readback.py` 抽取 `STARTUP_FAILURE_TERMS`/`STARTUP_NON_FATAL_EVENTS`，或让现有 Python 测试读取生产端事件名而不是硬编码），保证两份判定不会漂移。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。整段 diff 只有测试文件和复核记录，没有触碰系统提示、工具定义、历史消息、遮盖或任何请求组装代码；也没有新增每轮会变的值。发给模型的内容不受影响，“只在末尾追加、变化值在最后一条消息里”的前提没有被改变。依据：`git diff --name-only 5834935d..4e4d1cb` 与测试文件内容（读代码证实）。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会/不涉及。改动只在测试里使用固定字符串和从源码提取的固定正则，不参与请求序列化、遮盖或历史存储；没有时间字段、无序集合输出。`new Set` 只用于成员判断，不序列化到任何请求（读代码证实）。
3. **有没有对应的自动检查，反向用例会失败吗？** 有。两条新用例覆盖读回判定（`:569-574`）和“生产实际事件 → 读回判定”（`:576-594`）；另有 `verify-startup-readiness-fixtures.mjs:55-72` 真正执行 `startupFailureEvents`，`test_make_packet.py:1811-1836` 覆盖 Python 切换匹配与门禁调用。按代码逻辑，生产事件改名会让 `:589`/`:590` 失败，把 `content_audit_failed` 加进 `nonFatal` 会让 `:569`/`:590` 失败（推测，基于代码阅读；作者的反向验证未作为自动用例提交，我也不能运行测试）。注意新行为用例只走到非瞬时失败路径；生产端“瞬时错误 → `content_audit_retryable`”的映射由现有 `begin` 测试覆盖，不在这条用例里（读代码证实）。
4. **增量产生或修改的值，每个使用端都能接受吗？** 增量没有产生/修改导出函数、配置键、字段或序列化格式；只新增测试内 `startupReadbackTreatsAsFailure`（`:569`、`:590` 使用）和局部 `settledEvent`（仅本用例）。两端的校验：`nonFatal` 是 `Set<string>`，`.has(event)` 接收 `string`；`new RegExp(String(pattern?.[1]), String(pattern?.[2]))` 接收两个字符串（`:565`）；`:588` 先断言 `settledEvent()` 已定义，`:590` 再用 `String(...)` 传入接收 `string` 的谓词。被消费的 S7 值（正则正文/标志、JSON 数组字面量）当前与脚本完全一致（逐项核对过 `S7-startup-readback.mjs:65-66`）。没有仓库内其他使用端。风险（推测）：抽取正则的 `(.+)` 是贪婪匹配，`JSON.parse` 假定数组为单行双引号；脚本格式若变化，测试会显式抛错而不是静默通过。
