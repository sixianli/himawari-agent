## 复核说明

我无法读取 `.agents/reviews/pr-463/round-3/judgments.md` 等复核记录：环境对 `records-path` 的 `git show` 直接拒绝。因此第 3 轮改了什么，是我用 `git show 27afc84328` 的 diff 反推的；第 1、2 轮的判断没有读到，标为未核实。

---

## 读代码证实的问题

### 中：资格脚本在失败路径可能永久挂起，既不非零退出，也不清理

文件：`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs:35-41,62-64,73,75-77`

问题：脚本有三处无超时等待。最危险的是 `await closed`：如果网关在收到 kill 后不返回 close（进程卡住、连接半开等），脚本会一直等，`finally` 永远不执行，网关进程和临时目录都留下。这不符合“失败时非零退出”。

证据：

```js
35:  await new Promise((resolve, reject) => {
36:    host.stdout.on("data", (chunk) => {
37:      if (chunk.toString().includes("listening")) resolve();
...
39:    host.once("exit", () => reject(new Error("GATEWAY_HOST_EXITED")));
40:    host.once("error", reject);
41:  });
...
62:  const closed = new Promise((resolve) =>
63:    transport.onceClose((exitCode, signal) => resolve({ exitCode, signal })),
64:  );
...
73:  assert.deepEqual(await closed, { exitCode: null, signal: "SIGKILL" }, "QUALIFY_KILL_FAILED");
...
75: } finally {
76:   if (host && host.exitCode === null) host.kill("SIGKILL");
77:   await rm(root, { recursive: true, force: true });
78: }
```

建议：用有界 `Promise.race` 包住“等 listening”“等 spawned”“等 closed”；超时也走失败分支，并在 `finally` 里兜底清理（见下一条）。

---

### 低：失败清理只杀网关，不兜底杀 Job Host；Job Host 若在断线后不退，会遗留

文件：`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs:76`，`test/fixtures/job-host-gateway-host.mjs:13`，`test/fixtures/job-host-gateway-child.mjs:23-26`

问题：脚本在 `finally` 只对 `host`（setpriv/网关）发 SIGKILL。Job Host 由网关以 `detached: true` 另起进程组。当前 fixture 恰好会在 IPC 断开后自行 `exit(0)`，因此正常失败多半不会遗留；但网关专门设置 `cleanupTimeoutMs` 兜底，说明存在“disconnect 后不退出”的 Job Host。一旦脚本在这条路径上失败，先杀网关会让网关的兜底逻辑没有机会执行，从而留下脱离的 Job Host。

证据：

```js
// 脚本
76:   if (host && host.exitCode === null) host.kill("SIGKILL");

// host fixture
13:     fork(child, [], { detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] }),

// child fixture
23: process.on("disconnect", () => {
24:   if (process.argv.includes("--ignore-disconnect")) return;
25:   clearInterval(keepAlive);
26:   process.exit(0);
27: });
```

建议：把 `transport` 提升到 `finally` 可见的作用域；失败时先在 `finally` 里调用 `transport.killGroup()` 并给一个很短的确认窗口，再杀网关；或者按网关回报的 pid 直接杀其进程组。

---

### 低：跨账号脚本绕开真实入口和 0600 套接字

文件：`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs:21-34`，`test/fixtures/job-host-gateway-host.mjs:6,15`

问题：脚本用 `job-host-gateway-host.mjs` 起网关，而该 fixture 直接 `import gatewaySource` 后调用 `serveJobHostGateway`，不经过 `job-host-gateway-main.ts`；它自己 `server.listen(socketPath)`，没有主程序里的 umask 逻辑。因此这个“跨账号资格”没有验证真实入口的参数解析、systemd fd 路径，也没有验证套接字权限。

证据：

```js
// 脚本
28:      hostFixture,
29:      gatewaySource,
30:      socketPath,
...
// host fixture
6: const { serveJobHostGateway } = await import(gatewaySource);
...
15: server.listen(socketPath, () => process.stdout.write("listening\n"));
```

而真实入口才设置 0600：

```ts
// job-host-gateway-main.ts
17: const umask = "path" in args.listen ? process.umask(0o177) : undefined;
18: server.listen(args.listen, () => {
19:   if (umask !== undefined) process.umask(umask);
20: });
```

