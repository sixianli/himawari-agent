已核对两个 diff（`f06f62b..1b0423e` 与 `d0aedcc..1b0423e`）以及网关、传输、协议、会话、后端、CI 策略和测试相关代码。第 2 轮增量集中在 `job-host-transport.ts`、`job-host-gateway-frames.ts`、`job-host-gateway.ts`、`job-host-gateway-main.ts` 和四个新测试。

## 发现的问题（按严重度）

### 1. 中：`fork` 同步抛错会直接打崩整个网关进程

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway.ts:64`、`packages/runtime-sandbox/src/job-host-protocol.ts:119-131`、`packages/runtime-sandbox/src/job-host-messages.ts:24-34`
- 问题：`launch()` 里 `const started = fork(request);` 没有 `try/catch`。`parseJobHostRequest` 只要求 `policy.workspace` / `privateDirectory` 是绝对路径字符串，不拒绝 NUL 或其他控制字符；这两个值随后被 `forkJobHost` 用作 `cwd` 和 `HOME`/`TMPDIR`。Node 的 `child_process` 会在同步参数校验时拒绝 NUL（`cwd` / env 值），异常从 socket 的 `data` 回调冒到顶层，未捕获异常会让网关退出，丢掉该人全部网关连接。
- 证据：
  - `job-host-gateway.ts:64`：`const started = fork(request);`
  - `job-host-protocol.ts:124-130`：只检查 `typeof policy.workspace === "string" && path.isAbsolute(...)`、`privateDirectory` 同理。
  - `job-host-messages.ts:25,29-31`：`cwd: request.policy.workspace ?? ...`，`HOME/TMPDIR: request.policy.privateDirectory`。
- 性质：缺少 `try/catch` 是读代码直接确认；“NUL 会同步抛错”依据 Node `child_process` 的参数校验行为，未实际运行复现，标为推测。
- 建议：在 `launch` 中包住 `fork`，捕获后回 `error`+`close` 并销毁连接；同时让 `parseJobHostRequest` 拒绝 policy 路径中的 NUL/控制字符，或 fork 前再做一次路径校验。补一个 `workspace: "/x\0y"`（或 `privateDirectory`）的用例，断言收到 error/close 且网关进程仍存活。

### 2. 中低：`started` 先清启动定时器、后校验 pid，非法 `started` 可让 transport 永不结束

- 文件:行：`packages/runtime-sandbox/src/job-host-transport.ts:109-114,146-149`；对照 `packages/runtime-sandbox/src/job-host-gateway.ts:68`
- 问题：收到 `started` 时先 `clearTimeout(startTimer)`，再判断 pid 是否合法。网关协议允许 `started{pid:null}`（`started.pid ?? null`）。若对端发一个非法 pid 的 `started` 后保持连接不关闭、也不发 `error`/`close`，启动窗口的保护已经被清掉，`spawned` 以 `undefined` 完成，但 `close` 永远不会触发；此时 Worker 后端已经把会话放进 `live`，`session.result` 也无法结算。
- 证据：
  - `job-host-transport.ts:109-114`：`clearTimeout(startTimer); ... pid = Number.isSafeInteger(value) && value > 1 ? ... : undefined;`
  - `job-host-transport.ts:145-149`：只有 `socket close` 和启动定时器会调用 `close()`。
  - `job-host-gateway.ts:68`：`writeGatewayFrame(socket, { type: "started", pid: started.pid ?? null });`
- 性质：读代码证实。
- 建议：只有 pid 合法时才清定时器；pid 非法时立即 `fail()`+`close()`（或保留定时器继续等待）。补一个服务端发送 `{"type":"started","pid":null}\n` 后保持连接的测试，断言启动窗口内 transport 关闭。

### 3. 中低：Job Host 已自己 `disconnect()` 时，Worker 断线不会进入 cleanupTimeout 兜底

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway.ts:128-138`、`packages/runtime-sandbox/src/job-host-main.ts:317`
- 问题：网关只在 `current?.connected` 为真时安排 `cleanupTimeoutMs` 后的杀进程组。但 Job Host 交回结果后的正常收尾路径会先执行 `process.disconnect()`，此时 `child.connected` 已是 false。若 Worker 的 socket 在这段窗口内断开，网关既不会再 disconnect，也不会安排兜底 kill；一个卡在收尾阶段的 Job Host 会留在 `children` 里，`reconsider()` 永远看不到 `children.size === 0`，网关也不会 idle 退出。
- 证据：
  - `job-host-main.ts:317`：`if (process.connected) process.disconnect();`，随后才 `process.exitCode = ...`。
  - `job-host-gateway.ts:131-136`：`if (current?.connected) { current.disconnect(); const grace = setTimeout(...); ... }`
