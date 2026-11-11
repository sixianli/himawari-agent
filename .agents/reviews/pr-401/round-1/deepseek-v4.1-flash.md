## 结论

按 PR 提交 `5d8a0a02` 本身核对，默认本机路径与改动前逐行等价，未发现会改变生产行为的代码缺陷。主要问题在**复核基准给错**、**session 注入路径没有测试**，以及新公开的传输合同里 `pid` / `killGroup` 的语义没有写清楚。

## 发现（按严重度）

### 1. 高（复核材料，不是代码缺陷）：给出的基准不是本 PR 的父提交

`git show --format=%P -s 5d8a0a` 显示父提交是 `65d39ca7`，不是 `b66ed7`；`git show --stat 5d8a0a` 只有 5 个文件，而 `git diff b66ed7..5d8a0a --stat` 有 134 个文件。`b66ed7` 还是 `65d39ca7` 的后代（`git log 65d39ca7..b66ed7` 非空，反向为空），即两条分叉。

后果：按 `b66ed7..5d8a0a` 复核，会把 129 个与 PR 无关的文件算进来，其中包括删除 `packages/prompt-catalog/prompt-manifest.json` 的 `review.prereview` 项和 `packages/prompt-catalog/src/review.ts` 的提示词。这些是 `b66ed7` 一侧的新功能，不是 `5d8a0a` 的改动；若不指出，必答问题 1、2 会被误答成“改了模型开头”。

建议：改用 `git diff 65d39ca7..5d8a0a` 复核本 PR，并在材料里修正基准。

### 2. 中（已证实）：`prepareSandboxJobSession` 的 `launcher` 注入路径没有测试

新测试只导入了 `prepareSandboxJobHost`：

- `packages/runtime-sandbox/test/job-host-transport.unit.test.ts:2` `import { prepareSandboxJobHost } ...`
- 三处调用都在 `:81`、`:105`、`:131`，没有 `prepareSandboxJobSession`

但本次改动同时给 session 加了参数并改了强制杀进程：

- `packages/runtime-sandbox/src/job-host-session.ts:83-85` 新增 `launcher: JobHostLauncher = forkLocalJobHost`
- `packages/runtime-sandbox/src/job-host-session.ts:121-122` `force` 改走 `child.killGroup()`

如果 session 的 launcher 被忽略、或 session 的 `force` 退回直接 `process.kill`，现有新测试不会失败。建议补一个用假 transport 启动 `prepareSandboxJobSession`、断言 `sent[0]`、`killGroup` 被调用的用例。

### 3. 低（已证实）：本机 `killGroup` 的正向行为没有被单元测试钉住

新测试使用的是假 `killGroup`：

- `packages/runtime-sandbox/test/job-host-transport.unit.test.ts:34` `const killGroup = vi.fn()`
- `:122` / `:144` 只断言假函数被调用

本机实现仍是：

- `packages/runtime-sandbox/src/job-host-transport.ts:47-52` `process.kill(-child.pid, "SIGKILL")` 加 `try/catch`

现有 `job-host.unit.test.ts:427`、`:481` 只断言“没有杀”，没有断言“该杀时确实以负 pid 和 `SIGKILL` 杀了”。建议补一条 `localJobHostTransport` 的正向用例；同理，`send` 的失败回调转发（`job-host-transport.ts:28-30`）也建议单独覆盖。

### 4. 低（推测）：`JobHostTransport.pid` 与协议里的 `processId` 语义没有写明

合同里只有：

- `packages/runtime-sandbox/src/job-host-transport.ts:6` `readonly pid: number | undefined`

消费端把它当作 Job Host 上报的进程号做认证：

- `packages/runtime-sandbox/src/job-host.ts:245-250` `authenticateJobHostEnvelope(..., { processId: child.pid, ... })`
- `packages/runtime-sandbox/src/job-host-messages.ts:51` 要求 `message["processId"] !== expected.processId` 即失败

本机 fork 下二者相同；但作者目标里的跨账号网关，若 `pid` 填的是本地网关/中继进程号，而远端 Job Host 上报的是远端宿主进程号，所有消息都会被判定为 `host_failure`。建议把字段语义写成“远端 Job Host 进程号”，或改名 `hostProcessId`，并给远程实现加一条测试。

### 5. 低（推测）：`killGroup` 的错误语义和 pid 安全边界未定义

