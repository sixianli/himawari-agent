## 读代码证实的问题

### 1. 高（接入网关后）：`await session.spawned` 没有超时，且发生在环境锁内，网关不应答会把整个环境卡死

- 文件:行：`apps/execution-worker/src/production-srt-task-environment-backend.ts:301`、`:361`、`:656`
- 问题：`session.spawned` 只在收到网关 `started` 帧、`close` 帧或套接字关闭时兑现；如果网关已经 accept 了连接但一直不回应，这个 Promise 永远不结束。等待发生在 `locked()` 的工作函数内部，而 `stop()`/`destroy()` 用的是同一把按 environmentId 的锁，因此会一起被卡住；`session` 的 10 秒启动定时器只会 `cancel()`/`force()`，不会兑现 `spawned`。
- 证据：
  - `production-srt-task-environment-backend.ts:301` `const next = await this.locked(identity, async () => {`
  - `:361` `const pid = (await session.spawned) ?? null;`
  - `:656-660` 锁用 `previous.catch(...).then(work)` 串行化。
  - `packages/runtime-sandbox/src/job-host-transport.ts:74-76` 只有 `started`/`close`/校验失败路径会 `resolveSpawned`；`job-host-gateway.ts:43-131` 没有每连接的 launch 超时。
  - `packages/runtime-sandbox/src/job-host-session.ts:219-231` 启动超时只调用 `cancel()` 和 `force()`，不结束 `spawned`。
- 建议：把 `spawned` 与启动窗口/AbortSignal 竞速，超时后 resolve/reject 并关闭连接；网关对每个连接强制 launch 握手超时、无论如何都回 `close`；不要把身份锁跨越无界等待，或先把 `starting` 登记再 await。

### 2. 中：套接字权限边界和连接方身份校验都不在本 PR 内，`--socket` 模式目前不安全

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-main.ts:14`、`packages/runtime-sandbox/src/job-host-gateway.ts:52-66`、`:149-159`
- 问题：网关完全信任连上来的一方，凭帧里的 `JobHostRequest` fork 任意绝对路径的 `executable` 和参数。代码没有 `SO_PEERCRED`/uid 校验，也没有对 socket 文件 chmod/chown；用 `--socket` 时 Node 按 umask 创建 socket。作者说“systemd 建套接字、属主主服务、0600”在 PR③，但本 PR 已经把 `--socket` 暴露成可运行路径。
- 证据：
  - `job-host-gateway-main.ts:14` `server.listen(args.listen);`
  - `job-host-gateway.ts:54-66` `request = parseJobHostRequest(value); ... const started = fork(request);`
  - `job-host-gateway.ts:157-163` 接受 `--socket` 并返回 `{ path: socket }`。
  - 全文件没有 `chmod`、`chown`、`SO_PEERCRED` 或 peer uid 检查。
- 建议：在 PR③ 之前把 `--socket` 限定为测试/开发用途；或在网关内校验连接对端 uid（Linux `SO_PEERCRED`），并显式设置 socket 属主/0600。补一个“另一个 uid 能连上但不能 launch”的反向测试。
- 说明：生产尚未接入网关（只被测试和 `index.ts` 引用），所以当前线上不受影响，但这是 PR③ 接入前必须补的边界。

### 3. 中/低：帧大小上限只在“未完成行”上检查，且没有背压、连接数或握手超时

- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-frames.ts:3`、`:30-34`、`:50-56`、`packages/runtime-sandbox/src/job-host-gateway.ts:70-75`、`:126-130`
- 问题：
  - 找到换行后直接 `Buffer.concat(pending)` 解析，完整帧的字节数没有在解析前检查；`pendingBytes` 只累计最后一个换行之后的剩余部分。因此“单帧上限 64 MiB”实际可被“64 MiB + 一个 socket chunk”突破。
  - `socket.write` 的返回值被忽略，stderr 转发和消息转发没有背压处理；worker 读得慢时网关内存可无界增长。
  - 没有连接数/Job Host 数上限，也没有“连上但不发 launch”或“发了 launch 但网关不回应”的超时。
  - 收到 `close` 后只 `socket.end()`，客户端若一直不关连接，`connections` 不清理，网关永远不会进入 idle。
- 证据：
  - `:30-34` `pending.push(chunk.subarray(start, index)); const line = Buffer.concat(pending).toString("utf8");`
  - `:50-56` 只在循环结束后对 `rest` 做 `pendingBytes > JOB_HOST_GATEWAY_FRAME_MAX_BYTES`。
  - `:14` `socket.write(...)` 没有处理返回的 `false`。
  - `job-host-gateway.ts:126-130` 只在 socket `close` 时删除连接。