- 性质：读代码证实。
- 建议：只要 `children.has(current)` 且进程尚未退出（`exitCode === null && signalCode === null`）就安排 grace kill；只有 `connected` 为真时才调用 `disconnect()`。补一个 fixture：收到 disconnect 后自己不退出（或先 `process.disconnect()` 再挂住），断开 Worker socket，断言 `cleanupTimeoutMs` 后收到 SIGKILL。

### 4. 低（安全）：`chmod 0600` 在 listen 之后执行，存在权限窗口，失败也未处理

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-main.ts:18-20`
- 问题：`server.listen(...)` 完成后才 `chmodSync(..., 0o600)`。在 bind 成功到 chmod 之间，socket 文件按默认 umask 创建（常见 0755），本机其他账号有短暂连接窗口；网关信任连接方，因此窗口内可请求以执行账号启动 Job Host。`chmodSync` 抛错时没有 `try/catch`，会以未捕获异常退出。另：路径模式下的 socket 属于执行账号，和“只有主服务能连”的模型只在 systemd fd 模式成立；本 PR 的测试也没有覆盖 0600。
- 证据：
  - `job-host-gateway-main.ts:18-20`：listen 回调里才 chmod。
  - `test/integration/job-host-gateway.test.ts:314-343` 只检查 socket 存在、非法 launch 和 idle 退出，未读 mode。
- 性质：读代码证实。
- 建议：生产继续依赖 systemd 创建的 socket；路径模式若要保留，至少在 listen 前收紧 umask 或把 socket 放在 0700 目录，chmod 失败时关闭 server 并设非零退出码，并加一个检查 `stat(socket).mode & 0o777 === 0o600` 的测试。

### 5. 低（不可撤销操作）：grace kill 只核对 `children` 集合，不核对进程是否仍存活/身份是否一致

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway.ts:133-136`
- 问题：`if (children.has(current)) killGroup(current)` 只证明 ChildProcess 还在集合里。`children.delete` 发生在 `finish`（通常是 `close` 事件）；如果 `exit` 事件已经发生但 `close` 因 stderr 管道被后代继承而迟迟不来，后注册的 `current.once("exit", ...)` 不会再触发，定时器仍可能向已复用 pid 的进程组发 SIGKILL。
- 证据：`job-host-gateway.ts:133-136` 只有 `children.has(current)`；`finish` 在 `close` 时才 `children.delete`（`81-88`）。
- 性质：竞态窗口未被实际复现，属于推测；但“只用 pid 发 SIGKILL、不校验 start token”这一事实是读代码确认的。
- 建议：定时器回调再加 `current.exitCode === null && current.signalCode === null`；更稳妥的是发信号前用 `readProcessStartToken`/pidfd 核对身份，或至少在调度时记录 pid 与 start token。

### 6. 低：transport 在错误路径也会发出 `exit`，和本机 `ChildProcess` 事件顺序不完全一致

- 文件:行：`packages/runtime-sandbox/src/job-host-transport.ts:94-103`
- 问题：`close()` 无条件先 `exit()` 再通知 close 监听器。因此启动超时、连接失败、非法 launch、未知帧这些路径都会出现“exit → close”，而本机 spawn 失败只会“error → close”，正常退出才是“exit → close”。目前 `job-host.ts:134-136` 和 `job-host-session.ts:125-127` 只把 exit 当布尔标志，影响小，但这与作者“事件顺序和本机一致”的说法不完全相符。
- 证据：`job-host-transport.ts:94-103`；`job-host-session.ts:125-127` 仅 `childExited = true`。
- 性质：读代码证实。
- 建议：只在收到 `exit` 帧或确认正常退出时触发 exit；错误路径只触发 error+close，并用测试固定顺序。

