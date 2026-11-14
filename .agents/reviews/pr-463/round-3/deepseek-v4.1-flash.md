## 结论（按严重度从高到低）

### 1. 中 — 第 3 轮只给“断线兜底”这一条杀进程路径加了存活判定，其他杀进程路径仍可能在进程退出/被回收后按 pid 发 SIGKILL
【读代码证实的】
- `packages/runtime-sandbox/src/job-host-gateway.ts:123`
  ```ts
  if (frame["type"] === "kill") return killGroup(current);
  ```
- `job-host-gateway.ts:49-51`
  ```ts
  const reject = () => {
    if (child) killGroup(child);
    socket.destroy();
  };
  ```
- `job-host-gateway.ts:127-130`
  ```ts
  if (!current.connected) return killGroup(current);
  current.send(message, (error) => {
    if (error) killGroup(current);
  });
  ```
- 第 3 轮新加的保护只在这里（`job-host-gateway.ts:138-144`）：
  ```ts
  const running = (target: ChildProcess) =>
    children.has(target) && target.exitCode === null && target.signalCode === null;
  if (current && running(current)) {
    ...
      if (running(current)) killGroup(current);
  ```
- `killGroup` 本身没有身份校验，直接 `process.kill(-child.pid, "SIGKILL")`（`job-host-gateway.ts:18-23`）。

**问题**：作者说“断线后按 `cleanupTimeoutMs` 兜底杀进程组，不会误杀已经正常退出、或误杀 pid 被复用的进程”，这句话对断线路径成立，但对 `kill` 帧、协议违规 `reject`、IPC 发送失败三条路径不成立：只要子进程已经退出、`finish` 因 stderr 尚未关闭还没把它从 `children` 删除，这几条路径仍会对 `-pid` 发 SIGKILL。此时若 pid 已被系统复用给别的进程组，就会误杀网关账号下的无关进程组。
**推测**：触发需要“Worker 在收到 `exit` 帧前发出 kill”这类很窄的竞态，概率低；但杀进程组不可撤销，影响可能不小。
**建议**：把 `running()` 提成公共判定，四条路径（`kill`、`reject`、`send` 失败、断线兜底）统一先判存活；更进一步可记录 `/proc/<pid>` 的启动时间令牌后再杀。

### 2. 中 — socket 权限的新测试在“去掉第 3 轮修复”时仍会通过，不能守住 umask 修复
【读代码证实的】
- 第 3 轮改为在 `listen` 前设 umask（`packages/runtime-sandbox/src/job-host-gateway-main.ts:17-19`）：
  ```ts
  const umask = "path" in args.listen ? process.umask(0o177) : undefined;
  server.listen(args.listen, () => {
    if (umask !== undefined) process.umask(umask);
  });
  ```
- 新测试只断言最终权限（`test/integration/job-host-gateway.test.ts:393-394`）：
  ```ts
  await until(() => existsSync(socketPath));
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  ```
- 第 2 轮被替换掉的写法是 `listen` 回调里 `chmodSync(path, 0o600)`，最终权限同样是 0600。

**问题**：这个改动真正修的是“从 bind 到 chmod 之间 socket 可能处于 0777 & ~umask（例如 0755）”的可访问窗口；最终模式测试对旧 `chmod` 写法也通过，去掉修复测试仍绿，属于反向用例无效。
**建议**：把“在 bind 前设置 umask、bind 后恢复”抽成可注入的小函数，单测断言绑定发生时 `process.umask()` 已是 0177；或让测试以宽松 umask 启动并在 bind 窗口内检查权限。保留现有最终模式断言作为兜底。

### 3. 低 — 网关出站写不处理背压，慢 Worker 或大量 stderr 时内存可无界增长
【读代码证实的】
- `packages/runtime-sandbox/src/job-host-gateway-frames.ts:14-16` 忽略 `socket.write` 返回值：
  ```ts
  socket.write(`${JSON.stringify(frame)}\n`, (error) => {
    if (error) onFailure?.();
  });
  ```
- 网关对每条 Job Host stderr/消息都单独写一帧（`job-host-gateway.ts:76-84`）。
**问题**：Worker 若暂时不读（事件循环卡住/被暂停），Node 会把待发数据堆在网关进程内存里；单个 Job Host 狂写 stderr 时可以放大。另有单帧 64 MiB 上限，`Buffer.concat` + utf8 字符串 + `JSON.parse` 瞬时占用可达数百 MiB（`frames.ts:3`、`readGatewayFrames`）。
**建议**：尊重 `write()` 返回值，stderr 流 `pause()`/`resume()`；对出站排队字节数设上限，超限关闭连接并杀子进程；必要时下调单帧上限或分片。

