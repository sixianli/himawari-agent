## 侧重检查

我按“错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则与文档一致性”先查了这些路径：

- 三个 `.catch` 错误回调（工具循环停止、后台通知、存历史失败）和压缩后补发的 `.catch`：确认 `session.abort()` 是异步的（`cancel()` 里 `await session.abort()`，`pi-runtime-adapter.ts:1228`），但在回调里返回的 Promise 没有被接住。见下面发现 1。
- 不可信输入：模型描述里塞 `promptCache` 的路径已核对，`providerModelConfig` 逐字段构造、不转发它（`configured-model-binding.ts:258-284`），`[D7]` 用例走真实 Pi runtime 断言（`configured-model-binding.compat.test.ts:326-341`）。这条防住了“目录里混进短缓存寿命”的输入。
- 资源/成本：`cacheWarming: "streaming"` 目前因所有模型无 `promptCache` 不会触发预热；但这是“靠测试挡”而不是运行时兜底，见发现 5。
- 不可撤销操作：`session.abort()` 会等会话空闲；代码里都是“发出去不等待”，不会在回调里死等自己（结构上成立），但压缩补发给运行环境说明新增了“补发失败即中止整轮”的失败模式，见发现 4。
- 规则/文档一致：`.claude/rules/prompt-prefix.md:74` 明确说压缩后补发运行环境说明不在 `check:prompt-prefix` 里，由 compat 用例覆盖；而该 compat 用例把 `sendCustomMessage` 换成了桩，见发现 3。ADR 0206 对“已覆盖”的表述偏强，见发现 4。

---

## 读代码证实的问题（按严重度）

### 1. 中：三处 `.catch` 把异步 `session.abort()` 的拒绝丢成未处理 Promise

**文件:行**：`packages/runtime-pi/src/pi-runtime-adapter.ts:1388-1390`、`1658-1660`、`1692`、`1703-1705`

**问题**：`agent.abort()` 改为 `session.abort()` 后，回调返回的是 Promise；外层是 `void ...catch(...)`，只处理了 `sendCustomMessage`/`pending` 的拒绝，没有处理 `session.abort()` 自身的拒绝。Node 22 默认把未处理拒绝当未捕获异常；仓库生产代码里没有 `process.on("unhandledRejection")` 兜底（我搜过，只有测试文件注册）。

**证据**：
- `pi-runtime-adapter.ts:1228`：`if (session) await session.abort();` —— 证明 `session.abort()` 返回 Promise，可在等待空闲时失败。
- `pi-runtime-adapter.ts:1388-1390`：`void active.sendCustomMessage(...).catch(() => active.abort());`
- `pi-runtime-adapter.ts:1658-1660`、`1692`、`1703-1705` 同样写法。

**建议**：把异步收尾包起来，例如 `.catch(() => { void session.abort().catch(() => undefined); })`，或用显式 `void (async () => { try { await session.abort(); } catch {} })()`；同时加一条断言“abort 失败不产生未处理拒绝”的用例。

> 说明：`session.abort()` 是否真的会拒绝，需读 Pi 源码确认，本仓库没有 `node_modules`，标为未核实；但“返回的 Promise 没人接”这一点由代码结构证实。

### 2. 中：`[D7]` 的 streaming 锁定用例在 1.5.0 上删掉新配置行也不会失败

**文件:行**：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:4228-4248`，对应实现 `pi-runtime-adapter.ts:1405-1413`

**问题**：用例只断言 `getCacheWarmingMode()` 的有效值等于 `"streaming"`，而 ADR 0206 自己写明 1.5.0 默认就是 `"streaming"`（`docs/adr/0206-...md:42`）。因此把新增的 `cacheWarming: "streaming"` 删掉，当前锁定版本上用例仍然通过；配置键写错、被 Pi 静默忽略，也照样通过。它只在“同时升级到 1.5.1 且这行被删”时才失败，不能证明这次新增的显式设置生效。

**证据**：
- `pi-runtime-adapter.compat.test.ts:4241`：`modes.push(options.settingsManager?.getCacheWarmingMode() ?? "unset");`
- `pi-runtime-adapter.compat.test.ts:4247`：`expect(modes).toEqual(["streaming"]);`
- `docs/adr/0206-...md:42`：`cacheWarming` 1.5.0 默认 `"streaming"`。

**建议**：直接锁“传给 `SettingsManager.inMemory` 的原始对象包含 `cacheWarming: "streaming"`”（spy/包装 `SettingsManager.inMemory`，或断言可读的原始设置字段），并补一条“显式设成 `"idle"` 时 `getCacheWarmingMode()` 返回 `"idle"`”的用例，证明该键确实被 Pi 接受，而不是碰巧等于默认值。

### 3. 中低：压缩后补发运行环境说明没有真实 Pi 用例，关键 compat 用例把 `sendCustomMessage` 换成了桩

**文件:行**：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:1658-1677`，实现 `pi-runtime-adapter.ts:1695-1706`，规则 `.claude/rules/prompt-prefix.md:74`

