node_modules 未安装在此检出中（glob 无结果），Pi 1.5.0 dist 代码无法直接核对——这会影响对作者若干“已核对事实”的验证，后面会标注。现在读适配器与相关文件。
# 复核报告：PR 359（D1 第 2 步，7ed6ff95）

## 侧重检查

从最普通的使用流程走了一遍（入口到结束，均在 `packages/runtime-pi/src/pi-runtime-adapter.ts`）：

1. `adapter.run`（约 1300 行起）→ 解析 `binding` → 建 `governedRuntime`（1576）→ `sessionFactory` 传入 `modelRuntime: governedRuntime`（1614）→ `restored` 赋值（1673）→ `session.subscribe`（1686，`compaction_start` 置 `compacting`）→ `session.prompt`/`agent.continue`（1809-1823）→ Pi 默认 streamFn → 代理 `streamSimple` → `deferredPiStream` → `govern`（1578-1608）→ `admitPiStream`（967）→ `forward` → 共享 `binding.modelRuntime.streamSimple` → 事件回流经 `mapEvent` → `emit`。
2. **结论**：govern 闭包体与旧 `streamFunction` 逐行相同（diff 证实，仅 `originalStreamFunction` 换成 `forward`）；`compacting`、`loopSummaryAttempted`、`restored` 均为闭包内惰性读取，且所有模型请求只发生在 `session.prompt`/`continue` 之后（`restored` 已在 1673 赋值），**无时序问题**。
3. **测试覆盖**：压缩摘要（prompt-prefix `[COMPACT-1]` 两条，真实 Pi 会话）、审批回放（"restores a known result…"、"preserves loop detection across approval…" 等多条）、工具循环（"keeps summary generation behind the model admission gate"，`admissions===5` 证明第 5 次摘要请求也过准入）、准入失败各分支（model-accounting 全套经代理走）、`model !== binding.model`（compat 592 行"same-model clone"）都有覆盖，且 fake 会话改为调 `rawOptions.modelRuntime.streamSimple`，即走新代理。
4. **没有测试覆盖的路径**（本次改动新增/受影响的）：
   - `govern` 抛异常 → `deferredPiStream` 的 catch（pi-runtime-adapter.ts:820-821）：如历史写 promise 被拒（1712 存入的 `pending` 本身仍 rejected，1713 的 `.catch` 只处理派生 promise），"does not call the model when native history cannot be persisted" 只断言“不完成”，不断言错误文本/码。
   - 代理非 `streamSimple` 成员的 `bind` 转发（846）：无直接测试，仅由真实会话测试间接覆盖。
   - 预热请求走代理：无测试（当前不会发生，见下）。
5. **环境限制**：本检出里没有 node_modules（glob 无结果），Pi 1.5.0 dist（`sdk.js`、`agent-session.js`、`cache-warmer.js`）读不到；也不能运行测试。作者关于 dist 的核对与“442/27 条通过”均**未核实**（prompt-prefix 测试文件的 it 块数恰为 27，数量吻合）。

## 发现的问题（按严重度从高到低）

**1. 低 ｜ pi-runtime-adapter.ts:820-821 ｜ `deferredPiStream` 把 `govern` 内的异常统一压成 "Model request failed"，丢失具体诊断**
- 证据（读代码证实）：`catch { output.push(piErrorEvent(model, "Model request failed")); }`。`govern` 里 `await this.#historyWrites.get(request.runId)`（1582）在历史写失败时会 rejection（1712 存入的 `pending` 被 1713 `.catch` 处理的是派生 promise，`pending` 本身仍 rejected）。旧实现是 `session.agent.streamFunction` 这个 async 函数直接 reject，由 Pi 处理；新实现变成流内一条固定文案的错误事件。
- 影响：仅错误路径；`mapEvent` 的错误分类对未知文案走通用 `PI_MODEL_ERROR`（compat 测试 2199 行"arbitrary message"分支模式），失败诊断码可能从旧的具体码变粗。请求字节不受影响。
- 建议：在 catch 里保留 `error` 的稳定码（复用 `admissionFailure` 的提取逻辑），或至少为该路径补一条断言错误文本的测试。

**2. 低（风险备注，未核实）｜ pi-runtime-adapter.ts:840-848 ｜ 代理假设依赖未核实的 Pi dist 行为**
- 读代码证实的部分：每次 `get` 都返回新函数（`streamSimple` 新建、其余 `bind` 出新引用）；`has`/`ownKeys`/`set` 未拦截。
- 未核实：作者声称 Pi dist 无 `instanceof ModelRuntime`、`_getSummarizationRequestAuth` 按 runtime 对象身份登记、函数身份无被比较处——本环境读不到 dist，无法独立证实。真实 Pi 会话的 compat/golden/prompt-prefix 测试（作者称通过）是行为证据，但不是证明。
- 建议：把这几条 dist 核对写成一次性的机器检查（例如升级 Pi 时跑的契约测试），不要只靠 ADR 文字。

