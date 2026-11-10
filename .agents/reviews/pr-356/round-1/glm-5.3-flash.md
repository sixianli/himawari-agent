# 代码复核报告：d76066f1（D4 改回 Pi 原生认证）

## 问题清单（严重度从高到低）

### 1. 高 — 「golden 录制」提交实际夹带了运行时行为改动，作者说明未提
- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1667,1688,1996`；`packages/runtime-pi/src/pi-tool-batch-continuation.ts:37,73-81`
- 证据：`git diff 6557219..e934cd2f -- packages/runtime-pi/src/` 显示第一个提交（自述「test: 录下旧写法发给网关的请求」）已改了源码：3 处 `session.messages` → `session.agent.state.messages`，以及 `runsInParallel` 从「`getActiveToolNames()` 激活 + 注册为 parallel」改成「`agent.state.tools` 里存在且 `executionMode !== "sequential"`」。作者说明只说第一个提交「用旧写法录请求」，未提这些源码改动。
- 后果：golden 逐字节比对**只**证明了「模型服务方注册写法」的等价性，不能证明这些 adapter 改动无影响；「改写前后请求字节一致」这句话对它们不成立。
- 建议：把这两个提交的源码改动拆出来单独说明，golden 在真正未改动的基线上重录，或在 ADR 中补记这些改动及其验证方式。

### 2. 高 — `runsInParallel` 语义变宽，守护测试被删除
- 文件：`packages/runtime-pi/src/pi-tool-batch-continuation.ts:73-81`；`packages/runtime-pi/test/tool-batch-state.unit.test.ts`（删除的用例）
- 证据：旧逻辑里「已注册但未激活的并行工具」被当作 sequential（`tool-batch-state.unit.test.ts` 原有用例「treats a registered but inactive parallel tool as sequential…」断言 `parallel` 为 undefined、激活时报 `PI_CONTINUATION_RESULTS_INVALID`，该用例整条删除）。新逻辑 `tools.find(({name}) => …)` 只看注册表，不看激活状态。
- 后果：并行判定变宽后，`checkedBatch` 对 `completedResults.length` 的期望从 `waitingIndex` 变成 0（pi-tool-batch-continuation.ts:121），审批挂起/续跑路径（`saveToolCheckpoint`，pi-runtime-adapter.ts:1523）在「工具注册但未激活」场景下的行为改变，且新语义无任何测试覆盖。
- 建议：恢复一条针对新语义的用例，或在 ADR/规范里写明为什么 `getActiveToolNames` 语义被放弃。

### 3. 高 — 删除了记录 Andy 批准的 ADR 0204，编号被复用，批准状态被回退
- 文件：`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md`（整文件删除）；`docs/pi-development-guide.md:349-353`
- 证据：改动前指南里 D2/D3 状态为「Andy 2026-11-10 批准保留（[ADR 0204](adr/0204-handle-pi-deviations-d2-d3-d5.md)）」，本 PR 把它们改回「待 Andy 定」，并删除该 ADR，把 0204 编号给了新的 `0204-pi-native-provider-auth.md`（其 `supersedes: ""`）。全仓 grep 已无 `0204-handle-pi-deviations` 残留引用。
- 作者说明只提「规范 D4 行改为已关闭」，完全没有提删除旧 ADR 和回退 D2/D3/D5 的批准状态。指南自己的规则是「批准前，新代码不得照抄」，而 D2/D3 的代码仍在运行、状态却变成未批准——自相矛盾，且丢失了批准记录。
- 建议：要么恢复旧 ADR 并给新 ADR 换编号，要么在新 ADR 里显式说明旧决策为何作废并补 `supersedes`；D2/D3 代码的去留需重新交 Andy 定。

### 4. 中 — 「变异验证都会失败」的说法与仓库里的自动检查不符
- 文件：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2847-2864`
- 证据：仓库中唯一自动化反向用例是「改 maxTokens（512）后与 golden 不同」；作者声称的「check 返回 undefined、resolve 凭空给密钥、改 maxTokensField」三个变异没有对应的自动用例（grep 全仓只有 maxTokens 变体），属作者手工验证，无法复核。
- 建议：把三个变异做成参数化反向用例，或改口说明是手工验证。

### 5. 低 — 初始化失败被吞成一个笼统错误码，无测试
- 文件：`packages/runtime-pi/src/configured-model-binding.ts:409-411`
- 证据：`catch { throw new Error("PI_MODEL_RUNTIME_CONFIGURATION_FAILED") }` 会吞掉 `registerNativeProvider`/`refresh` 失败的具体原因（如模型 id 校验失败）；grep 显示没有任何测试覆盖此分支。
- 建议：至少保留原始错误的 `cause`，并补一条失败用例。

### 6. 低 — 未声明的仓库改动：删除 `.agents/reviews/pr-354/` 下 12 个复核记录
- 证据：diff stat 显示这批文件 `Bin … -> 0 bytes`。作者说明未提。若是有意清理请声明，若是误删请恢复。

## 「读代码证实的」与「推测/未核实」

