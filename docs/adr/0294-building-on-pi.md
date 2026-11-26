---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0198-upgrade-pi-to-1-5-0.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0203-follow-pi-official-extension-patterns.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0204-handle-pi-deviations-d2-d3-d5.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0205-pi-native-provider-auth.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0206-pi-deviations-d5-insertion-and-d7-cache-warming.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0207-compaction-request-reuses-conversation-head.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/runtime-pi/package.json, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/src/pi-tool-batch-continuation.ts, packages/runtime-pi/src/configured-model-binding.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, packages/runtime-pi/test/prompt-prefix.compat.test.ts, packages/runtime-pi/test/fixtures/d4-golden-requests.json, docs/pi-development-guide.md"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0294：在 Pi 上开发：照官方写法，偏离逐条批准

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
  - [照官方写法的规矩](#rule)
  - [Pi 版本和历史恢复](#version)
  - [请求开头和每次运行的模型代理（D1、D6）](#request-head)
  - [审批续跑和插消息（D2、D3、D5）](#continuation)
  - [服务方认证（D4）](#auth)
  - [缓存预热（D7）](#warming)
  - [压缩摘要请求沿用原对话开头](#compaction)
- [第 2 步实施记录](#step-2-record)
- [第 3 步实施记录](#step-3-record)
- [比较过的方案](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

Pi（Himawari 用来跑 Agent 循环的开源库，`@earendil-works/pi-*` 包）上的做法原来分散在七份 ADR 里：ADR 0198 升级到 Pi 1.5.0，ADR 0203 定“先照官方写法”，ADR 0204 到 0208 逐条处理 2026-11-10 核查出的七处偏离（D1 到 D7）和压缩请求。这份 ADR 把仍然有效的决定合成一份。每处偏离的位置、官方写法和现状，以[Pi 二次开发规范的偏离表](../pi-development-guide.md#current-deviations)为准；这里记批准了什么、为什么。旧文全文在 `supersedes` 列的固定提交链接里。

<a id="premises"></a>

## 前提

- 官方的请求钩子出错时只记录、照样放行，不能“失败就不发”；官方注册的服务方里拿不到本次运行的状态（预算预留、审批回放）。来源：Pi 1.5.0 pi-agent-core 的 agent-loop 里的 `streamAssistantResponse`，旧文 [ADR 0208 前提](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md#premises)。
- 官方的 `tool_call` 拦截只能在进程里当场等，审批要等几小时、服务中途可能重启。来源：[Pi 二次开发规范](../pi-development-guide.md#current-deviations) 的 D2 一行。
- 会话层没有“不加新消息、接着跑”和查底层队列的接口；`session.pendingMessageCount` 只数用户的 `steer()`/`followUp()`（Pi 1.5.0 `dist/core/agent-session.js` 第 1972–1974 行）。

<a id="decision"></a>

## 决定

<a id="rule"></a>

### 照官方写法的规矩

- 在 Pi 上加功能或改接入点之前，先读 [Pi 二次开发规范](../pi-development-guide.md)。官方有写法就照官方写；只有官方没有能满足需求的写法、或官方写法有缺陷时，才允许自己设计，而且要先出方案交 Andy，同意后才写进代码和规范，另开 ADR，并加一条 Pi 行为变化时会失败的测试。
- 查官方写法时同时读锁定版本和最新版本的文档，按锁定版本的接口写代码，两者不同之处写进方案或提交说明。
- 偏离表里的偏离，未经 Andy 批准不得照抄或扩大。

<a id="version"></a>

### Pi 版本和历史恢复

- `packages/runtime-pi` 固定 Pi 1.5.0，只有这个包导入 Pi。
- 审批挂起时存 `pi-tool-batch.v3` 快照：挂起那次回答之前的全部会话条目、冻结的系统提示、那次回答和已完成的工具结果。续跑用 `SessionManager.inMemory(cwd, { id }, entries)` 建会话，这份条目是续跑时唯一的历史来源；冻结的系统提示和当前不一致就拒绝续跑（`PI_CONTINUATION_SYSTEM_PROMPT_CHANGED`）。v2 快照续跑时报 `PI_CONTINUATION_VERSION_INVALID`，生产的恢复扫描遇到它跳过。
- Himawari 的历史不存 system 消息；请求中间出现 system 或 developer 消息判为破坏。
- 直接执行 Pi 内置工具的两处，先检查参数是普通 JSON 值（拒绝 undefined、BigInt、Map、循环引用，深度和节点数有上限）。
- 内置工具文字跟随 Pi 1.5.0；已有对话冻结的工具文字不变。`legacy-pi-history.ts` 保留，运维导入脚本和资格证据还在用。

<a id="request-head"></a>

### 请求开头和每次运行的模型代理（D1、D6）

- 请求开头由隐藏扩展 `himawari-request-head` 的 `context_with_system` 钩子生成：冻结的系统提示和冻结的工具组成第一条消息，后面是去掉 system 消息的历史。D6（`before_agent_start` 里再返回一次系统提示）已删除，系统提示只由资源加载器的 `systemPromptOverride` 给出。
- 不再给 `session.agent.streamFunction` 赋值。准入、预算、出口遮盖和还原、审批续跑时回放已有回答、识别压缩请求、拒发，都放在每次运行新建的 `ModelRuntime` 代理（`governedModelRuntime`，只重写 `streamSimple`）上。这是仍保留的偏离，依据第一条前提：官方钩子不能失败即拒发。
- 代理每次请求核对第 0 条消息逐字段等于冻结开头、其后没有 system 消息，不满足就一次请求都不发（`PI_REQUEST_HEAD_DIVERGED`）。钩子没注册或被改时，拒发由代理这一侧保证。

<a id="continuation"></a>

### 审批续跑和插消息（D2、D3、D5）

- D2（权限判断和等审批写在工具的 `execute` 里，等审批时存快照、结束这次运行）、D3（审批后续跑时回放那次回答）批准保留，依据第二条前提。升级 Pi 时这两条的测试必须先过。
- D5 已改成官方写法的部分：读历史用 `session.messages`，判断工具能否并行用 `session.getActiveToolNames()` 和 `session.getToolDefinition(name)?.executionMode`；压缩后补发运行环境说明用 `session.sendCustomMessage(environment, { deliverAs: "steer" })`；“工具循环已停止”提示、后台通知插入失败、存历史失败时用 `session.abort()`。
- D5 批准保留的部分，依据第三条前提：审批续跑用 `session.agent.continue()`（改成 `sendCustomMessage(..., { triggerTurn: true })` 会让模型多看到一条合成消息）；续跑那一轮里的“工具循环已停止”提示用 `agent.steer`；一轮结束后的补跑循环 `#continueForSteeredNotices`（落在 Pi 收尾前那次 `await` 间隙里的后台通知要补跑，用例 `[D5-NOTICE]`）；工具内部的 `agent.abort()`（工具运行中不能等会话空闲）。

<a id="auth"></a>

### 服务方认证（D4）

- 用 `createProvider` 构造完整服务方、`runtime.registerNativeProvider` 注册，流式实现复用官方的 `openAICompletionsApi()`。`auth.apiKey.check` 固定返回“已配置”，不读密钥；`resolve` 只从 `credential` 取密钥。Pi 的凭据库必须保持为空，以保证密钥来源只有一个（测试断言 `listCredentials()` 为空）。
- 准入、取密钥、传 `apiKey` 的顺序不变：先过权限和预算，再取密钥，再发请求。

<a id="warming"></a>

### 缓存预热（D7）

- `SettingsManager.inMemory` 显式写 `cacheWarming: "streaming"`，升级 Pi 不被新默认值带走。注册给 Pi 的模型都不填 `promptCache`，所以从不预热，用例 `[D7]` 锁住这一点。
- 要加短缓存的模型之前，先出整套方案：用隐藏扩展接 `cache_warming_decision` 走准入和预算、预热重放每次新建出口遮盖、`cache_warm` 用量记进用量表，并给预热请求加标记，让审批回放只对主对话请求生效。

<a id="compaction"></a>

### 压缩摘要请求沿用原对话开头

- 只观察的 `session_before_compact` 钩子（内联扩展 `himawari-compaction-prefix`）算出切点之前的消息，不替换 Pi 的压缩流程。只处理 threshold 或 manual 且不是拆分轮的压缩；溢出和拆分轮走 Pi 默认请求。
- 代理发现压缩期间的摘要请求时，若上一次普通请求的前几条历史和钩子算出的范围逐条相同，就把摘要请求换成：上一次普通请求的系统提示、完整工具定义、这几条历史，末尾追加一条指令（`packages/prompt-catalog` 的 `runtime.compaction.summary-instruction`），这样吃得到缓存。对不上、窗口放不下、没有上一次普通请求时，一律走 Pi 默认请求。会话编号和缓存设置沿用上一次普通请求，用量记为 `other`。
- 压缩期间（`compaction_start` 到 `compaction_end`）产品侧一律拒绝执行工具（`RUNTIME_TOOL_EXECUTION_STOPPED`），不依赖 Pi 的摘要路径恰好不执行工具。每次摘要请求写服务日志 `compaction.summary_request`，带 `sharedHead`。

<a id="step-2-record"></a>

## 第 2 步实施记录（2026-11-10）

代理只重写 `streamSimple`，用 `deferredPiStream` 先同步返回一条流、再异步走准入，准入失败时流里只有一个错误事件。方法用 `bind` 绑回原对象。`d4-golden-requests.json` 的黄金请求测试（真实 Pi 会话）改前改后都通过。遗留：预热器拿到的也是这个代理，预热请求会走准入、遮盖和预算，也会先消耗审批续跑的一次性回放；打开 D7 前要处理（见[缓存预热](#warming)）。

<a id="step-3-record"></a>

## 第 3 步实施记录（2026-11-10）

请求开头改由 `himawari-request-head` 的 `context_with_system` 生成，核对从只比工具名改成比整条开头。反向用例：`pi-runtime-adapter.compat.test.ts` 里开头被改、缺开头、开头之后又出现 system 消息，三种都零请求；`prompt-prefix.compat.test.ts` 的 `[D1]` 用例在钩子被摘掉时要求零请求。D1 在“开头”一项已回到官方写法。

<a id="options"></a>

## 比较过的方案

- 把准入、遮盖放进官方的 `before_provider_request` 或注册的服务方：钩子不能失败即拒发，服务方里拿不到本次运行的状态，放弃。
- 审批改用官方 `tool_call` 拦截：只能在进程里当场等，等几小时、服务重启就丢，放弃。
- 审批续跑改用 `sendCustomMessage(..., { triggerTurn: true })`：模型会多看到一条合成消息，还可能插在工具调用和它的结果之间，放弃。
- 删掉一轮结束后的补跑循环：落在间隙里的后台通知会丢，而通知回调已经回报“送达”，放弃。
- 压缩时自己发摘要请求、替换 Pi 的压缩流程：比改写请求多维护一整套逻辑，放弃。

<a id="consequences"></a>

## 后果

- 升级 Pi 时，D1 到 D7 各自的测试（`[D1]`、`[D4]`、`[D5-NOTICE]`、`[D7]`、`[COMPACT-*]` 和黄金请求）会先告诉我们哪里变了。
- 加 5 分钟缓存的模型之前必须先做完 D7 的整套方案。