建议：至少补一条用真实 `job-host-gateway-main.ts --socket ...` 以 `execUid` 启动、并断言套接字 `mode & 0o777 === 0o600` 的检查；如果 fixture 只是为了让测试注入 `fork`，在脚本输出里明确写清“只验证核心网关，不验证主入口/权限”。

---

### 低：网关把“发给已断开 Job Host 的消息”当作杀进程组信号，和本机 transport 语义不同

文件：`packages/runtime-sandbox/src/job-host-gateway.ts:127`，`packages/runtime-sandbox/src/job-host-transport.ts:165-166`，`packages/runtime-sandbox/src/job-host-main.ts:317`，`packages/runtime-sandbox/src/job-host-session.ts:216`

问题：Job Host 正常完成时会先 `process.disconnect()` 再设置 exitCode。此时本机 `ChildProcess.connected` 变 false，session 的心跳会被 `if (child.connected)` 跳过；但网关 transport 的 `connected` 只看“socket 还开着”，所以还会把心跳转发给网关。网关看到 `!current.connected` 就 `killGroup(current)`，可能把正在正常退出的 Job Host 从“正常退出”改成 SIGKILL。当前 session 的结果取自更早的 `result` 消息，close 的 signal 不参与结果，所以**现有可观察结果不变**，但事件/退出语义与 `ChildProcess` 不完全一致。

证据：

```ts
// job-host-main.ts
317:   if (process.connected) process.disconnect();

// job-host-gateway.ts
127:         if (!current.connected) return killGroup(current);

// job-host-transport.ts
165:       get connected() {
166:         return open && !socket.destroyed;
167:       },

// job-host-session.ts
216:     if (!ended && !cancelled) send({ type: "heartbeat" });
```

建议：网关监听 `started.on("disconnect")`，断开后不再把 Worker 消息转成 kill（或直接把断开视作“Job Host 正在收尾”），必要时让 transport 的 `connected` 也反映 Job Host 的 IPC 断开。

---

### 低：跨账号验证没有自动检查，也没有文档入口

文件：`ci/policy.json`（已无该 qualification 登记），`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs`

问题：第 4 轮删除了 `test/integration/job-host-gateway-accounts-qualification.test.ts`，恢复了 `ci/policy.json`，而替代物是纯手工脚本。仓库里没有任何 CI 或 tooling 检查会执行它；也没有任何文档写明运行命令。`grep qualify-job-host-gateway-accounts` 在仓库内无结果，只有提交说明提到它。因此脚本以后坏掉、或者没人运行，都不会有检查失败。round-4 的“新测试能否在去掉修复时失败”没有对应测试可回答。

证据：`git show --stat 1a6fda11c` 显示删除 87 行测试并新增 78 行脚本；当前 `ci/policy.json` 的 `registeredTests` 和 integration `exclude` 都没有该路径；仓库内除脚本自身外无引用。

建议：在 `docs/execution/` 或运营/资格文档里写明确切命令、root 前提、期望输出和“不签发生产资格”的说明；把实际运行输出作为 PR 证据保存。自动检查至少可以做静态检查（文件存在、`node --check`、无硬编码 uid 等），但不要为了它违反 policy 去改已接受的测试选择。

---

### 低：脚本的 pid/uid 断言使用宽松相等

文件：`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs:70-71`

问题：`assert.equal` 是 `==`。如果网关/子进程把 `uid` 返回成字符串 `"4999"`，断言仍会通过；这与“资格验证”的目的不符。

证据：

```js
70:   assert.equal(messages[0]?.pid, pid, "QUALIFY_JOB_HOST_PID_MISMATCH");
71:   assert.equal(messages[0]?.uid, execUid, "QUALIFY_JOB_HOST_UID_MISMATCH");
```

建议：改用 `assert.strictEqual`（或 `assert.deepStrictEqual`）。

---

### 低：新集成测试依赖 `/proc`，未按平台跳过

文件：`test/integration/job-host-gateway.test.ts:347`

问题：`readFileSync('/proc/${holder}/stat')` 仅 Linux 存在。CI 的 integration 只在 Linux 跑（`ci/policy.json` 的 macOS build 也是 paused），所以 CI 不会暴露；但在 macOS 本地跑完整测试会失败。

证据：

```ts
347:     const state = readFileSync(`/proc/${holder}/stat`, "utf8").split(") ").at(1)?.at(0);
```

建议：该条用 `it.runIf(process.platform === "linux")` 包起来，或改成跨平台的进程存在性检查。

---

### 低：作者说法与代码/材料不一致