**读代码证实：**
- `admitPiStream` 本身未被本 PR 改动（diff 仅删 Proxy + 3 处消息来源）；主机密钥只在准入（`gate.begin`，pi-runtime-adapter.ts:1005）之后经 `binding.resolveSecret`（:1057）取出，经 `apiKey` 选项传入（:1075）。
- `hostSecretAuth.resolve` 只读 `credential?.key`（configured-model-binding.ts:262-268），不触碰 `#secretSource`；凭据库为 `InMemoryCredentialStore()`（:386），且有测试断言 `listCredentials()` 为空、环境变量 `AI_GATEWAY_API_KEY` 不被取用、`secretReads` 为空（configured-model-binding.compat.test.ts:345-373、pi-runtime-adapter.compat.test.ts:2692-2732）。
- golden 文件两次提交间请求体逐字节未变，仅 authorization 头由「原始值」改为「Bearer [fixture]」脱敏（测试在比对前把 `Bearer ${FIXTURE_KEY}` 归一化，若新代码漏发/改发认证头，`toEqual` 仍会失败）。
- compat 字段（`maxTokensField`、`thinkingFormat: "openrouter"`、`sendSessionAffinityHeaders`、`supportsStrictMode`）在改动前后一致，golden 请求体逐字节相同佐证。
- golden fixture 无明显不稳定字段：时间固定为 NOW、`session_id`/`x-session-affinity` 为固定元组的 SHA-256、易变请求头（host/user-agent/accept-encoding 等）被过滤，无 Date 类字段。
- 架构文档 647 行附近已改写、指南 D4 行已标已关闭、D7 行补了预热绕过准入的事实——与作者说法一致。

**推测/未核实（node_modules 未检出，Pi SDK 内部无法直接核对；测试无法运行）：**
- Pi 1.5.0 内 `session.messages` 与 `agent.state.messages` 是否恒等；`getActiveToolNames` 的确切语义（影响问题 2 的实际影响面）。
- `registerNativeProvider` + `refresh({allowNetwork:false})` 的内部时序（刷新会不会重建/覆盖已注册服务方）——只能靠 `[D4]` 测试在真实 runtime 上断言 `hasConfiguredAuth`/`checkAuth` 成立来间接覆盖。
- `himawari-host-secret` 这个 `source` 值在 Pi 内部是否只作展示/审计标签（未核实，但除测试外无 Himawari 侧消费者）。
- 两个提交的测试是否真的全部通过；作者已声明未在 Hermes 上跑。

## 侧重检查

走的流程（最普通的一次对话请求）：
1. `PiAgentRuntimeAdapter.run` → `models.resolve` → `ConfiguredPiModelBindingPort.resolve`（configured-model-binding.ts:337）→ `initializeRuntime`（:381-413：`createProvider` + `registerNativeProvider` + `refresh` + 逐 descriptor `getModel` 校验）。
2. 会话创建（pi-runtime-adapter.ts:1541-1602）→ Pi 在 `prompt()` 前做认证检查（依赖 `hasConfiguredAuth`/`checkAuth`，SDK 内部未核实）→ `session.agent.streamFunction` 替换（:1608，D1）。
3. `admitPiStream`（:928）：上下文规整 → 准入 `gate.begin`（:1005）→ `resolveSecret`（:1057）→ 带 `apiKey` 选项调原流（:1072-1077）→ Pi `hostSecretAuth.resolve` 返回密钥 → `openAICompletionsApi()` 发请求。
4. 覆盖情况：happy path 两个服务方由 golden 测试覆盖（真实 Pi 会话 + 本地 HTTP 服务）；凭据不落库、环境变量密钥不读由 `[D4]` 用例覆盖。
5. **无测试覆盖的路径**：`initializeRuntime` 的 catch → `PI_MODEL_RUNTIME_CONFIGURATION_FAILED`（问题 5）；`runsInParallel` 新语义的「注册但未激活」分支（问题 2）；`refresh` 失败/模型未注册抛错分支。文档与代码一致性方面：新 ADR 0204 的「后果」「前提」与代码一致，但指南 D2/D3 状态与代码现状矛盾（问题 3）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 组装请求的代码（系统提示冻结、遮盖、末尾追加语境块）本 PR 未动；golden 比对证实请求体逐字节不变（authorization 仅测试侧脱敏，断言仍有效），每轮变化值（`himawari-context` 时间）仍在最后一条用户消息。保留意见：golden 录制提交里夹带了 `session.messages` → `agent.state.messages` 改动（问题 1），它影响「存历史」的字节；若两者在真实 Pi 中不等价，属于存储侧变化，[I-66] 出口检查（真实 Pi、逐字节比 `messages`）应能抓住——SDK 内部等价性未核实。
2. **同一段文字会不会变字节？** 未发现新增不确定来源：`check`/`resolve` 无时间、无环境依赖；golden fixture 时间固定、ID 哈希固定、易变头过滤。`runsInParallel` 改动只影响续跑控制流，不进请求字节。
3. **有没有对应的自动检查？反向用例会不会真的失败？** 有：golden 比对（两个服务方）+ maxTokens 反例 + `[D4]` 契约用例（checkAuth 值、凭据库为空、环境变量密钥不读、主机密钥未被提前读）。但作者声称的三个变异中只有 maxTokens 一条是自动用例，其余两条是手工验证（问题 4）。
4. **每个产生/使用的值两端都能接受吗？** `HOST_SECRET_SOURCE`：产生于 configured-model-binding.ts:256，消费于 check/resolve 返回值和两处测试断言，Pi 内部用法未核实但无其他消费方；`Model.provider` 显式字段与 `registerNativeProvider` 的 id 同源（同一 `first.provider`），与 AgentSession 按 `model.provider` 查认证的用法一致；compat 字段不变且 golden 字节一致；内置 `vercel-ai-gateway` 被替换丢失的只是环境变量密钥兜底（故意、有测试），模型目录由 `getModel` 校验兜底；`refresh` 时序经真实 runtime 测试间接覆盖（SDK 内部未核实）。**未通过的一端是流程性的**：ADR 编号 0204 被复用、已批准决策记录被删除（问题 3）。