**3. 信息 ｜ pi-runtime-adapter.ts:1435 + ADR 0208:80/93 ｜ 预热请求一旦发生将首次进治理层，但无标记、用途记为 "chat"**
- 读代码证实：`cacheWarming: "streaming"` 被钉住（`[D7]` 测试锁住此设置）；旧实现里预热器直连共享 runtime，**绕过**准入/遮盖/预算；新实现里预热器调代理 `streamSimple`，会完整走 `admitPiStream`（预算、遮盖、`++streamOrdinal`），用途是 `"chat"` 不是 `"other"`。
- 现状无害：ADR 0206（docs/adr/0206…md:54）不给任何模型写 `promptCache` 寿命，预热不会触发——作者“生产关着预热”的说法在效果上成立。
- 建议：维持 ADR 0208 line 80 的承诺——打开预热（第 3 步）前必须加标记和专门用途；可在文档里明确“新代理已使预热从绕过变为进治理”这一行为变化，第 2 步记录目前没写这一条。

**4. 信息 ｜ 文档一致性**
- 读代码证实：`src` 里已无任何 `streamFunction` 赋值（grep 证实）；ADR 0208 第 2 步记录与 `pi-development-guide.md` D1 行的“第 2 步已完成”和代码一致；“`model !== binding.model` 测试覆盖”属实（compat:592）。
- 未核实：`sdk.js` 261-272、`agent-session.js` 登记、`cache-warmer.js` 的引用行号；442/27 条测试通过。

## 必答问题逐条回答

**1. 会不会改变模型已见过的请求开头？** 不会（就代码结构而言）。请求链路变为：Pi 默认 streamFn（不再被覆盖，负责选项整理、预热触发，仍在会话层）→ 代理 `streamSimple` → `govern`（上下文构建逻辑与旧 `streamFunction` 逐行相同）→ `admitPiStream`（遮盖/准入未动）→ 共享 runtime。同步返回流由 `deferredPiStream` 保证，每轮会变的值仍只在最后一条消息（相关构建代码未动，prompt-prefix 检查覆盖）。字节不变有黄金请求测试（真实 Pi 会话对比 `d4-golden-requests.json`，改前录制的基线）守护。**注意**：Pi 默认 streamFn 的行为和“测试当前通过”在我这里未核实/未运行。

**2. 会不会同段文字在不同请求里变成不同字节？** 不会。本次没有引入任何新内容进请求：无新字段、无新序列化、无依赖前后文的遮盖变化、无时间/无序集合；`streamOrdinal`、代理、`deferredPiStream` 都不影响请求字节（`piErrorEvent` 的 `Date.now()` 只出现在错误事件，原有行为）。

**3. 有没有对应的自动检查，反向用例会不会失败？** 有。golden 测试自带反向用例（“fails the golden comparison when a model field…is altered”，断言改动后必不相等）；prompt-prefix 测试带 4 条以上 REVERSE 用例（改写历史用户消息、系统提示带每轮变化值、关掉冻结、请求中间出现 system 消息）加检查器自身的反向断言（1026、1040）。这些检查都经真实 Pi 会话+新代理路径。机制上反向用例会失败（读代码证实）；“当前确实全绿”未运行验证。

**4. 每个产生/使用的值两端都能接受吗？**
- `governedRuntime` 代理：产生于 adapter:1576，使用于 sessionFactory 选项（1614）→ Pi 会话内部（未核实 dist，但真实会话测试、黄金请求、prompt-prefix 全部经此路径，行为有覆盖）。
- `deferredPiStream` 返回流：产生于代理 `streamSimple`，消费方是 Pi 的 streamFn（同步使用——未核实 dist；fake 与真实会话测试均按流消费，终止性由 `finally end()` 保证，准入失败走 `failedPiStream`，其内层流终止依赖 Pi 事件流对 error 终止事件自动结束——该依赖旧代码同样存在，且有 `observedTerminals:["error"]` 测试行为佐证）。
- 新错误文本 "Model request failed"：消费方是 `mapEvent` 的错误分类（→ 通用 `PI_MODEL_ERROR`，见问题 1），两端可接受但诊断变粗，建议改进（发现 1）。
- `streamOrdinal`、`logicalSlot`、`compacting`/`loopSummaryAttempted` 语义未变；`binding.modelRuntime` 的另一消费方 `pi-model-transport.ts:359`（后台/辅助调用，走 `.stream` 不走 `streamSimple`）不受影响且本就自带头部与遮盖，属有意绕过代理，无问题。