### 4. 低 — 网关进程自身被终止时没有清理 detached Job Host
【读代码证实的】
- `job-host-gateway-main.ts` 全程没有 `SIGTERM`/`SIGINT`/`process.on("exit")` 清理；`forkJobHost` 使用 `detached: true`（`packages/runtime-sandbox/src/job-host-messages.ts:27`）。
**问题**：网关崩溃或被 SIGKILL 时，已 fork 的 Job Host 不会因子进程的父进程退出而自动结束，可能残留为孤儿；重启后的网关也无从认领。
**未核实**：PR③ 的 systemd 单元若使用默认 `KillMode=control-group`，停止/重启服务时 systemd 会清掉整个 cgroup，可能覆盖这一点；本仓库里还没有该单元，无法确认。
**建议**：在 PR③ 明确依赖 cgroup 清理并补说明；或网关加 SIGTERM 处理器，遍历 `children` 杀组，且把“崩溃后残留”写进运维排查项。

### 5. 低 — 作者说法“不在代码里写死上限数字”与新增的 64 MiB 常量不一致
【读代码证实的】
- `packages/runtime-sandbox/src/job-host-gateway-frames.ts:3`：
  ```ts
  export const JOB_HOST_GATEWAY_FRAME_MAX_BYTES = 64 * 1024 * 1024;
  ```
**问题**：材料里同时写了“单帧上限 64 MiB”和“不在代码里写死上限数字”，两句自相矛盾。
**建议**：把说法改成“空闲退出时间必须由参数给出；帧上限是代码常量”，或把帧上限也参数化并校验。

### 6. 低 — `started` 之前的 `message`/`stderr` 帧不会被拒绝，只校验 `started.pid`
【读代码证实的】
- `packages/runtime-sandbox/src/job-host-transport.ts:108-120` 只在 `type === "started"` 时校验 pid，`message`、`stderr`、`exit` 在任何时刻都直接处理。
**问题**：网关本应第一帧回 `started`，但传输层没强制顺序；异常/恶意网关可在 `pid` 仍为 `undefined` 时先送消息，`job-host-session` 会用 `processId: undefined` 去认证，通常走到 host_failure。当前网关受套接字权限保护，风险低，但属于校验缺口。
**建议**：在 `pid === undefined` 时把 `message`/`stderr` 视为协议错误（或在缓冲后等 `started`），与 `started` 的严格校验一致。

---

## 侧重检查