**问题**：这次行为变化的关键是“压缩后在会话运行中调用 `sendCustomMessage(environment, { deliverAs: "steer" })`”。用例只断言适配器调用了被替换的 `sendCustomMessage`，没有让真实 Pi 处理这个 custom message，也没有断言它确实在下一轮请求末尾出现。`check:prompt-prefix` 明确不覆盖压缩补发路径，所以“插入时机不变”在自动检查里没有正向证据，也没有反向用例（去掉补发会失败的那条只验证“有没有调用桩”）。

**证据**：
- `pi-runtime-adapter.compat.test.ts:1665-1667`：`session.sendCustomMessage = async (message, options) => { steered.push({ message, options }); };`
- `.claude/rules/prompt-prefix.md:74`：续跑和压缩补发“由 … `pi-runtime-adapter.compat.test.ts` 覆盖，它们不在这一步里”。

**建议**：仿照 `[D5-NOTICE]` 增加一条真实 `createAgentSession` 的压缩用例，断言 `environment` 进入紧接压缩重试的请求末尾；至少断言压缩事件发生时 `session.isStreaming === true`，把 ADR 前提 5 变成可失败的门槛。

### 4. 低：存历史失败的两条“真实 Pi 用例”并未验证 `session.abort()` 的新语义

**文件:行**：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2997-3060`，ADR 表述 `docs/adr/0206-...md:52`

**问题**：ADR 说存历史失败路径由这两条用例覆盖。但两条用例只断言“不调用模型/不执行工具、不以 completed 结束”，换成旧的 `agent.abort()` 也照样通过；它们没有制造“底层队列里还有后台通知”的情形，因此无法证明 `session.abort()` 的 `_agentRunAbortRequested` 真的阻止了 Pi 自动续跑——而这正是本次改动的理由。

**证据**：
- `pi-runtime-adapter.compat.test.ts:3015-3016`：`expect(model.observed).toEqual([]);`、`expect(events.at(-1)?.type).not.toBe("runtime.completed");`
- `pi-runtime-adapter.compat.test.ts:3057-3059` 同样是“没执行、没完成”的断言。
- ADR 0206:52：“存历史失败的路径由 … 两条真实 Pi 用例覆盖”。

**建议**：增加“存历史失败时后台通知已在队列”的真实 Pi 用例，断言不会再发模型请求；或把 ADR 的表述改为“覆盖失败会终止运行，但不覆盖是否阻止自动续跑”。

### 5. 低：`cacheWarming: "streaming"` 的成本风险只靠测试挡，无运行时兜底

**文件:行**：`packages/runtime-pi/src/pi-runtime-adapter.ts:1409`、`packages/runtime-pi/src/configured-model-binding.ts:258-284`

**问题**：如果将来目录描述里混进 `promptCache`（并通过别的入口送到 Pi），Pi 会在 streaming 时直接预热，不计预算、不记 `cache_warm` 用量。本次靠 `[D7]` 测试挡在 `providerModelConfig` 这一层，但没有运行时断言/兜底；`promptCache` 一旦从任何非该函数路径进入就会失效。这属于设计取舍（ADR 决定第 6 条已承认整套预热未做），不是本次必然故障，但值得记录。

**建议**：在注册模型后或绑定层加一个便宜的运行时断言/日志（例如发现 model 带 `promptCache` 就拒绝），不要只靠单测；或者至少在 ADR 里把“唯一防线是测试”写明。

---

## 推测 / 未核实

1. **未核实（缺 Pi 源码）**：ADR 前提 1–6 关于 `sendCustomMessage` 与 `agent.steer` 等价、`isStreaming` 只在 `_startRun` 为真、压缩只在会话自己开的一轮发生、`session.abort()` 设置 `_agentRunAbortRequested`、`session.abort()` 先中止底层 Agent 再等空闲等，全部只能依据 ADR 转述。仓库是稀疏检出、没有 `node_modules`，我无法打开 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 核对。因此作者说法 1、2 的“等同/不会自己等自己”只能算未核实。
2. **未核实**：`SettingsManager.inMemory` 在 1.5.0 是否接受顶层 `cacheWarming`、`getCacheWarmingMode()` 是否存在。若键名不对，发现 2 的用例会静默通过。
3. **推测**：`session.abort()` 是否会在会话已 dispose、监听器抛错等场景拒绝，未复现；发现 1 的后果取决于此。
4. **未核实**：`[D5-NOTICE]` 是否真的落在 Pi 的收尾 `await` 间隙、删掉 `#continueForSteeredNotices` 后是否必失败；需要读 Pi 源码或实际跑测试。

---

## 作者说法逐条核对