- 建议：在拼接前检查 `pendingBytes + segment.length`，或统一按已读字节限流；处理写背压；给连接加空闲/握手超时和数量上限；明确 64 MiB 是否允许硬编码（作者约束写“不在代码里写死上限数字”，但这里写了 `64 * 1024 * 1024`）。

### 4. 低：transport 在 `close` 时无条件合成 `exit`，与本机 `ChildProcess` 的事件顺序不完全一致

- 文件:行：`packages/runtime-sandbox/src/job-host-transport.ts:91-99`、`packages/runtime-sandbox/src/job-host-gateway.ts:56-60`、`:94-98`
- 问题：本机 spawn 失败通常是 `error` → `close`，不一定有 `exit`；网关在非法 launch 时只发 `error` + `close`，没有 `exit` 帧。但 transport 的 `close()` 总会先调用 `exit()`，再通知 `onceClose`。因此 worker 侧实际看到的是 `error` → `exit` → `close`。
- 证据：
  - `job-host-transport.ts:91-99` `close()` 内先 `resolveSpawned(pid); exit();` 再执行 close listeners。
  - `job-host-gateway.ts:56-60` 解析失败时 `writeGatewayFrame(... {type:"error"})`、`{type:"close"...}`，没有 `exit`。
  - `packages/runtime-sandbox/src/job-host.ts:134-136` 目前只把 `exit` 用来置 `childExited = true`，所以当前没有看到实际破坏。
- 建议：记录是否真的收到过 `exit` 帧；如果要求与本机语义严格一致，spawn/protocol 失败路径不要合成 `exit`，或在文档里明确这是 transport 的有意统一。补一个 spawn 失败事件顺序用例。

### 5. 低：新测试覆盖了主要路径，但仍缺少关键的失败路径和边界测试

- 文件:行：`test/integration/job-host-gateway.test.ts`、`test/integration/job-host-gateway-accounts-qualification.test.ts:41-70`、`test/fixtures/job-host-gateway-host.mjs:12-13`
- 问题：现有测试覆盖了 launch、message/stderr 转发、kill、断线 disconnect、非法 launch、首个帧不是 launch、非对象 JSON、socket 不存在、idle、参数解析。但没有：
  - gateway 内 `fork` 失败/Job Host spawn error 的事件顺序；
  - 64 MiB 帧上限；
  - 分片/合并到达的帧；
  - 网关挂起导致 worker 永远等 `spawned`；
  - systemd fd 3 的真实启动路径；
  - socket 属主/权限和“另一个 uid 不能连接”；
  - 网关收到 SIGTERM 时仍有 Job Host 的清理。
- 证据：
  - `job-host-gateway-accounts-qualification.test.ts:41-70` 以 root 连接，测试自己把临时目录 chown 给执行账号；“跨账号”只证明子进程 uid，没有验证 socket 权限边界。
  - `test/fixtures/job-host-gateway-host.mjs:12-13` 使用自定义 `fork` fixture，不走真实的 `forkJobHost`/`job-host-gateway-main` systemd 路径。
- 建议：至少补 spawn 失败顺序、帧大小、分片帧、网关不应答超时和 socket 权限反向用例。

## 推测与未核实

- **网关确实会卡死**：从代码看没有 launch 超时是确定的；“实际环境中何时会出现 accept 后不回应”未复现，可能是网关事件循环阻塞、重启期残留监听 socket 等。
- `job-host-gateway-main.ts:16-19` 在 `server` 出错时调用 `server.close()`；如果此时 server 尚未 listening，`close()` 的具体行为（抛错还是静默）未核实。
- 网关收到 SIGTERM 时没有显式杀子进程；依赖 Job Host 收到 IPC disconnect 后自行取消。该清理行为未测试，不能确认所有异常 Job Host 都会退出。
- 跨账号下 Worker 用 `readProcessStartToken(pid)` 读取 `/proc/<pid>/stat`，在 `hidepid=2` 等配置下可能拿不到 startToken；本次 qualification 没覆盖这一点。
- 网关在 Job Host 退出后仍可能对旧 pid 发送 `kill`，理论上存在 pid 复用时误杀其他进程组的窗口；概率低，未验证。

## 侧重检查