- **错误路径**：非法首帧（非 launch）、非对象 JSON、超长完整行/未结束行、同步 `fork` 抛错、异步 spawn 失败（`started.pid=null`）、Job Host 崩溃、断线、kill、空闲退出都查过。除上面第 1 条的 kill 路径外，其余路径会结束 socket 或子进程，没有发现确定的泄漏；`reconsider()` 在连接关闭和 `finish()` 两处被调用，空闲判定正确。
- **不合规范/不可信输入**：`parseJobHostRequest` 会校验 deadline、`cleanupTimeoutMs`（≤30000）、请求大小（131072 字节）；帧解析只接受 JSON 对象；消息转发前校验 `message` 是对象。套接字对端完全被信任，这与设计一致（靠文件权限）。帧上限对完整行和未结束行都覆盖（`frames.ts:31`、`frames.ts:57`），恰好等于上限时放行。
- **安全**：umask 改法消除了 bind→chmod 的权限窗口，是正确方向；`--socket` 路径模式创建的 socket 属主是网关账号、模式 0600，跨账号时主服务其实连不上，因此该模式只能用于同账号/测试，生产必须走 systemd fd（PR③）。网关不校验 `SO_PEERCRED`，仍依赖套接字权限；未发现新增提权路径。
- **资源耗尽**：见上面第 3、4 条；另外没有连接数/子进程数上限，连接后不发 launch 会一直占住网关（`reconsider` 只在没有连接时启空闲计时），属于可接受的已知取舍。
- **不可撤销操作**：SIGKILL 进程组是唯一不可撤销动作；第 3 轮已降低断线误杀风险，但其他 kill 路径仍未加保护（第 1 条）。
- **规则/文档一致性**：本改动没有触及 `.claude/rules/prompt-prefix.md` 相关的提示、工具、历史或遮盖文件；仓库 `docs/` 里没有找到本网关的 ADR/规格，暂无法核对文档与实现。材料声称的第 1/2 轮 `judgments.md` 不在当前工作树，`git show` 被策略拒绝，**未核实**。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（依据读到的 diff 和文件）。改动只涉及 `packages/runtime-sandbox`、`apps/execution-worker` 的进程管理/状态记录、CI 清单和测试；没有改 `packages/prompt-catalog`、运行时环境块、历史或遮盖代码。唯一可能外溢的是 `production-srt-task-environment-backend.ts:361` 把 `pid` 记录到环境状态，但那是内部执行状态，且 pid 字段原本就存在（类型仍是 `number|null`），没有进入模型请求。新增帧是 Worker↔网关内部协议，不发送给模型。未核实项：我没有穷举环境状态的所有下游读者，但没有发现通往提示组装的文件改动。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会因本改动产生新的不确定性。网关帧没有时间字段，`started` 里的 pid 只用于进程管理；消息帧按原对象转发，未重排、未加时间。请求里本来就有的 `deadlineAt` 属于既有字段。没有看到新的无序集合、遮盖依赖或带时间序列化进入模型内容。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，但强弱不一：
- 断线兜底：`job-host-gateway.test.ts:273` 的 `--disconnect-self --ignore-disconnect` 用例。把第 3 轮 `running()` 改回旧的 `current?.connected` 判断，子进程不会被杀，测试会等到超时失败。✓
- fork 同步抛错：`:290` 用例。去掉 `try/catch`，异常从 data 回调抛出，测试进程/用例失败。✓
- `started.pid=null`：`:314` 用例。改回旧逻辑会清掉启动定时器并永远等 socket 关闭，测试超时失败（不是“立刻”失败，会拖 30 秒）。✓（但检测慢）
- umask：`:394` 只断言最终 0600；改回第 2 轮 `chmodSync` 仍然通过，**反向用例无效**（见第 2 条发现）。
- 启动窗口只触发一次：`:259` 只验证超时会失败；没有专门用例验证“started 与超时同时发生不双报/不误关”。
- 帧上限：`packages/runtime-sandbox/test/job-host-gateway-frames.unit.test.ts:28`（完整行）和 `:35`（未结束行）都对。✓

**4. 改动产生/修改的每个值，使用方都能接受吗？**
逐个核对如下，均一致：
- `JobHostTransport.spawned: Promise<number|undefined>`：本地实现返回 `child.pid`；网关实现成功时返回 `started.pid`，失败/超时在 `close()` 里返回 `undefined`（`job-host-transport.ts:27,77,99,110-117`）。消费方 `production-srt-task-environment-backend.ts:361` 用 `(await session.spawned) ?? null`，并在 `null` 时失败（`:372-375`），接受 undefined。测试桩 `FakeSession` 已补 `spawned`。
- `started.pid`：生产方 `job-host-gateway.ts:75` 发 `pid ?? null`；消费方 `job-host-transport.ts:108-114` 只接受安全整数且 `>1`，否则 `fail()+close(null,null)`，不会把非法值传给上层。两端一致。
- `close.exitCode/signal`：生产方传 `number|null` / `Signals|null`；消费方把非安全整数变 null、非字符串 signal 变 null，类型可接受。
- `session.pid` 改为 getter：网关模式下在 `started` 前是 `undefined`，与接口 `number|undefined` 一致；生产代码在 `await spawned` 之后才使用 pid，其他使用处是持久化记录里的 pid，不是 live session。
- 配置键：`--idle-exit-ms`、`--socket`、`LISTEN_PID/LISTEN_FDS` 的解析和错误路径自洽；空闲值有参数校验。
- 清单项：`ci/policy.json:165` 把新测试从 integration 排除，`:244-248` 登记为 qualification，`project` 在 `vitest.workspace.ts:50-59` 会生成对应用例，`allowedModifiers:["skipIf"]` 与测试里的 `describe.skipIf` 一致，校验器（`scripts/ci/check-policy.mjs:259-268`）可接受。
- 导入重排（`job-host-control-client.ts`、`linux-host-group.ts`、`readiness-probe.ts`）不改变导出名，无重复导出。

**总体**：第 3 轮的三处代码修复本身是正确的（fork 同步失败不再崩网关、非法 `started.pid` 立即失败、断线兜底只在子进程仍存活时杀），启动定时器只会触发一次且与 `close`/`started` 不冲突，帧上限两种形态都覆盖。主要遗留是第 1 条“其他 kill 路径仍无存活判定”和第 2 条“umask 修复缺少有效反向测试”。
