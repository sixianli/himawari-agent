# 复核报告：PR 463（每人 Job Host 网关和远端传输）

## 侧重检查（先走的流程）

我选了最普通的一条生产使用流程，从入口走到结束：

`SrtTaskEnvironmentBackend.session()`（apps/execution-worker/src/production-srt-task-environment-backend.ts:294，identity 锁内）→ `prepareSession`（:356，生产走默认 `forkLocalJobHost`）→ `prepareSandboxJobSession`（job-host-session.ts:84，`parseJobHostSessionRequest` → launcher）→ `await session.spawned` 记 pid（backend:361）→ `startToken(pid)`（:377）→ `finishStart` → `session.run()` → `session.close()`/`settle`。

结论：
- 本改动里这条链只有一处生产行为变化：`session.pid ?? null` 换成 `(await session.spawned) ?? null`（backend:361）。本机路径 `spawned = Promise.resolve(child.pid)`（job-host-transport.ts:27），fork 的 pid 同步可得，值与旧代码一致；`session()` 全程在 identity 锁内（:301），新增的 await 不会造成并发双开。已核实兼容。
- **生产代码没有任何路径构造 `gatewayJobHostLauncher`**（全仓库 grep，只有测试和导出）。整个网关链路（gateway、frames、远端 transport）目前是死代码，接不进生产——这与作者“生产暂不接网关”的说法一致。
- 未被测试覆盖的改动路径：①帧大小上限的拒绝分支（job-host-gateway-frames.ts:52-55）；②launch 成功后再发一帧 launch → reject 杀子进程的分支（job-host-gateway.ts:99-101 的 reject 经由 `frame["type"] !== "launch"` 之后的二次 launch）；③网关侧 spawn 失败发 `error` 帧的分支（:136，`started.once("error")`）。其余新增路径（relay、kill、断线、非法首帧、非法 JSON、socket 不存在、空闲退出、参数解析、跨账号）都有用例且我会判为真反向用例（见必答 3）。

## 发现的问题（按严重度）

**1. 中 ｜ packages/runtime-sandbox/src/job-host-gateway-frames.ts:33-57 ｜ “单帧上限 64 MiB”没实现全，且与作者自述约束矛盾**
证据：`pendingBytes` 只累加换行后的 `rest`（:54-55 `pendingBytes += rest.length; if (pendingBytes > JOB_HOST_GATEWAY_FRAME_MAX_BYTES)`）；完整行在循环里直接 `Buffer.concat(pending).toString("utf8")`（:35-36）送去 `JSON.parse`，**从未计入上限**。一个一次性到达、含换行符的 100 MiB 行不会被拒。同时 `JOB_HOST_GATEWAY_FRAME_MAX_BYTES = 64 * 1024 * 1024` 是写死的数字（:3），与作者“不在代码里写死上限数字”的约束直接冲突。读代码证实。
建议：concat 后按行长度检查再 parse；上限要么做成参数，要么修正两处说法；补一个超长帧反向用例。

**2. 低 ｜ packages/runtime-sandbox/src/job-host-gateway.ts:127-130 ｜ 断线后不肯退出的 Job Host 会让网关永不空闲**
证据：socket close 时只 `if (child?.connected) child.disconnect();`（:128），不 kill；`reconsider()` 里 `children.size === 0` 才计时（:37-42）。若 Job Host 收到 disconnect 后 hang 住（其取消路径异常时），children 永不为空，网关进程永不 idle，子进程滞留。本机模式 Worker 死了同样 orphan，但网关是常驻 systemd 服务，泄漏会累积。属于推测（依赖 Job Host hang 这个前提），但兜底缺失是读代码证实。
建议：disconnect 后加一个由参数给出的宽限期，超时 `killGroup(child)`。

**3. 低 ｜ apps/execution-worker/src/production-srt-task-environment-backend.ts:377、508-521 ｜ 跨账号接入网关时，pid 两端校验会失效（I-73 前瞻）**
证据：`startToken(pid)`（:377、:516）和 `groupPresent(pid)`（:518）都在主服务账号下按 pid 读进程状态；网关模式下 Job Host 属执行账号（fork 在网关进程里发生，job-host-messages.ts:22-36）。接网关后这些 /proc 读取可能拿不到 token，`remaining()` 的存活判定（:518 `token !== null || this.options.groupPresent(pid)`）会把活着的进程判成已死，destroy 门槛形同虚设。推测（取决于部署的 /proc 挂载选项，本 PR 生产未接网关所以现在不炸），但接网关的 PR 必须同步改这两端，正是 I-73 的教训。
建议：在 PR③ 里把“pid 的使用方在跨账号下能否工作”列为验收项。

