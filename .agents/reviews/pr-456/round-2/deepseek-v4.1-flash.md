# PR 456 第 2 轮复核结论

## 一、发现（按严重度）

### 1. 中低：冻结意图被原样复用，规则/事实版本变化时不再重建意图，与本 ADR 明写的上线后果矛盾
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:645-653`，`apps/agent-service/src/owner-scope-authorization.ts:165-172`，`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:132,271`
- 问题：本轮改成先 `lookup` 再写，命中冻结意图就直接读回；`authorize` 只核对 `intent.id / runId / capabilityRef`，不再比较新算出的 `proposed`（`deterministicFacts`、`finalRisk`、`capabilityVersion`、`expiresAt`）。因此发布新规则/新事实后，续跑的旧意图仍带旧事实。
- 证据（证实）：
  - `production-runtime-tools.ts:646-653`：`const frozen = await this.#options.artifacts.lookup(... operationKey: key ...); return this.#readJson(frozen?.payloadRef ?? (await this.#writeJson(...)).ref);`
  - `owner-scope-authorization.ts:166-171`：只校验 `intent.id !== id || intent.runId !== invocation.runId || intent.capabilityRef !== row.capabilityRef`，返回 `intent_identity_changed` 之外不再校验其余字段。
  - ADR:132 说“事实在组动作意图时定下来就不再变”，但 ADR:271 同时写“上线前还等着的旧审批，续跑时新组的动作意图多了事实，指纹对不上，会被拒绝后重新问一次”。新实现下不会再“新组”，第 271 行的说法不再成立。
- 影响（据代码收窄）：旧**待人工审批**记录不会因此被自动放行——`owner-policy-authorization.ts:64` 对 `pending` 且无 `policyAuthorization` 的记录直接返回，随后 `ActionPolicyService` 走 `existingApproval` 继续问。真正有风险的是“已预先授权、尚未执行”的窄窗口（例如预先授权后崩溃、重启续跑），以及 ADR 承诺与实际行为不一致。
- 建议：在冻结意图里带一个事实/策略结构版本（或把 `proposed.deterministicFacts / finalRisk / capabilityVersion` 与冻结值比较），不一致时拒绝并重新组意图；若决定保留冻结事实语义，则删改 ADR:271 并补一条说明和用例。