1. **“不在代码里写死上限数字”** 与 `packages/runtime-sandbox/src/job-host-gateway-frames.ts:3` 的 `JOB_HOST_GATEWAY_FRAME_MAX_BYTES = 64 * 1024 * 1024` 字面冲突。如果该约束只针对按任务配置的上限，需在说明里写清；否则帧上限是写死的常量。
2. 材料开头仍说“测试……登记在 `ci/policy.json` 为 qualification，普通 CI 跳过”，但 HEAD 已删除该测试并恢复 policy；这是第 4 轮之后的材料过期。
3. “`ci/policy.json` 恢复为 main 原样”：我核对到 `git diff e2d2e651f..1a6fda11c -- ci/policy.json` 无输出，就所述基准而言一致。
4. “跨账号测试在 root 容器里通过”“第 0 层 13 个文件 212 条通过”“`node scripts/ci/check-policy.mjs` 改前失败、改后通过”“脚本在开发容器以 root 运行返回 passed”：这些都需要运行环境，我没有执行，**未核实**。

---

## 推测（未证实）

1. **PID 复用窗口**：`job-host-gateway.ts:18-23` 的 `killGroup` 现在会检查 `child.exitCode === null && child.signalCode === null`，能挡住绝大多数“已正常退出”的情况；但 Node 的 `exitCode` 要等 exit 事件才更新，内核可能已经回收 pid。在这个很窄的窗口里，`process.kill(-child.pid)` 仍可能打到复用了同一 pid/pgid 的无关进程组。仓库里已有 `readProcessStartToken` 可用于更强校验；建议在 `cleanupTimeoutMs` 兜底路径上保存并复核启动 token，而不是只依赖 `exitCode`。
2. **`startTimer` 的 TDZ**：`job-host-transport.ts:94-102` 的 `close()` 在 `const startTimer`（第 152 行）初始化之前引用它。当前所有会触发 `close()` 的路径都是异步事件，实际不可达；但如果以后在 socket 创建阶段同步调用 `close()`，会抛 `ReferenceError`。建议把定时器声明提前或用 `let startTimer`。
3. **PID 命名空间假设**：网关回报的 `started.pid` 被 Worker 用来写 `SessionRecord.pid`、调用 `startToken(pid)`/`groupPresent(pid)`。只有网关和 Worker 在同一 PID 命名空间时这些值才对应；如果将来把 Worker 放进容器而网关在宿主 systemd 上，这条链会失效。当前部署模型下未发现问题。
4. **空闲退出与并发连接**：`reconsider()` 在连接集合为空时启动退出计时；内核 accept 队列里尚未交付的连接可能在计时器触发和 `server.close()` 之间被丢掉。生产用 systemd socket activation 时通常会重启实例，但 `--socket` 模式没有重试。属于设计边界，未在本 PR 中看到对应的重试/交接。

---

## 侧重检查

- **非法输入/帧解析**：`readGatewayFrames` 对非法 JSON、非对象、超长完整行、超长未结束行都会置 `invalid` 并回调 `onInvalid`；后续数据直接忽略。我逐段核对了 `pendingBytes + index - start` 的边界，完整行和未结束行两种情况都覆盖。结论：正确。
- **launch 校验**：网关第一帧必须是 `launch`，`request` 交给 `parseJobHostRequest`，复用了 Worker 端同一套 jobId/policyDigest/deadline/maxOutputBytes/cleanupTimeoutMs 校验；非法时回 `error`+`close`，不 fork。结论：正确。
- **kill 路径**：`kill` 帧、协议违规、发送失败、断线兜底四条路径都走 `killGroup`，且 `killGroup` 先查 `exitCode/signalCode`；`cleanupTimeoutMs` 来自已校验的 request（1..30000）。残余风险是上面的 pid 复用窗口。
- **资源耗尽**：入站单帧 64 MiB 上限、`parseJobHostRequest` 另有 128 KiB 整体上限；但出站 `writeGatewayFrame` 没有大小/背压上限。对端是主服务，未发现可被普通用户直接利用的路径；仍建议后续给 outbound 加 bounds。
- **不可撤销操作**：SIGKILL 进程组是不可撤销的；当前只在 kill 帧、断线兜底、协议违规、发送失败时使用。正常退出的 Job Host 可能因“断开后仍有心跳”被误判为发送失败而杀，见上面的低严重度项。
- **安全/套接字**：真实入口 `job-host-gateway-main.ts` 用 umask 0177 创建 0600 套接字；但 socket 的属主/由 systemd 创建、只允许主服务连接这一部分按作者说明属于 PR③，本 PR 未实现，无法核实。资格 fixture 不经过主入口，也不设置该 umask。
- **文档/规则一致性**：`.claude/rules/prompt-prefix.md` 相关路径没有任何改动；新脚本没有文档入口（见上）。I-73 要求的“产生处/使用处两端校验”我按新增值逐项核对了（见必答 4）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 只涉及 `packages/runtime-sandbox` 的 Job Host 网关/传输、`apps/execution-worker` 的 pid 记录、测试和资格脚本；没有系统提示、工具定义、消息序列化、历史或遮盖代码。`spawned`/pid 是执行层元数据，不进入模型请求。依据 `[发给模型的内容只追加](.claude/rules/prompt-prefix.md#append-only)`：本次没有改动任何已发内容的字节。