**4. 低 ｜ apps/execution-worker/src/production-srt-task-environment-backend.ts:361 ｜ `await session.spawned` 在 identity 锁内且无超时**
证据：`const pid = (await session.spawned) ?? null;`（:361）位于 `this.locked(identity, ...)` 回调内（:301）。网关模式下若网关收下 launch 后既不发 `started` 也不关连接（socket 保持打开），spawned 永不 resolve，锁被占死，该环境所有后续操作卡住。推测（需要网关 hang）；本机路径同步 resolve，无影响。
建议：给 spawned 的消费加超时，或后端对无限期 pending 容错。

**5. 信息 ｜ 测试覆盖缺口（对应侧重检查第 3 点列的三条路径）**
证据：test/integration/job-host-gateway.test.ts 全文 286 行，没有超长帧、二次 launch、fork 失败（`forkJobHost` 抛错/子进程 spawn error → 网关 `error` 帧）的用例。读代码证实（文件已通读）。

## 读代码证实的说法核对（与作者说法一致的部分）

- `parseJobHostRequest`（job-host-protocol.ts:54-79）确实在网关侧校验 launch 请求；`parseJobHostSessionRequest`（:165-169）是它的严格子集，会话请求重过网关校验不会失败，两端校验一致。
- pid 语义成立：网关回 `started{pid}` 用的是 fork 返回的真实 pid（job-host-gateway.ts:57），Worker 侧 `authenticateJobHostEnvelope` 的 `processId === child.pid`（job-host-session.ts:312）与之匹配。
- kill 杀进程组：`forkJobHost` `detached: true`（job-host-messages.ts:27）+ `process.kill(-child.pid, "SIGKILL")`（job-host-gateway.ts:17-22）。
- 断线语义：网关 `child.disconnect()`（job-host-gateway.ts:128）→ Job Host `process.on("disconnect", () => stop("cancelled"))`（job-host-main.ts:1264），与本机 Worker 退出一致，且 integration test 断言退出码 0。
- 事件顺序：网关先 `exit` 帧后 `close` 帧（:94-114），Worker 侧 session 的 `onceExit`→`childExited`→不再 force、`onceClose`→收尾，与本机 ChildProcess 的 exit→close 顺序一致；spawn 失败路径 error→close 的顺序也对齐（error 帧 → close 帧）。
- `spawned` 的产生处（localJobHostTransport、gatewayJobHostLauncher、两个测试假件）和使用处（job-host-session.ts:457、backend:361、integration 测试的 spread 包装）全部找到，类型与取值兼容；`session.pid` 改 getter 没有遗留旧读取方（grep 证实）。
- ci/policy.json 新条目的字段与相邻 qualification 条目同构；测试用 `describe.skipIf(process.getuid?.() !== 0)` 与“普通 CI 跳过”一致。
- 网关信任模型确实如作者所说靠套接字文件权限（代码里无任何认证），0600 属主设置留给 PR③——本 PR 不含，说法一致。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。改动文件全部是沙箱执行设施（runtime-sandbox 的 gateway/frames/transport/session）、worker 后端一处 pid 记录、ci policy 和复核记录；没有触碰系统提示、工具定义、历史消息、遮盖相关的任何文件（diff --stat 全量核对）。发给模型的内容照旧只在末尾追加，每轮变的值也都在原有位置。依据的规则文件 `.claude/rules/prompt-prefix.md` 在仓库里不存在，规则原文**未核实**，结论基于 diff 本身。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的帧、pid、`spawned` 都是运行期 IPC 或状态文件里的值，不进入模型可见内容；`SessionRecord.pid` 本来就逐次变化（旧代码同样记录 `session.pid`），不是上下文依赖的遮盖或带时间字段。

**3. 有没有自动检查、反向用例会不会真失败？** 有：单元测试（job-host-transport.unit.test.ts 新增 7 个用例）、真套接字集成测试（job-host-gateway.test.ts，8+1 个）、root 资格测试（已登记 qualification）。反向用例核实：非法 launch（坏 digest）→ 断言 error+close 且 `forks` 为空，网关不校验就会失败；非 JSON 行 → 断言连接被弃且不 fork；参数缺省/冲突各有 throw 断言。缺口见问题 1 和 5（超长帧、二次 launch、fork 失败无反向用例）。“第 0 层 212 条通过”**未核实**（无法运行测试）。

**4. 每个产生/使用的值两端都接受吗？** 逐一核对过：`spawned`（Promise）、`pid` getter、网关帧类型（launch/kill/started/message/stderr/exit/error/close，两端处理对称）、`--idle-exit-ms`/`--socket`/LISTEN_* 参数、ci/policy.json 条目、index.ts 导出（无重复、无遗漏）。全部两端一致。唯一的前瞻缺口是问题 3：pid 这个值跨账号后的使用方（startToken/groupPresent）尚未验证，接生产前必须核对。