### 2. 中低：统一出口的 `catch` 吞掉所有异常，无审计/日志，会把配置与编程错误伪装成“组件错误”
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:640-665`
- 问题：`try` 只包住 `ownerScope.authorize(...)`，随后 `catch {}` 不记原因、不审计，统一改成 `authorization_component_error`。除了存储不可用，它还会吞掉 `assertPolicyFactCodes` / `validateGovernedActionIntent` 抛出的 `PORT_INVALID_OPERATION`（登记表/事实配置写错）、`PORT_CONFLICT`（并发/版本冲突）、以及真正的 TypeError。行为是 fail-closed（不执行），但会把可诊断缺陷变成模型的普通失败。
- 证据（证实）：`catch { await this.#options.assertRunActive(invocation.runId); signal?.throwIfAborted(); permission = { decision: "DENY", reasonCode: "authorization_component_error", alternativesAllowed: false }; }`
- 建议：只捕获“组件不可用/超时/临时冲突”一类错误；对 `INVALID_OPERATION` 等构造性错误直接抛出或至少写审计/诊断（含原始 `error.code`）；拒绝路径也记一条审计，便于线上定位。

### 3. 中低：主张“这一轮已停或已取消时照旧抛出”没有反向用例
- 文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:1922-1953`
- 问题：新用例只覆盖 `authorize` 先 reject、后 resolve；没有任何用例让 `assertRunActive` 拒绝或让传入信号已取消，因此若以后有人删掉 `assertRunActive` / `throwIfAborted` 两行，测试仍会通过。
- 证据（证实）：代码本身确实有这两行（`production-runtime-tools.ts:658-659`），但测试文件里 grep 不到 owner-scope 的 stop/abort 用例。
- 建议：补两条反向用例：(a) run 已停时 execute 必须抛出（而不是返回 `failed`）；(b) `signal` 已 abort 时抛出 AbortError。

### 4. 低：ADR 前提表表头与更新后的行号自相矛盾
- 文件:行：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:53`
- 问题：表头仍写“每条前提的来源在 2026-11-12 对着 `origin/main` 的 `cc510cc0` 核对过”，但第 1、14、31、35 等行已按当前分支更新（如 `production-runtime-tools.ts:573-575`）。这些行号在 `cc510cc0` 上并不是这些代码（本轮 ADR diff 自己显示旧值是 561-563）。读者按表头去基线核对会失败。
- 证据（证实）：`git diff 4f0173a..f7d1e20 -- docs/adr/...` 显示前提 35 从 `561-563` 改为 `573-575`；当前文件第 53 行仍写 `cc510cc0`。
- 建议：把表头改成“行号以当前分支为准，语义以 cc510cc0 为准”，或逐条标注“基线行号/当前行号”。

### 5. 低：#inFlight 合并忽略调用方信号，一个调用取消会波及共享结果的另一个调用
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:755-766`
- 问题：键只含 `runId+toolCallId`，fingerprint 也不含 `signal`。两个同键并发调用会共享同一个 `#ownerScopedOnce` Promise；若先创建者的 `signal` 被取消，`authorize` 的 `throwIfAborted` 使共享 Promise 拒绝，另一个未取消的调用也拿到拒绝。`packages/runtime-pi/src/pi-runtime-adapter.ts:2215-2223` 会把 `execute` 的抛出改写成 `dispatchState: "possibly_sent"`，可能把未派发的动作标成“可能已发”。
- 证据（证实）：`#ownerScoped` 直接 `return active.result`，未比较信号；`pi-runtime-adapter.ts:2215-2219` 的 `catch` 固定 `outcome:"result_unknown", dispatchState:"possibly_sent"`。
- 说明：重复的同 `toolCallId` 通常来自同一轮、同一 run 信号，实际触发概率低。
- 建议：把调用方 signal 的取消代次纳入 fingerprint，或在注释/测试里明确“同键调用必须共享同一 run 信号”。

### 6. 低/信息：两次并发首次调用在跨进程下仍会冲突，但当前部署下不可达
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:755-766`，`packages/persistence-sqlite/src/sqlite-run-payload-artifact-operations.ts:292-300`
- 问题：同进程由 `#inFlight` 合并；跨进程时两个首次调用都 `lookup` 未命中，随后各自 `commit`，只要 `clock.now()` 不同，`sameIdentity` 就判为 `PORT_CONFLICT`，再被第 2 条的 `catch` 变成 `authorization_component_error` 拒绝。
- 证据（证实）：`commit` 的 `existing && !sameIdentity(...) -> PORT_CONFLICT`；`#inFlight` 是实例字段。
- 收窄结论（证实）：`product-state-repository.ts:237` 打开仓库时 `acquireStateRootLock` 独占 state root，正常部署不会有两个进程共用一个库，因此该路径目前不可达；若将来破坏这个前提，最坏是误拒绝，不是重复执行。
- 建议：在注释或 ADR 写明“并发去重只在单实例内有效，依赖 state-root 独占锁”；若要防跨实例，可把 intent 的 `requestedAt`/事实版本从内容指纹里拿掉，使同键首次写入内容一致。

## 二、推测 / 未核实

- [推测] `owner-scope-authorization.ts:36` 的 `digest` 没有排序键，`inputDigest` 依赖 `invocation.arguments` 的 JSON 键序；同一语义参数换键序会得到不同 intent id / 审批。未核实上游 Pi 是否规范化工具参数键序。若不会规范化且同一 `toolCallId` 会以不同键序重放，可能出现重复审批卡片（不重复执行）。
- [推测] 第 1 条里“已预先授权未执行”的窄窗口是否真的能在发布间隔内存活，取决于崩溃恢复路径；未在运行中验证。
- [未核实] `production-runtime-tools.unit.test.ts:2043` 的 `EVERY_TOOL_DEFINITIONS_SHA256` 是否真的来自改动前的输出。测试能守住今后不再变化，但不能独立证明它与基线逐字节相同（没有基线产物可比）。

## 三、侧重检查

- 错误路径：确认 `authorize` 抛出时只在 run 已停/信号已取消时重抛，其余一律 DENY；确认 DENY 返回发生在 `run(...)` 之前（`production-runtime-tools.ts:796-801`），不会执行副作用。发现：吞错无审计（见 2）、停/取消无反向用例（见 3）。
- 不合规范/不可信输入：冻结意图来自持久化，`authorize` 只校验三个字段，完整校验在 `ActionPolicyService.evaluate -> validateGovernedActionIntent`（`action-policy-service.ts:181`）；畸形意图会抛错再被统一拒绝，属 fail-closed。未发现新的注入/越权路径。
- 安全：组件错误是 fail-closed，未发现直接绕过；发现冻结事实跨版本复用（见 1）和并发合并共享取消（见 5）。跨进程冲突因 state-root 独占锁不可达（见 6）。
- 资源耗尽：`awaiting_approval` 立即返回（`gate` 返回 `stopped` 后直接 return），`#inFlight` 用 `finally` 清理，不会长期占用；先查再写还减少了重放时重复生成 payload 记录。未发现新的无界增长。
- 不可撤销操作：`reminder_cancel`、`rule_undo` 在登记表里是可撤销；DENY/组件错误路径都在 `run` 前返回，已读代码确认不会误派发。
- 规则/文档/代码一致：登记表“只登记未读取”的列（`detail`、`resultOrigin`、`mayFollowExternalContent`、`deduplication`、`device`）核对属实；ADR 表头与行号不一致（见 4）；`authorization_component_error` 未进 ADR 新值清单，但它是自由字符串、后端无清单校验，不会出现 I-73 那种“清单值过不了校验”的问题。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会（本轮增量）。本轮只改 `#ownerScopeGate` / `#ownerScoped` 与测试，未动系统提示、工具定义、历史或遮盖。整个 PR 里 `listAuthorized` 改为 `this.#registry.offer(descriptors)`（`production-runtime-tools.ts:577`），但 `offer` 只按登记表过滤、保持原顺序；我逐行核对了内置 7 行、编码/网页/任务/`authorized_` 行都存在，`parallel` 过滤只可能去掉“有后果且并行”的描述符，而代码中 `executionMode: "parallel"` 只出现在 READ 工具。新增的模型可见内容只有工具结果（拒绝原因、审批/成功结果），它们是最后一条 tool-result 消息，属于“只在末尾追加”。每轮会变的值（`errorCode`、审批 id 等）都在结果里，不进请求头。结论：未发现前缀变化。唯一保留意见是上面 [未核实] 的哈希常量出处。

### 2. 同一段文字会不会在不同请求里变成不同字节？
本轮的“先查再写”反而减少了时间导致的字节变化：重放时不再用新的 `now` 重写 `requestedAt/expiresAt`，而是读回原意图（`owner-scope-authorization.ts:107-113,165`）。成功结果走 `runtime-tool-result` 缓存，`awaiting_approval` 走已有审批，模型可见字节稳定。内置动作事实经 `runtimePolicyFacts` 排序、`actionGateFacts` 再 `sort`。未发现新的无序集合或时间字段进入模型可见文本。保留一点：[推测] `inputDigest` 未排序键序（见上）。

### 3. 有没有自动检查，反向用例真的会失败吗？
有。`test/integration/tool-action-registry.test.ts` 新增：时钟前进重放（184-238）、同键并发只跑一次（240-252）、规则修订号开/关（254-293）；`production-runtime-tools.unit.test.ts:1922-1953` 新增出口抛错用例；该集成文件已挂进 `package.json` 的 `check:rule-registry`。反向有效性：去掉 lookup-first 则重放会产生内容冲突（或 DENY），`toEqual(waiting)` 失败；去掉 `#inFlight` 则并发用例会跑两次 `reminders` / 产生两张审批而失败；去掉“开着自动更新、关着保持”则修订号用例失败；去掉 `catch` 则出口抛错用例直接 reject 而失败；把失败结果持久化则第二次 execute 不会 succeeded。缺口：停/取消重抛（见 3）、`#inFlight` 同键不同 fingerprint 的 CONFLICT 分支、以及哈希常量来自改动前的证明。

### 4. 每个新/改值两端都能接受吗？
- `authorization_component_error`：产生于 `production-runtime-tools.ts:662`；消费于 `runtimeToolAuthorizationResult`（任意字符串，`runtime-tool-authorization.ts:34-36`）→ `RuntimeToolSettledResult.errorCode/modelContent` → `pi-runtime-adapter.ts:2238,2245`；没有 reasonCode 清单会拒绝它。两端都接受，但没有审计/日志，也没写进 ADR 新值清单。
- `owner-scoped:<digest>`：只在这一处产生和消费（`production-runtime-tools.ts:755-765`）。写代码工具的键是裸 `digest([runId, toolCallId])`（`:1252`），64 位十六进制，不可能等于带 `owner-scoped:` 前缀的字符串；全类只有这两个 `#inFlight` 键来源，**不会相撞**。
- `action-rule:<ruleId>` 与 `{enabled, ruleRevision}`：产生于 `owner-scope-authorization.ts:223-247`；消费于同函数的重读、`applyOwnerPolicyAuthorization` 写入 `approval.policyAuthorization`，以及 `sqlite-durable-operations.ts:2091-2103` / `durable-adapters.ts:365-370` 的“记录 revision 相同且 enabled=true”校验。`commitStateAndEvents` 不校验 key/value 形状，写入能被接受。需要提醒：后端核对的是 **product_state_records 的 revision**，不是 `ruleRevision` 与当前内置规则修订号是否一致；`ruleRevision` 目前只被 `#standingAuthorization` 自己用来决定是否自动更新，没有第二个校验者。因此不要把 ADR 里的“修订号没变”理解为“内置规则修订号没变”。
- 新增的 `detail`/`resultOrigin`/`mayFollowExternalContent`/`deduplication`/`device`：已确认第 1 步无读取方，ADR 的说明属实，不存在“生产方写了但使用方不接受”的问题。