- **错误路径**：非法 launch、首帧非 launch、非对象 JSON、连接不存在、断线 disconnect、kill、子进程退出均已阅读。发现网关挂起时 `spawned` 无界等待（问题 1）；spawn 失败/超时没有测试（问题 5）。
- **不可信输入**：帧解析有“必须是 JSON 对象”检查，launch 走同一份 `parseJobHostRequest`；但连接方身份完全依赖未在本 PR 实现的 socket 权限（问题 2），帧大小限制不严格（问题 3）。
- **安全**：网关接受任意绝对路径可执行文件和参数，这是设计使然；当前无对端 uid 校验，套接字权限必须由后续 PR 补齐。测试不覆盖权限边界。
- **资源耗尽/泄漏**：无连接数上限、无握手/空闲超时、无背压、客户端可拖延 socket close 使网关不进入 idle（问题 1、3）。
- **不可撤销操作**：`SIGKILL` 整个 Job Host 进程组的路径正确；断线后通过 `disconnect()` 让 Job Host 自行取消。未覆盖 SIGTERM 下活子进程的处置。
- **规则/文档一致性**：本 PR 没有改提示词、工具定义或历史组装；`prompt-prefix` 规则不受影响。作者“不写死上限数字”的说法与 `JOB_HOST_GATEWAY_FRAME_MAX_BYTES` 硬编码 64 MiB 不一致；“套接字属主/0600 在 PR③”也与本 PR 已暴露 `--socket` 的事实存在安全落差。`ci/policy.json` 的新增项路径、project 名和 `skipIf` 与测试文件一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 改动只涉及 `runtime-sandbox` 的 Job Host 传输/进程启动和 execution-worker 的 pid 获取，没有改 `packages/prompt-catalog`、`packages/runtime-pi` 或线程 prompt 组装。系统提示、工具定义、历史消息、遮盖仍由原路径生成；新增的 `pid`、`exitCode`、stderr 分块都在执行 IPC 内，不是模型输入。默认本机路径仍取本机 Job Host pid；网关模式只是换成远端回报的 Job Host pid，而 prompt/runtime 目录中没有使用 pid 的代码。因此发给模型的内容仍然只在末尾追加，每轮变化的值没有进入头部。未运行 `check:prompt-prefix`，这里只按代码路径核对。

2. **会不会让同一段文字在不同请求里变成不同字节？对模型内容不会。** 网关帧中的 `pid`、`exitCode` 和 base64 stderr 分块会随进程/调度变化，但这些不是模型文本，也没有新增“把集合序列化进提示”的路径；`observedAt` 本来就是 Job Host 协议字段，不是模型内容。若以后把 stderr 原文拼进提示，分块边界不同也不改变拼接后的文本。当前没有这种路径，因此不改变模型请求字节。

3. **有没有对应的自动检查，反向用例真的会失败？有，但覆盖不完整。** 已有的反向用例在对应行为被删掉时会失败：非法 launch 不 fork、首帧不是 launch 断开、非对象 JSON 断开、socket 不存在报错、非法参数抛错、idle 只在 Job Host 结束后触发、kill 通过网关进程组。qualification 测试也按 `describe.skipIf(process.getuid?.() !== 0)` 跳过，`ci/policy.json` 中 `allowedModifiers: ["skipIf"]` 与之一致，`vitest.workspace.ts` 会自动生成对应 qualification project。缺的反向用例见问题 5：spawn 失败、帧大小、分片帧、网关挂起超时、socket 权限和 systemd fd 路径。

4. **每个新值两端是否都能接受？大部分可以，两处需要注意。**
   - `spawned`：接口新增后，本机 transport、网关 transport、测试 fake、`FakeSession` 都实现了；生产端 `await session.spawned ?? null` 能接受。已用 grep 找到所有实现，未发现漏改。
   - `pid`：产端 `job-host-gateway.ts:66` 发送 `started.pid`；transport 端 `job-host-transport.ts:105-109` 校验 `Number.isSafeInteger > 1`；下游 `readProcessStartToken` 也要求 `pid > 1`，两端一致。
   - `close.exitCode/signal`：网关产 `child` 的退出码/信号，transport 对非法 exitCode 降为 `null`、字符串 signal 转 `NodeJS.Signals`；下游目前只记录/忽略，没有更严格校验，和本机 `ChildProcess` 基本一致。
   - `--idle-exit-ms`：参数解析和 `serveJobHostGateway` 都校验安全整数且大于 0，一致。
   - `--socket`：只在网关内 `server.listen` 使用，没有属主/权限/对端身份校验；这是问题 2。
   - `ci/policy.json` 的新增项：路径存在、project 由 workspace 自动生成、`skipIf` 与测试一致。
   - 另有一个轻微点：`SandboxJobSession.pid` 改成 getter 后，`test/integration/production-srt-task-environment.test.ts:252` 的 `{ ...session }` 会把 getter 当前值快照下来；该测试用的是本机立即有 pid 的 session，所以不破坏，但其他类似展开需要留意。

总体结论：**模型请求前缀不受影响；主要风险集中在网关的错误/超时路径和套接字信任边界。生产尚未接入网关，问题 1、2 应在 PR③ 接入前解决。**
