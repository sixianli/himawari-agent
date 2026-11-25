---
status: active
document_type: adr
decision_status: proposed
supersedes: ""
superseded_by: ""
amends: "docs/adr/0078-authority-check-once-then-version-compare.md"
date: "2026-10-29"
covers: "apps/agent-service/src/production-sandbox-services.ts, apps/agent-service/test/production-stage-timing.unit.test.ts, packages/platform-node/src/capabilities/sandbox-host-verifier.ts, packages/platform-node/test/sandbox-host-reuse.unit.test.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0116：服务进程里的宿主文件核验按文件状态复用 10 秒，授权每次照常重判；工具调用前后各段加计时

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0078 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-29 12:51（日本时间），Andy 在生产网页让 Himawari 规划一条至少 80 公里的骑行路线并输出 PDF，整轮用了 185.3 秒。按请求逐段拆开（[诊断报告](../engineering-casebook.md#case-tool-gap-host-check)）：模型生成 72.5 秒，沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境）里命令真正执行 44.2 秒，剩下 60.1 秒是工具调用前后的空等，平均每次工具调用前约 3.0 秒、后约 2.0 秒。Andy 当天 16:06 回复“修，找到根音修掉”。

同一轮的服务日志（`sandbox.admission.timing`，Mac 线程在生产机上只读导出）显示：11 次沙箱工具调用一共做了 77 次完整核对（`resolve`，确认这次执行仍被允许的请求），合计 27.98 秒。按阶段分：

| 阶段 | 合计（秒） | 每次平均（毫秒） |
| --- | --- | --- |
| 宿主核验 `host_verification`（核对沙箱程序、工作区和工具链文件没被替换、没被别人改权限） | 12.6 | 163 |
| 授权判断 `scope_authorization` | 6.4 | 83 |
| 读执行范围 `scope_payload` | 2.9 | 38 |
| 工作区身份 `workspace_identity` | 2.0 | 26 |
| 部署快照 `deployment_snapshot` | 1.2 | 16 |

每次工具调用在 Worker（受限执行进程）启动前要做 4 次（准入、绑定等），运行中又做约 3 次。[ADR 0078](0078-authority-check-once-then-version-compare.md) 只让已经在运行的执行复用结果，准入和绑定每次都完整重做，所以宿主核验在一次工具调用里重复 7 次，而这几秒之间这些文件几乎不可能变。

另有两段空等还没有日志能解释：模型说完到第一次核对之间 0.5–2.5 秒，Worker 结束到工具结果交回模型之间平均约 2.1 秒。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **服务进程里的宿主核验按“文件状态”复用，最长 10 秒**（`SANDBOX_HOST_REUSE_MS`，在 `apps/agent-service/src/production-sandbox-services.ts`；实现是 `packages/platform-node/src/capabilities/sandbox-host-verifier.ts` 的 `createReusingSandboxHostVerifier`）。
   - 每次都先做不碰磁盘的计划核对：绑定、资格版本、执行计划是否一致。这一步不复用。
   - 再并行读一遍每个受检路径的文件自身信息（`lstat`：设备号、inode 编号、权限、所有者；普通文件再加大小、修改时间、状态变更时间，精确到纳秒），连同绑定内容和保护清单路径算一个摘要，叫“文件状态”。
   - 10 秒内同一个文件状态已经完整核验通过过，就跳过逐个解析真实路径、哈希可执行文件这些重的检查；否则完整核验，核验前后文件状态相同才记下。
   - 受检的普通文件里，只要有一个在核验开始前 2 秒内被改过，这次结果不记下。原因和 Git 的“racy git”问题相同：文件在同一个时间刻度内被原地改写、大小不变时，文件信息看起来没变，内容却变了；文件稳定 2 秒以上再信任它的时间戳。
   - 只记在服务进程内存里，重启全部作废；时钟往回走也视为过期。
2. **授权每次照常重判。** 读部署快照、读执行范围、授权判断、工作区身份四步不复用，撤销授权在下一次核对立刻生效，和以前一样。
3. **Worker 启动前自己的那次宿主核验不变**，仍然每次完整做（`apps/execution-worker` 调用的 `verifySandboxHost`）。所以即使服务进程这边复用了，命令真正开始跑之前还有一次完整核验。
4. **给工具调用前后每一段加计时日志**，用来找那两段没解释的空等：
   - `tool.dispatch.timing`（`production-runtime-tools.ts`）：校验参数、写意图、等运行就绪、派发、Worker 开始、Worker 结果、写结果。
   - `tool.workflow.timing`（`production-coding-workflow.ts`）：绑定、准备、授权、发句柄、工作区前后快照。
   - `sandbox.tool_result.timing`（`production-sandbox-tool-result.ts`）：读准入、披露检查、核对新鲜度、写日志、写意图、发回执、确认。
   - Pi 适配层在工具执行前的三段等待，记进每轮的 `run.timing`：`tool.history_wait`（等对话历史写完）、`tool.checkpoint.drain`（等前面的流式事件写完）、`tool.checkpoint.save`（保存续跑点）。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0078 的关系

ADR 0078 决定 1 写的是“准入、绑定和启动仍然每次完整核对”。本 ADR 只改其中宿主核验这一项：服务进程这边的准入和绑定改为按文件状态复用，最长 10 秒；授权判断仍然每次完整做；Worker 启动时的宿主核验仍然每次完整做。ADR 0078 的其余决定（运行中按版本号复用、60 秒上限、撤销靠 250 毫秒轮询）不变。

为什么 10 秒而不是 60 秒：一次工具调用从准入到 Worker 启动通常在几秒内，10 秒足够覆盖同一次调用里的重复核验，又让“通过上层目录换掉路径”这类文件状态看不出的变化最多在 10 秒后被完整核验发现。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：准入、绑定也像运行中一样按版本号复用整份核对结果（含授权）

- 好处：能省下宿主核验加授权判断加工作区身份，约 21 秒（按上表）。
- 代价：授权判断也不再每次重做，撤销要靠版本号变化才生效；改动面大，要动 ADR 0078 已验证过的授权复用逻辑。
- 结论：2026-10-29 已用选择卡问 Andy（推荐 A），本 ADR 先只做其中最安全的一半（宿主文件核验，按文件状态而不是只按时间），授权复用等计时数据出来再定。

### 方案 B：保持每次完整核对，只加计时

- 好处：不改任何安全行为。
- 代价：12.6 秒的重复宿主核验照旧。

### 方案 C：按时间缓存宿主核验结果，不看文件状态

- 好处：最简单。
- 代价：ADR 0067 已否决“只按时间信任结果”，文件被替换时 10 秒内发现不了。
- 结论：不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：同一次工具调用里重复的宿主核验，在文件状态没变时只做一次重的检查。省下多少要看生产上 163 毫秒里有多少花在重的检查上：云端容器里完整核验约 0.85 毫秒、复用约 0.41 毫秒，和生产差两个数量级，说明生产上的时间可能在受保护安装的哈希上，也可能在事件循环（Node 处理异步任务的单线程队列）排队上。上线前**未测量**，最多省约 12.6 秒。
- 限制：文件状态看不出“上层目录被换掉、但受检路径本身信息不变”的情况，这种情况最长 10 秒后才被完整核验发现；Worker 启动时的完整核验不受影响。
- 测试：`packages/platform-node/test/sandbox-host-reuse.unit.test.ts`（标签 `[TG-2]`）证明 10 秒内复用、10 秒后重查、改权限、改写可执行文件、换掉工作区根目录都会完整重查并报错，计划不符每次都报错，刚改过 2 秒内的文件不复用（把 2 秒改成 0 时这条测试失败，已复现）；`apps/agent-service/test/production-stage-timing.unit.test.ts` 和 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`（标签 `[TG-1]`）证明计时按段累加、只写一行，Pi 适配层三段等待都被计时。
- 后续：第十九版上线后，用一次真实对话按新日志逐段对比 185 秒基线，再修剩下的空等（事故 [I-25](../incidents-and-gates.md#incidents)）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0078：运行中的授权核对按版本号比对](0078-authority-check-once-then-version-compare.md)
- [ADR 0069：信任未受保护的运行时](0069-trust-unprotected-runtime-like-claude-code.md)
- [案例 59：工具调用前后的空等](../engineering-casebook.md#case-tool-gap-host-check)
- [事故清单 I-25](../incidents-and-gates.md#incidents)

[↑ 返回阅读导航](#contents)