2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型内容不会：没有改模型请求的组装或遮盖。对 Job Host 传输本身：帧是 JSON，消息/`stderr` 的字节序保持；stdout 分片只是分帧，session 按顺序拼接，数据不变。唯一需要留意的是：本地 IPC 用 structured clone，网关用 JSON；对于已校验的 `JobHostRequest`（全是 JSON 安全字段）没有差异；如果将来有人往 request/policy 里塞 `undefined`、`Infinity`、`BigInt`、循环引用，JSON 序列化行为会不同（`undefined` 丢失、`BigInt` 抛错）。当前 `parseJobHostRequest` 的 128 KiB `JSON.stringify` 检查和字段校验已排除这些。作者说“不改发给模型的内容”，与代码一致。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 网关/帧/本机 transport 有 unit + integration 测试；第 3 轮的两条反向用例，我按代码推断去掉修复后会失败：`job-host-transport.unit.test.ts` 的“started 前收到 message”在去掉 guard 后会一直等到 60s 启动窗口，而 unit 测试默认 5s 超时，失败；`job-host-gateway.test.ts` 的“已退出不杀进程组”在去掉 `exitCode/signalCode` 检查后会把 holder 杀成僵尸，`state` 变 `Z`，断言失败。
   - 第 2 轮的帧上限用例去掉上限检查会不再触发 `invalid`；断线兜底用例去掉 grace timer 会一直等不到 SIGKILL，失败或超时。
   - **第 4 轮没有反向测试**：跨账号验证变成手工脚本，CI 不运行它；去掉脚本或改坏断言，不会有任何自动检查失败。policy 检查只保证测试选择与基准一致。`check-policy` 的实际运行结果我未核实。

4. **每个新增/修改的值，使用它的两端都能接受吗？** 我逐项核对了：
   - `JobHostTransport.spawned`：本机实现 `Promise.resolve(child.pid)`，网关实现由 `started.pid`/close/error/超时 resolve；`SandboxJobSession.spawned` 直接转出；`production-srt-task-environment-backend.ts:361` `await session.spawned`；测试里的 `FakeSession` 已补 `spawned`。所有实现处和消费处类型/语义一致。
   - 网关回报的 pid：网关产出 `started.pid`，Worker 侧校验 `Number.isSafeInteger` 且 `>1`，再用于 session 的 `processId` 认证和 `startToken`。Job Host 自己上报的 `processId` 是同一个 fork 子进程的 pid，两端相等。唯一前提是网关与 Worker 在同一 PID 命名空间（见“推测”）。
   - 帧类型：网关产出 `started/message/stderr/exit/error/close`，传输端逐类消费；Worker 产出 `launch/message/kill`，网关逐类消费。两端没有悬空类型。
   - `cleanupTimeoutMs`：`parseJobHostRequest` 校验 1..30000，网关作为 setTimeout 使用；`idleExitMs`：参数正则 + `serveJobHostGateway` 再校验正安全整数，作为 setTimeout 使用。
   - `ci/policy.json`：恢复后相对基准无 diff；被删除的 qualification 测试文件和它的 `registeredTests` 项、integration `exclude` 项同时消失，没有留下“登记了但文件不存在”或“排除项未登记”的不一致。
   - 脚本的 `execUid`：正安全整数、root 前提，传入 `chown`/`setpriv`；fixture 上报的 uid 与断言值同类型（数字）。未发现 I-73 那种“一端认、另一端不认”的值。