1. **“`sendCustomMessage(..., { deliverAs: "steer" })` 等同 `agent.steer`，压缩只在会话开的一轮发生”**：代码只显示调用了它；等价性、`isStreaming`、压缩时机均未核实（无 Pi 源码）。测试上，运行中插消息只由 `[D5-NOTICE]` 真实 Pi 用例覆盖，压缩路径是桩。
2. **“`session.abort()` 在回调里不被等待、不会自己等自己，且多标记 `_agentRunAbortRequested`”**：前半句与代码一致（`void ...catch`，不等待）；`_agentRunAbortRequested` 与“阻止自动续跑”未核实，且没有能区分新旧行为的自动用例（发现 4）。
3. **“模型注册只经 `providerModelConfig`、不带 `promptCache`”**：证实。`providerModelConfig` 不复制 `promptCache`（`configured-model-binding.ts:263-283`），`[D7]` 用真实 runtime 断言 `not.toHaveProperty("promptCache")`（`configured-model-binding.compat.test.ts:340`）。生产里两处注册都走该类（`production-model-composition.ts:338、393`）。
4. **“不改变模型已经见过的请求开头”**：就本次 diff 而言，没有改系统提示、工具定义或改写历史；插入的仍是追加的 custom message，`cacheWarming` 不进提示。故代码层面成立。但“插入位置和时机不变”依赖未核实的前提 1–5，且压缩补发路径没有真实 Pi 的只追加检查（发现 3）。

---

## 必答问题

**1. 是否改变模型已经见过的请求开头？**
代码层面没有：改动只替换插入消息/中止接口，并新增一个设置键；系统提示、工具定义、历史没有被改写。追加的运行环境说明仍是自定义消息，内容来自稳定的 `projection`，属于末尾追加。每轮会变的值（时间、环境等）没有挪到系统提示/工具定义；环境说明只在变化时补发。**但**“补发时机不变”依赖 ADR 前提 5 的“压缩一定发生在会话自己开的一轮里”，该前提我无法读 Pi 源码核对；若为假，`sendCustomMessage` 会走“直接写历史”分支而不是 steer，插入时机可能不同。结论：未发现改写已发前缀，但缺少覆盖压缩路径的只追加门槛。

**2. 是否会让同一段文字在不同请求里变成不同字节？**
本次 diff 没有引入依赖后文的遮盖、无序集合或新的每轮变化值。环境消息内容确定；`timestamp` 在旧代码里也是 `Date.now()`，且只落在追加的消息里，不是请求开头。`cacheWarming` 不影响提示。未核实 `sendCustomMessage` 内部是否额外写入随机/时间字段；即使有，按追加语义也只影响该轮末尾及之后作为历史的部分，属于同一对话内会冻结的历史，不造成跨请求重遮。

**3. 自动检查是否覆盖、反向用例是否真会失败？**
- `[D7]` 模型不转发 `promptCache`：真实 runtime，反向（开始转发）会失败，**有效**。
- `[D7]` 锁定 `streaming`：**反向（删掉新增行）在当前 1.5.0 上不会失败**，见发现 2。
- `[D5-NOTICE]`：真实 Pi，覆盖收尾间隙补跑，设计上能反向失败，但未核实。
- 压缩补发：只有桩用例；删掉补发会失败，但换成任意实现（包括错误的 Pi 用法）也能通过，见发现 3。
- `session.abort()` 新语义：没有能区分新旧实现的反向用例，见发现 4。
- 规则中 `check:prompt-prefix` 是阻断项，但明确不含压缩补发路径。

**4. 改动产生的每个值和每个使用方是否两端都能接受？**
- `cacheWarming: "streaming"`：生产方是 `pi-runtime-adapter.ts:1409`，消费方是 Pi `SettingsManager`。测试通过 `getCacheWarmingMode()` 间接读取，但无法证明显式键被接受（发现 2）。键名/枚举值未核实。
- `deliverAs: "steer"`：生产方 `pi-runtime-adapter.ts:1389、1659、1704`，消费方 Pi `sendCustomMessage`。后台通知路径由真实 Pi 的 `[D5-NOTICE]` 跑到，较可信；压缩环境路径只有桩。
- custom message 形状 `{customType, content, display, details}`：`runtimeEnvironmentMessage`/`backgroundCommandMessage` 生产，`sendCustomMessage` 消费；后台通知由真实 Pi 覆盖，环境路径未真实覆盖。
- `promptCache`：模型目录描述可能带入，`providerModelConfig` 丢弃，真实 runtime 用例锁住。生产端两处绑定都走该类，已核对。
- 用量表/事件：本次未接预热，未新增 `cache_warm` 用途或迁移；若将来 `promptCache` 漏进来，`cache_warm` 用量与 `entry_appended` 仍未处理（`docs/pi-development-guide.md:332` 已写），属于已知未完成项。

**总体判断**：核心改动方向与代码一致，作者说法 3 证实、4 在 diff 层面成立；说法 1、2 依赖无法在仓库内核对的 Pi 源码。建议至少补上“显式 `cacheWarming` 原始设置断言”和“真实 Pi 压缩补发只追加用例”再合并；发现 1 的未处理 Promise 建议顺手修掉。
