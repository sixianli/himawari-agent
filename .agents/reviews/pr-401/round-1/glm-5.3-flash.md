# PR 401 复核报告

## 发现（按严重度从高到低）

### 1. 中 | 复核材料 | 「对比基准 b66ed74」不是本 PR 的基准，材料里的 diff 混入了整个 PR 373 的反向差异

**问题**：作者说「对比基准是 b66ed74」，但 `git diff b66ed74..5d8a0a02` 有 134 个文件、-6027 行（review-prereview、demo 数据包、迁移 0091、prompt-manifest 等大量删除），和「纯重构、只改 runtime-sandbox」的说法在字面上矛盾。
**证据**：`git log --oneline b66ed74..5d8a0a02` 只输出一个提交 `5d8a0a02`；`git log --oneline 65d39ca7..b66ed74` 显示 b66ed74 是 PR 373 分支顶端（prereview + demo，共 21 个提交），与 head 的父提交 65d39ca7 同源分叉。因此该 diff = PR 401 + PR 373 全部改动的反向。实际 PR 的差异是 `git diff 5d8a0a02^..5d8a0a02 --stat`：仅 5 个文件（index.ts、job-host-session.ts、job-host-transport.ts 新文件、job-host.ts、新测试），与作者「改了什么」一致。
**建议**：复核这类单提交 PR 时基准应取提交本身的父（`5d8a0a02^`）或 merge-base；作者描述的改动清单是对的，错的（或误导的）是给定的 diff 范围。

### 2. 低 | packages/runtime-sandbox/test/job-host-transport.unit.test.ts:81、105、131 | `prepareSandboxJobSession` 新增的 launcher 注入口没有直接测试

**问题**：新测试只对 `prepareSandboxJobHost` 注入 fake transport，`prepareSandboxJobSession` 的同一条缝没有任何用例。
**证据**：三条用例全部调 `prepareSandboxJobHost(request, undefined, undefined, undefined, () => remote.transport)`；grep 确认 job-host-session.unit.test.ts 里 26 处调用全是 `prepareSandboxJobSession(request())`（默认 fork）。
**缓解（读代码证实）**：session 的本机路径并非无覆盖——job-host-session.unit.test.ts:46 有 `connected: true` 的假 child（mock `node:child_process` 的 fork，job-host.unit.test.ts:11-12 同款），重构后这些用例全部经 `forkLocalJobHost → localJobHostTransport` 走一遍，transport 的每个方法都被间接覆盖。缺的只是「远端 transport + session」这条未来路径。
**建议**：给 session 也加一条 fake-launcher 用例（可复用本次的 `fakeTransport`），或在下一个真用 transport 的 PR 里补。

### 3. 低 | packages/runtime-sandbox/test/job-host-transport.unit.test.ts:38-40 | fake transport 的 `send` 忽略了 `onSendFailure`，「send 失败 → force」接线在注入路径上没有断言

**证据**：测试里 `send: (message) => { sent.push(message); }`，第二参数被丢弃。
**推测/未核实**：本机路径上 send 失败（ERR_IPC_CHANNEL_CLOSED / 回调 error）触发 force 的行为，只能靠旧的 mocked-fork 或真实 fork 测试接住；我没有逐条确认旧测试里有 send 失败用例。生产代码这一行（job-host-transport.ts:28-31）与重构前内联的 `(error) => { if (error) force(); }` 逐字等价，风险本身很低。
**建议**：fake transport 增加一个「send 回调带 error」的用例，断言 `killGroup` 被调。

### 4. 信息 | 未核实的说法：「第 0 层 11 个文件：209 过 20 败，20 个失败全在 sandbox-preparation-control.test.ts」

**读代码证实的**：该测试确实 fork 真实 job-host 并安装真实 node runtime（test/integration/sandbox-preparation-control.test.ts:25-98），在缺 bwrap/Linux 沙箱工具的环境里失败方向合理。
**未核实**：具体数字（11/209/20）和「改动前同样失败」我无法运行测试验证，只能存疑接受。

### 5. 信息 | packages/runtime-sandbox/src/index.ts:20-25 | 新公开导出目前无包外消费者