接口是 `killGroup(): void`（`job-host-transport.ts:14`），本机实现自己吞异常，但远程实现若在网络失败时抛出，调用点可能在 `setTimeout`（`job-host-session.ts:144`）或 `send` 回调（`job-host-transport.ts:28-30`）里变成未捕获异常。另外 `localJobHostTransport` 现从包入口导出（`src/index.ts:21-24`），却默认传入的 `ChildProcess` 是进程组组长；若被用于非 detached 子进程，`process.kill(-pid)` 可能打到别的组。建议在合同注释中明确“尽力而为、不得抛出、幂等”，并在本机实现里校验 `pid > 1` 后再发负 pid 信号，或不要导出 `localJobHostTransport`。

## 侧面检查

- **错误路径**：发送失败、`error`、`exit`、`close`、强制杀进程逐项对照旧代码，默认本机路径等价；本机 `killGroup` 仍保留 `try/catch`，`force` 仍有 `!childExited && !ended` 前置。
- **不可信输入**：两个入口都先 `parseJobHostRequest` / `parseJobHostSessionRequest` 再调用 launcher（`job-host.ts:59`、`job-host-session.ts:87`）；IPC 消息仍校验 `sessionId`、`processId`、序号、时间窗（`job-host-messages.ts:48-67`），本改动没有放宽校验。
- **安全**：本机仍是 `SIGKILL` 整个进程组，未改变；新合同不带“杀哪个 pid”的参数，反而降低了远程误杀任意 pid 的表面，但 `pid` 语义需写清。
- **资源耗尽**：监听器仍按每个 transport 注册一次，定时器逻辑未变；没有新增无界集合。
- **不可撤销操作**：杀进程组仍是不可撤销的 `SIGKILL`，本机行为未变；远程实现的失败/重试语义缺失，见发现 5。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 约束的是模型请求组装，本 PR 未触碰；仓库里没有 `JobHostTransport` 的设计文档，作者“纯重构、行为不变”的说法对 `5d8a0a` 基本成立，但“已核对 209 过 20 败”因不能运行测试，未核实。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   按 `5d8a0a`：不会。提交只改 `packages/runtime-sandbox` 的 Job Host 启动/杀进程路径，不碰系统提示、工具定义、历史、遮盖或 prompt-catalog。Job Host 的 `observedAt`、`sessionId` 等只走子进程 IPC，不进入模型请求。
   但按作者给的 `b66ed7..5d8a0a` 全量 diff：看起来会动 `prompt-catalog` 和模型组合，但那是错误基准带来的反向差异，不是本提交。实际应复核 `65d39ca7..5d8a0a`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会新增这种问题。本 PR 没有新的遮盖、时间字段或无序集合；Job Host 消息里原本就有 `observedAt` 和随机 `sessionId`，本改动只是把发送/接收原样转交给 transport，不改变序列化内容。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有新测试 `job-host-transport.unit.test.ts`。其中：
   - launcher 被忽略会失败（`:88` 期望 `prepare` 已发送，且假 transport 才能提供 `pid 4242`）；
   - 直接 `process.kill` 而不走 transport 会失败（`:122-123`）；
   - 去掉 `processId` 认证会失败（`:142` 期望 `cancel`）。
   但 session 的 launcher 路径、本机 `killGroup` 正向行为、`send` 失败转发都没有直接用例。测试未运行，作者“209 过 20 败”未核实。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `pid`：产生于 `job-host-transport.ts:21-23`，用于 `job-host.ts:247`、`job-host-session.ts:311` 的认证，以及 `job-host-session.ts:453` 的返回值；本机语义与旧代码一致，远程语义需补文档/测试（发现 4）。
   - `connected`：本机是动态 getter（`:24-26`），用于发送前判断和 `inspect()` 的 `alive/lost`；本机一致，远程实现必须保持动态。
   - `send` / `onMessage` / `onStderr` / `onceExit` / `onceError` / `onceClose`：本机逐一转发到对应 `ChildProcess` 事件和回调，签名与 Node 事件匹配；消费端未改变解析逻辑。
   - `killGroup`：只被两处 `force` 调用；本机实现保留 pid 检查和 `try/catch`，行为等价。
   - 新导出的 `JobHostLauncher`、`JobHostTransport`、`forkLocalJobHost`、`localJobHostTransport`：仓库内无同名冲突；新增的 `launcher` 参数只有新测试使用，生产调用点仍用默认值（如 `apps/execution-worker/src/product-job-host.ts:26-45`、`production-sandbox-execution-v2.ts:504-534`），没有调用方被破坏。
   - 没有新增配置键、清单项或跨包序列化格式，因此没有 I-73 那种“清单 id 过不了后端校验”的新增风险。