### 7. 低：启动窗口固定 10 秒，没有按请求剩余期限截断

- 文件:行：`packages/runtime-sandbox/src/job-host-transport.ts:63-66,146-149`；对照 `packages/runtime-sandbox/src/job-host-session.ts:222-225`
- 问题：会话自身启动定时器用 `Math.min(JOB_HOST_STARTUP_WINDOW_MS, Math.max(1, deadlineRemainingMs))`，但网关 transport 的 `startupWindowMs` 默认固定 10 秒。请求剩余期限很短而网关失效时，`await session.spawned`（在 Worker 的每环境锁内）可把失败推迟到期限之后最多 10 秒。
- 证据：session 的 `startupTimer` 取了 min；transport 的 `setTimeout(..., startupWindowMs)` 没有。
- 性质：读代码证实。
- 建议：默认值改为 `Math.min(startupWindowMs, Math.max(1, Date.parse(request.deadlineAt) - Date.now()))`。

### 8. 说明：帧上限是写死的数字，和作者“不在代码里写死上限数字”的字面表述不一致

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-frames.ts:3`
- 证据：`export const JOB_HOST_GATEWAY_FRAME_MAX_BYTES = 64 * 1024 * 1024;`
- 性质：读代码证实。若该约束只指每人资源配额，则不算问题；若包括协议帧上限，则需要参数化并在文档说明取值依据。

## 侧重检查

- 错误路径：逐条核对了非法 launch、首帧非 launch、非 JSON 行、超长完整行、超长未结束行、第二次 launch、连接失败、静默网关启动超时、fork 失败、忽略 disconnect、Job Host 自己 disconnect、kill 帧。结论见问题 1–3、6。
- 不可信/不合规输入：`parseJobHostRequest` 的键集合、id、digest、executable、args、stdin、resourceLimits、policy、readiness、deadline、output/cleanup 上限都读过；主要缺口是 policy 路径只验证“绝对路径”，不拒绝控制字符（问题 1）。后续 message 帧只检查是普通对象，大小受 64 MiB 行限制。
- 安全：套接字权限窗口与 chmod 失败（问题 4）；网关信任连接方、不校验 peer 身份这一模型在 systemd fd 模式成立，在路径模式下 socket 属于执行账号，不能证明“只有主服务能连”。跨账号 pid 只用于记录和认证，Worker 不直接对它发信号，风险低于直接 kill。
- 资源耗尽：64 MiB 帧会带来同量级 `Buffer.concat` 内存（受信任连接方，影响有限）；没有每网关连接数/Job Host 数上限；`stderr` 管道若被后代继承会使 `close`/`children.delete` 延迟，和问题 5 相关；`connected === false` 时可能留下 Job Host（问题 3）。
- 不可撤销操作：`SIGKILL` 进程组是主要不可逆操作，见问题 5；路径模式 chmod 失败/残留 socket 见问题 4。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 与本改动无关；作者关于“换行 JSON、64 MiB、第一帧 launch、exit/close、idle 退出、spawned/pid”的描述与代码基本一致；不一致处是“不写死上限数字”（问题 8）和“断线时调用 disconnect/兜底”在 `connected === false` 时不成立（问题 3）。本 PR 没有更新任何说明文档，未发现文档与代码冲突到需要阻断的程度。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `packages/runtime-sandbox` 的执行/传输、`apps/execution-worker` 的会话 pid 获取、CI 策略和测试；没有触碰系统提示、工具定义、历史消息、遮盖或任何模型请求组装代码。发给模型的内容仍然只能末尾追加，每轮会变的值仍应只在最后一条消息里；本 PR 没有引入新的每轮变化值进入请求头。`check:prompt-prefix` 是这条规则的自动门槛，但本次未运行（不能运行命令）；这条结论基于改动文件范围，不是端到端复验。

2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求不会。本 PR 没有修改遮盖、序列化或模型上下文。新增的网关帧序列化（换行 JSON、base64 stderr）只用于执行侧 IPC，且属性顺序由对象字面量固定，不进入模型内容。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   - 完整行超限：`job-host-gateway-frames.unit.test.ts:27-33` 是真反向用例；去掉第 2 轮新增的 `pendingBytes + index - start` 检查后，这一行会被正常解析，`frames` 变成 1、`invalid` 不调用，测试失败。
   - 未结束行超限：`:35-39` 的用例在去掉第 2 轮改动后仍会通过，因为 `pendingBytes > MAX` 检查在第 1 轮就已存在；它是保护用例，不是新修复的反向用例。
   - 启动窗口超时：`job-host-gateway.test.ts:259-271` 在去掉 startTimer 后会一直等 `seen.closed`，测试超时失败，是真反向用例。
   - cleanup 兜底：`:219-230` 在去掉 grace 定时器后，忽略 disconnect 的子进程不退出，测试超时失败，是真反向用例。但它用的 `cleanupTimeoutMs` 只有 10ms，且只断言最终 SIGKILL，无法区分“等 10ms 后杀”和“立即杀”；也没有“子进程在期限内正常退出、不应被杀”的反向用例。
   - 其他缺口：没有测试 `started{pid:null}` 后对端静默（问题 2）；没有测试 `connected === false` 时仍应兜底（问题 3）；没有测试 chmod 0600（问题 4）；没有测试完整行跨 chunk 时才越过上限（只测了单 chunk 完整行）；没有测试“started 先到、等待超过启动窗口也不应关闭”。
   - 资格测试 `job-host-gateway-accounts-qualification.test.ts` 在非 root 时跳过，且对 `setpriv` 进程只监听 `exit`、不监听 `error`；若环境没有 `setpriv`，会挂到测试超时而不是快速失败（测试健壮性问题）。

4. **每个新值/修改值，使用它的地方都能接受吗？**
   - `JobHostTransport.spawned` / `SandboxJobSession.spawned`：实现方 `localJobHostTransport`、`gatewayJobHostLauncher`、测试里的 `fakeTransport`/`FakeSession` 都已补齐；生产使用方只有 `production-srt-task-environment-backend.ts:361` 的 `await session.spawned`。可以接受。测试里 `test/integration/production-srt-task-environment.test.ts:252` 用展开复制会话，`pid` 会从 getter 变成快照，但那是本机路径的测试封装，未使用网关传输。
   - 网关回报的 `pid`：产生处 `job-host-gateway.ts:68` 允许 `null`；消费处 `job-host-transport.ts:112-113` 只接受 `safe integer > 1`，否则当作 undefined，后端 `:361,372-375` 把 undefined 当启动失败；`readProcessStartToken` 对非法的 pid 会抛错，但后端用 `.catch(() => null)` 接住。两端能接受。未解决的是“网关谎报 pid”时的身份核验，Worker 目前只读启动时间，不验证父子关系或执行账号。
   - `cleanupTimeoutMs`：产生处 `job-host-protocol.ts:150-159` 校验为 1..30000 的整数；消费处 `job-host-gateway.ts:63,133-135` 直接交给 `setTimeout`，可以接受。
   - 帧上限常量：读写两侧共用同一常量（`job-host-gateway-frames.ts:31,57` 与 transport 的 `readGatewayFrames`），测试也用同一常量，语义一致；只是硬编码（问题 8）。
   - 新增 `ci/policy.json` 清单项：路径同时出现在 `integration.exclude`（`ci/policy.json:165`）和 `registeredTests`（`:244-249`），`planTestInventory` 要求“恰好一个归属”，满足；`project: "qualification-job-host-gateway-accounts"` 会被 `vitest.workspace.ts:50-60` 自动生成为项目，`validateVitestProjects`（`scripts/ci/check-policy.mjs:1325-1348`）能找到它；`allowedModifiers: ["skipIf"]` 与源码里的 `describe.skipIf` 匹配。两端校验能通过。
   - 新增 socket 的 `0o600`：消费方是操作系统，没有代码侧校验；也没有自动检查（问题 4）。
   - 新增的帧类型 `started/message/stderr/exit/error/close`：网关只产生这几种，transport 逐一处理，未知类型会 fail+close，两端格式一致。