**证据**：`forkLocalJobHost`、`localJobHostTransport`、`JobHostTransport`、`JobHostLauncher` 的使用点全部在包内（job-host.ts:27,57；job-host-session.ts:27,85；新测试）和 index 导出；grep 未发现 apps/、test/ 下有包外引用。调用端参数序核对：product-job-host.ts:26 传 2 个可选参、production-sandbox-execution-v2.ts:504 传 controlDirectory+assertNetworkAuthority，都在 launcher（第 5 位）之前，默认值不破坏现有调用。无重名导出冲突。
**建议**：无（为下一个 PR 铺路，合理）。

## 侧重检查

我走的流程：模型/任务侧发起沙箱作业 → `apps/execution-worker/src/production-sandbox-execution-v2.ts:504` 调 `prepareSandboxJobHost(value, controlDirectory, assertNetworkAuthority, …)` → 默认 `forkLocalJobHost` → `forkJobHost`（job-host-messages.ts:22-36，fork `job-host-main`）→ IPC `prepare`/`heartbeat`/`result` → `onceClose` 汇总产出 `JobHostResult`；会话路径经 `production-srt-task-environment-backend.ts:118` 用 `prepareSandboxJobSession`（默认 launcher）。

结论：
- 走到的每一环，重构后行为逐行等价（见必答 3 的对照）；全程有测试覆盖：job-host.unit.test.ts（~30 用例，mocked fork）、job-host-session.unit.test.ts、job-host-main.unit.test.ts、新 transport 测试、test/integration/production-srt-task-environment.test.ts:236、production-workspace-copy.test.ts:41-51。
- 无测试覆盖的代码路径：session 的注入 launcher 缝（发现 2）、transport `send` 失败回调的显式断言（发现 3）；其余（`localJobHostTransport` 的 `killGroup`/事件转发）由 mocked-fork 旧套件经新 transport 覆盖。
- 文档与规则一致性：PR 描述与提交内容一致（除发现 1 的基准问题）；本次纯重构、新增公开合同尚无文档/词表条目（docs/glossary.md 无 JobHostTransport），不阻断。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会（读代码证实）。提交只碰 `packages/runtime-sandbox` 5 个文件（`git diff 5d8a0a02^..5d8a0a02 --stat`），不碰提示词目录、工具定义、历史组装或出口遮盖。发给模型的内容不受影响；沙箱的 stdout/资源只作为工具结果在历史末尾追加。对照 `.claude/rules/prompt-prefix.md` 第 4、5 条：无追加之外的改动、无会变的新值进请求头。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（读代码证实）。没有新增序列化、时间字段或无序集合。IPC 消息里的 `observedAt`/`processStartedAt`/`validUntil`（job-host-messages.ts:56-78）是改动前就有的，且这些消息只发给沙箱子进程，不进模型请求。

**3. 有没有对应的自动检查，反向用例会失败吗？** 有（读代码证实，运行结果未核实）。新测试被 unit 项目收进（ci/policy.json:147 `packages/**/*.unit.test.ts`）。第 2 条用例（test:104-129）spy `process.kill` 并断言「不被调用 + `transport.killGroup` 被调用」——若实现改回直接 `process.kill(-pid)`，该用例失败；若 `killGroup` 变 no-op，`toHaveBeenCalled` 失败。第 3 条（test:130-147）断言 processId 不符 → `cancel host_failure`。逻辑上反向用例会真失败；「209 过 20 败」等运行数字未核实。

**4. 每个产生/修改的值，两端都核对了吗？** 核对了（读代码证实）。逐项：`forkLocalJobHost`/`localJobHostTransport`/`JobHostTransport`/`JobHostLauncher` 产生于 job-host-transport.ts，消费于 job-host.ts、job-host-session.ts、index.ts 导出、新测试；接口 9 个成员（pid、connected、send、onMessage、onStderr、onceExit、onceError、onceClose、killGroup）与两处消费点用到的方法一一对应，fake 也实现全接口（TS 结构类型约束）。`launcher` 默认值 `forkLocalJobHost` = 原 `forkJobHost` 路径，现有调用者传参不超过第 4 位，两端校验（参数位置、默认行为、killGroup 内 `if (child.pid) try/catch`）均与旧代码等价。未发现任何一端不接受的值。
